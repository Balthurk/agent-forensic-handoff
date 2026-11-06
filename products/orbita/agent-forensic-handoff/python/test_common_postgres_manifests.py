"""Typed manifests prove rows and actual schema, never a simulated PRAGMA."""
import hashlib,sqlite3,struct,unittest
from unittest.mock import patch
import psycopg
import test_common_postgres_catalog as fixture
from orbita_store import StoreError,manifests
from orbita_store.admin import connect_operator
from orbita_store.objects import ObjectStore
from orbita_store.schema import ident

class CommonManifests(unittest.TestCase):
    setUpClass=classmethod(fixture.CommonCatalogue.setUpClass.__func__)
    tearDownClass=classmethod(fixture.CommonCatalogue.tearDownClass.__func__)
    setUp=fixture.CommonCatalogue.setUp
    tearDown=fixture.CommonCatalogue.tearDown
    connect=fixture.CommonCatalogue.connect

    def seed(self):
        db=self.connect('embedding','original/cache')
        db.execute('INSERT INTO vectors VALUES(?,?,?,?,?)',('model','one','literal ñ😀','[1,0]','hash'))
        db.execute('INSERT INTO vectors VALUES(?,?,?,?,?)',('model','two','other','[0,1]','hash2'))
        return db

    def test_exact_clone_and_fresh_reader_have_same_manifest_without_embedded_engine(self):
        db=self.seed()
        with patch('sqlite3.connect',side_effect=AssertionError('embedded runtime forbidden')):before=db.logical_manifest()
        self.assertEqual(before['format'],'orbita-common-rows-1');self.assertEqual(before['rows'],2)
        with ObjectStore(self.config,self.binding) as fs:fs.clone_tree('original','copy')
        clone=self.connect('embedding','copy/cache');self.assertEqual(clone.logical_manifest(),before)
        db.close();fresh=self.connect('embedding','original/cache');self.assertEqual(fresh.logical_manifest(),before)
        clone.execute("UPDATE vectors SET text='changed' WHERE text_hash='one'")
        self.assertNotEqual(clone.logical_manifest()['sha256'],before['sha256']);self.assertEqual(fresh.logical_manifest(),before)

    def test_typed_framing_distinguishes_null_empty_bytes_text_numbers_and_boundaries(self):
        values=(None,b'',b'1','',1,'1',1.0,2**60,-2**60,'ñ😀')
        encoded=[manifests.frame(v) for v in values];self.assertEqual(len(set(encoded)),len(values))
        self.assertNotEqual(manifests.frame('ab')+manifests.frame('c'),manifests.frame('a')+manifests.frame('bc'))
        db=self.connect('vector');raw=b'\x00\x00\x80\x3f\x00\x00\x00\x00'
        db.execute('INSERT INTO semantic_embedding VALUES(?,?,?,?,?,?)',(2**60,'text',raw,hashlib.sha256(raw).hexdigest(),2,'now'))
        before=db.logical_manifest();db.execute('UPDATE semantic_embedding SET vector=?',(raw[::-1],))
        self.assertNotEqual(db.logical_manifest()['sha256'],before['sha256'])
        self.assertEqual(db.execute('SELECT rowid FROM semantic_embedding').fetchone(),(2**60,))

    def test_pipelined_empty_headers_match_independent_full_table_reads_and_fresh_append(self):
        db=self.connect('semantic')
        def oracle():
            db.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            try:
                shape=db.raw.execute('SELECT orbita_common.store_structure()').fetchone()[0]
                tables=[];total_rows=total_bytes=0
                for table in shape['tables']:
                    columns=','.join(ident(c['name']) for c in table['columns'])
                    rows=db.raw.execute('SELECT '+columns+' FROM orbita_semantic.'+ident(table['name'])+' ORDER BY rowid').fetchall()
                    digest=hashlib.sha256();count=0
                    for row in rows:
                        digest.update(b'R'+struct.pack('>I',len(row)))
                        for value in row:
                            framed=manifests.frame(value);digest.update(framed);count+=len(framed)
                    total_rows+=len(rows);total_bytes+=count
                    tables.append(dict(name=table['name'],schemaSha256=hashlib.sha256(manifests.stable(table)).hexdigest(),rows=len(rows),typedBytes=count,sha256=digest.hexdigest()))
                result=dict(format='orbita-common-rows-1',family='semantic',tables=tables,rows=total_rows,typedBytes=total_bytes,
                    catalogueSha256=hashlib.sha256(manifests.stable(shape['catalogue'])).hexdigest(),countersSha256=hashlib.sha256(manifests.stable(shape['counters'])).hexdigest())
                result['sha256']=hashlib.sha256(manifests.stable(result)).hexdigest();return result
            finally:db.raw.rollback()
        empty=db.logical_manifest();self.assertEqual(empty,oracle())
        self.assertGreater(len(empty['tables']),10);self.assertEqual(empty['rows'],0)
        for version in (1,2):
            db.execute('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?,?)',('r','scope',version,'2026-10-31T00:00:00Z','{"literal":"ñ😀"}','hash','request-'+str(version),'hash'))
            actual=db.logical_manifest();self.assertEqual(actual,oracle());self.assertEqual(actual['rows'],version)
            self.assertNotEqual(actual['sha256'],empty['sha256'])

    def test_budgets_fail_without_partial_manifest_and_preserve_connection(self):
        db=self.seed()
        for limit in (manifests.Limits(rows=1),manifests.Limits(bytes=1),manifests.Limits(field_bytes=1),manifests.Limits(seconds=.00001)):
            with self.subTest(limit=limit),self.assertRaisesRegex(StoreError,'MANIFEST_(ROW_BUDGET|BYTE_BUDGET|FIELD_BUDGET|DEADLINE)'):db.logical_manifest(limits=limit)
            self.assertFalse(db.in_transaction);self.assertEqual(db.execute('SELECT count(*) FROM vectors').fetchone(),(2,))
        self.assertEqual(db.logical_manifest()['rows'],2)

    def test_concurrent_commit_cannot_mix_rows_from_two_cuts(self):
        db=self.seed();before=db.logical_manifest();writer=self.connect('embedding','original/cache');original=manifests.frame;changed=False
        def update(value):
            nonlocal changed
            if not changed:
                changed=True;writer.execute("UPDATE vectors SET text='after'")
            return original(value)
        with patch.object(manifests,'frame',update):self.assertEqual(db.logical_manifest(),before)
        self.assertNotEqual(db.logical_manifest()['sha256'],before['sha256'])

    def test_timer_cancels_real_server_statement_and_read_committed_is_not_restarted(self):
        db=self.seed();original=db.raw.execute;delayed=False
        def slow(query,*args,**kwargs):
            nonlocal delayed
            if query=='SELECT orbita_common.store_structure()' and not delayed:
                delayed=True;original('SELECT pg_sleep(3)')
            return original(query,*args,**kwargs)
        # Delay an actual server command after the watchdog starts. A streaming
        # cursor owns its transport until drained and cannot run nested queries.
        with patch.object(db.raw,'execute',slow),self.assertRaisesRegex(StoreError,'MANIFEST_DEADLINE'):db.logical_manifest(limits=manifests.Limits(seconds=.5))
        self.assertTrue(delayed);self.assertFalse(db.in_transaction)
        db.execute('BEGIN');db.execute("UPDATE vectors SET text='pending'")
        with self.assertRaisesRegex(StoreError,'MANIFEST_REPEATABLE_SNAPSHOT_REQUIRED'):db.logical_manifest()
        self.assertTrue(db.in_transaction);self.assertEqual(db.execute('SELECT text FROM vectors LIMIT 1').fetchone(),('pending',));db.rollback()

    def test_disabled_constraint_trigger_is_reported_as_failure(self):
        db=self.seed();before=db.logical_manifest()
        with connect_operator(self.operator) as operator:
            operator.execute('ALTER TABLE orbita_embedding.vectors DISABLE TRIGGER orbita_assign_rowid')
            try:
                with self.assertRaisesRegex(psycopg.Error,'RELATION_CONSTRAINT_INVALID'):db.logical_manifest()
            finally:operator.execute('ALTER TABLE orbita_embedding.vectors ENABLE TRIGGER orbita_assign_rowid')
        self.assertEqual(db.logical_manifest(),before)

if __name__=='__main__':unittest.main()

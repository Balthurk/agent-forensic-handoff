"""Real common-store tree operations: history, FK order, snapshots and authority."""
import hashlib,struct,threading,unittest
from concurrent.futures import ThreadPoolExecutor,TimeoutError
import psycopg
import test_common_postgres_catalog as fixture
from orbita_store import StoreError
from orbita_store.connection import Connection
from orbita_store.objects import ObjectStore
from orbita_store.admin import connect_operator

class CommonTrees(unittest.TestCase):
    setUpClass=classmethod(fixture.CommonCatalogue.setUpClass.__func__)
    tearDownClass=classmethod(fixture.CommonCatalogue.tearDownClass.__func__)
    setUp=fixture.CommonCatalogue.setUp
    tearDown=fixture.CommonCatalogue.tearDown
    connect=fixture.CommonCatalogue.connect

    def history(self,key='original/history'):
        db=self.connect('semantic',key)
        db.executescript((self.root/'semantic.sql').read_text(encoding='utf8'))
        db.execute('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?,?)',('r','scope',1,'now','{"literal":"ñ😀"}','hash','request','request-hash'))
        return db

    def test_clone_retains_history_catalogue_counters_and_immutable_bytes(self):
        original=self.history();identity=original.session.store_id
        original.execute('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?,?)',('r','scope',2,'later','{}','hash2','request2','request-hash2'))
        with ObjectStore(self.config,self.binding) as fs:
            fs.write_bytes('original/bytes',b'\x00literal\xff');meta=fs.stat('original/bytes')
            result=fs.clone_tree('original','copy');self.assertEqual(result['stores'],1);self.assertEqual(result['rows'],2)
            self.assertEqual(fs.stat('copy/bytes')['objectId'],meta['objectId'])
            clone=self.connect('semantic','copy/history');self.assertNotEqual(clone.session.store_id,identity)
            self.assertEqual(original.execute('SELECT rowid,* FROM record_versions ORDER BY rowid').fetchall(),clone.execute('SELECT rowid,* FROM record_versions ORDER BY rowid').fetchall())
            self.assertEqual(original.execute('SELECT name,type,sql FROM sqlite_master ORDER BY name').fetchall(),clone.execute('SELECT name,type,sql FROM sqlite_master ORDER BY name').fetchall())
            clone.execute('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?,?)',('r','scope',3,'third','{}','hash3','request3','request-hash3'))
            self.assertEqual(clone.lastrowid,3);self.assertEqual(original.execute('SELECT count(*) FROM record_versions').fetchone(),(2,))
            with self.assertRaises(psycopg.errors.CheckViolation):clone.execute('DELETE FROM record_versions')
            fs.write_bytes('copy/bytes',b'new');self.assertEqual(fs.read_bytes('original/bytes'),b'\x00literal\xff')

    def test_clone_copies_foreign_keys_in_dependency_order(self):
        db=self.connect('case','original/case')
        db.execute("INSERT INTO source(id,harness,native_uri,source_kind,raw_sha256,byte_length,compression,availability) VALUES('s','generic','input','file','hash',5,'none','AVAILABLE')")
        db.execute("INSERT INTO source_record(source_id,ordinal,byte_offset,byte_length,sha256,parse_status) VALUES('s',1,0,5,'hash','PARSED')")
        db.execute("INSERT INTO session(id,native_id,harness) VALUES('session','native','generic')")
        db.execute("INSERT INTO actor(id,kind,epistemic_status) VALUES('a','human','DIRECT_EVIDENCE')")
        db.execute("INSERT INTO event(id,session_id,source_id,record_ordinal,time_precision,actor_id,kind,epistemic_status) VALUES('e','session','s',1,'UNKNOWN','a','message','DIRECT_EVIDENCE')")
        with ObjectStore(self.config,self.binding) as fs:
            self.assertEqual(fs.clone_tree('original','copy')['rows'],5)
            clone=self.connect('case','copy/case');self.assertEqual(clone.execute('SELECT e.id,s.native_uri FROM event e JOIN source s ON s.id=e.source_id').fetchall(),[('e','input')])
            clone.close();self.assertEqual(fs.purge_tree('copy',recursive=True)['rows'],5)
            self.assertEqual(db.execute('SELECT count(*) FROM event').fetchone(),(1,))

    def test_vector_clone_preserves_private_insertion_ordinals(self):
        db=self.connect('vector','original/vector');value=struct.pack('<ff',1,0)
        for rowid in (91,5,74):
            db.execute('INSERT INTO semantic_embedding VALUES(?,?,?,?,?,?)',(rowid,str(rowid),value,hashlib.sha256(value).hexdigest(),2,'now'))
            db.execute('INSERT INTO vector_index VALUES(?,?)',(rowid,value))
        with ObjectStore(self.config,self.binding) as fs:fs.clone_tree('original','copy')
        clone=self.connect('vector','copy/vector')
        self.assertEqual(clone.nearest_vectors(value,3).fetchall(),[(74,0.),(5,0.),(91,0.)])
        clone.execute('INSERT INTO semantic_embedding VALUES(?,?,?,?,?,?)',(1,'1',value,hashlib.sha256(value).hexdigest(),2,'now'))
        clone.execute('INSERT INTO vector_index VALUES(?,?)',(1,value))
        self.assertEqual(clone.nearest_vectors(value,1).fetchone(),(1,0.))
        self.assertEqual(db.nearest_vectors(value,1).fetchone(),(74,0.))

    def test_purge_requires_closed_exact_store_and_retains_pinned_bytes(self):
        db=self.history();store_id=db.session.store_id
        other=self.history('other/history')
        with ObjectStore(self.config,self.binding) as fs:
            fs.write_bytes('original/bytes',b'kept by reader');reader=fs.open_read('original/bytes')
            object_id=reader.item['objectId']
            with self.assertRaisesRegex(psycopg.errors.ObjectInUse,'OPEN_STORE'):fs.purge_tree('original',recursive=True)
            self.assertTrue(fs.exists('original'));db.close()
            self.assertEqual(fs.purge_tree('original',recursive=True),{'entries':3,'stores':1,'rows':1})
            self.assertFalse(fs.exists('original'));self.assertEqual(reader.read(),b'kept by reader')
            self.assertEqual(other.execute('SELECT count(*) FROM record_versions').fetchone(),(1,))
            with connect_operator(self.operator) as operator:
                self.assertEqual(operator.execute('SELECT count(*) FROM orbita_private.stores WHERE id=%s',(store_id,)).fetchone(),(0,))
                self.assertEqual(operator.execute('SELECT count(*) FROM orbita_semantic.record_versions WHERE _store_id=%s',(store_id,)).fetchone(),(0,))
            reader.close();fs.collect([object_id])
            self.assertEqual(fs.raw.execute('SELECT count(*) FROM orbita_common.objects WHERE id=%s',(object_id,)).fetchone(),(0,))

    def test_live_unpublished_writer_and_checkpoint_block_purge(self):
        with ObjectStore(self.config,self.binding) as fs:
            fs.mkdir('original',parents=True);writer=fs.open_write('original/bytes');writer.write(b'prefix')
            for checkpoint in (False,True):
                if checkpoint:writer.checkpoint();writer.write(b'unpublished')
                with self.assertRaisesRegex(psycopg.errors.ObjectInUse,'LIVE_WRITER'):fs.purge_tree('original',recursive=True)
            writer.abort();self.assertEqual(fs.read_bytes('original/bytes'),b'prefix')
            self.assertEqual(fs.purge_tree('original',recursive=True)['entries'],2)

    def test_clone_one_snapshot_and_outer_rollback_leave_no_partial_copy(self):
        db=self.connect('embedding','original/cache');db.execute('INSERT INTO vectors VALUES(?,?,?,?,?)',('model','hash','before','[1,0]','vhash'))
        with ObjectStore(self.config,self.binding) as fs:
            fs.write_bytes('original/literal',b'before')
            pin=fs.open_read('original/literal')
            fs.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
            fs.raw.execute('SELECT count(*) FROM orbita_common.entries').fetchone()
            db.execute("UPDATE vectors SET text='after'")
            with ObjectStore(self.config,self.binding) as writer:writer.write_bytes('original/literal',b'after')
            try:
                self.assertEqual(fs.raw.execute("SELECT orbita_common.clone_tree('original','copy')").fetchone()[0]['rows'],1)
                fs.raw.execute("SELECT orbita_common.open_store('copy/cache','embedding',false)")
                self.assertEqual(fs.raw.execute('SELECT text FROM orbita_embedding.vectors').fetchone(),('before',))
                self.assertEqual(fs.raw.execute("SELECT o.sha256 FROM orbita_common.entries e JOIN orbita_common.objects o ON e.workspace_id=o.workspace_id AND e.object_id=o.id WHERE e.path='copy/literal'").fetchone(),(hashlib.sha256(b'before').hexdigest(),))
            finally:fs.raw.rollback()
            pin.close()
            self.assertFalse(fs.exists('copy'))
            with connect_operator(self.operator) as operator:
                self.assertEqual(operator.execute("SELECT count(*) FROM orbita_private.stores WHERE workspace_id=%s AND logical_key LIKE 'copy/%%'",(self.binding.workspace_id,)).fetchone(),(0,))
            fs.clone_tree('original','copy')
            clone=self.connect('embedding','copy/cache');self.assertEqual(clone.execute('SELECT text FROM vectors').fetchone(),('after',))
            self.assertEqual(fs.read_bytes('copy/literal'),b'after')

    def test_root_overlap_readonly_and_private_authority_are_rejected(self):
        db=self.history()
        with ObjectStore(self.config,self.binding) as fs:
            for source,target in (('','copy'),('original','original/sub'),('original','original')):
                with self.assertRaises((StoreError,psycopg.Error)):fs.clone_tree(source,target)
            with self.assertRaisesRegex(StoreError,'ROOT_DELETE'):fs.purge_tree('',recursive=True)
            with self.assertRaises(psycopg.Error):fs.raw.execute("INSERT INTO orbita_private.tree_operations VALUES(pg_backend_pid(),now(),txid_current(),%s,'purge')",(db.session.store_id,))
            fs.raw.execute("SET orbita.purge='true'")
            with self.assertRaises(psycopg.errors.CheckViolation):db.execute('DELETE FROM record_versions')
            self.assertEqual(fs.purge_tree('absent',missing_ok=True)['entries'],0)
        with ObjectStore(self.config,self.binding,read_only=True) as fs:
            with self.assertRaisesRegex(StoreError,'READ_ONLY'):fs.purge_tree('original',recursive=True)
            with self.assertRaisesRegex(StoreError,'READ_ONLY'):fs.clone_tree('original','copy')
        self.assertEqual(db.execute('SELECT count(*) FROM record_versions').fetchone(),(1,))

    def test_new_reader_binding_is_fenced_by_concurrent_purge(self):
        db=self.history();db.close();started=threading.Event()
        def read():
            started.set()
            with Connection(self.binding.root+'/original/history',family='semantic',config=self.config,read_only=True) as reader:
                return reader.execute('SELECT count(*) FROM record_versions').fetchone()
        with ObjectStore(self.config,self.binding) as fs,ThreadPoolExecutor(max_workers=1) as pool:
            with fs.raw.transaction():
                fs._lock();future=pool.submit(read);self.assertTrue(started.wait(2))
                with self.assertRaises(TimeoutError):future.result(timeout=.05)
                fs.purge_tree('original',recursive=True)
            with self.assertRaisesRegex(StoreError,'STORE_NOT_FOUND'):future.result(timeout=5)
            self.assertFalse(fs.exists('original'))

if __name__=='__main__':unittest.main()

"""Legacy lexical oracle plus real PostgreSQL execution/isolation/budgets."""
from dataclasses import replace
from unittest.mock import patch
import sqlite3,time,unittest

import test_common_postgres_catalog as catalogue_fixture
import test_semantic as semantic_fixture
from orbita_store.connection import Connection
from orbita_store import StoreError,fts
from orbita_store.admin import provision_workspace
from orbita_store.config import Binding

class CommonFullText(unittest.TestCase):
    setUpClass=classmethod(catalogue_fixture.CommonCatalogue.setUpClass.__func__)
    tearDownClass=classmethod(catalogue_fixture.CommonCatalogue.tearDownClass.__func__)
    setUp=catalogue_fixture.CommonCatalogue.setUp
    tearDown=catalogue_fixture.CommonCatalogue.tearDown
    connect=catalogue_fixture.CommonCatalogue.connect

    def populate(self,rows):
        db=self.connect('case')
        db.executemany('INSERT INTO event_fts VALUES(?,?,?,?)',rows)
        return db

    def test_all_unicode_scalars_match_legacy_unicode61_positions(self):
        # Explicit legacy test oracle only, in-memory, never imported by product.
        with sqlite3.connect(':memory:') as oracle:
            oracle.execute('CREATE VIRTUAL TABLE f USING fts5(text)')
            oracle.execute("CREATE VIRTUAL TABLE v USING fts5vocab(f,'instance')")
            for start in range(0,0x110000,8192):
                text=' '.join(chr(c) for c in range(start,min(start+8192,0x110000)) if not 0xD800<=c<=0xDFFF)
                oracle.execute('DELETE FROM f');oracle.execute('INSERT INTO f VALUES(?)',(text,))
                expected=tuple(row[0] for row in oracle.execute('SELECT term FROM v ORDER BY offset'))
                self.assertEqual(fts.tokens(text),expected,hex(start))

    def test_combining_diacritics_phrase_boolean_and_null_parity(self):
        rows=[('a','kind','Éxito alfa_beta revisión',None),('b','kind','alpha beta gamma','delta'),
              ('c','kind','alpha','beta'),('d','kind','a\u0301b CAFÉ Straße Łódź ộ',None),
              ('e','kind','😀\ue000 \U00010400 Œuvre','quote "two words"')]
        db=self.populate(rows)
        queries=['"exito"','"alfa_beta"','"alpha beta"','"alpha" AND "beta"','"alpha" NOT "gamma"',
                 '("alpha" OR "cafe") AND "kind"','"ab"','"straße"','"Łódź"','"ộ"','"😀\ue000"',
                 '"quote ""two words"""','alpha beta NOT gamma','""','alpha\u00a0beta']
        with sqlite3.connect(':memory:') as oracle:
            oracle.execute('CREATE VIRTUAL TABLE event_fts USING fts5(event_id UNINDEXED,kind,input_preview,output_preview)')
            oracle.executemany('INSERT INTO event_fts VALUES(?,?,?,?)',rows)
            for query in queries:
                with self.subTest(query=query):
                    sql='SELECT event_id FROM event_fts WHERE event_fts MATCH ? ORDER BY event_id'
                    self.assertEqual(db.execute(sql,(query,)).fetchall(),oracle.execute(sql,(query,)).fetchall())
            with self.assertRaises(sqlite3.OperationalError):oracle.execute(sql,(None,)).fetchall()
            with self.assertRaisesRegex(StoreError,'FTS_QUERY_SYNTAX'):db.execute(sql,(None,)).fetchall()

    def test_alias_filters_order_limit_and_unindexed_columns(self):
        db=self.populate([('secret-only','alpha','one two',None),('z','alpha','two three',None),('a','alpha','two four',None)])
        self.assertEqual(db.execute('SELECT f.event_id,f.input_preview FROM event_fts f WHERE event_fts MATCH ? AND f.event_id<>? ORDER BY f.event_id DESC LIMIT ? OFFSET ?',('"two"','z',1,0)).fetchall(),[('secret-only','one two')])
        self.assertEqual(db.execute('SELECT event_id FROM event_fts WHERE event_fts MATCH ?',('"secret-only"',)).fetchall(),[])

    def test_same_table_in_other_store_and_workspace_is_not_scanned(self):
        db=self.populate([('one','alpha',None,None)])
        other=self.connect('case','other')
        other.execute('INSERT INTO event_fts VALUES(?,?,?,?)',('two','secret',None,None))
        self.assertEqual(db.execute('SELECT event_id FROM event_fts WHERE event_fts MATCH ?',('secret',)).fetchall(),[])
        self.assertEqual(other.execute('SELECT event_id FROM event_fts WHERE event_fts MATCH ?',('secret',)).fetchall(),[('two',)])
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':fts-foreign',kind='test')
        self.fixture_ids.append(value['workspaceId'])
        binding=Binding(self.binding.root+'/foreign',value['workspaceId'],value['capability'])
        foreign=Connection(binding.root+'/case',family='case',config=replace(self.config,bindings=(binding,)),create=True)
        self.connections.append(foreign)
        foreign.execute('INSERT INTO event_fts VALUES(?,?,?,?)',('foreign','secret',None,None))
        self.assertEqual(foreign.execute('SELECT event_id FROM event_fts WHERE event_fts MATCH ?',('secret',)).fetchall(),[('foreign',)])
        self.assertEqual(db.execute('SELECT count(*) FROM event_fts WHERE event_fts MATCH ?',('secret',)).fetchone(),(0,))

    def test_scan_and_final_query_share_snapshot_during_concurrent_commit(self):
        db=self.populate([('one','alpha','old',None)])
        writer=self.connect('case');original=fts.matches;changed=False
        def concurrent(tree,columns):
            nonlocal changed
            if not changed:
                changed=True
                writer.execute("UPDATE event_fts SET kind='changed',input_preview='new'")
                writer.execute('INSERT INTO event_fts VALUES(?,?,?,?)',('two','alpha','new-row',None))
            return original(tree,columns)
        with patch.object(fts,'matches',concurrent):
            self.assertEqual(db.execute('SELECT event_id,input_preview FROM event_fts WHERE event_fts MATCH ?',('alpha',)).fetchall(),[('one','old')])
        self.assertEqual(db.execute('SELECT event_id FROM event_fts WHERE event_fts MATCH ?',('alpha',)).fetchall(),[('two',)])

    def test_limits_fail_without_partial_results_and_connection_recovers(self):
        db=self.populate([('a','alpha','text',None),('b','alpha','text',None)])
        for limits in (fts.Limits(rows=1),fts.Limits(bytes=1),fts.Limits(row_bytes=1)):
            db.fts_limits=limits
            with self.assertRaisesRegex(StoreError,'FTS_SCAN_BUDGET'):db.execute('SELECT * FROM event_fts WHERE event_fts MATCH ?',('alpha',))
            self.assertFalse(db.in_transaction)
            self.assertEqual(db.execute('SELECT count(*) FROM event_fts').fetchone(),(2,))
        db.fts_limits=fts.Limits()
        self.assertEqual(len(db.execute('SELECT * FROM event_fts WHERE event_fts MATCH ?',('alpha',)).fetchall()),2)

    def test_deadline_cancels_actual_server_statement(self):
        db=self.populate([('a','alpha',None,None)])
        db.fts_limits=fts.Limits(seconds=.15);started=time.monotonic()
        with self.assertRaisesRegex(StoreError,'FTS_DEADLINE'):
            db.execute('SELECT pg_sleep(4) FROM event_fts WHERE event_fts MATCH ?',('alpha',))
        self.assertLess(time.monotonic()-started,2)
        self.assertFalse(db.in_transaction)
        self.assertEqual(db.execute('SELECT count(*) FROM event_fts').fetchone(),(1,))

    def test_unsupported_queries_fail_explicitly_and_quoted_symbols_are_literal(self):
        db=self.populate([('a','alpha',None,None)])
        for query in ('alpha*','^alpha','kind:alpha','NEAR(alpha beta)','"unclosed','OR alpha','alpha AND',''):
            with self.subTest(query=query),self.assertRaisesRegex(StoreError,'FTS_QUERY'):
                db.execute('SELECT event_id FROM event_fts WHERE event_fts MATCH ?',(query,))
        with self.assertRaisesRegex(StoreError,'FTS_MATCH_TARGET'):
            db.execute('SELECT event_id FROM event_fts WHERE input_preview MATCH ?',('alpha',))
        with patch('sqlite3.connect',side_effect=AssertionError('runtime must not open SQLite')):
            self.assertEqual(db.execute('SELECT event_id FROM event_fts WHERE event_fts MATCH ?',('"alpha*"',)).fetchall(),[('a',)])

    def test_existing_read_committed_transaction_is_not_silently_restarted(self):
        db=self.populate([('a','alpha',None,None)])
        db.execute('BEGIN');db.execute("UPDATE event_fts SET input_preview='uncommitted'")
        with self.assertRaisesRegex(StoreError,'FTS_REPEATABLE_SNAPSHOT_REQUIRED'):
            db.execute('SELECT event_id FROM event_fts WHERE event_fts MATCH ?',('alpha',))
        self.assertTrue(db.in_transaction)
        self.assertEqual(db.execute('SELECT input_preview FROM event_fts').fetchone(),('uncommitted',))
        db.rollback()
        reader=Connection(self.binding.root+'/case',family='case',config=self.config,read_only=True)
        self.connections.append(reader);reader.execute('BEGIN')
        self.assertEqual(reader.execute('SELECT event_id FROM event_fts WHERE event_fts MATCH ?',('alpha',)).fetchall(),[('a',)])
        self.assertTrue(reader.in_transaction);reader.rollback()

    def test_publication_real_outbox_fence_readback_and_replay(self):
        fixture=semantic_fixture.SemanticTest('test_cas_idempotency_unknown_fields');fixture.setUp()
        try:
            from afh_semantic.publication import dispatch_publication
            fixture.put()
            def call(op,**kw):return dispatch_publication(fixture.records,dict(scope='scope',op='publication_'+op,**kw))
            stale=call('claim',leaseSeconds=.01)[0];time.sleep(.02)
            current=call('claim')[0]
            binding=dict(outboxId=current['outbox_id'],owner=current['owner'],fence=current['fence'])
            with self.assertRaisesRegex(ValueError,'PUBLICATION_STALE_FENCE'):
                call('publish',outboxId=stale['outbox_id'],owner=stale['owner'],fence=stale['fence'])
            call('publish',**binding);call('publish',**binding)
            self.assertEqual(call('query',question='staging')['items'],[])
            call('ack',**binding)
            self.assertEqual(len(call('query',question='staging')['items']),1)
            self.assertEqual(call('claim'),[])
            self.assertEqual(call('status')['jobs'][0]['state'],'published')
        finally:fixture.tearDown()

if __name__=='__main__':unittest.main()

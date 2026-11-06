"""Additional actual PostgreSQL invariants, independent of the 26 legacy oracles."""
import contextlib,time,unittest
from unittest.mock import patch
import psycopg
from test_janus_native import JanusTest,Janus,Ledger,binding,plan,Projection,Connection,dispatch_graph
from afh_semantic.graph_publication import verified_projection
from afh_semantic.graph_mirror import READ_BATCH

class CommonGraphTests(unittest.TestCase):
    setUp=JanusTest.setUp;tearDown=JanusTest.tearDown
    put=JanusTest.put;savecfg=JanusTest.savecfg;op=JanusTest.op
    publish=JanusTest.publish;query=JanusTest.query;error=JanusTest.error;mutate=JanusTest.mutate

    def test_actual_graph_and_sources_share_repeatable_read_snapshot(self):
        r=self.publish();seen=[];original=Janus._verify_reader
        def inspect(client,p,expected,endpoint,marker,**kw):
            if 'request' not in kw:
                connections=[self.r.db,self.memory.db,*client._views]
                identities=[(c.raw.info.backend_pid,*c.raw.execute("SELECT current_setting('transaction_isolation'),current_setting('transaction_read_only'),pg_current_snapshot()::text").fetchone()) for c in connections]
                self.assertEqual(len({x[0] for x in identities}),4)
                self.assertEqual({x[1:3] for x in identities},{('repeatable read','on')})
                self.assertEqual(len({x[3] for x in identities}),1);seen.append(identities)
            return original(client,p,expected,endpoint,marker,**kw)
        with patch.object(Janus,'_verify_reader',inspect):self.query(r)
        self.assertEqual(len(seen),2);self.assertFalse(self.r.db.in_transaction);self.assertFalse(self.memory.db.in_transaction)

    def test_warm_source_cache_cannot_hide_registry_corruption(self):
        r=self.publish();self.query(r);self.tmp.corrupt(self.memory.db,'source_bindings',{'digest':'broken'})
        self.error('SOURCE_UNAVAILABLE',lambda:self.query(r));self.assertFalse(self.r.db.in_transaction);self.assertFalse(self.memory.db.in_transaction)

    def test_source_changes_during_pinned_read_rejected_on_next_read(self):
        r=self.publish();original=Projection.verify_rows;changed=False
        def inspect(graph,p):
            nonlocal changed
            if not changed:
                changed=True
                with contextlib.closing(Connection(self.memory.path,family='corpus',config=self.memory.db.config)) as writer:self.tmp.corrupt(writer,'source_bindings',{'digest':'broken'})
            return original(graph,p)
        with patch.object(Projection,'verify_rows',inspect):self.assertEqual(len(self.query(r)['items']),2)
        self.assertTrue(changed);self.error('SOURCE_UNAVAILABLE',lambda:self.query(r))

    def test_structural_foreign_keys_cannot_cross_logical_stores(self):
        self.publish()
        with contextlib.closing(self.client.connection(write=True)) as a,contextlib.closing(Connection(self.semantic/'other-mirror.pgstore',family='graph_mirror',config=self.r.db.config,create=True)) as b:
            with b:b.execute('INSERT INTO objects VALUES(?,?,?,?,?)',('only-other','g','act','other','{}'))
            uid=a.execute("SELECT uid FROM objects WHERE kind='act' ORDER BY uid LIMIT 1").fetchone()[0]
            with self.assertRaises(psycopg.errors.ForeignKeyViolation):
                with a:a.execute('INSERT INTO links VALUES(?,?,?)',(uid,'orbita_from','only-other'))
            self.assertEqual(a.execute("SELECT COUNT(*) FROM objects WHERE uid='only-other'").fetchone()[0],0)

    def test_claim_renews_with_an_independent_connection_and_stops(self):
        self.publish();ledger=Ledger(self.r,binding(self.r),True);claim=ledger.claim('scope')
        try:
            before=ledger.db.execute('SELECT expires FROM claims WHERE scope=?',('scope',)).fetchone()[0]
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                after=ledger.db.execute('SELECT expires FROM claims WHERE scope=?',('scope',)).fetchone()[0]
                if after>before:break
                time.sleep(.05)
            self.assertGreater(after,before);claim.check(ledger.db)
        finally:claim.close();ledger.close()
        self.assertFalse(claim.worker.is_alive())

    def test_basic_projection_refuses_one_physical_reader(self):
        self.publish();p=plan(self.r,self.request['outboxId']);one=Projection(self.r)
        with patch('afh_semantic.graph_publication.Projection',return_value=one):self.error('TWO_READERS',lambda:verified_projection(self.r,p))
        self.assertTrue(one.db.closed)

    def test_second_connection_failure_closes_first_reader(self):
        self.publish();p=plan(self.r,self.request['outboxId']);one=self.client.connection()
        with patch.object(self.client,'connection',side_effect=[one,RuntimeError('synthetic second reader unavailable')]):
            with self.assertRaisesRegex(RuntimeError,'second reader unavailable'):self.client.verify(p)
        self.assertTrue(one.closed);self.assertIsNone(self.client._views)

    def test_payload_length_is_checked_before_loading_body(self):
        self.publish();p=plan(self.r,self.request['outboxId']);original=Connection.execute;payload_read=[]
        def execute(connection,statement,*args,**kwargs):
            if statement.startswith('SELECT uid,kind,key,payload FROM objects'):payload_read.append(True)
            return original(connection,statement,*args,**kwargs)
        with patch('afh_semantic.graph_mirror.MAX_BYTES',1024),patch.object(Connection,'execute',execute):self.error('READBACK_MISMATCH',lambda:self.client.verify(p))
        self.assertEqual(payload_read,[])

if __name__=='__main__':unittest.main(verbosity=2)

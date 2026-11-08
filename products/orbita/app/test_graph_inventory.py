"""Conservative inventory over real local/mirror generations; no real purge."""
import contextlib,json,sys,unittest,uuid
from unittest.mock import patch
from test_janus_native import JanusTest
from test_graph_publication_protocol import ProtocolTest
from afh_semantic.host import dispatch
from afh_semantic.graph_publication import dispatch_graph,latest,digest,Projection
from afh_semantic.graph_mirror_publication import Ledger
from afh_semantic.graph_mirror import CommonGraph,binding,UPSERT
from afh_semantic.knowledge_records import RecordError

class InventoryTest(unittest.TestCase):
    setUp=JanusTest.setUp;tearDown=JanusTest.tearDown;savecfg=JanusTest.savecfg
    put=JanusTest.put;op=JanusTest.op;publish=JanusTest.publish;query=JanusTest.query
    writer=ProtocolTest.writer

    def inventory(self):
        try:return dispatch_graph(self.r,dict(op='graph_inventory',scope='scope'))
        except RecordError as e:
            if e.code=='UNKNOWN_GRAPH_OPERATION':self.fail('A14_INVENTORY_MISSING')
            raise

    def contents(self):
        values={}
        for key,connection,tables in [('n04',self.r.db,['g1_projection_outbox','g1_projection_events'])]:
            values[key]={t:[list(r) for r in connection.execute('SELECT * FROM '+t+' ORDER BY rowid')] for t in tables}
        with contextlib.closing(Projection(self.r)) as local,contextlib.closing(Ledger(self.r,binding(self.r))) as ledger,contextlib.closing(self.client.connection()) as mirror:
            for key,db,tables in [('local',local.db,['objects','markers','selectors']),('ledger',ledger.db,['claims','receipts','selectors']),('mirror',mirror,['objects','links'])]:
                values[key]={t:[list(r) for r in db.execute('SELECT * FROM '+t+' ORDER BY rowid')] for t in tables}
            values['files']=[list(r) for r in ledger.db.raw.execute('SELECT path,kind,object_id::text,store_id::text,revision FROM orbita_common.entries ORDER BY path')]
        return digest(values)

    def test_history_receipts_selectors_and_objects_are_retained_without_mutation(self):
        first=self.publish();historical=self.query(first);self.put(2)
        self.request={'outboxId':latest(self.r,'scope')['outbox_id']};second=self.publish()
        before=self.contents();value=self.inventory();self.assertEqual(before,self.contents())
        self.assertTrue(value['dryRun']);self.assertFalse(value['purgeAuthorized']);self.assertFalse(value['mutationPerformed'])
        entries={r['generation']:r for r in value['entries']}
        self.assertEqual(entries[first['generation']]['states']['mirror'],'historical_referenced')
        self.assertEqual(entries[second['generation']]['states']['mirror'],'selected')
        self.assertGreater(entries[first['generation']]['references']['n04SelectedEvents'],0)
        self.assertGreater(entries[first['generation']]['references']['mirrorReceipts'],0)
        self.assertGreater(entries[first['generation']]['references']['localReceipts'],0)
        self.assertTrue(all(r['retained'] and r['retentionReasons'] for r in entries.values()))
        # The dry-run removal set is applied only to an in-memory copy. The
        # real referenced historical generation must remain queryable exactly.
        simulated=set(entries)-set(value['simulation']['removeGenerations'])
        self.assertEqual(simulated,set(entries));self.assertEqual(value['simulation']['removeGenerations'],[])
        self.assertEqual(self.query(first,mode='system_history',knownAt=historical['selectedAt'])['items'],historical['items'])

    def test_partial_object_batch_and_live_lease_are_retained(self):
        original=CommonGraph.request;injected=[]
        def request(client,endpoint,operation,values):
            result=original(client,endpoint,operation,values)
            if operation==UPSERT and not injected:
                injected.append(True);raise RuntimeError('DECLARED_PARTIAL_MIRROR_AFTER_OBJECT_BATCH')
            return result
        with patch.object(CommonGraph,'request',request):
            with self.assertRaisesRegex(RuntimeError,'DECLARED_PARTIAL_MIRROR'):self.publish()
        generation=latest(self.r,'scope')['generation_id']
        with contextlib.closing(Ledger(self.r,binding(self.r),True)) as ledger:
            claim=ledger.claim('scope')
            try:
                value=self.inventory();entry=next(r for r in value['entries'] if r['generation']==generation)
                self.assertEqual(entry['states']['mirror'],'in_progress')
                self.assertTrue(entry['activeLease']);self.assertTrue(entry['retained'])
                self.assertGreater(entry['physical']['mirrorObjects'],0)
            finally:claim.close()
        value=self.inventory();entry=next(r for r in value['entries'] if r['generation']==generation)
        self.assertEqual(entry['states']['mirror'],'aborted');self.assertTrue(entry['retained'])
        self.assertEqual(entry['references']['mirrorReceipts'],0)
        self.assertEqual(value['simulation']['removeGenerations'],[])

    def test_unattributed_and_unselected_generations_never_expose_bodies_or_become_purgeable(self):
        selected=self.publish();token='PRIVATE_UNKNOWN_'+uuid.uuid4().hex
        with contextlib.closing(self.client.connection(write=True)) as db,db:
            db.execute('INSERT INTO objects VALUES(?,?,?,?,?)',(uuid.uuid4().hex,token,'unknown','unknown',json.dumps({'secret':token})))
        self.memory.sources.pop('a')
        before=self.contents();value=self.inventory();self.assertEqual(before,self.contents())
        encoded=json.dumps(value)
        self.assertEqual(value['entries'],[])
        self.assertNotIn(selected['generation'],encoded);self.assertNotIn(token,encoded)
        self.assertGreater(value['unattributed']['retainedGroups'],0)
        self.assertGreater(value['excludedGenerations'],0)
        self.assertEqual(value['simulation']['removeGenerations'],[])

    def test_inventory_holds_one_cut_while_an_independent_writer_commits(self):
        from afh_semantic import graph_inventory
        self.publish();before=self.inventory();previous=latest(self.r,'scope')['outbox_id']
        original=graph_inventory.plan;committed=[]
        def held(records,oid):
            if not committed:committed.append(self.writer())
            return original(records,oid)
        with patch.object(graph_inventory,'plan',held):value=self.inventory()
        self.assertEqual(len(committed),1)
        self.assertNotEqual(latest(self.r,'scope')['outbox_id'],previous)
        self.assertEqual(value['entries'],before['entries'])
        self.assertEqual(value['pendingWithoutGeneration'],before['pendingWithoutGeneration'])
        self.assertFalse(value['purgeAuthorized'])

    def test_empty_inventory_never_creates_a_semantic_store(self):
        empty=self.root/'empty-inspection';self.assertFalse(empty.exists())
        before=self.r.db.raw.execute('SELECT path,revision FROM orbita_common.entries ORDER BY path').fetchall()
        result=dispatch(dict(op='graph_inventory',root=str(empty),scope='scope',sources=[]))
        self.assertEqual(result['entries'],[]);self.assertFalse(empty.exists())
        self.assertEqual(before,self.r.db.raw.execute('SELECT path,revision FROM orbita_common.entries ORDER BY path').fetchall())
        self.assertFalse(result['mutationPerformed']);self.assertFalse(result['purgeAuthorized'])

if __name__=='__main__':
    result=unittest.TextTestRunner(stream=sys.stderr,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(InventoryTest))
    print(json.dumps(dict(status='PASS' if result.wasSuccessful() else 'FAIL',tests=result.testsRun,failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped))))
    sys.exit(not result.wasSuccessful())

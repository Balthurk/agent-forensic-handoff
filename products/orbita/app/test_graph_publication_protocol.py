"""Actual N04 writer processes race a verified common PostgreSQL publication."""
import contextlib,json,pathlib,subprocess,sys,unittest
import psycopg
from unittest.mock import patch
from test_janus_native import JanusTest
from afh_semantic.host import AFHMemory
from afh_semantic.knowledge_records import KnowledgeRecords,RecordError
from afh_semantic.graph_mirror import CommonGraph,binding
from afh_semantic.graph_mirror_publication import Ledger
from orbita_store.paths import Path as CommonPath
from orbita_store.pool import close_idle
from orbita_store.admin import connect_operator
from orbita_store import StoreError

class ProtocolTest(unittest.TestCase):
    setUp=JanusTest.setUp
    tearDown=JanusTest.tearDown
    savecfg=JanusTest.savecfg
    put=JanusTest.put
    op=JanusTest.op
    publish=JanusTest.publish
    query=JanusTest.query

    def writer(self):
        # Start only when the mirror method has been reached. Its successful
        # commit is the barrier; elapsed time is never the success oracle.
        payload=json.dumps(dict(root=str(self.semantic),sources=self.sources))
        child=subprocess.Popen([sys.executable,'-X','utf8','-B',__file__,'--writer'],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            text=True,encoding='utf8',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            out,err=child.communicate(payload,timeout=20)
        except subprocess.TimeoutExpired:
            child.kill();child.communicate();self.fail('A03_OWNED_WRITER_DEADLINE')
        self.assertEqual(child.returncode,0,'A03_N04_WRITER_BLOCKED: '+err[-3000:])
        result=json.loads(out)
        self.assertTrue(result['committed'])
        self.assertGreater(result['pid'],0)
        return result

    def selector(self):
        with contextlib.closing(Ledger(self.r,binding(self.r),True)) as ledger:
            return ledger.db.execute('SELECT generation,fence,sha FROM selectors WHERE config=? AND scope=?',(ledger.config,'scope')).fetchone()

    def test_writer_commits_during_mirror_work_and_stale_generation_is_not_selected(self):
        original=CommonGraph.write;committed=[]
        def remote(client,p):
            committed.append(self.writer())
            return original(client,p)
        with patch.object(CommonGraph,'write',remote):
            with self.assertRaisesRegex(RecordError,'G1_REMOTE_GENERATION_STALE'):
                self.publish()
        self.assertEqual(len(committed),1)
        self.assertIsNone(self.selector())

    def test_replay_revalidates_after_remote_read_and_keeps_previous_selector(self):
        selected=self.publish();before=self.selector();original=CommonGraph.verify;committed=[]
        def remote(client,p,*args,**kwargs):
            if not committed:committed.append(self.writer())
            return original(client,p,*args,**kwargs)
        with patch.object(CommonGraph,'verify',remote):
            with self.assertRaisesRegex(RecordError,'G1_REMOTE_GENERATION_STALE'):
                self.publish()
        self.assertEqual(len(committed),1)
        self.assertEqual(self.selector(),before)
        self.assertEqual(before[0],selected['generation'])

    def test_source_removed_during_mirror_write_cannot_be_selected(self):
        original=CommonGraph.write
        def remote(client,p):
            original(client,p);self.memory.sources.pop('a')
        with patch.object(CommonGraph,'write',remote):
            with self.assertRaisesRegex(RecordError,'SOURCE_SCOPE_MISMATCH'):self.publish()
        self.assertIsNone(self.selector())

    def test_source_removed_during_replay_cannot_return_old_success(self):
        self.publish();before=self.selector();original=CommonGraph.verify
        def remote(client,p,*args,**kwargs):
            value=original(client,p,*args,**kwargs);self.memory.sources.pop('a');return value
        with patch.object(CommonGraph,'verify',remote):
            with self.assertRaisesRegex(RecordError,'SOURCE_SCOPE_MISMATCH'):self.publish()
        self.assertEqual(self.selector(),before)

    def test_revision_change_after_durable_receipt_rejected(self):
        original=Ledger.save
        def save(ledger,receipt,claim):
            original(ledger,receipt,claim)
            self.memory.sources['a']={**self.memory.sources['a'],'revision':'f'*64}
        with patch.object(Ledger,'save',save):
            with self.assertRaisesRegex(RecordError,'SOURCE_UNAVAILABLE'):self.publish()
        self.assertIsNone(self.selector())

    def test_lost_lease_does_not_select_or_expire_replacement(self):
        original=Ledger.save;replacement=[]
        with contextlib.closing(Ledger(self.r,binding(self.r),True)) as other:
            def save(ledger,receipt,claim):
                claim.done.set();claim.worker.join()
                with other.db:other.db.execute('UPDATE claims SET expires=0 WHERE config=? AND scope=?',(other.config,'scope'))
                newer=other.claim('scope');replacement.append(newer)
                self.assertGreater(newer.fence,claim.fence)
                return original(ledger,receipt,claim)
            try:
                with patch.object(Ledger,'save',save):
                    with self.assertRaisesRegex(RecordError,'G1_REMOTE_STALE_FENCE'):self.publish()
                self.assertIsNone(self.selector())
                replacement[0].check(other.db)
            finally:
                for claim in replacement:claim.close()

    def test_second_reader_lost_during_publication_rejects_selector(self):
        original=CommonGraph._verify_reader;closed=[]
        def verify(client,*args,**kwargs):
            value=original(client,*args,**kwargs)
            if not closed:
                client._views[1].close();closed.append(True)
            return value
        with patch.object(CommonGraph,'_verify_reader',verify):
            with self.assertRaisesRegex(StoreError,'CONNECTION_CLOSED'):self.publish()
        self.assertEqual(closed,[True]);self.assertIsNone(self.selector())

    def test_original_sessions_are_not_reauthorized_after_revocation(self):
        original=Ledger.save
        def save(ledger,receipt,claim):
            original(ledger,receipt,claim)
            with connect_operator(self.tmp.operator) as db,db.transaction():
                identity=db.execute('SELECT kind,label FROM orbita_private.workspaces WHERE id=%s::uuid',(self.tmp.workspace_id,)).fetchone()
                self.assertEqual(identity[0],'test');self.assertTrue(identity[1].startswith('qualification:'+self.tmp.id+':'))
                db.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s::uuid',(self.tmp.workspace_id,))
                db.execute('UPDATE orbita_private.workspaces SET active=true WHERE id=%s::uuid',(self.tmp.workspace_id,))
            receipt=json.loads(self.tmp.receipt.read_text(encoding='utf8'))
            receipt['authorityFaultInjection']='Own synthetic workspace deactivated then reactivated; old session fences must remain invalid'
            self.tmp.receipt.write_text(json.dumps(receipt,indent=2),encoding='utf8')
        with patch.object(Ledger,'save',save):
            with self.assertRaisesRegex(RecordError,'G1_REMOTE_AUTHORITY_CHANGED'):self.publish()
        self.assertIsNone(self.r.db.raw.execute('SELECT orbita_common.workspace_id()').fetchone()[0])
        self.assertIsNone(self.selector())

    def test_revocation_is_excluded_during_final_selector_commit(self):
        original=Ledger.select;blocked=[]
        def select(ledger,p,receipt,claim):
            self.assertTrue(self.r.db.in_transaction)
            # Diagnostic timeout belongs only to this adversarial operator;
            # application connection and claim deadlines remain unchanged.
            with self.assertRaises(psycopg.errors.LockNotAvailable):
                with connect_operator(self.tmp.operator) as db,db.transaction():
                    identity=db.execute('SELECT kind,label FROM orbita_private.workspaces WHERE id=%s::uuid',(self.tmp.workspace_id,)).fetchone()
                    self.assertEqual(identity[0],'test');self.assertTrue(identity[1].startswith('qualification:'+self.tmp.id+':'))
                    db.execute("SET LOCAL lock_timeout='250ms'")
                    db.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s::uuid',(self.tmp.workspace_id,))
            blocked.append(True)
            return original(ledger,p,receipt,claim)
        with patch.object(Ledger,'select',select):result=self.publish()
        self.assertEqual(blocked,[True]);self.assertEqual(self.selector()[0],result['generation'])

    def test_n04_writer_is_excluded_only_at_final_selector_boundary(self):
        original=Ledger.select;blocked=[]
        def select(ledger,p,receipt,claim):
            with self.assertRaisesRegex(AssertionError,'A03_N04_WRITER_BLOCKED'):self.writer()
            blocked.append(True)
            return original(ledger,p,receipt,claim)
        with patch.object(Ledger,'select',select):result=self.publish()
        self.assertEqual(blocked,[True]);self.assertEqual(self.selector()[0],result['generation'])

def writer():
    import os
    payload=json.load(sys.stdin)
    memory=AFHMemory(CommonPath(payload['root']),payload['sources'],'scope',register=False)
    records=KnowledgeRecords(memory,CommonPath(payload['root'])/'records.pgstore')
    try:
        holder=ProtocolTest();holder.sources=payload['sources'];holder.memory=memory;holder.r=records
        created=holder.put(2)
        print(json.dumps(dict(committed=True,pid=os.getpid(),recordId=created['id'])))
    finally:records.close();memory.close();close_idle()

if __name__=='__main__':
    if sys.argv[1:]==['--writer']:writer()
    else:
        result=unittest.TextTestRunner(stream=sys.stderr,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ProtocolTest))
        print(json.dumps(dict(status='PASS' if result.wasSuccessful() else 'FAIL',tests=result.testsRun,failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped))))
        sys.exit(not result.wasSuccessful())

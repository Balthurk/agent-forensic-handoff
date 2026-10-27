import copy, unittest, tempfile, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_semantic import source
from afh_semantic.host import AFHMemory, compile_act, digest, query_records
from afh_semantic.knowledge_records import KnowledgeRecords, RecordError
from afh_semantic.reevaluation import prepare, apply, verify

class ReevaluationTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup);root=Path(self.tmp.name)
        self.sources=[source('original','Ella llegó.'),source('late','Con «ella» me refería a Ana.','B'),source('other','Llueve.','C')]
        self.memory=AFHMemory(root,self.sources,'scope',register=True);self.addCleanup(self.memory.close);self.records=KnowledgeRecords(self.memory,root/'records.sqlite3');self.addCleanup(self.records.close)
        act={'key':'arrival','targetSourceId':'original','type':'fact','summary':'Ella llegó.','modality':'stated','clauses':[{'key':'arrival','quote':'Ella llegó.','predicate':'llegar','polarity':'positive','resolution':'insufficient_context','arguments':[{'role':'subject','literal':'Ella','interpreted':'','evidence':[{'sourceId':'original','quote':'Ella llegó.'}]}]}]}
        p=compile_act(self.memory,act,'producer','old-cut');p['opaque']={'preserve':42};p['semantic_unit']['clauses'][0]['opaque']={'x':1};p['semantic_unit']['clauses'][0]['unrepresented_fields']=['/opaque']
        from afh_semantic.host import manifest
        manifest(p['semantic_unit']);self.first=self.records.put(p,expected_version=0,request_id='initial')
        self.packet=prepare(self.records,{'scope':'scope','id':p['id'],'newSourceIds':['late'],'sourceCut':'new-cut','eventId':'event'})
        cid=p['semantic_unit']['clauses'][0]['semantic_clause_id']
        self.output={'disposition':'changed','reason':'Antecedente explícito tardío','summary':'Ana llegó.','clauses':[{'clauseId':cid,'predicate':'llegar','resolution':'resolved','arguments':[{'index':0,'interpreted':'Ana','evidence':[{'sourceId':'late','quote':self.sources[1]['text']}]}],'evidence':[{'sourceId':'late','quote':self.sources[1]['text']}]}]}
    def admit(self,output=None,packet=None,requestId='review'):
        return apply(self.records,{'scope':'scope','packet':packet or self.packet,'output':output or self.output,'producer':'test-producer','requestId':requestId})
    def test_late_antecedent_version_history_retrieval_and_selective_preservation(self):
        result=self.admit();r=result['record'];self.assertEqual(r['version'],2);self.assertEqual(r['payload']['opaque'],{'preserve':42})
        c=r['payload']['semantic_unit']['clauses'][0];self.assertEqual(c['opaque'],{'x':1});self.assertEqual(c['arguments'][0]['interpreted'],'Ana');self.assertEqual(c['target_ref'],self.first['payload']['semantic_unit']['clauses'][0]['target_ref'])
        self.assertEqual(r['payload']['status'],'proposed');self.assertEqual(self.records.history(r['id'],'scope')[0],self.first)
        q=query_records(self.records,{'scope':'scope','question':'Ana'});self.assertEqual(q['items'][0]['recordVersion'],2);self.assertTrue(q['requiresAbstention'])
        self.assertEqual(result,self.admit());self.assertEqual(len(self.records.history(r['id'],'scope')),2)
    def test_no_change_is_attributed_without_new_version(self):
        output={'disposition':'no_change','reason':'La nueva fuente no cambia la interpretación','summary':'','clauses':[]}
        result=self.admit(output);self.assertEqual(result,self.admit(output));self.assertEqual(result['record']['version'],1);self.assertEqual(result['disposition'],'no_change');self.assertTrue(result['receipt']['outputSha256'])
        self.assertEqual(len(self.records.history(self.first['id'],'scope')),1)
    def test_insufficient_context_is_not_a_confirmation(self):
        result=self.admit({'disposition':'insufficient_context','reason':'No identifica el referente','summary':'','clauses':[]});self.assertEqual(result['disposition'],'insufficient_context');self.assertEqual(result['record']['version'],1)
    def test_stale_packet_rejected_before_inference(self):
        self.admit()
        with self.assertRaisesRegex(RecordError,'STALE_REEVALUATION'):verify(self.records,self.packet,'different')
        self.assertTrue(verify(self.records,self.packet,'review')['replay'])
    def test_tampering_and_conflicting_replay_rejected(self):
        p=copy.deepcopy(self.packet);p['target']['payload']['text']='tampered'
        with self.assertRaisesRegex(RecordError,'PACKET_HASH'):self.admit(packet=p)
        self.admit();o=copy.deepcopy(self.output);o['reason']='different'
        with self.assertRaisesRegex(RecordError,'IDEMPOTENCY_CONFLICT'):self.admit(o)
    def test_foreign_source_and_inexact_quote_rejected(self):
        for sid,quote,code in [('missing','Ana','SOURCE'),('late','invented','QUOTE')]:
            o=copy.deepcopy(self.output);o['clauses'][0]['arguments'][0]['evidence']=[{'sourceId':sid,'quote':quote}]
            with self.assertRaisesRegex(RecordError,code):self.admit(o)
    def test_unchanged_disposition_cannot_hide_updates(self):
        o=copy.deepcopy(self.output);o['disposition']='no_change'
        with self.assertRaisesRegex(RecordError,'UNCHANGED_HAS_PATCH'):self.admit(o)
    def test_missing_mapping_and_duplicate_patch_rejected(self):
        o=copy.deepcopy(self.output);o['clauses'][0]['clauseId']='unknown'
        with self.assertRaisesRegex(RecordError,'CLAUSE_MAPPING'):self.admit(o)
        o=copy.deepcopy(self.output);o['clauses']*=2
        with self.assertRaisesRegex(RecordError,'CLAUSE_MAPPING'):self.admit(o)
    def test_renewed_fence_blocks_changed_and_no_change(self):
        def guard():raise RecordError('GENERATION_STALE_FENCE')
        self.records._afh_generation_guard=guard
        for output in [self.output,{'disposition':'no_change','reason':'same','summary':'','clauses':[]}]:
            with self.assertRaisesRegex(RecordError,'GENERATION_STALE_FENCE'):self.admit(output)
        self.assertEqual(len(self.records.history(self.first['id'],'scope')),1)
    def test_crash_after_record_commit_reconstructs_receipt_without_new_version(self):
        original_put=self.records.put
        def interrupted(*args,**kwargs):
            original_put(*args,**kwargs)
            raise RuntimeError('LOST_AFTER_RECORD_COMMIT')
        self.records.put=interrupted
        with self.assertRaisesRegex(RuntimeError,'LOST_AFTER_RECORD_COMMIT'):self.admit()
        self.records.put=original_put;result=self.admit();self.assertEqual(result['record']['version'],2);self.assertEqual(result,self.admit())
    def test_current_dependencies_are_bound_to_packet(self):
        payload=copy.deepcopy(self.first['payload']);payload['id']='dependency';payload.pop('semantic_unit');payload.pop('afh_mentions')
        r=self.records.put(payload,expected_version=0,request_id='dep1')
        packet=prepare(self.records,{'scope':'scope','id':self.first['id'],'newSourceIds':['late'],'sourceCut':'new-cut','eventId':'event','dependencyIds':['dependency']})
        payload['text']='Changed dependency';self.records.put(payload,expected_version=1,request_id='dep2')
        with self.assertRaisesRegex(RecordError,'STALE_REEVALUATION_DEPENDENCY'):self.admit(packet=packet)
    def test_empty_changed_and_reused_old_context_rejected(self):
        o=copy.deepcopy(self.output);o['clauses']=[]
        with self.assertRaisesRegex(RecordError,'CHANGED_EMPTY'):self.admit(o)
        o=copy.deepcopy(self.output);e=[{'sourceId':'original','quote':'Ella llegó.'}];o['clauses'][0]['evidence']=e;o['clauses'][0]['arguments'][0]['evidence']=e
        with self.assertRaisesRegex(RecordError,'NEW_CONTEXT_REQUIRED'):self.admit(o)
    def test_argument_witness_does_not_need_duplication_on_unchanged_predicate(self):
        o=copy.deepcopy(self.output);o['clauses'][0]['evidence']=[]
        result=self.admit(o);c=result['record']['payload']['semantic_unit']['clauses'][0]
        self.assertEqual(c['evidence_by_field']['/predicate'],self.first['payload']['semantic_unit']['clauses'][0]['evidence_by_field']['/predicate'])
        self.assertEqual(c['arguments'][0]['interpreted'],'Ana');self.assertEqual(c['evidence_by_field']['/resolution'][0]['source_id'],'late')
    def test_changed_predicate_cannot_borrow_argument_evidence_implicitly(self):
        o=copy.deepcopy(self.output);o['clauses'][0].update(predicate='salir',evidence=[])
        with self.assertRaisesRegex(RecordError,'PREDICATE_EVIDENCE_REQUIRED'):self.admit(o)

if __name__=='__main__':unittest.main()

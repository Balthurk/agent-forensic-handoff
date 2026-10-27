import sys,unittest,tempfile,copy,hashlib,json,sqlite3,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from afh_semantic.host import AFHMemory,compile_act,manifest,query_records,prepare_review,admit_review,correct,digest
from afh_semantic.knowledge_records import KnowledgeRecords,RecordError,approval_statement

def source(id,text,conversation='A',role='user'):
    sha=hashlib.sha256(text.encode()).hexdigest()
    return {'id':id,'revision':sha,'payload_sha256':sha,'representation_id':id,'occurrence_id':'occ-'+id,'source_conversation_id':conversation,'text':text,'text_sha256':sha,'record_sha256':sha,'role':role,'verified':True,'coordinate_space':'AFH-representation-text-v1'}

class SemanticTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.sources=[source('rep-a','Ana permite staging si pasa QA. Producción está prohibida.'),source('rep-b','Revoco sólo staging; producción sigue prohibida.','B'),source('rep-c','Ana decide esperar.','C'),source('rep-d','Sí, eso.','D')]
        self.memory=AFHMemory(self.root,self.sources,'scope',register=True);self.records=KnowledgeRecords(self.memory,self.root/'records.sqlite3')
    def tearDown(self):self.records.close();self.memory.close();self.tmp.cleanup()
    def act(self,which=0):
        s=self.sources[which];quote=s['text'];e=[{'sourceId':s['id'],'quote':quote}]
        return {'key':'rule','targetSourceId':s['id'],'type':'policy','summary':quote,'modality':'directive','clauses':[{'key':'clause','quote':quote,'predicate':'permits','polarity':'positive','resolution':'resolved','arguments':[{'role':'subject','literal':'Ana','interpreted':'','evidence':e}], 'conditions':[],'temporal':[],'relations':[]}]}
    def payload(self,which=0):return compile_act(self.memory,self.act(which),'producer','cut-1')
    def put(self,which=0):return self.records.put(self.payload(which),expected_version=0,request_id='req-'+str(which))
    def error(self,code,fn):
        with self.assertRaisesRegex((RecordError,ValueError,sqlite3.IntegrityError),code):fn()
    def test_cas_idempotency_unknown_fields(self):
        p=self.payload();p['extension']={'arbitrary':['kept',{'x':1}]};a=self.records.put(p,expected_version=0,request_id='same');b=self.records.put(p,expected_version=0,request_id='same');self.assertEqual(a,b)
        self.error('IDEMPOTENCY_CONFLICT',lambda:self.records.put({**p,'text':'other'},expected_version=0,request_id='same'))
        self.error('VERSION_CONFLICT',lambda:self.records.put(p,expected_version=0,request_id='other'));self.assertEqual(a['payload']['extension'],p['extension'])
    def test_append_only_and_corruption(self):
        self.put();self.error('append only',lambda:self.records.db.execute('UPDATE record_versions SET version=3'))
    def test_explicit_coordinate_space(self):
        p=self.payload();p['semantic_unit']['target_ref']['locator']['source_encoding']='N01-evidence-text-v1';self.error('LOCATOR_UNSUPPORTED',lambda:self.records.put(p,expected_version=0,request_id='bad'))
    def test_bad_quote(self):
        a=self.act();a['clauses'][0]['arguments'][0]['evidence'][0]['quote']='Never said';self.error('QUOTE_AMBIGUOUS_OR_MISSING',lambda:compile_act(self.memory,a,'p','c'))
    def test_role_forgery(self):
        p=self.payload();p['semantic_unit']['issuer']['role']='assistant';self.error('ISSUER_ROLE',lambda:self.records.put(p,expected_version=0,request_id='bad'))
    def test_source_scope(self):
        p=self.payload();p['scope']='other';self.error('SOURCE_SCOPE_MISMATCH',lambda:self.records.put(p,expected_version=0,request_id='bad'))
    def test_fake_approval(self):
        p=self.payload();p['status']='approved';self.error('APPROVAL_REQUIRED',lambda:self.records.put(p,expected_version=0,request_id='bad'))
    def test_mechanical_validity_does_not_grant_support(self):
        r=self.put();q=query_records(self.records,{'scope':'scope','question':'staging'});self.assertTrue(q['requiresAbstention']);self.assertEqual(q['items'][0]['support'],'pending_or_rejected')
    def test_no_backdating(self):
        r=self.put();self.assertGreater(r['recorded_at'],'2026-10-01');q=query_records(self.records,{'scope':'scope','question':'staging','knownAt':'2026-01-01T00:00:00Z'});self.assertEqual(q['items'],[])
    def test_temporal_unknown_does_not_mean_valid(self):
        self.put();q=query_records(self.records,{'scope':'scope','question':'staging','validAt':'2026-10-21T00:00:00Z'});self.assertEqual(q['items'][0]['validity'],'unknown');self.assertTrue(q['requiresAbstention'])
    def test_pronoun_requires_antecedent(self):
        a=self.act(3);a['clauses'][0]['arguments'][0].update(literal='eso',interpreted='desplegar producción');p=compile_act(self.memory,a,'p','cut');c=p['semantic_unit']['clauses'][0];self.assertEqual(c['resolution'],'insufficient_context');self.assertNotIn('interpreted',c['arguments'][0])
    def test_homonyms_separate(self):
        a=self.payload(0);b=self.payload(2);self.assertNotEqual(a['afh_mentions'][0]['entity_candidate_id'],b['afh_mentions'][0]['entity_candidate_id'])
    def test_reimport_does_not_add_support(self):
        self.put();self.records.close();self.memory.close();self.memory=AFHMemory(self.root,self.sources,'scope',register=True);self.records=KnowledgeRecords(self.memory,self.root/'records.sqlite3');self.assertEqual(self.memory.db.execute('SELECT count(*) FROM source_bindings').fetchone()[0],4);self.assertEqual(query_records(self.records,{'scope':'scope','question':'staging'})['independentOccurrences'],1)
    def test_partial_correction_preserves_other_clause_and_extensions(self):
        a=self.act();b=copy.deepcopy(a['clauses'][0]);b['key']='second';b['predicate']='forbids';a['clauses'].append(b)
        p=compile_act(self.memory,a,'p','cut');p['custom']={'opaque':42};r=self.records.put(p,expected_version=0,request_id='first');p=copy.deepcopy(r['payload']);old=copy.deepcopy(p['semantic_unit']['clauses'][1]);c=p['semantic_unit']['clauses'][0];c['predicate']['value']='reports_permission';c['clause_version_id']='cv-corrected';manifest(p['semantic_unit'])
        new=correct(self.records,{'id':p['id'],'scope':'scope','expectedVersion':1,'payload':p,'requestId':'correction'});self.assertEqual(new['payload']['semantic_unit']['clauses'][1],old);self.assertEqual(new['payload']['custom'],{'opaque':42});self.assertEqual(len(self.records.history(p['id'],'scope')),2)
        self.error('VERSION_CONFLICT',lambda:correct(self.records,{'id':p['id'],'scope':'scope','expectedVersion':1,'payload':p,'requestId':'stale'}))
    def test_missing_clause_correction_rejected(self):
        r=self.put();p=copy.deepcopy(r['payload']);p['semantic_unit']['clauses']=[];self.error('CLAUSE_MAPPING_REQUIRED',lambda:correct(self.records,{'id':p['id'],'scope':'scope','expectedVersion':1,'payload':p,'requestId':'bad'}))
    def linked(self,kind='retracts',target=None):
        a=self.put(0);b=self.payload(1);c=b['semantic_unit']['clauses'][0];vid=target or a['payload']['semantic_unit']['clauses'][0]['clause_version_id'];c['relations']=[{'kind':kind,'direction':'outgoing','status':'candidate','target_clause_version_id':vid,'evidence_keys':['/relations/0']}];c['evidence_by_field']['/relations/0']=copy.deepcopy(c['evidence_by_field']['/predicate']);c['clause_version_id']='cv-linked';manifest(b['semantic_unit']);r=self.records.put(b,expected_version=0,request_id='link');return a,r
    def test_incoming_revocation_is_retrieved(self):
        a,b=self.linked();vid=a['payload']['semantic_unit']['clauses'][0]['clause_version_id'];q=query_records(self.records,{'scope':'scope','question':'','roots':[vid]});self.assertEqual(len(q['items']),2);self.assertEqual(q['edges'][0]['kind'],'retracts')
    def test_unavailable_endpoint_is_explicit(self):
        a,b=self.linked(target='cv-missing');q=query_records(self.records,{'scope':'scope','question':'revoco'});self.assertTrue(q['missing']);self.assertTrue(q['requiresAbstention'])
    def test_hop_limit(self):self.error('HOP_LIMIT',lambda:query_records(self.records,{'scope':'scope','question':'','hops':4}))
    def test_root_budget_applies_even_without_traversal(self):
        r=self.put();vid=r['payload']['semantic_unit']['clauses'][0]['clause_version_id'];self.error('ROOT_BUDGET',lambda:query_records(self.records,{'scope':'scope','roots':[vid]*101,'hops':0}));self.error('ROOT_BUDGET',lambda:query_records(self.records,{'scope':'scope','question':'staging','limit':0}))
    def receipt(self,r,judgment='supported',reviewer='reviewer'):
        c=r['payload']['semantic_unit']['clauses'][0];packet=prepare_review(self.records,r['id'],'scope',c['semantic_clause_id']);raw=json.dumps({'kind':'n04.semantic-support-review.v1','reviewer':{'task_id':reviewer,'method':'independent_technical_review'},'request_sha256':packet['request_sha256'],'binding':packet['content']['binding'],'fields':[{'field_pointer':f['field_pointer'],'judgment':judgment,'reason':'Test receipt, not product review','evidence':f['evidence']} for f in packet['content']['fields']]});return packet,raw
    def test_review_receipt_exact_binding(self):
        r=self.put();packet,raw=self.receipt(r);v=admit_review(self.records,packet,raw,'reviewer','producer','support');q=query_records(self.records,{'scope':'scope','question':'staging'});self.assertEqual(q['items'][0]['support'],'supported');self.assertEqual(v['payload']['status'],'proposed');self.assertEqual(v,admit_review(self.records,packet,raw,'reviewer','producer','support'))
    def test_review_rejects_same_producer(self):
        r=self.put();packet,raw=self.receipt(r,reviewer='producer');self.error('REVIEWER_INDEPENDENCE',lambda:admit_review(self.records,packet,raw,'producer','producer','support'))
    def test_near_match_is_not_support(self):
        r=self.put();packet,raw=self.receipt(r,'near_match');admit_review(self.records,packet,raw,'reviewer','producer','support');self.assertTrue(query_records(self.records,{'scope':'scope','question':'staging'})['requiresAbstention'])
    def test_review_cannot_omit_a_field(self):
        r=self.put();packet,raw=self.receipt(r);raw=json.loads(raw);raw['fields'].pop();self.error('FIELD_COVERAGE',lambda:admit_review(self.records,packet,json.dumps(raw),'reviewer','producer','bad'))
    def test_corrupt_stored_payload_fails_closed(self):
        r=self.put();self.records.db.execute('DROP TRIGGER records_no_update');self.records.db.execute("UPDATE record_versions SET payload_sha256='bad'");self.records.db.commit();self.error('RECORD_CORRUPT',lambda:self.records.get(r['id'],'scope'))
    def test_date_without_zone_is_preserved_as_uncertain(self):
        a=self.act();e=[{'sourceId':'rep-a','quote':self.sources[0]['text']}];a['clauses'][0]['temporal']=[{'dimension':'event','status':'exact','literal':'date from model','value':'2026-10-20','evidence':e}];p=compile_act(self.memory,a,'p','cut');c=p['semantic_unit']['clauses'][0];self.assertEqual(c['temporal'][0]['status'],'ambiguous');self.assertNotIn('value',c['temporal'][0]);self.assertEqual(c['afh_temporal_unparsed'][0]['value'],'2026-10-20');self.records.put(p,expected_version=0,request_id='uncertain')
    def test_empty_arguments_preserve_literal_without_inventing_subject(self):
        a=self.act();a['clauses'][0]['arguments']=[];p=compile_act(self.memory,a,'p','cut');arg=p['semantic_unit']['clauses'][0]['arguments'][0];self.assertEqual(arg['role'],'literal_content');self.assertEqual(arg['literal'],self.sources[0]['text']);self.assertNotIn('interpreted',arg)
    def test_known_cut_and_partial_correction_replay(self):
        from datetime import datetime, timezone, timedelta
        from unittest.mock import patch
        first_at=datetime(2026,10,27,8,0,tzinfo=timezone.utc)
        correction_at=first_at+timedelta(microseconds=1)
        # knownAt is inclusive wall time, not a unique commit/version token.
        # Control the two distinct instants this historical-cut oracle requires.
        with patch('afh_semantic.knowledge_records.datetime') as clock:
            clock.now.side_effect=[first_at,correction_at]
            r=self.put();p=copy.deepcopy(r['payload']);c=p['semantic_unit']['clauses'][0]
            c['predicate']['value']='claims_permission';c['clause_version_id']='cv-history'
            manifest(p['semantic_unit'])
            request={'id':r['id'],'scope':'scope','expectedVersion':1,'payload':p,'requestId':'correction'}
            new=correct(self.records,request)
            self.assertEqual(new,correct(self.records,request))
            self.assertEqual(clock.now.call_count,2)
        self.assertEqual(r['recorded_at'],first_at.isoformat(timespec='microseconds'))
        self.assertEqual(new['recorded_at'],correction_at.isoformat(timespec='microseconds'))
        q=query_records(self.records,{'scope':'scope','question':'staging','knownAt':r['recorded_at']})
        self.assertEqual(q['items'][0]['predicate'],'permits')
        self.assertEqual(query_records(self.records,{'scope':'scope','question':'staging'})['items'][0]['predicate'],'claims_permission')
    def test_unselected_latest_does_not_fall_back_to_old_current(self):
        r=self.put();p=copy.deepcopy(r['payload']);p['source_refs'].append({'id':'rep-b','revision':self.sources[1]['revision']});self.records.put(p,expected_version=1,request_id='new-source');self.memory.sources.pop('rep-b');q=query_records(self.records,{'scope':'scope','question':'staging'});self.assertEqual(q['items'],[]);self.assertTrue(q['limitations'])
    def test_precise_validity_bounds(self):
        p=self.payload();c=p['semantic_unit']['clauses'][0];bounds={'relation':'closed_interval','lower':{'value':'2026-10-01T00:00:00Z','inclusive':True,'precision':'instant','zone':{'kind':'utc_offset','offset_minutes':0}},'upper':{'value':'2026-10-10T00:00:00Z','inclusive':False,'precision':'instant','zone':{'kind':'utc_offset','offset_minutes':0}}};c['temporal']=[{'dimension':'validity','status':'exact','literal':'bounded test','bounds':bounds,'evidence_keys':['/temporal/0/bounds']}]
        for field in ['dimension','status','literal','bounds']:c['evidence_by_field']['/temporal/0/'+field]=copy.deepcopy(c['evidence_by_field']['/predicate'])
        manifest(p['semantic_unit']);self.records.put(p,expected_version=0,request_id='bounds');q=query_records(self.records,{'scope':'scope','question':'staging','validAt':'2026-10-05T00:00:00Z'});self.assertEqual(q['items'][0]['validity'],'inside');q=query_records(self.records,{'scope':'scope','question':'staging','validAt':'2026-10-10T00:00:00Z'});self.assertEqual(q['items'][0]['validity'],'outside')
    def test_offset_is_preserved(self):
        a=self.act();a['clauses'][0]['temporal']=[{'dimension':'event','status':'exact','literal':'source assertion','value':'2026-10-20T13:30:00+02:00','evidence':[{'sourceId':'rep-a','quote':self.sources[0]['text']}]}];p=compile_act(self.memory,a,'p','c');self.assertEqual(p['semantic_unit']['clauses'][0]['temporal'][0]['zone']['offset_minutes'],120)
    def test_explicit_historical_root_remains_queryable(self):
        r=self.put();old=r['payload']['semantic_unit']['clauses'][0]['clause_version_id'];p=copy.deepcopy(r['payload']);c=p['semantic_unit']['clauses'][0];c['predicate']['value']='revised';c['clause_version_id']='cv-new';manifest(p['semantic_unit']);self.records.put(p,expected_version=1,request_id='new');q=query_records(self.records,{'scope':'scope','question':'','roots':[old]});self.assertEqual(len(q['items']),1);self.assertFalse(q['items'][0]['currentAtCut'])
    def test_zero_hops_reports_omitted_revocation(self):
        a,b=self.linked();q=query_records(self.records,{'scope':'scope','roots':[a['payload']['semantic_unit']['clauses'][0]['clause_version_id']],'hops':0});self.assertEqual(len(q['items']),1);self.assertTrue(q['missing']);self.assertTrue(q['requiresAbstention'])
    def test_attribution_requires_text(self):
        r=self.put();self.error('CORRECTION_ATTRIBUTION',lambda:correct(self.records,{'id':r['id'],'scope':'scope','expectedVersion':1,'payload':r['payload'],'requestId':'bad','editor':{'id':'fake'}}))
    def test_targeted_user_approval(self):
        p=self.payload();p['status']='approved';p['actor']={'id':'declared-local-user','role':'user'};statement=approval_statement(p);s=source('rep-approval',statement,role='user');self.memory.close();self.memory=AFHMemory(self.root,self.sources+[s],'scope',register=True);self.records.memory=self.memory;p['approval']={'source_ref':{'id':s['id'],'revision':s['revision']},'quote':statement};r=self.records.put(p,expected_version=0,request_id='approval');self.assertEqual(r['payload']['status'],'approved');p['text']='changed';self.error('APPROVAL_REQUIRED',lambda:self.records.put(p,expected_version=1,request_id='changed'))
if __name__=='__main__':unittest.main(verbosity=2)

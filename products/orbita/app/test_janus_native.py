"""Mandatory real Janus tests. Missing services/configuration are failures, never skips."""
import copy,datetime,hashlib,json,os,pathlib,sqlite3,sys,tempfile,unittest,uuid
P=pathlib.Path(__file__).resolve().parents[1]/'agent-forensic-handoff/python';sys.path.insert(0,str(P))
from afh_semantic.host import AFHMemory,compile_act,manifest,correct
from afh_semantic.knowledge_records import KnowledgeRecords,RecordError
from afh_semantic.graph_publication import dispatch_graph,latest,plan,Projection,digest
from afh_semantic.janus_client import Janus,binding,READ,READ_BATCH
from afh_semantic.janus_publication import Ledger
from test_semantic import source

SETTINGS=json.loads(pathlib.Path(os.environ['AFH_G1_JANUS_TEST_CONFIG']).read_text())
class JanusTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=SETTINGS['testRoot']);self.root=pathlib.Path(self.tmp.name)/'data';self.semantic=self.root/'semantic';self.semantic.mkdir(parents=True)
  self.sources=[source('a','Regla sintética: conservar el original.'),source('b','Retiro esa regla si el original fue revocado.','B'),source('c','La vigencia debe comprobarse.','C')]
  self.memory=AFHMemory(self.semantic,self.sources,'scope',register=True);self.r=KnowledgeRecords(self.memory,self.semantic/'records.sqlite3');self.cfg=pathlib.Path(self.tmp.name)/'config.json'
  self.settings={'schema':1,'endpoints':SETTINGS['endpoints'],'roots':{str(self.root):{'namespace':uuid.uuid4().hex,'active':True}}};self.savecfg();self.old=os.environ.get('AFH_G1_JANUS_CONFIG');os.environ['AFH_G1_JANUS_CONFIG']=str(self.cfg)
  self.put(0);self.put(1);self.request={'outboxId':latest(self.r,'scope')['outbox_id']};self.client=Janus(binding(self.r))
 def savecfg(self):self.cfg.write_text(json.dumps(self.settings))
 def tearDown(self):
  self.r.close();self.memory.close()
  if self.old is None:os.environ.pop('AFH_G1_JANUS_CONFIG',None)
  else:os.environ['AFH_G1_JANUS_CONFIG']=self.old
  self.tmp.cleanup()
 def put(self,i):
  s=self.sources[i];act={'key':'r'+str(i),'targetSourceId':s['id'],'type':'policy','summary':s['text'],'modality':'directive','clauses':[{'key':'c','quote':s['text'],'predicate':'conservar_original','polarity':'negative' if i==1 else 'positive','resolution':'resolved','arguments':[],'conditions':[],'temporal':[],'relations':[]}]}
  p=compile_act(self.memory,act,'synthetic-tests','cut')
  if i==1:
   first=self.r.get(self.first['id'],'scope');c=p['semantic_unit']['clauses'][0];c['relations']=[{'kind':'retracts','direction':'outgoing','status':'candidate','target_clause_version_id':first['payload']['semantic_unit']['clauses'][0]['clause_version_id'],'evidence_keys':['/relations/0']}];c['evidence_by_field']['/relations/0']=copy.deepcopy(c['evidence_by_field']['/predicate']);manifest(p['semantic_unit'])
  r=self.r.put(p,expected_version=0,request_id='put'+str(i))
  if i==0:self.first=r
  return r
 def op(self,op,**kw):return dispatch_graph(self.r,{'scope':'scope','op':'graph_'+op,'backend':'janusgraph',**kw})
 def publish(self):return self.op('publish',**self.request)
 def query(self,r,**kw):return self.op('query',generation=r['generation'],sourceCut=r['sourceCut'],**kw)
 def error(self,code,fn):
  with self.assertRaisesRegex((RecordError,ValueError),code):fn()
 def mutate(self,script,values):
  return self.client.request(SETTINGS['endpoints'][0],"try {"+script+";graph.tx().commit();return groovy.json.JsonOutput.toJson(true)} finally {graph.tx().rollback()}",values)
 def test_actual_two_readers_whole_objects_edges_originals(self):
  r=self.publish();q=self.query(r);local=dispatch_graph(self.r,dict(op='graph_query',scope='scope',generation=r['generation'],sourceCut=r['sourceCut']))
  self.assertEqual(q['items'],local['items']);self.assertEqual(len(q['items']),2);self.assertEqual(q['items'][0]['relations'][0]['value']['kind'],'retracts');self.assertTrue(q['requiresAbstention']);self.assertFalse(q['policy']['executionAuthority']);self.assertEqual(len(q['remoteVerification']['receipt']['readbackHashes']),2)
  record=q['items'][0]['record'];original=self.op('original',generation=r['generation'],sourceCut=r['sourceCut'],recordId=record['id'],sourceId=record['payload']['source_refs'][0]['id']);self.assertIn(original['source']['text'],[s['text'] for s in self.sources]);self.assertIn('Not asserted',q['remoteVerification']['historicalAvailability'])
 def test_replay_uses_same_receipt_and_generation(self):
  a=self.publish();b=self.publish();self.assertEqual(a['remoteReceipt'],b['remoteReceipt']);self.assertTrue(b['replayed']);self.assertEqual(a['generation'],b['generation'])
 def test_unpublished_remote_never_falls_back(self):
  r=dispatch_graph(self.r,dict(op='graph_publish',scope='scope',**self.request));self.error('RECEIPT_MISSING',lambda:self.query(r))
 def test_local_query_ignores_unavailable_remote_configuration(self):
  r=self.publish();self.cfg.unlink();q=dispatch_graph(self.r,dict(op='graph_query',scope='scope',generation=r['generation'],sourceCut=r['sourceCut']));self.assertEqual(len(q['items']),2);self.error('CONFIG_UNAVAILABLE',lambda:self.query(r))
 def test_old_generation_cannot_be_presented_current(self):
  old=self.publish();self.put(2);self.error('CURRENT_PROJECTION_PENDING',lambda:self.query(old));self.request={'outboxId':latest(self.r,'scope')['outbox_id']};new=self.publish();self.error('CURRENT_GENERATION',lambda:self.query(old));self.assertEqual(self.query(new)['totalMembers'],3)
 def test_history_is_n04_history_checked_against_mirror_now(self):
  r=self.publish();q=self.query(r);self.put(2);hist=self.query(r,mode='system_history',knownAt=q['selectedAt']);self.assertEqual(hist['items'],q['items']);self.assertGreater(hist['remoteVerification']['readAt'],hist['selectedAt'])
 def test_current_permissions_are_required_for_history(self):
  r=self.publish();at=self.query(r)['selectedAt'];self.memory.sources.pop('a');self.error('SOURCE_SCOPE',lambda:self.query(r,mode='system_history',knownAt=at))
 def test_payload_corruption_rejected(self):
  r=self.publish();p=plan(self.r,self.request['outboxId']);uid=self.client.objects(p)[0]['uid'];self.mutate("g.V().has('orbitaUid',uid).property('orbitaPayload','{}').iterate()",{'uid':uid});self.error('READBACK_MISMATCH',lambda:self.query(r))
 def test_marker_corruption_rejected(self):
  r=self.publish();p=plan(self.r,self.request['outboxId']);uid=self.client.objects(p,True)[-1]['uid'];self.mutate("g.V().has('orbitaUid',uid).property('orbitaPayload','{}').iterate()",{'uid':uid});self.error('READBACK_MISMATCH',lambda:self.query(r))
 def test_actual_structural_link_loss_rejected(self):
  r=self.publish();p=plan(self.r,self.request['outboxId']);self.mutate("g.V().has('orbitaGroup',group).outE('orbita_to').limit(1).drop().iterate()",{'group':self.client.group(p)});self.error('READBACK_MISMATCH',lambda:self.query(r))
 def test_extra_vertex_rejected(self):
  r=self.publish();p=plan(self.r,self.request['outboxId']);self.mutate("graph.addVertex(org.apache.tinkerpop.gremlin.structure.T.label,'orbitaObject','orbitaUid',uid,'orbitaGroup',group,'orbitaKind','extra','orbitaKey','extra','orbitaPayload','{}')",{'uid':uuid.uuid4().hex,'group':self.client.group(p)});self.error('READBACK_MISMATCH',lambda:self.query(r))
 def test_foreign_incoming_link_cannot_invent_relationship(self):
  r=self.publish();p=plan(self.r,self.request['outboxId']);target=self.client.objects(p)[0]['uid'];uid=uuid.uuid4().hex
  self.mutate("def v=graph.addVertex(org.apache.tinkerpop.gremlin.structure.T.label,'orbitaObject','orbitaUid',uid,'orbitaGroup',group,'orbitaKind','foreign','orbitaKey','foreign','orbitaPayload','{}');v.addEdge('orbita_to',g.V().has('orbitaUid',target).next())",{'uid':uid,'group':'foreign-'+uid,'target':target});self.error('READBACK_MISMATCH',lambda:self.query(r))
 def test_configuration_inside_data_cannot_grant_external_access(self):
  inside=self.root/'connection.json';inside.write_bytes(self.cfg.read_bytes());os.environ['AFH_G1_JANUS_CONFIG']=str(inside);self.error('CONFIG_',self.publish);self.assertEqual(latest(self.r,'scope')['state'],'planned')
 def test_membership_change_during_bounded_readback_is_rejected(self):
  self.publish();p=plan(self.r,self.request['outboxId']);original=self.client.request;changed=False
  def request(endpoint,script,values):
   nonlocal changed
   result=original(endpoint,script,values)
   if script==READ_BATCH and not changed:
    changed=True
    self.mutate("graph.addVertex(org.apache.tinkerpop.gremlin.structure.T.label,'orbitaObject','orbitaUid',uid,'orbitaGroup',group,'orbitaKind','extra','orbitaKey','extra','orbitaPayload','{}')",{'uid':uuid.uuid4().hex,'group':self.client.group(p)})
   return result
  self.client.request=request;self.error('MEMBERSHIP_CHANGED',lambda:self.client.verify(p));self.assertTrue(changed)
 def test_receipt_corruption_rejected(self):
  r=self.publish();l=Ledger(self.r,binding(self.r),True)
  with l.db:l.db.execute("UPDATE receipts SET payload='{}'")
  l.close();self.error('RECEIPT_CORRUPT',lambda:self.query(r))
 def test_selector_loss_rejected(self):
  r=self.publish();l=Ledger(self.r,binding(self.r),True)
  with l.db:l.db.execute('DELETE FROM selectors')
  l.close();self.error('SELECTOR_MISMATCH',lambda:self.query(r))
 def test_copied_root_not_admitted(self):
  self.settings['roots']={str(self.root)+'-copy':next(iter(self.settings['roots'].values()))};self.savecfg();self.error('ROOT_NOT_ADMITTED',self.publish);self.assertEqual(latest(self.r,'scope')['state'],'planned')
 def test_config_identity_change_cannot_reuse_receipt(self):
  r=self.publish();self.settings['roots'][str(self.root)]['namespace']=uuid.uuid4().hex;self.savecfg();self.error('SELECTOR_MISMATCH',lambda:self.query(r))
 def test_restore_paused_before_config_and_no_rights_from_content(self):
  r=self.publish();pause=self.root.parent/('.'+self.root.name+'.orbita-restore.json');pause.write_text(json.dumps({'externalAccess':False}));self.cfg.unlink();self.error('EXTERNAL_ACCESS_PAUSED',lambda:self.query(r));pause.unlink()
 def test_managed_not_admitted(self):
  old=os.environ.get('AFH_MANAGED');os.environ['AFH_MANAGED']='1'
  try:self.error('MANAGED_NOT_ADMITTED',self.publish)
  finally:
   if old is None:os.environ.pop('AFH_MANAGED',None)
   else:os.environ['AFH_MANAGED']=old
 def test_endpoint_injection_and_public_hosts_denied(self):
  for bad in ['https://127.0.0.1:18184/gremlin','http://example.com/gremlin','http://127.0.0.1:18184/gremlin?x=1','http://user@127.0.0.1:18184/gremlin','http://127.0.0.1:18184/other']:
   self.settings['endpoints']=[bad,SETTINGS['endpoints'][1]];self.savecfg();self.error('ENDPOINT_INVALID',self.publish)
 def test_single_reader_not_qualified(self):
  self.settings['endpoints']=[SETTINGS['endpoints'][0]];self.savecfg();self.error('TWO_READERS',self.publish)
 def test_configuration_is_not_health_or_acceptance(self):
  r=dispatch_graph(self.r,dict(op='graph_capabilities',scope='scope'));self.assertTrue(r['configured']);self.assertFalse(r['verified']);self.assertFalse(r['humanAcceptance']);self.assertFalse(r['automaticPromotion'])
 def test_expired_claim_cannot_select_and_replacement_increases_fence(self):
  self.publish();l=Ledger(self.r,binding(self.r),True);claim=l.claim('scope')
  with l.db:l.db.execute('UPDATE claims SET expires=0')
  self.error('STALE_FENCE',lambda:claim.check(l.db));replacement=l.claim('scope');self.assertGreater(replacement.fence,claim.fence);claim.close();replacement.check(l.db);replacement.close();l.close()
 def test_concurrent_claim_cannot_steal_live_owner(self):
  self.publish();l=Ledger(self.r,binding(self.r),True);claim=l.claim('scope')
  try:self.error('WRITER_BUSY',lambda:l.claim('scope'))
  finally:claim.close();l.close()
 def test_small_page_omits_whole_act_not_clauses(self):
  r=self.publish();q=self.query(r,maxBytes=4096);self.assertEqual(q['items'],[]);self.assertTrue(q['omissions']);self.assertLessEqual(len(json.dumps(q).encode()),4096)

if __name__=='__main__':
 suite=unittest.defaultTestLoader.loadTestsFromTestCase(JanusTest);result=unittest.TextTestRunner(stream=sys.stderr,verbosity=2).run(suite)
 print(json.dumps({'status':'PASS' if result.wasSuccessful() else 'FAIL','tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped)}));sys.exit(not result.wasSuccessful())

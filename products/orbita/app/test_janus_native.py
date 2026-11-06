"""Port of all26 real mirror oracles to the common PostgreSQL protocol."""
import contextlib,copy,datetime,hashlib,json,os,pathlib,sys,unittest,uuid
from unittest.mock import patch
P=pathlib.Path(__file__).resolve().parents[1]/'agent-forensic-handoff/python';sys.path.insert(0,str(P))
from afh_semantic.host import AFHMemory,compile_act,manifest,correct
from afh_semantic.knowledge_records import KnowledgeRecords,RecordError
from afh_semantic.graph_publication import dispatch_graph,latest,plan,Projection,digest
from afh_semantic.graph_mirror import CommonGraph as Janus,binding,READ,READ_BATCH
from orbita_store.paths import Path as CommonPath
from common_test_fixture import WorkspaceFixture
from orbita_store import StoreError
from orbita_store.connection import Connection
from orbita_store.pool import close_idle
from afh_semantic.graph_mirror_publication import Ledger
from test_semantic import source

SETTINGS={'endpoints':['reader:0','reader:1']}
class JanusTest(unittest.TestCase):
 def setUp(self):
  self.tmp=WorkspaceFixture(self.id());self.root=CommonPath(self.tmp.name)/'data';self.semantic=self.root/'semantic';self.semantic.mkdir(parents=True)
  self.sources=[source('a','Regla sintética: conservar el original.'),source('b','Retiro esa regla si el original fue revocado.','B'),source('c','La vigencia debe comprobarse.','C')]
  self.memory=AFHMemory(self.semantic,self.sources,'scope',register=True);self.r=KnowledgeRecords(self.memory,self.semantic/'records.pgstore');self.cfg=CommonPath(self.tmp.name)/'legacy-config.json'
  self.settings={'schema':1,'endpoints':SETTINGS['endpoints'],'roots':{str(self.root):{'namespace':uuid.uuid4().hex,'active':True}}};self.savecfg();self.old=os.environ.get('AFH_G1_JANUS_CONFIG');os.environ['AFH_G1_JANUS_CONFIG']=str(self.cfg)
  self.put(0);self.put(1);self.request={'outboxId':latest(self.r,'scope')['outbox_id']};self.client=Janus(binding(self.r))
 def savecfg(self):self.cfg.write_text(json.dumps(self.settings))
 def tearDown(self):
  self.r.close();self.memory.close()
  if self.old is None:os.environ.pop('AFH_G1_JANUS_CONFIG',None)
  else:os.environ['AFH_G1_JANUS_CONFIG']=self.old
  close_idle();self.tmp.cleanup()
 def put(self,i):
  s=self.sources[i];act={'key':'r'+str(i),'targetSourceId':s['id'],'type':'policy','summary':s['text'],'modality':'directive','clauses':[{'key':'c','quote':s['text'],'predicate':'conservar_original','polarity':'negative' if i==1 else 'positive','resolution':'resolved','arguments':[],'conditions':[],'temporal':[],'relations':[]}]}
  p=compile_act(self.memory,act,'synthetic-tests','cut')
  if i==1:
   first=self.r.get(self.first['id'],'scope');c=p['semantic_unit']['clauses'][0];c['relations']=[{'kind':'retracts','direction':'outgoing','status':'candidate','target_clause_version_id':first['payload']['semantic_unit']['clauses'][0]['clause_version_id'],'evidence_keys':['/relations/0']}];c['evidence_by_field']['/relations/0']=copy.deepcopy(c['evidence_by_field']['/predicate']);manifest(p['semantic_unit'])
  r=self.r.put(p,expected_version=0,request_id='put'+str(i))
  if i==0:self.first=r
  return r
 def op(self,op,**kw):return dispatch_graph(self.r,{'scope':'scope','op':'graph_'+op,'backend':'postgresql-verified',**kw})
 def publish(self):return self.op('publish',**self.request)
 def query(self,r,**kw):return self.op('query',generation=r['generation'],sourceCut=r['sourceCut'],**kw)
 def error(self,code,fn):
  with self.assertRaisesRegex((RecordError,ValueError,StoreError),code):fn()
 def mutate(self,operation,values):
  with contextlib.closing(self.client.connection(write=True)) as db,db:
   if operation=='payload':db.execute("UPDATE objects SET payload='{}' WHERE uid=?",(values['uid'],))
   elif operation=='drop-link':
    owner,label=db.execute("SELECT l.owner_uid,l.label FROM links l JOIN objects o ON l.owner_uid=o.uid WHERE o.group_id=? AND l.label='orbita_to' ORDER BY l.owner_uid LIMIT 1",(values['group'],)).fetchone();db.execute('DELETE FROM links WHERE owner_uid=? AND label=?',(owner,label))
   elif operation in ('extra','incoming'):
    db.execute('INSERT INTO objects VALUES(?,?,?,?,?)',(values['uid'],values['group'],'extra',values['uid'],'{}'))
    if operation=='incoming':db.execute('INSERT INTO links VALUES(?,?,?)',(values['uid'],'orbita_to',values['target']))
   else:raise AssertionError('undeclared synthetic mutation')
 def test_actual_two_readers_whole_objects_edges_originals(self):
  r=self.publish();q=self.query(r);local=dispatch_graph(self.r,dict(op='graph_query',scope='scope',generation=r['generation'],sourceCut=r['sourceCut']))
  self.assertEqual(q['items'],local['items']);self.assertEqual(len(q['items']),2);self.assertEqual(q['items'][0]['relations'][0]['value']['kind'],'retracts');self.assertTrue(q['requiresAbstention']);self.assertFalse(q['policy']['executionAuthority']);self.assertEqual(len(q['remoteVerification']['receipt']['readbackHashes']),2)
  record=q['items'][0]['record'];original=self.op('original',generation=r['generation'],sourceCut=r['sourceCut'],recordId=record['id'],sourceId=record['payload']['source_refs'][0]['id']);self.assertIn(original['source']['text'],[s['text'] for s in self.sources]);self.assertIn('Not asserted',q['remoteVerification']['historicalAvailability'])
 def test_replay_uses_same_receipt_and_generation(self):
  a=self.publish();b=self.publish();self.assertEqual(a['remoteReceipt'],b['remoteReceipt']);self.assertTrue(b['replayed']);self.assertEqual(a['generation'],b['generation'])
 def test_unpublished_remote_never_falls_back(self):
  r=dispatch_graph(self.r,dict(op='graph_publish',scope='scope',**self.request));self.error('RECEIPT_MISSING',lambda:self.query(r))
 def test_local_query_ignores_unavailable_remote_configuration(self):
  r=self.publish();self.cfg.unlink();q=dispatch_graph(self.r,dict(op='graph_query',scope='scope',generation=r['generation'],sourceCut=r['sourceCut']));self.assertEqual(len(q['items']),2)
  self.error('NOT_QUALIFIED',lambda:dispatch_graph(self.r,dict(op='graph_query',scope='scope',generation=r['generation'],sourceCut=r['sourceCut'],backend='janusgraph')))
  previous=os.environ.pop('ORBITA_POSTGRES_BINDING')
  try:self.error('EXACTLY_ONE_CONFIG_REQUIRED',lambda:self.query(r))
  finally:os.environ['ORBITA_POSTGRES_BINDING']=previous
  self.assertEqual(len(self.query(r)['items']),2)
 def test_old_generation_cannot_be_presented_current(self):
  old=self.publish();self.put(2);self.error('CURRENT_PROJECTION_PENDING',lambda:self.query(old));self.request={'outboxId':latest(self.r,'scope')['outbox_id']};new=self.publish();self.error('CURRENT_GENERATION',lambda:self.query(old));self.assertEqual(self.query(new)['totalMembers'],3)
 def test_history_is_n04_history_checked_against_mirror_now(self):
  r=self.publish();q=self.query(r);self.put(2);hist=self.query(r,mode='system_history',knownAt=q['selectedAt']);self.assertEqual(hist['items'],q['items']);self.assertGreater(hist['remoteVerification']['readAt'],hist['selectedAt'])
 def test_current_permissions_are_required_for_history(self):
  r=self.publish();at=self.query(r)['selectedAt'];self.memory.sources.pop('a');self.error('SOURCE_SCOPE',lambda:self.query(r,mode='system_history',knownAt=at))
 def test_payload_corruption_rejected(self):
  r=self.publish();p=plan(self.r,self.request['outboxId']);uid=self.client.objects(p)[0]['uid'];self.mutate('payload',{'uid':uid});self.error('READBACK_MISMATCH',lambda:self.query(r))
 def test_marker_corruption_rejected(self):
  r=self.publish();p=plan(self.r,self.request['outboxId']);uid=self.client.objects(p,True)[-1]['uid'];self.mutate('payload',{'uid':uid});self.error('READBACK_MISMATCH',lambda:self.query(r))
 def test_actual_structural_link_loss_rejected(self):
  r=self.publish();p=plan(self.r,self.request['outboxId']);self.mutate('drop-link',{'group':self.client.group(p)});self.error('READBACK_MISMATCH',lambda:self.query(r))
 def test_extra_vertex_rejected(self):
  r=self.publish();p=plan(self.r,self.request['outboxId']);self.mutate('extra',{'uid':uuid.uuid4().hex,'group':self.client.group(p)});self.error('READBACK_MISMATCH',lambda:self.query(r))
 def test_foreign_incoming_link_cannot_invent_relationship(self):
  r=self.publish();p=plan(self.r,self.request['outboxId']);target=self.client.objects(p)[0]['uid'];uid=uuid.uuid4().hex
  self.mutate('incoming',{'uid':uid,'group':'foreign-'+uid,'target':target});self.error('READBACK_MISMATCH',lambda:self.query(r))
 def test_configuration_inside_data_cannot_grant_external_access(self):
  inside=self.root/'connection.json';inside.write_bytes(self.cfg.read_bytes());os.environ['AFH_G1_JANUS_CONFIG']=str(inside)
  self.error('NOT_QUALIFIED',lambda:dispatch_graph(self.r,dict(op='graph_publish',scope='scope',backend='janusgraph',**self.request)))
  self.assertEqual(latest(self.r,'scope')['state'],'planned')
 def test_membership_change_during_bounded_readback_is_rejected(self):
  self.publish();p=plan(self.r,self.request['outboxId']);original=self.client.request;changed=False
  def request(endpoint,script,values):
   nonlocal changed
   result=original(endpoint,script,values)
   if script==READ_BATCH and not changed:
    changed=True
    self.mutate('extra',{'uid':uuid.uuid4().hex,'group':self.client.group(p)})
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
  copied=pathlib.Path(self.tmp.name+'-copy')/'data/semantic/records.pgstore'
  self.error('PATH_NOT_BOUND',lambda:Connection(copied,family='semantic',config=self.r.db.config,create=True))
  self.assertEqual(latest(self.r,'scope')['state'],'planned');self.assertFalse(pathlib.Path(self.tmp.name+'-copy').exists())
 def test_config_identity_change_cannot_reuse_receipt(self):
  r=self.publish();prior=os.environ['ORBITA_POSTGRES_BINDING'];changed=json.loads(prior);changed['instanceId']=str(uuid.uuid4());os.environ['ORBITA_POSTGRES_BINDING']=json.dumps(changed)
  try:self.error('INSTANCE_MISMATCH',lambda:self.query(r))
  finally:os.environ['ORBITA_POSTGRES_BINDING']=prior
  self.assertEqual(self.publish()['remoteReceipt'],r['remoteReceipt'])
 def test_restore_paused_before_config_and_no_rights_from_content(self):
  r=self.publish();pause=self.root.parent/('.'+self.root.name+'.orbita-restore.json');pause.write_text(json.dumps({'externalAccess':False}));self.cfg.unlink()
  self.error('NOT_QUALIFIED',lambda:dispatch_graph(self.r,dict(op='graph_query',scope='scope',generation=r['generation'],sourceCut=r['sourceCut'],backend='janusgraph')))
  self.assertEqual(len(self.query(r)['items']),2)
  # A content file cannot authorize an external backend by changing its value.
  pause.write_text(json.dumps({'externalAccess':True}));self.error('NOT_QUALIFIED',lambda:dispatch_graph(self.r,dict(op='graph_query',scope='scope',generation=r['generation'],sourceCut=r['sourceCut'],backend='janusgraph')))
 def test_managed_not_admitted(self):
  old=os.environ.get('AFH_MANAGED');os.environ['AFH_MANAGED']='1'
  try:
   self.error('NOT_QUALIFIED',lambda:dispatch_graph(self.r,dict(op='graph_publish',scope='scope',backend='janusgraph',**self.request)))
   self.assertEqual(self.publish()['backend'],'postgresql-verified')
  finally:
   if old is None:os.environ.pop('AFH_MANAGED',None)
   else:os.environ['AFH_MANAGED']=old
 def test_endpoint_injection_and_public_hosts_denied(self):
  for bad in ['https://127.0.0.1:18184/gremlin','http://example.com/gremlin','http://127.0.0.1:18184/gremlin?x=1','http://user@127.0.0.1:18184/gremlin','http://127.0.0.1:18184/other']:
   self.error('READER_NOT_ADMITTED',lambda:self.client.request(bad,READ,{}))
  self.assertEqual(latest(self.r,'scope')['state'],'planned')
 def test_single_reader_not_qualified(self):
  self.publish();p=plan(self.r,self.request['outboxId']);one=self.client.connection()
  try:
   with patch.object(self.client,'connection',return_value=one):self.error('TWO_READERS',lambda:self.client.verify(p))
  finally:one.close()
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

import contextlib,importlib.util,json,os,pathlib,subprocess,unittest,uuid,io
from volume_store import Store,VolumeError,canonical,digest,PRIMARY,ANALYTICS
from common_test_fixture import WorkspaceFixture
from orbita_store.paths import Path as CommonPath
from orbita_store.transfers import StoreExport,import_stream
from orbita_store.pool import close_idle
from orbita_store import StoreError

class VolumeTests(unittest.TestCase):
 def setUp(self):
  self.fixture=WorkspaceFixture(self.id());self.base=pathlib.Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('volume-export-'+self.fixture.id);self.base.mkdir();self.root=pathlib.Path(self.fixture.name);self.s=Store(self.root)
  self.catalog=[dict(id='alfa',caseHash='a'*64,manifestHash='1'*64,metadata={'currentRevision':True}),dict(id='beta',caseHash='b'*64,manifestHash='2'*64,metadata={'currentRevision':True})]
  self.cat=lambda:dict(sources=self.catalog,token=digest(canonical(self.catalog)))
  self.s.prepare(self.cat())
 def tearDown(self):
  self.s.close();close_idle()
  self.assertEqual(self.base.resolve().parent,pathlib.Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS']).resolve())
  self.assertTrue(self.base.name.startswith('volume-export-'))
  self.assertFalse(self.root.exists());self.fixture.cleanup()
 def worker(self,request,*,crash=None,env=None):
  environment={**os.environ,'PYTHONUTF8':'1',**(env or {})}
  if crash:environment['AFH_VOLUME_CRASH_AT']=crash
  result=subprocess.run([os.sys.executable,'-X','utf8','-B',str(pathlib.Path(__file__).with_name('volume_store.py'))],input=json.dumps(dict(root=str(self.root),**request)),text=True,capture_output=True,encoding='utf8',env=environment,timeout=15)
  (self.base/('worker-'+str(uuid.uuid4())+'.json')).write_text(json.dumps(dict(exit=result.returncode,stdout=result.stdout,stderr=result.stderr),ensure_ascii=False),encoding='utf8')
  return result
 def rows(self,source,n,start=1):
  out=[]
  for i in range(start,start+n):
   raw=canonical({'text':f'Registro {i} · café 漢字 '+('permiso RETIRADO' if i%5==0 else 'regla condicionada'),'synthetic':True})
   out.append(dict(sourceId=source,uri=f'fixture:{source}:{i}',ordinal=i,kind='synthetic.message',raw=raw,sha=digest(raw),caseHash=('a' if source=='alfa' else 'b')*64))
  return out
 def seed(self,n=12):
  self.s.append('alfa',0,n,self.rows('alfa',n),True);self.s.append('beta',0,3,self.rows('beta',3),True)
 def test_01_pending_never_queries(self):
  with self.assertRaisesRegex(VolumeError,'PENDING'):self.s.query({})
 def test_02_atomic_batch_and_idempotent_reference(self):
  rows=self.rows('alfa',2);r=self.s.append('alfa',0,2,rows,False);self.assertEqual(r['added'],2)
  r=self.s.append('alfa',2,3,[rows[0]],True);self.assertEqual(r['added'],0);self.assertEqual(self.s.status()['storedRecords'],2)
  with self.assertRaisesRegex(VolumeError,'CURSOR_CONFLICT'):self.s.append('alfa',0,2,rows,False)
 def test_03_payload_error_rolls_back_every_row(self):
  rows=self.rows('alfa',2);rows[-1]['sha']='f'*64
  with self.assertRaisesRegex(VolumeError,'RECORD_BINDING'):self.s.append('alfa',0,2,rows,True)
  self.assertEqual(self.s.status()['storedRecords'],0);self.assertEqual(self.s.status()['pending'][0]['after'],0)
 def test_04_resume_after_process_exit(self):
  self.s.append('alfa',0,4,self.rows('alfa',4),False);self.s.close();self.s=Store(self.root)
  self.s.append('alfa',4,8,self.rows('alfa',4,start=5),True);self.s.append('beta',0,0,[],True)
  self.assertEqual([r['ordinal'] for r in self.s.query({})['rows']],list(range(1,9)))
 def test_05_keyset_covers_every_identity_once(self):
  self.seed();cursor=None;ids=[]
  while True:
   r=self.s.query({'limit':2,'cursor':cursor});ids.extend((x['sourceId'],x['ordinal'],x['sha']) for x in r['rows']);cursor=r['cursor']
   if not cursor:break
  expected=[(x['sourceId'],x['ordinal'],x['sha']) for x in self.rows('alfa',12)+self.rows('beta',3)];self.assertEqual(ids,expected)
 def test_06_tampered_cursor_and_changed_query_fail(self):
  self.seed();c=self.s.query({'limit':2})['cursor']
  for request in [{'cursor':c+'x'},{'cursor':c,'query':'RETIRADO'},{'cursor':c,'sourceIds':['beta']}]:
   with self.assertRaises(VolumeError):self.s.query(request)
 def test_07_catalog_revision_invalidates_page_without_erasing_history(self):
  self.seed();c=self.s.query({'limit':2})['cursor'];self.catalog[0]['metadata']['currentRevision']=False;self.s.prepare(self.cat())
  with self.assertRaisesRegex(VolumeError,'CURSOR_STALE'):self.s.query({'cursor':c})
  self.assertEqual(len(self.s.query({})['rows']),15)
 def test_08_scope_and_literal_percent_not_wildcards(self):
  self.seed();self.assertEqual(len(self.s.query({'sourceIds':['beta']})['rows']),3);self.assertEqual(self.s.query({'query':'%'})['rows'],[])
  with self.assertRaisesRegex(VolumeError,'SELECTION'):self.s.query({'sourceIds':['other']})
 def test_09_row_deletion_and_hash_change_fail_closed(self):
  self.seed();self.s.db.execute("UPDATE records SET payload='{}' WHERE seq=1")
  with self.assertRaisesRegex(VolumeError,'ROW_HASH'):self.s.query({})
  self.s.db.execute('DELETE FROM records WHERE seq=1')
  with self.assertRaisesRegex(VolumeError,'ROW_COUNT'):self.s.query({})
 def test_10_source_identity_cannot_be_rebound(self):
  self.catalog[0]['caseHash']='c'*64
  with self.assertRaisesRegex(VolumeError,'SOURCE_REBOUND'):self.s.prepare(self.cat())
 def test_11_real_parquet_independent_duckdb_and_exact_hashes(self):
  import duckdb
  self.seed();first=self.s.lake(limit=4);self.assertEqual(first['added'],4);self.assertFalse(first['ready']);self.assertTrue(first['readbackVerified'])
  with self.assertRaisesRegex(VolumeError,'LAKE_BEHIND'):self.s.verify_lake()
  while not self.s.lake(limit=4)['ready']:pass
  r=self.s.verify_lake();self.assertEqual(r['records'],15)
  receipt=self.s.export_parquet(self.base/'parquet');self.assertEqual(self.s.verify_export(receipt)['status'],'VERIFIED')
  names=[str(self.base/'parquet'/f['path']) for f in receipt['files']]
  got=duckdb.sql('SELECT seq,payload,row_hash FROM read_parquet(?) ORDER BY seq',params=[names]).fetchall();expected=[tuple(x) for x in self.s.db.execute('SELECT seq,payload,row_hash FROM records ORDER BY seq')];self.assertEqual(got,expected)
  catalog=duckdb.sql('SELECT source_id,catalog_token,cut FROM read_parquet(?) ORDER BY source_id',params=[str(self.base/'parquet'/receipt['catalogFile'])]).fetchall();self.assertEqual(catalog,[('alfa',self.cat()['token'],15),('beta',self.cat()['token'],15)])
  self.assertEqual(self.s.lake()['added'],0)
 def test_12_missing_or_mutated_parquet_is_not_success(self):
  self.seed();self.s.lake();receipt=self.s.export_parquet(self.base/'parquet');p=self.base/'parquet'/receipt['files'][0]['path'];before=p.read_bytes();p.write_bytes(b'PAR1not-parquetPAR1')
  with self.assertRaisesRegex(VolumeError,'EXPORT_FILE_CHANGED'):self.s.verify_export(receipt)
  p.write_bytes(before);p.rename(p.with_suffix('.retained-missing-fixture'))
  with self.assertRaisesRegex(VolumeError,'EXPORT_FILE_CHANGED'):self.s.verify_export(receipt)
  self.assertEqual(self.s.verify_lake()['records'],15)
 def test_13_lake_orphan_does_not_advance_cursor(self):
  self.seed();self.s.close();r=self.worker(dict(op='lake',limit=4),crash='lake-after-file');self.assertEqual(r.returncode,86)
  self.s=Store(self.root);self.assertEqual(self.s.status()['lake']['cursor'],0)
  with contextlib.closing(self.s._connect(self.s.analytics_path)) as reader:self.assertEqual(reader.execute('SELECT COUNT(*) FROM records').fetchone()[0],0);self.assertEqual(reader.execute('SELECT COUNT(*) FROM parts').fetchone()[0],0)
  self.assertFalse(self.root.exists())
  while not self.s.lake(limit=4)['ready']:pass
  self.assertEqual(self.s.verify_lake()['records'],15)
 def test_14_copied_local_state_restores_cursor_and_parquet(self):
  self.seed();c=self.s.query({'limit':3})['cursor'];self.s.lake();self.s.close();copy=self.root/'restored';config=self.s.config
  CommonPath(copy/'volume',config=config).mkdir(parents=True,exist_ok=True)
  for name in ('operational.pgstore','analytical.pgstore'):
   with StoreExport(self.root/'volume'/name,config=config) as export:
    restored=import_stream(export,export.size,copy/'volume'/name,config=config);self.assertEqual(restored['manifest']['sha256'],export.manifest['sha256'])
  restored=Store(copy)
  try:
   self.assertEqual(len(restored.query({'limit':200,'cursor':c})['rows']),12);self.assertEqual(restored.verify_lake()['records'],15)
   r=restored.export_parquet(self.base/'restored-parquet');self.assertEqual(restored.verify_export(r)['records'],15)
  finally:restored.close();self.s=Store(self.root)
 def test_15_invalid_limits_and_large_record_do_not_silently_truncate(self):
  self.seed()
  for limit in [0,201,True,'20']:
   with self.assertRaisesRegex(VolumeError,'QUERY_LIMIT'):self.s.query({'limit':limit})
  with self.assertRaisesRegex(VolumeError,'BATCH_LIMIT'):self.s.lake(limit=501)
 def test_16_postgres_real_equivalence_scope_and_delta(self):
  self.seed();r=self.s.lake(limit=3);self.assertFalse(r['ready'])
  with self.assertRaisesRegex(VolumeError,'ANALYTICS_BEHIND'):self.s.query({},ANALYTICS)
  while not self.s.lake(limit=3)['ready']:pass
  for q in ['', 'RETIRADO', '%', 'café']:
   left=self.s.query({'query':q,'sourceIds':['alfa']});right=self.s.query({'query':q,'sourceIds':['alfa']},ANALYTICS);self.assertEqual(left['rows'],right['rows'])
  self.assertEqual(self.s.lake()['added'],0)
  foreign=WorkspaceFixture('volume-foreign-space')
  try:
   other=Store(foreign.name)
   try:other.prepare(self.cat());other.append('alfa',0,1,self.rows('alfa',1),True);other.append('beta',0,0,[],True);other.lake();self.assertEqual(other.verify_lake()['records'],1)
   finally:other.close()
   self.assertEqual(len(self.s.query({},ANALYTICS)['rows']),15)
  finally:foreign.cleanup()
  self.catalog[0]['metadata']['currentRevision']=False;self.s.prepare(self.cat())
  with self.assertRaisesRegex(VolumeError,'ANALYTICS_BEHIND'):self.s.query({},ANALYTICS)
  self.s.lake();self.assertEqual(len(self.s.query({},ANALYTICS)['rows']),15)
 def test_17_postgres_scope_configuration_cannot_follow_restore(self):
  self.seed();unauthorized=self.root.parent/('unauthorized-'+str(uuid.uuid4()))
  with self.assertRaisesRegex(StoreError,'PATH_NOT_BOUND'):Store(unauthorized)
  self.assertFalse(unauthorized.exists())
 def test_18_postgres_crash_rolls_back_rows_and_cursor_together(self):
  self.seed();self.s.close();r=self.worker(dict(op='lake',limit=3),crash='postgres-before-commit');self.assertEqual(r.returncode,86)
  self.s=Store(self.root);self.assertEqual(self.s.status()['lake']['cursor'],0)
  r=self.s.lake();self.assertEqual(r['added'],15);self.assertEqual(len(self.s.query({},ANALYTICS)['rows']),15)
 def test_19_empty_catalog_is_explicit_and_has_readable_metadata(self):
  self.catalog=[];self.s.prepare(self.cat());self.assertTrue(self.s.status()['ready']);page=self.s.query({});self.assertEqual(page['rows'],[]);self.assertFalse(page['executionAuthority']);self.s.lake();self.assertEqual(self.s.verify_lake()['records'],0)
 def test_20_large_original_has_its_own_page_without_omission_in_both_backends(self):
  rows=self.rows('alfa',3);rows[1]['raw']='原'*1024**2;rows[1]['sha']=digest(rows[1]['raw']);self.s.append('alfa',0,3,rows,True);self.s.append('beta',0,0,[],True);self.s.lake()
  for backend in [PRIMARY,ANALYTICS]:
   one=self.s.query({},backend);self.assertEqual(len(one['rows']),1);self.assertFalse(one['singleLargeRecord'])
   large=self.s.query({'cursor':one['cursor']},backend);self.assertEqual(len(large['rows']),1);self.assertTrue(large['singleLargeRecord']);self.assertEqual(large['rows'][0]['raw'],rows[1]['raw']);self.assertGreater(large['bytes'],2*1024**2);self.assertLess(large['bytes'],large['responseBudgetBytes'])
   last=self.s.query({'cursor':large['cursor']},backend);self.assertEqual(last['rows'][0]['ordinal'],3);self.assertIsNone(last['cursor'])

 def test_21_unavailable_postgres_never_reports_ready_or_leaks_credentials(self):
  import socket
  self.seed();sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
  password='synthetic-unavailable-provider-secret';config=json.loads(os.environ['ORBITA_POSTGRES_BINDING']);config.update(port=port,password=password)
  try:result=self.worker(dict(op='status'),env={'ORBITA_POSTGRES_BINDING':json.dumps(config)})
  finally:sock.close()
  self.assertEqual(result.returncode,1);self.assertEqual(json.loads(result.stdout),{'error':'VOLUME_DEPENDENCY_OR_STORAGE_ERROR'});self.assertNotIn(password,result.stdout+result.stderr);self.assertIsNone(self.s.get('postgres_receipt'))

if __name__=='__main__':
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(VolumeTests))
 print(json.dumps(dict(status='PASS' if result.wasSuccessful() else 'FAIL',tests=result.testsRun,failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped))))
 raise SystemExit(not result.wasSuccessful())

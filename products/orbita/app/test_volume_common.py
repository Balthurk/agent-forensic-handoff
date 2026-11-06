"""Actual PostgreSQL readers, ownership, concurrency and native export boundaries."""
import contextlib,json,os,pathlib,subprocess,unittest
from test_volume_store import VolumeTests
from volume_store import Store,VolumeError,PRIMARY,ANALYTICS
from orbita_store import StoreError

class CommonVolumeTests(unittest.TestCase):
 setUp=VolumeTests.setUp;tearDown=VolumeTests.tearDown
 rows=VolumeTests.rows;seed=VolumeTests.seed;worker=VolumeTests.worker
 def test_two_actual_readers_share_readonly_snapshot_and_database(self):
  self.seed();self.s.lake()
  with self.s.readers() as other:
   self.assertNotEqual(self.s.db.raw.info.backend_pid,other.raw.info.backend_pid)
   for conn in (self.s.db,other):
    self.assertEqual(conn.raw.execute('SHOW transaction_read_only').fetchone()[0],'on')
    self.assertEqual(conn.raw.execute('SELECT current_database()').fetchone()[0],self.s.config.dbname)
   self.assertEqual(self.s.db.raw.execute('SELECT pg_current_snapshot()::text').fetchone(),other.raw.execute('SELECT pg_current_snapshot()::text').fetchone())
  self.assertFalse(self.s.db.in_transaction)
 def test_concurrent_writer_cannot_change_pinned_source_snapshot(self):
  self.s.append('alfa',0,1,self.rows('alfa',1),False);writer=Store(self.root)
  try:
   with self.s.readers(projection=False):
    self.assertEqual(self.s.db.execute('SELECT COUNT(*) FROM records').fetchone()[0],1)
    writer.append('alfa',1,2,self.rows('alfa',1,start=2),True)
    self.assertEqual(self.s.db.execute('SELECT COUNT(*) FROM records').fetchone()[0],1)
   self.assertEqual(self.s.status()['storedRecords'],2)
  finally:writer.close()
 def test_real_two_process_append_race_commits_exactly_once(self):
  request=json.dumps(dict(op='append',root=str(self.root),source='alfa',expectedAfter=0,after=2,rows=self.rows('alfa',2),complete=True))
  command=[os.sys.executable,'-X','utf8','-B',str(pathlib.Path(__file__).with_name('volume_store.py'))]
  children=[subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=dict(os.environ),text=True,encoding='utf8',creationflags=subprocess.CREATE_NO_WINDOW) for _ in range(2)]
  try:
   for child in children:child.stdin.write(request);child.stdin.close();child.stdin=None
   results=[]
   for child in children:
    stdout,stderr=child.communicate(timeout=15);results.append(dict(exit=child.returncode,value=json.loads(stdout),stderr=stderr))
   (self.base/'race.json').write_text(json.dumps(results),encoding='utf8')
   self.assertEqual(sorted(r['exit'] for r in results),[0,1]);self.assertEqual(self.s.status()['storedRecords'],2)
   self.assertEqual(next(r for r in results if r['exit']==0)['value']['added'],2)
  finally:
   for child in children:
    if child.poll() is None:child.kill();child.wait(timeout=5)
 def test_analytical_corruption_never_verifies(self):
  self.seed();self.s.lake()
  with contextlib.closing(self.s._connect(self.s.analytics_path,write=True)) as other:self.fixture.corrupt(other,'records',{'payload':'{}'},where_rowid=1)
  with self.assertRaisesRegex(VolumeError,'ROW_HASH'):self.s.verify_lake()
  with self.assertRaisesRegex(VolumeError,'ROW_HASH'):self.s.query({},ANALYTICS)
  self.assertEqual(len(self.s.query({})['rows']),15)
 def test_real_append_and_catalog_publication_crashes_leave_no_partial_rows(self):
  r=self.worker(dict(op='append',source='alfa',expectedAfter=0,after=2,rows=self.rows('alfa',2),complete=True),crash='append-before-commit');self.assertEqual(r.returncode,86)
  self.assertEqual(self.s.status()['storedRecords'],0);self.assertEqual(self.s.status()['pending'][0]['after'],0)
  self.seed();r=self.worker(dict(op='lake'),crash='lake-before-commit');self.assertEqual(r.returncode,86)
  self.assertEqual(self.s.status()['lake']['cursor'],0)
  with contextlib.closing(self.s._connect(self.s.analytics_path)) as reader:self.assertEqual(reader.execute('SELECT COUNT(*) FROM heads').fetchone()[0],0)
  self.assertTrue(self.s.lake()['ready']);self.assertEqual(self.s.verify_lake()['records'],15)
 def test_legacy_contracts_and_export_overlap_rejected_without_fallback(self):
  self.seed();self.s.lake()
  for backend in ('sqlite','postgres'):
   with self.assertRaisesRegex(VolumeError,'BACKEND'):self.s.query({},backend)
  result=self.worker(dict(op='postgres'));self.assertEqual(result.returncode,1);self.assertEqual(json.loads(result.stdout),{'error':'VOLUME_OPERATION'})
  for name in (self.root,self.root/'native-export',self.root.parent):
   with self.assertRaisesRegex(VolumeError,'EXPORT_OVERLAPS_COMMON_ROOT'):self.s.export_parquet(name)
  self.assertFalse(self.root.exists())
 def test_export_crash_never_publishes_success_or_damages_operational_rows(self):
  self.seed();self.s.lake();destination=self.base/'cut-export'
  result=self.worker(dict(op='export-parquet',destination=str(destination)),crash='export-after-file');self.assertEqual(result.returncode,86)
  self.assertFalse((destination/'export.json').exists());self.assertEqual(len(list(destination.glob('*.parquet'))),1)
  self.assertEqual(self.s.verify_lake()['records'],15)
  with self.assertRaisesRegex(VolumeError,'EXPORT_EXISTS'):self.s.export_parquet(destination)
  receipt=self.s.export_parquet(self.base/'fresh-export');self.assertEqual(self.s.verify_export(receipt)['records'],15)

if __name__=='__main__':unittest.main(verbosity=2)

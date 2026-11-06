"""Volume migration mechanics; the separate Node oracle checks forensic cases."""
from contextlib import closing
import copy,hashlib,json,os,subprocess,sys,unittest
from pathlib import Path

import test_legacy_metadata as metadata
from orbita_store import StoreError
from orbita_store.connection import Connection
from orbita_store.legacy_import import checked_plan,import_bundle
from orbita_store.objects import ObjectStore


class LegacyVolume(unittest.TestCase):
    setUpClass=classmethod(metadata.LegacyMetadata.setUpClass.__func__)
    tearDownClass=classmethod(metadata.LegacyMetadata.tearDownClass.__func__)
    tearDown=metadata.LegacyMetadata.tearDown
    run_import=metadata.LegacyMetadata.run_import
    absent=metadata.LegacyMetadata.absent
    def setUp(self):
        metadata.LegacyMetadata.setUp(self)
        env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
        script=Path(__file__).parent/'legacy_fixtures/i05_application/generate_volume.py'
        result=subprocess.run([sys.executable,'-I','-X','utf8','-B',str(script),str(self.native)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode,0,result.stderr.decode('utf8'));self.oracle=json.loads(result.stdout)
        indices=[];store=None
        for path in sorted((self.native/'volume').rglob('*')):
            if not path.is_file():continue
            source=path.relative_to(self.native).as_posix();target=source;kind='custody';extra={}
            if source=='volume/operational.sqlite':store=len(self.plan['entries']);kind='store';target='volume/legacy-source.pgstore';extra={'family':'volume'}
            if source.startswith('volume/lake/'):indices.append(len(self.plan['entries']))
            self.plan['entries'].append(dict(source=source,target=target,kind=kind,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),**extra))
        self.plan['derivations'].append(dict(kind='volume',store=store,cases=[0],parquet=indices))

    def test_native_catalog_cursor_rows_and_secret_survive_explicit_derivation(self):
        result=self.run_import();self.assertEqual(result['derivations'][-1]['cut'],3)
        with closing(Connection(self.destination/'volume/operational.pgstore',family='volume',config=self.config,read_only=True)) as db:
            meta=dict(db.execute('SELECT k,v FROM meta').fetchall())
            self.assertEqual(meta['schema'],'2');self.assertEqual(meta['legacy_cursor_format'],'orbita-volume-1')
            self.assertEqual(hashlib.sha256(meta['secret'].encode()).hexdigest(),self.oracle['secretSha256'])
            self.assertEqual(meta['instance'],self.oracle['instance']);self.assertEqual(meta['generation'],self.oracle['generation'])
            self.assertEqual(json.loads(meta['catalog']),self.oracle['catalog']['sources'])
        with closing(Connection(self.destination/'volume/legacy-source.pgstore',family='volume',config=self.config,read_only=True)) as db:self.assertEqual(db.execute("SELECT v FROM meta WHERE k='schema'").fetchone(),('1',))
        with ObjectStore(self.config,self.binding,read_only=True) as files:
            for r in result['entries']:self.assertEqual(files.read_bytes('imported/'+r['custodyPath']),(self.native/r['source']).read_bytes())
        self.assertFalse(Path(self.binding.root).exists())

    def test_cut_before_derived_commit_rolls_back_both_stores_and_resumes(self):
        def stop(event):
            if event['event']=='volume-before-commit':raise InterruptedError('synthetic transaction cut')
        with self.assertRaises(InterruptedError):self.run_import(progress=stop)
        self.absent()
        with ObjectStore(self.config,self.binding,read_only=True) as files:
            for name in ('operational.pgstore','analytical.pgstore','migration.json'):self.assertFalse(files.exists('staging/payload/volume/'+name))
        self.assertEqual(self.run_import()['status'],'PASS_EXPLICIT_IMPORT')

    def test_committed_derivation_resumes_only_after_independent_row_readback(self):
        def stop(event):
            if event['event']=='volume-derived-verified':raise InterruptedError('after derived commit')
        with self.assertRaises(InterruptedError):self.run_import(progress=stop)
        self.absent();result=self.run_import();self.assertEqual(result['status'],'PASS_EXPLICIT_IMPORT')

    def test_tampered_derived_rows_reject_resume_without_publication(self):
        def stop(event):
            if event['event']=='volume-derived-verified':raise InterruptedError('after derived commit')
        with self.assertRaises(InterruptedError):self.run_import(progress=stop)
        with closing(Connection(self.stage/'payload/volume/operational.pgstore',family='volume',config=self.config)) as db:db.execute("UPDATE records SET raw='forged' WHERE seq=1");db.commit()
        with self.assertRaisesRegex(StoreError,'LEGACY_VOLUME_DERIVED_MISMATCH'):self.run_import()
        self.absent()

    def test_corrupt_parquet_is_not_accepted_by_rebinding_the_plan_hash(self):
        entry=self.plan['entries'][self.plan['derivations'][-1]['parquet'][0]];file=self.native/entry['source'];data=bytearray(file.read_bytes());data[len(data)//2]^=1;file.write_bytes(data);entry['sha256']=hashlib.sha256(data).hexdigest()
        with self.assertRaisesRegex(StoreError,'LEGACY_VOLUME_PARQUET_HASH'):self.run_import()
        self.absent()

    def test_case_rebinding_duplicate_derivation_and_unclassified_part_reject(self):
        duplicate=copy.deepcopy(self.plan);duplicate['derivations'].append(copy.deepcopy(duplicate['derivations'][-1]))
        with self.assertRaisesRegex(StoreError,'LEGACY_VOLUME_DUPLICATE'):checked_plan(duplicate,self.destination,self.stage,self.config)
        missing=copy.deepcopy(self.plan);missing['derivations'][-1]['parquet'].pop()
        with self.assertRaisesRegex(StoreError,'LEGACY_VOLUME_UNCLASSIFIED_PARQUET'):checked_plan(missing,self.destination,self.stage,self.config)
        file=self.native/'cases/a/case.json';value=json.loads(file.read_text());value['unexpected']='rebound';file.write_text(json.dumps(value));self.plan['entries'][0]['sha256']=hashlib.sha256(file.read_bytes()).hexdigest()
        with self.assertRaisesRegex(StoreError,'LEGACY_VOLUME_CASE_BINDING'):self.run_import()
        self.absent()

if __name__=='__main__':unittest.main()

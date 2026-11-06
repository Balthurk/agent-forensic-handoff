"""Hostile derivations and restart boundaries; deep cases are checked in Node.

These small case stores exercise metadata mechanics only. They deliberately
make no claim of valid forensic content; the original I05 application oracle
provides that independent positive end-to-end check.
"""
from contextlib import closing
import copy,hashlib,json,os,sqlite3,unittest,uuid
from pathlib import Path
import test_common_postgres_catalog as fixture
from orbita_store import StoreError
from orbita_store.legacy_import import import_bundle,checked_plan
from orbita_store.objects import ObjectStore


class LegacyMetadata(unittest.TestCase):
    setUpClass=classmethod(fixture.CommonCatalogue.setUpClass.__func__)
    tearDownClass=classmethod(fixture.CommonCatalogue.tearDownClass.__func__)
    tearDown=fixture.CommonCatalogue.tearDown
    def setUp(self):
        fixture.CommonCatalogue.setUp(self)
        self.native=Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/'metadata-native'/str(uuid.uuid4());(self.native/'cases/a').mkdir(parents=True)
        self.case=dict(status='COMPLETE',caseHash='a'*64,sourceSnapshotHash='b'*64,graphIdentity='c'*64,temporalIdentity='d'*64,sources=[],history=['original literal á😀'])
        (self.native/'cases/a/case.json').write_text(json.dumps(self.case,ensure_ascii=False),encoding='utf8')
        with closing(sqlite3.connect(self.native/'cases/a/case.sqlite')) as db:db.executescript((self.root/'case.sql').read_text(encoding='utf8'))
        original=str(self.native/'cases/a')
        (self.native/'library.json').write_text(json.dumps([dict(id='a',path=original,title='synthetic')]),encoding='utf8')
        entries=[]
        for source,target,kind in [('cases/a/case.json','cases/a/case.json','custody'),('cases/a/case.sqlite','cases/a/case.pgstore','store'),('library.json','library.json','custody')]:
            entries.append(dict(source=source,target=target,kind=kind,sha256=hashlib.sha256((self.native/source).read_bytes()).hexdigest(),**({'family':'case'} if kind=='store' else {})))
        self.plan=dict(schema='orbita-legacy-plan-2',sourceRoot=str(self.native),entries=entries,derivations=[dict(kind='case',entry=0,store=1,caseHash=self.case['caseHash']),dict(kind='library',entry=2,mappings=[dict(id='a',case=0,originalPath=original)])])
        self.destination=Path(self.binding.root)/'imported';self.stage=Path(self.binding.root)/'staging'
    def run_import(self,**kwargs):return import_bundle(self.plan,self.destination,self.stage,config=self.config,**kwargs)
    def absent(self):
        with ObjectStore(self.config,self.binding,read_only=True) as files:self.assertFalse(files.exists('imported'))

    def test_only_declared_metadata_changes_and_all_original_bytes_survive(self):
        result=self.run_import();self.assertEqual(len(result['derivations']),3)
        with ObjectStore(self.config,self.binding,read_only=True) as files:
            raw=files.read_bytes('imported/cases/a/case.json');value=json.loads(raw);storage=value.pop('storage')
            self.assertEqual(value,self.case);self.assertEqual(storage['engine'],'postgresql-common');self.assertEqual(storage['path'],'case.pgstore')
            self.assertEqual(files.read_bytes('imported/cases/a/case-seals/'+storage['manifest']['sha256']+'.json'),raw)
            self.assertEqual(json.loads(files.read_bytes('imported/library.json'))[0]['path'],str(self.destination/'cases/a'))
            for item in result['entries']:self.assertEqual(files.read_bytes('imported/'+item['custodyPath']),(self.native/item['source']).read_bytes())
            state=files.raw.execute("SELECT orbita_common.restore_state('imported')").fetchone()[0]
            self.assertFalse(state['automaticWork']);self.assertFalse(state['externalAccess'])
        self.assertFalse(Path(self.binding.root).exists())

    def test_declared_case_identity_mismatch_prevents_publication(self):
        self.plan['derivations'][0]['caseHash']='f'*64
        with self.assertRaisesRegex(StoreError,'LEGACY_CASE_IDENTITY'):self.run_import()
        self.absent()

    def test_external_or_rebound_library_path_prevents_publication(self):
        self.plan['derivations'][1]['mappings'][0]['originalPath']=str(self.native/'different')
        with self.assertRaisesRegex(StoreError,'LEGACY_LIBRARY_PATH'):self.run_import()
        self.absent()

    def test_tampered_derived_prefix_is_not_overwritten_on_resume(self):
        def stop(event):
            if event['event']=='derived-verified':raise InterruptedError('after durable derived object')
        with self.assertRaises(InterruptedError):self.run_import(progress=stop)
        self.absent()
        with ObjectStore(self.config,self.binding) as files:files.write_bytes('staging/payload/cases/a/case.json',b'{"forged":true}')
        with self.assertRaisesRegex(StoreError,'LEGACY_RESUME_DERIVED_MISMATCH'):self.run_import()
        self.absent()

    def test_aliases_unknown_derivations_and_seal_collisions_are_rejected(self):
        original=copy.deepcopy(self.plan)
        variants=[]
        p=copy.deepcopy(original);p['entries'][2]['target']='CASES/A/CASE.JSON';variants.append((p,'LEGACY_PLAN_DUPLICATE'))
        p=copy.deepcopy(original);p['derivations'][0]['kind']='execute';variants.append((p,'LEGACY_DERIVATION_KIND'))
        p=copy.deepcopy(original);p['entries'][2]['target']='cases/a/case-seals/forged.json';variants.append((p,'LEGACY_DERIVED_TARGET_COLLISION'))
        p=copy.deepcopy(original);p['derivations'][0]['store']=True;variants.append((p,'LEGACY_DERIVATION_INDEX'))
        p=copy.deepcopy(original);p['entries'][0]['target']='cases//a/case.json';variants.append((p,'LEGACY_NONCANONICAL_PATH'))
        for plan,code in variants:
            with self.subTest(code=code),self.assertRaisesRegex(StoreError,code):checked_plan(plan,self.destination,self.stage,self.config)
        self.absent()

    def test_duplicate_json_keys_are_rejected_even_with_a_valid_source_hash(self):
        file=self.native/'cases/a/case.json';file.write_text('{"status":"COMPLETE","caseHash":"'+('a'*64)+'","caseHash":"'+('a'*64)+'"}',encoding='utf8')
        self.plan['entries'][0]['sha256']=hashlib.sha256(file.read_bytes()).hexdigest()
        with self.assertRaisesRegex(StoreError,'LEGACY_METADATA_DUPLICATE_KEY'):self.run_import()
        self.absent()

if __name__=='__main__':unittest.main()

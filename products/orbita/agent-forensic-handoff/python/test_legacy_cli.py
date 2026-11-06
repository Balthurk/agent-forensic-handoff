"""Actual operator CLI process, bounded input, explicit authority and closure."""
from pathlib import Path
import hashlib,json,os,subprocess,sys,unittest,uuid
import test_legacy_import as fixture
from orbita_store.objects import ObjectStore


class LegacyCLI(unittest.TestCase):
    setUpClass=classmethod(fixture.LegacyImport.setUpClass.__func__)
    tearDownClass=classmethod(fixture.LegacyImport.tearDownClass.__func__)
    setUp=fixture.LegacyImport.setUp
    tearDown=fixture.LegacyImport.tearDown
    seed=fixture.LegacyImport.seed
    plan=fixture.LegacyImport.plan
    absent=fixture.LegacyImport.absent

    def invoke(self,plan,*,expected=None,config_change=None):
        raw=plan if isinstance(plan,bytes) else json.dumps(plan).encode()
        file=self.native/(str(uuid.uuid4())+'.plan.json');file.write_bytes(raw)
        settings=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text(encoding='utf8'))
        settings['bindings']=[dict(root=self.binding.root,workspaceId=self.binding.workspace_id,capability=self.binding.capability)]
        if config_change:settings.update(config_change)
        credential=Path(os.environ['ORBITA_POSTGRES_CONFIG']).parent/('legacy-cli-'+str(uuid.uuid4())+'.json')
        credential.write_text(json.dumps(settings),encoding='utf8')
        env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
        env.update(PYTHONDONTWRITEBYTECODE='1',PYTHONUTF8='1')
        process=subprocess.run([sys.executable,'-X','utf8','-B','-m','orbita_store.legacy_cli','--plan',str(file),'--plan-sha256',expected or hashlib.sha256(raw).hexdigest(),'--config',str(credential),'--destination',str(self.destination),'--stage',str(self.stage)],cwd=Path(__file__).parent,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
        output=process.stdout.decode('utf8');error=process.stderr.decode('utf8')
        self.assertTrue(settings['password'] not in output+error,'SECRET_EXPOSED')
        self.assertTrue(self.binding.capability not in output+error,'CAPABILITY_EXPOSED')
        value=json.loads(output);self.assertEqual(value['consumerClosure']['backends'],0)
        self.assertFalse(Path(self.binding.root).exists())
        return process.returncode,value

    def test_real_cli_import_has_durable_receipt_exact_custody_and_no_native_store(self):
        plan=self.seed();code,result=self.invoke(plan)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'PASS_EXPLICIT_IMPORT')
        with ObjectStore(self.config,self.binding,read_only=True) as files:
            receipt=files.read_bytes(result['receipt']);self.assertEqual(hashlib.sha256(receipt).hexdigest(),result['receiptSha256'])
            self.assertEqual(files.read_bytes('imported/.orbita-legacy/originals/cache.sqlite.bin'),(self.native/'cache.sqlite').read_bytes())
            state=files.raw.execute("SELECT orbita_common.restore_state('imported')").fetchone()[0]
            self.assertFalse(state['automaticWork']);self.assertFalse(state['externalAccess'])
        code,repeated=self.invoke(plan);self.assertEqual(code,1);self.assertEqual(repeated['code'],'ORBITA_PG_LEGACY_DESTINATION_EXISTS')

    def test_changed_hash_duplicate_keys_and_oversized_plan_fail_before_publication(self):
        plan=self.seed();code,result=self.invoke(plan,expected='0'*64)
        self.assertEqual(code,1);self.assertEqual(result['code'],'ORBITA_PG_LEGACY_SOURCE_HASH')
        for raw in (b'{"schema":1,"schema":2}',b' '*(8*1024**2+1)):
            code,result=self.invoke(raw);self.assertEqual(code,1);self.absent()
            self.assertIn(result['code'],('ORBITA_PG_LEGACY_METADATA_DUPLICATE_KEY','ORBITA_PG_LEGACY_SOURCE_BYTE_BUDGET'))

    def test_runtime_role_and_control_family_cannot_be_replaced_by_operator_input(self):
        plan=self.seed();code,result=self.invoke(plan,config_change={'user':'postgres'})
        self.assertEqual(code,1);self.assertEqual(result['code'],'ORBITA_PG_RUNTIME_ROLE_REQUIRED');self.absent()
        plan['entries'][0]['family']='access';code,result=self.invoke(plan)
        self.assertEqual(code,1);self.assertEqual(result['code'],'ORBITA_PG_LEGACY_CONTROL_CUSTODY_ONLY');self.absent()


if __name__=='__main__':unittest.main()

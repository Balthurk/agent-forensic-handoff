from pathlib import Path
import json,os,subprocess,sys,unittest


class CompleteInstallCLI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parameters=json.loads(Path(os.environ['ORBITA_INSTALLATION_TEST_OPERATOR']).read_text())
        assert cls.parameters['dbname']=='orbita_installation' and cls.parameters['port']!=15438
        cls.input={'operator':{k:cls.parameters[k] for k in ('host','port','dbname','user','password')},'instanceId':cls.parameters['instanceId'],'runtimePassword':cls.parameters['runtimePassword']}

    def invoke(self,value,*args):
        raw=value if isinstance(value,bytes) else json.dumps(value).encode()
        result=subprocess.run([sys.executable,'-I','-X','utf8','-B',str(Path(__file__).with_name('install-common.py')),*args],input=raw,capture_output=True,timeout=90)
        self.assertEqual(result.stderr,b'')
        for secret in (self.parameters['password'],self.parameters['runtimePassword'],'SECRET_CANARY_NEVER_REPORT'):
            self.assertNotIn(secret.encode(),result.stdout)
        return result.returncode,json.loads(result.stdout)

    def test_01_repeat_complete_install_from_private_stdin(self):
        code,value=self.invoke(self.input)
        self.assertEqual(code,0);self.assertEqual(value['status'],'ALREADY_INITIALIZED')
        self.assertEqual(value['instanceId'],self.parameters['instanceId'])
        self.assertEqual((value['complete']['families'],value['complete']['tables']),(19,98))

    def test_02_credentials_never_allowed_as_arguments(self):
        code,value=self.invoke(self.input,'SECRET_CANARY_NEVER_REPORT')
        self.assertEqual(code,1);self.assertEqual(value['error'],'ORBITA_PG_INSTALL_NO_ARGUMENTS')

    def test_03_malformed_input_is_redacted(self):
        code,value=self.invoke(b'{"SECRET_CANARY_NEVER_REPORT":')
        self.assertEqual(code,1);self.assertEqual(value['error'],'ORBITA_PG_INSTALL_FAILED')

    def test_04_size_is_bounded_before_json_parse(self):
        code,value=self.invoke(b' '*(1024*1024+1))
        self.assertEqual(code,1);self.assertEqual(value['error'],'ORBITA_PG_INSTALL_INPUT_SIZE')

    def test_05_wrong_runtime_password_does_not_rotate(self):
        bad=dict(self.input,runtimePassword='SECRET_CANARY_NEVER_REPORT'+'x'*40)
        code,value=self.invoke(bad);self.assertEqual(code,1);self.assertEqual(value['error'],'ORBITA_PG_INSTALL_FAILED')
        code,value=self.invoke(self.input);self.assertEqual(code,0)

    def test_06_unexpected_fields_are_rejected(self):
        code,value=self.invoke(dict(self.input,extra='SECRET_CANARY_NEVER_REPORT'))
        self.assertEqual(code,1);self.assertEqual(value['error'],'ORBITA_PG_INSTALL_INPUT_FIELDS')

"""Dedicated empty service only: no family is installed by a test fixture."""
from contextlib import closing
from dataclasses import replace
from pathlib import Path
import hashlib,json,os,shutil,unittest,uuid
from unittest.mock import patch
import psycopg
from orbita_store import StoreError
from orbita_store.admin import connect_operator,install,provision_workspace
from orbita_store.config import Binding,parse_config
from orbita_store.connection import Connection
from orbita_store.installation import schema_bundle,FAMILIES,ROOT,install_family
from orbita_store.pool import close_idle
from orbita_store.session import Session


class CompleteInstallation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator=json.loads(Path(os.environ['ORBITA_INSTALLATION_TEST_OPERATOR']).read_text())
        assert cls.operator['dbname']=='orbita_installation' and cls.operator['user']=='orbita_install_owner' and cls.operator['port']!=15438
        assert cls.operator['instanceId']!='dc1b1f4a-a445-48a1-9b12-0679686424cf'
        with connect_operator(cls.operator) as db:
            assert db.execute("SELECT to_regclass('orbita_common.identity')").fetchone()[0] is None
            assert db.execute("SELECT count(*) FROM pg_roles WHERE rolname='orbita_runtime'").fetchone()[0]==0
        calls=[]
        def interrupted(db,family,script):
            calls.append(family)
            if len(calls)==5:raise RuntimeError('synthetic installation interruption')
            return install_family(db,family,script)
        try:
            with patch('orbita_store.installation.install_family',side_effect=interrupted):install(cls.operator,instance_id=cls.operator['instanceId'],runtime_password=cls.operator['runtimePassword'])
        except RuntimeError as error:assert str(error)=='synthetic installation interruption'
        else:raise AssertionError('EXPECTED_INSTALLATION_INTERRUPTION')
        with connect_operator(cls.operator) as db:
            assert db.execute("SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'orbita_%'").fetchone()[0]==0
            assert db.execute("SELECT count(*) FROM pg_roles WHERE rolname='orbita_runtime'").fetchone()[0]==0
        cls.atomic_rollback=True
        cls.first=install(cls.operator,instance_id=cls.operator['instanceId'],runtime_password=cls.operator['runtimePassword'])
        cls.run_id=str(uuid.uuid4());cls.ids=[]
        cls.raw=dict(schema=1,host=cls.operator['host'],port=cls.operator['port'],dbname=cls.operator['dbname'],user='orbita_runtime',password=cls.operator['runtimePassword'],instanceId=cls.operator['instanceId'])
        cls.bundle,cls.package=schema_bundle()

    def setUp(self):
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':complete-installation',kind='test');self.ids.append(value['workspaceId'])
        self.root=Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/value['workspaceId'];self.binding=Binding(str(self.root),value['workspaceId'],value['capability'])
        self.config=parse_config(dict(self.raw,bindings=[dict(root=str(self.root),**value)]))

    def tearDown(self):close_idle();self.assertFalse(self.root.exists())
    @classmethod
    def tearDownClass(cls):
        close_idle();(Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixtures-install-'+cls.run_id+'.json')).write_text(json.dumps(dict(workspaceIds=cls.ids,instanceId=cls.operator['instanceId'],atomicRollback=cls.atomic_rollback)))

    def reinstall(self,**overrides):
        close_idle();return install(self.operator,**dict(instance_id=overrides.get('instance_id',self.operator['instanceId']),runtime_password=overrides.get('runtime_password',self.operator['runtimePassword'])))

    def mutate(self,statement):
        close_idle()
        with connect_operator(self.operator) as db:db.execute(statement)

    def test_00_fresh_complete_install_is_atomic_and_has_every_family(self):
        self.assertTrue(self.atomic_rollback);self.assertEqual(self.first['status'],'INITIALIZED')
        self.assertEqual((self.first['complete']['families'],self.first['complete']['tables']),(19,98))
        self.assertEqual(self.first['complete']['package'],self.package)
        with connect_operator(self.operator) as db:
            families={r[0] for r in db.execute('SELECT name FROM orbita_private.families')}
            self.assertEqual(families,FAMILIES)
            self.assertEqual(db.execute("SELECT count(*) FROM orbita_private.schema_catalog WHERE kind='table'").fetchone()[0],98)
            self.assertIsNotNone(db.execute("SELECT to_regprocedure('orbita_common.managed_legacy_archive(text,text)')").fetchone()[0])

    def test_01_runtime_can_bind_all_nineteen_families_without_operator_fixture(self):
        count=0
        for family,value in self.bundle.items():
            with closing(Connection(self.root/(family+'.pgstore'),family=family,config=self.config,create=True)) as db:
                db.executescript(value['source']);manifest=db.logical_manifest();self.assertEqual(manifest['rows'],0)
                self.assertEqual(len(manifest['tables']),sum(i['kind']=='table' for i in value['items']));count+=len(manifest['tables'])
        self.assertEqual(count,98)

    def test_02_repeated_installation_preserves_rows_and_instance(self):
        name=self.root/'embedding.pgstore'
        with closing(Connection(name,family='embedding',config=self.config,create=True)) as db:
            db.executescript(self.bundle['embedding']['source']);db.execute("INSERT INTO vectors VALUES('ns','id','literal ñ😀','[1,0]','original')");before=db.logical_manifest()
        result=self.reinstall();self.assertEqual(result['status'],'ALREADY_INITIALIZED');self.assertEqual(result['complete']['physicalSha256'],self.first['complete']['physicalSha256'])
        with closing(Connection(name,family='embedding',config=self.config,read_only=True)) as db:self.assertEqual(db.logical_manifest(),before)

    def test_03_wrong_instance_is_not_reinitialized(self):
        with self.assertRaisesRegex(StoreError,'INSTANCE_ALREADY_INITIALIZED'):self.reinstall(instance_id=str(uuid.uuid4()))
        self.assertEqual(self.reinstall()['complete']['physicalSha256'],self.first['complete']['physicalSha256'])

    def test_04_wrong_runtime_password_is_not_rotated(self):
        with self.assertRaises(psycopg.OperationalError):self.reinstall(runtime_password='synthetic-wrong-runtime-password-which-is-long')
        with Session(self.config,self.binding) as session:self.assertEqual(session.raw.execute('SELECT current_user').fetchone()[0],'orbita_runtime')

    def test_05_live_client_blocks_install_without_stopping_it(self):
        with Session(self.config,self.binding) as session:
            with self.assertRaisesRegex(StoreError,'INSTALL_CLIENTS_ACTIVE'):self.reinstall()
            self.assertEqual(session.raw.execute('SELECT 1').fetchone()[0],1)

    def test_06_disabled_rls_is_reported_as_drift(self):
        self.mutate('ALTER TABLE orbita_embedding.vectors DISABLE ROW LEVEL SECURITY')
        try:
            with self.assertRaisesRegex(StoreError,'INSTALL_EXISTING_PHYSICAL_DRIFT'):self.reinstall()
        finally:self.mutate('ALTER TABLE orbita_embedding.vectors ENABLE ROW LEVEL SECURITY')

    def test_07_column_type_drift_is_not_hidden_by_catalog_hash(self):
        self.mutate('ALTER TABLE orbita_embedding.vectors ALTER COLUMN vector_hash TYPE varchar')
        try:
            with self.assertRaisesRegex(StoreError,'INSTALL_EXISTING_PHYSICAL_DRIFT'):self.reinstall()
        finally:self.mutate('ALTER TABLE orbita_embedding.vectors ALTER COLUMN vector_hash TYPE text')

    def test_08_default_drift_is_detected_before_reinstallation(self):
        self.mutate("ALTER TABLE orbita_embedding.vectors ALTER COLUMN vector_hash SET DEFAULT 'unreviewed'")
        try:
            with self.assertRaisesRegex(StoreError,'INSTALL_EXISTING_PHYSICAL_DRIFT'):self.reinstall()
        finally:self.mutate('ALTER TABLE orbita_embedding.vectors ALTER COLUMN vector_hash DROP DEFAULT')

    def test_09_extra_permissive_policy_is_rejected(self):
        self.mutate('CREATE POLICY unexpected ON orbita_embedding.vectors USING(true)')
        try:
            with self.assertRaisesRegex(StoreError,'INSTALL_EXISTING_PHYSICAL_DRIFT'):self.reinstall()
        finally:self.mutate('DROP POLICY unexpected ON orbita_embedding.vectors')

    def test_10_runtime_cannot_access_installation_receipt_or_ddl(self):
        with Session(self.config,self.binding) as session:
            for command in ('SELECT * FROM orbita_private.installation','ALTER TABLE orbita_embedding.vectors DISABLE ROW LEVEL SECURITY','CREATE TABLE public.invalid(id int)','SET ROLE orbita_install_owner'):
                with self.subTest(command=command),self.assertRaises(psycopg.Error):session.raw.execute(command)

    def test_11_changed_bundle_fails_before_any_database_connection(self):
        root=Path(os.environ['TEMP'])/('altered-bundle-'+str(uuid.uuid4()));shutil.copytree(ROOT/'schemas',root/'schemas')
        source=root/'schemas/access.sql';source.write_bytes(source.read_bytes()+b'\n-- changed input\n')
        with patch('orbita_store.installation.ROOT',root),patch('orbita_store.admin.connect_operator') as connection,self.assertRaisesRegex(StoreError,'INSTALL_BUNDLE_HASH'):self.reinstall()
        connection.assert_not_called()

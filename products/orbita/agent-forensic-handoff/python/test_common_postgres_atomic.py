"""Actual same-transaction rows/objects, crash rollback and scoped ownership."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
import json,os,subprocess,sys,threading,time,unittest,uuid
import psycopg
from orbita_store import StoreError
from orbita_store.admin import connect_operator,provision_workspace
from orbita_store.config import Binding,parse_config
from orbita_store.connection import Connection
from orbita_store.objects import ObjectStore,BLOCK
from orbita_store.ownership import observe_owner


class CommonAtomic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_OPERATOR_CONFIG']).read_text(encoding='utf8'))
        cls.base=parse_config(json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text(encoding='utf8')))
        cls.run_id=str(uuid.uuid4());cls.fixture_ids=[]

    def setUp(self):
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':'+self._testMethodName,kind='test')
        self.fixture_ids.append(value['workspaceId']);self.opened=[]
        self.root=Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/value['workspaceId']
        self.binding=Binding(str(self.root),value['workspaceId'],value['capability'])
        self.config=replace(self.base,bindings=(self.binding,))
        self.db=self.connect(create=True)
        self.db.execute("INSERT INTO attempts VALUES('current',1,0)").close()
        self.objects=self.open_objects()
        self.objects.write_bytes('case/case.json',b'old')

    def connect(self,**options):
        db=Connection(self.root/'case/access.pgstore',family='access',config=self.config,**options)
        self.opened.append(db);return db

    def open_objects(self):
        obj=ObjectStore(self.config,self.binding);self.opened.append(obj);return obj

    def tearDown(self):
        for value in reversed(self.opened):value.close()
        self.assertFalse(self.root.exists())

    @classmethod
    def tearDownClass(cls):
        receipt=Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixtures-atomic-'+cls.run_id+'.json')
        with receipt.open('x',encoding='utf8') as stream:json.dump(dict(runId=cls.run_id,workspaceIds=cls.fixture_ids),stream)

    def borrow(self,name='case.json'):
        return self.db.transaction_objects(self.root/'case'/name)

    def mutate(self,value=b'new'):
        self.db.execute("UPDATE attempts SET count=2 WHERE name='current'").close()
        store,key=self.borrow();store.write_bytes(key,value)

    def actual(self):
        fresh=self.connect(read_only=True)
        try:return fresh.execute('SELECT count FROM attempts').fetchone()[0],self.open_objects().read_bytes('case/case.json')
        finally:fresh.close()

    def test_commit_exposes_both_rows_and_bytes_from_same_backend(self):
        reader=self.connect(read_only=True)
        self.db.begin_consistent_write();store,key=self.borrow()
        self.assertIs(store.raw,self.db.raw);self.assertIs(store.session,self.db.session)
        self.mutate();self.assertEqual(reader.execute('SELECT count FROM attempts').fetchone()[0],1)
        self.assertEqual(self.objects.read_bytes('case/case.json'),b'old')
        self.db.commit();self.assertEqual(self.actual(),(2,b'new'))
        self.assertFalse(self.db.closed)
        with self.assertRaisesRegex(StoreError,'OBJECT_STORE_CLOSED'):store.read_bytes(key)

    def test_rollback_discards_completed_objects_rows_and_open_writer(self):
        self.db.begin_consistent_write();self.mutate()
        store,key=self.borrow('unfinished');writer=store.open_write(key);writer.write(b'x'*BLOCK)
        self.db.rollback();self.assertTrue(writer.closed);self.assertEqual(self.actual(),(1,b'old'))
        self.assertFalse(self.objects.exists('case/unfinished'))
        with connect_operator(self.operator) as admin:
            self.assertEqual(admin.execute('SELECT count(*) FROM orbita_private.object_pins WHERE workspace_id=%s::uuid',(self.binding.workspace_id,)).fetchone()[0],0)

    def test_commit_rejects_open_readers_and_writers_without_silent_publication(self):
        for mode in ('reader','writer'):
            self.db.begin_consistent_write();store,key=self.borrow()
            handle=store.open_read(key) if mode=='reader' else store.open_write(key)
            with self.assertRaisesRegex(StoreError,'OBJECT_TRANSACTION_OPEN_HANDLES'):self.db.commit()
            self.assertTrue(self.db.in_transaction);self.db.rollback();self.assertTrue(handle.closed)
            self.assertEqual(self.actual(),(1,b'old'))

    def test_scope_readonly_no_transaction_and_isolation_are_enforced(self):
        with self.assertRaisesRegex(StoreError,'OBJECT_TRANSACTION_REQUIRED'):self.borrow()
        self.db.execute('BEGIN').close()
        with self.assertRaisesRegex(StoreError,'OBJECT_REPEATABLE_TRANSACTION_REQUIRED'):self.borrow()
        self.db.rollback();self.db.begin_consistent_write()
        for target in [self.root/'sibling/bytes',self.root/'case-sibling/bytes']:
            with self.assertRaisesRegex(StoreError,'OBJECT_TRANSACTION_PATH_ESCAPE'):self.db.transaction_objects(target)
        store,_=self.borrow()
        with self.assertRaisesRegex(StoreError,'OBJECT_TRANSACTION_PATH_ESCAPE'):store.write_bytes('sibling',b'x')
        self.db.rollback()
        reader=self.connect(read_only=True)
        with self.assertRaisesRegex(StoreError,'READ_ONLY'):reader.begin_consistent_write()

    def test_different_workspace_binding_is_rejected(self):
        other=provision_workspace(self.operator,label='qualification:'+self.run_id+':other',kind='test')
        self.fixture_ids.append(other['workspaceId'])
        second=Binding(str(self.root/'case/foreign'),other['workspaceId'],other['capability'])
        self.db.config=replace(self.config,bindings=(self.binding,second))
        self.db.begin_consistent_write()
        with self.assertRaisesRegex(StoreError,'OBJECT_TRANSACTION_BINDING_MISMATCH'):
            self.db.transaction_objects(self.root/'case/foreign/file')
        self.db.rollback()

    def test_close_with_live_handle_rolls_back_and_releases_all_pins(self):
        self.db.begin_consistent_write();self.mutate();store,key=self.borrow('open')
        writer=store.open_write(key);writer.write(b'z'*BLOCK)
        self.db.close();self.assertTrue(writer.closed);self.assertEqual(self.actual(),(1,b'old'))
        with connect_operator(self.operator) as admin:
            self.assertEqual(admin.execute('SELECT count(*) FROM orbita_private.object_pins WHERE workspace_id=%s::uuid',(self.binding.workspace_id,)).fetchone()[0],0)

    def test_large_exact_bytes_and_exclusive_seal_conflict_share_transaction(self):
        payload=('aá😀\r\n'.encode()*400000)+b'\x00\xff'
        self.db.begin_consistent_write();self.mutate(payload);store,key=self.borrow()
        self.assertEqual(store.read_bytes(key),payload)
        with self.assertRaises(FileExistsError):store.write_bytes(key,b'replacement',exclusive=True)
        self.assertEqual(store.read_bytes(key),payload);self.db.commit()
        self.assertEqual(self.actual(),(2,payload))

    def test_competing_writer_cannot_overwrite_a_stale_snapshot(self):
        acquired=threading.Event()
        competitor=self.connect()
        def competing():
            db=competitor
            try:
                acquired.set();db.begin_consistent_write()
                db.execute("UPDATE attempts SET count=3 WHERE name='current'")
                store,key=db.transaction_objects(self.root/'case/case.json');store.write_bytes(key,b'third')
                db.commit();return 'committed'
            except psycopg.errors.SerializationFailure:
                db.rollback();return 'serialization'
            finally:db.close()
        self.db.begin_consistent_write();self.mutate()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(competing);self.assertTrue(acquired.wait(5));time.sleep(0.1)
            self.assertFalse(future.done());self.db.commit();outcome=future.result(timeout=10)
        self.assertIn(outcome,('committed','serialization'))
        self.assertEqual(self.actual(),(3,b'third') if outcome=='committed' else (2,b'new'))

    def test_process_exit_at_each_uncommitted_stage_restores_previous_state(self):
        script='''import os,sys
from orbita_store.config import read_config
from orbita_store.connection import Connection
db=Connection(sys.argv[1],family='access',config=read_config())
db.begin_consistent_write();db.execute("UPDATE attempts SET count=9 WHERE name='current'")
if sys.argv[3]=='rows':os._exit(73)
store,key=db.transaction_objects(sys.argv[2]);writer=store.open_write(key);writer.write(b'z'*(1024*1024+7))
if sys.argv[3]=='chunks':os._exit(73)
writer.close();os._exit(73)
'''
        config=dict(schema=1,**self.config.connection_parameters(),instanceId=self.config.instance_id,
            bindings=[dict(root=self.binding.root,workspaceId=self.binding.workspace_id,capability=self.binding.capability)])
        for stage in ('rows','chunks','published-name'):
            owner=str(uuid.uuid4());env=dict(os.environ,ORBITA_POSTGRES_BINDING=json.dumps(config),ORBITA_POSTGRES_OWNER_ID=owner)
            env.pop('ORBITA_POSTGRES_CONFIG',None)
            result=subprocess.run([sys.executable,'-X','utf8','-B','-c',script,str(self.root/'case/access.pgstore'),str(self.root/'case/case.json'),stage],
                env=env,capture_output=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(result.returncode,73,result.stderr.decode());self.assertEqual(observe_owner(self.config,owner)['backends'],0)
            self.assertEqual(self.actual(),(1,b'old'),stage)

    def test_failed_statement_preserves_transaction_until_explicit_rollback(self):
        self.db.begin_consistent_write();self.mutate()
        with self.assertRaises(psycopg.errors.UniqueViolation):self.db.execute("INSERT INTO attempts VALUES('current',8,0)")
        self.assertTrue(self.db.in_transaction)
        self.assertEqual(self.db.execute('SELECT count FROM attempts').fetchone()[0],2)
        self.db.rollback();self.assertEqual(self.actual(),(1,b'old'))

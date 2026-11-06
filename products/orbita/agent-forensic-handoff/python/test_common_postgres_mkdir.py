"""Original directory semantics, savepoint failures, concurrent creators and RLS."""
from pathlib import Path,PurePosixPath
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import errno,unittest,uuid
import psycopg
from psycopg import sql
from orbita_store import StoreError
from orbita_store.admin import connect_operator,provision_workspace
from orbita_store.config import Binding
from orbita_store.objects import ObjectStore,file_error
import test_common_postgres_objects as fixture


def historical_mkdir(self,key,*,parents=False,exist_ok=False):
    # Exact pre-change operation preserved independently of the server helper.
    self._writable();key=self._key(key)
    with self.raw.transaction():
        self._lock()
        prior=self._entry(key)
        if prior:
            if exist_ok and prior['kind']=='directory':return
            raise file_error(errno.EEXIST,key)
        if key and parents:
            parts=['']+list(reversed([str(p) for p in PurePosixPath(key).parents if str(p)!='.']))
            for parent in parts:
                item=self._entry(parent)
                if item is None:self.raw.execute("INSERT INTO orbita_common.entries(path,kind) VALUES(%s,'directory')",(parent,))
                elif item['kind']!='directory':raise file_error(errno.ENOTDIR,parent)
        elif key:self._parent(key)
        self.raw.execute("INSERT INTO orbita_common.entries(path,kind) VALUES(%s,'directory')",(key,))


class CommonMkdir(unittest.TestCase):
    setUpClass=classmethod(fixture.CommonObjects.setUpClass.__func__)
    tearDownClass=classmethod(fixture.CommonObjects.tearDownClass.__func__)
    setUp=fixture.CommonObjects.setUp
    tearDown=fixture.CommonObjects.tearDown
    open_store=fixture.CommonObjects.open_store

    def other_store(self):
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':mkdir-other',kind='test')
        self.fixture_ids.append(value['workspaceId'])
        binding=Binding(str(Path(self.binding.root).parent/value['workspaceId']),value['workspaceId'],value['capability'])
        store=ObjectStore(self.config,binding);self.stores.append(store);historical_mkdir(store,'');return store

    def test_historical_matrix_keeps_root_unicode_path_and_exact_errors(self):
        other=self.other_store()
        actions=[('',False,False),('',False,True),('.',True,True),('missing/child',False,False),
                 ('parent/child',False,False),('file/child',True,False),('file',True,True),
                 ('ñ 😀/ spaces /deep',True,False),('repeat//dot/./last/',True,False),
                 ('parent/child',False,False),('../escape',True,False),('colon:',True,False)]
        outcomes=[];contents=[]
        for store,call in ((other,historical_mkdir),(self.store,ObjectStore.mkdir)):
            historical_mkdir(store,'parent');store.write_small('file',b'SYNTHETIC ORIGINAL')
            observed=[]
            for key,parents,exist_ok in actions:
                try:call(store,key,parents=parents,exist_ok=exist_ok);observed.append(('OK',))
                except OSError as error:observed.append((type(error).__name__,error.errno,error.filename))
                except StoreError as error:observed.append((type(error).__name__,str(error)))
                except psycopg.Error as error:observed.append((type(error).__name__,error.sqlstate,error.diag.message_primary))
                self.assertEqual(store.raw.info.transaction_status,psycopg.pq.TransactionStatus.IDLE)
            outcomes.append(observed)
            contents.append(store.raw.execute('SELECT path,kind,revision,object_id IS NOT NULL,store_id IS NOT NULL FROM orbita_common.entries ORDER BY path COLLATE "C"').fetchall())
            self.assertEqual(store.read_bytes('file'),b'SYNTHETIC ORIGINAL')
        self.assertEqual(outcomes[0],outcomes[1]);self.assertEqual(contents[0],contents[1])

    def test_nested_success_and_filesystem_error_preserve_caller_rollback(self):
        self.store.raw.execute('BEGIN')
        try:
            self.store.mkdir('pending/first',parents=True)
            with self.assertRaises(FileNotFoundError) as failed:self.store.mkdir('missing/child')
            self.assertEqual(failed.exception.filename,'missing')
            self.assertEqual(self.store.raw.info.transaction_status,psycopg.pq.TransactionStatus.INTRANS)
            self.store.mkdir('pending/second')
            with self.open_store(read_only=True) as reader:self.assertFalse(reader.exists('pending'))
        finally:self.store.raw.rollback()
        self.assertFalse(self.store.exists('pending'))

    def test_real_sql_failure_rolls_back_inserted_parents_and_nested_savepoint(self):
        token=uuid.uuid4().hex;function='mkdir_fault_'+token;trigger='mkdir_fault_'+token
        with connect_operator(self.operator) as admin:
            admin.execute(sql.SQL("CREATE FUNCTION orbita_common.{}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$ BEGIN IF NEW.workspace_id={}::uuid AND NEW.path='fault/a/leaf' THEN RAISE EXCEPTION 'SYNTHETIC_MKDIR_FAILURE';END IF;RETURN NEW;END $body$").format(sql.Identifier(function),sql.Literal(self.binding.workspace_id)))
            admin.execute(sql.SQL('CREATE TRIGGER {} BEFORE INSERT ON orbita_common.entries FOR EACH ROW EXECUTE FUNCTION orbita_common.{}()').format(sql.Identifier(trigger),sql.Identifier(function)))
            try:
                for nested in (False,True):
                    if nested:self.store.raw.execute('BEGIN');self.store.mkdir('caller-kept')
                    try:
                        with self.assertRaisesRegex(psycopg.Error,'SYNTHETIC_MKDIR_FAILURE'):self.store.mkdir('fault/a/leaf',parents=True)
                        expected=psycopg.pq.TransactionStatus.INTRANS if nested else psycopg.pq.TransactionStatus.IDLE
                        self.assertEqual(self.store.raw.info.transaction_status,expected)
                        self.assertFalse(self.store.exists('fault'))
                        if nested:self.assertTrue(self.store.exists('caller-kept'));self.store.mkdir('caller-continued')
                    finally:
                        if nested:self.store.raw.rollback()
                self.assertFalse(self.store.exists('caller-kept'));self.assertFalse(self.store.exists('caller-continued'))
            finally:
                self.store.raw.rollback()
                admin.execute(sql.SQL('DROP TRIGGER {} ON orbita_common.entries').format(sql.Identifier(trigger)))
                admin.execute(sql.SQL('DROP FUNCTION orbita_common.{}()').format(sql.Identifier(function)))

    def test_parallel_exclusive_and_idempotent_creators_share_original_lock(self):
        barrier=Barrier(4,timeout=15)
        def create():
            with ObjectStore(self.config,self.binding) as store:
                barrier.wait()
                try:store.mkdir('parallel/a/leaf',parents=True);first='CREATED'
                except FileExistsError:first='EXISTS'
                barrier.wait();store.mkdir('parallel/a/leaf',parents=True,exist_ok=True)
                return first
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures=[pool.submit(create) for _ in range(4)];results=[f.result(timeout=30) for f in futures]
        self.assertEqual(sorted(results),['CREATED','EXISTS','EXISTS','EXISTS'])
        self.assertEqual(self.store.raw.execute("SELECT path FROM orbita_common.entries WHERE path<>'' ORDER BY path").fetchall(),[('parallel',),('parallel/a',),('parallel/a/leaf',)])

    def test_read_only_revocation_isolation_and_invoker_authority_remain_fresh(self):
        self.store.mkdir('kept');foreign=self.other_store();foreign.mkdir('foreign-only')
        self.assertFalse(self.store.exists('foreign-only'));self.assertFalse(foreign.exists('kept'))
        with self.open_store(read_only=True) as reader:
            with self.assertRaisesRegex(StoreError,'READ_ONLY'):reader.mkdir('kept',exist_ok=True)
        for path in ('../escape','/absolute','with\\separator','control\x1f','colon:'):
            with self.assertRaises(psycopg.Error):self.store.raw.execute('SELECT orbita_common.make_directory(%s,true,true)',(path,))
        with connect_operator(self.operator) as admin:
            authority=admin.execute("SELECT p.prosecdef,p.provolatile,p.proconfig,EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) FROM pg_proc p WHERE p.oid='orbita_common.make_directory(text,boolean,boolean)'::regprocedure").fetchone()
            self.assertEqual(authority,(False,'v',['search_path=pg_catalog'],False))
            prior=admin.execute('SELECT path,kind FROM orbita_common.entries WHERE workspace_id=%s ORDER BY path',(self.binding.workspace_id,)).fetchall()
            admin.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.binding.workspace_id,))
            with self.assertRaises((OSError,psycopg.Error,StoreError)):self.store.mkdir('kept',exist_ok=True)
            self.assertEqual(admin.execute('SELECT path,kind FROM orbita_common.entries WHERE workspace_id=%s ORDER BY path',(self.binding.workspace_id,)).fetchall(),prior)
        foreign.mkdir('still-authorized');self.assertTrue(foreign.exists('still-authorized'))


if __name__=='__main__':unittest.main()

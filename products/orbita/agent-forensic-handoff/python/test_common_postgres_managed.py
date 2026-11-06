"""Managed authority, real concurrent admission and atomic whole-child purge."""
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import os
import threading
import time
import unittest
import uuid

import psycopg

from orbita_store import StoreError
from orbita_store.admin import connect_operator, provision_workspace
from orbita_store.config import Binding, parse_config
from orbita_store.connection import Connection
from orbita_store.objects import ObjectStore
from orbita_store.schema import install_family
from orbita_store.session import Session
from orbita_store.leases import StoreLease
from orbita_store.transfers import StoreExport

SCHEMAS=Path(__file__).parent/'orbita_store/schemas'
FUTURE_SCHEMA='''CREATE TABLE parents(id TEXT PRIMARY KEY,body TEXT);
CREATE TABLE children(id TEXT PRIMARY KEY,parent TEXT REFERENCES parents(id));
CREATE TRIGGER parents_immutable BEFORE DELETE ON parents BEGIN SELECT RAISE(ABORT, 'append only'); END;'''


class ManagedCommon(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_OPERATOR_CONFIG']).read_text(encoding='utf8'))
        cls.base=parse_config(json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text(encoding='utf8')))
        cls.run_id=str(uuid.uuid4());cls.fixture_ids=[]
        with connect_operator(cls.operator) as db:
            assert db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0]==cls.base.instance_id
            install_family(db,'access',(SCHEMAS/'access.sql').read_text(encoding='utf8'))
            install_family(db,'semantic',(SCHEMAS/'semantic.sql').read_text(encoding='utf8'))
            db.execute("INSERT INTO orbita_private.families(name) VALUES('managed_fixture') ON CONFLICT DO NOTHING")
            install_family(db,'managed_fixture',FUTURE_SCHEMA)

    def setUp(self):
        self.owned=[]
        self.parent,self.control=self.make_control('control')
        self.local='ws-'+str(uuid.uuid4())

    def keep(self,value):self.owned.append(value);return value

    def make_control(self,label):
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':'+self._testMethodName+':'+label,kind='test')
        self.fixture_ids.append(value['workspaceId'])
        binding=Binding(str(Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/value['workspaceId']),value['workspaceId'],value['capability'])
        cfg=replace(self.base,bindings=(binding,))
        control=self.keep(Connection(Path(binding.root)/'control/access.pgstore',family='access',config=cfg,create=True))
        control.executescript((SCHEMAS/'access.sql').read_text(encoding='utf8'))
        control.execute("INSERT INTO users VALUES('owner','owner','salt','derived-only',1,1,1)")
        return binding,control

    def body(self,local=None):
        now=datetime.now(timezone.utc)
        date=lambda days:(now+timedelta(days=days)).isoformat(timespec='milliseconds').replace('+00:00','Z')
        return dict(id=local or self.local,owner='owner',revision=1,status='active',policy=dict(rightsUntil=date(1),retainUntil=date(2)),legalHold=False,externalCopies=[])

    def seed(self,control=None,body=None):
        control=control or self.control;body=body or self.body();local=body['id']
        control.execute('INSERT INTO workspaces VALUES(?,?,?)',(local,1,json.dumps(body)))
        control.execute("INSERT INTO members VALUES(?,'owner','owner',1)",(local,))
        control.execute("INSERT INTO audit(at,actor,action,workspace,detail) VALUES('now','owner','workspace_created',?,'{}')",(local,))
        return body

    def provision(self,control=None,local=None):
        result=(control or self.control).raw.execute('SELECT orbita_common.provision_managed(%s)',(local or self.local,)).fetchone()[0]
        self.fixture_ids.append(result['workspaceId']);return result

    def create(self):
        with self.control.raw.transaction():self.seed();return self.provision()

    def metadata(self,mode='state',control=None,local=None):
        return (control or self.control).raw.execute('SELECT orbita_common.managed_binding(%s,%s)',(local or self.local,mode)).fetchone()[0]

    def binding(self,mode='maintenance',control=None,parent=None,local=None):
        value=self.metadata(mode,control,local)
        return Binding(str(Path((parent or self.parent).root)/'control/spaces'/(local or self.local)),value['workspaceId'],value['capability'])

    def session(self,binding):return self.keep(Session(self.base,binding))

    def update(self,**fields):
        body=json.loads(self.control.execute('SELECT payload FROM workspaces WHERE id=?',(self.local,)).fetchone()[0]);body.update(fields)
        self.control.execute('UPDATE workspaces SET payload=?,revision=revision+1 WHERE id=?',(json.dumps(body),self.local));return body

    def purge(self):return self.control.raw.execute('SELECT orbita_common.purge_managed(%s)',(self.local,)).fetchone()[0]

    def data(self,binding,family='managed_fixture',key='data/future.pgstore'):
        cfg=replace(self.base,bindings=(binding,))
        db=self.keep(Connection(Path(binding.root)/key,family=family,config=cfg,create=True))
        db.executescript(FUTURE_SCHEMA if family=='managed_fixture' else (SCHEMAS/(family+'.sql')).read_text(encoding='utf8'));return db

    def tearDown(self):
        for item in reversed(self.owned):item.close()

    @classmethod
    def tearDownClass(cls):
        from orbita_store.pool import close_idle
        close_idle()
        path=Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('managed-fixtures-'+cls.run_id+'.json')
        path.write_text(json.dumps(dict(runId=cls.run_id,instanceId=cls.base.instance_id,workspaceIds=cls.fixture_ids),indent=2),encoding='utf8')

    def test_atomic_create_rollback_initial_bytes_and_idempotency(self):
        with self.assertRaisesRegex(RuntimeError,'abort fixture'):
            with self.control.raw.transaction():
                self.seed();result=self.provision();raise RuntimeError('abort fixture')
        self.assertEqual(self.control.execute('SELECT count(*) FROM workspaces').fetchone(),(0,))
        self.assertEqual(self.control.execute('SELECT count(*) FROM members').fetchone(),(0,))
        self.assertEqual(self.control.execute('SELECT count(*) FROM audit').fetchone(),(0,))
        with connect_operator(self.operator) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM orbita_private.workspaces WHERE id=%s',(result['workspaceId'],)).fetchone(),(0,))
            self.assertEqual(db.execute('SELECT count(*) FROM orbita_common.entries WHERE workspace_id=%s',(result['workspaceId'],)).fetchone(),(0,))
        result=self.create();again=self.provision()
        self.assertTrue(result['created']);self.assertFalse(again['created']);self.assertEqual(result['workspaceId'],again['workspaceId'])
        with ObjectStore(self.base,self.binding()) as files:
            self.assertEqual(files.read_bytes('data/library.json'),b'[]');self.assertEqual(len(files.listdir('data')),1)
        self.assertFalse(Path(self.parent.root).exists())

    def test_same_logical_id_in_two_controls_never_shares_authority(self):
        a=self.create();parent2,control2=self.make_control('second')
        with control2.raw.transaction():self.seed(control2);b=self.provision(control2)
        self.assertNotEqual(a['workspaceId'],b['workspaceId'])
        first=self.binding('worker');second=self.binding('worker',control2,parent2)
        with self.assertRaises(StoreError):Session(self.base,replace(first,capability=second.capability))
        s=self.session(first);t=self.session(second)
        self.assertEqual(s.raw.execute('SELECT current_database()').fetchone(),t.raw.execute('SELECT current_database()').fetchone())
        self.assertEqual(s.raw.execute('SELECT DISTINCT workspace_id::text FROM orbita_common.entries').fetchall(),[(first.workspace_id,)])
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):s.raw.execute('SELECT maintenance_secret FROM orbita_private.managed_workspaces')
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):s.raw.execute("SELECT orbita_common.managed_binding(%s,'worker')",(self.local,))
        with self.assertRaises(psycopg.Error):s.raw.execute("INSERT INTO orbita_common.entries(workspace_id,path,kind) VALUES(%s,'stolen','directory')",(second.workspace_id,))

    def test_only_control_can_provision_and_owner_is_required(self):
        self.seed();self.control.execute('DELETE FROM members')
        with self.assertRaisesRegex(psycopg.Error,'OWNER_REQUIRED'):self.provision()
        self.control.execute("INSERT INTO members VALUES(?,'owner','owner',1)",(self.local,));self.provision()
        child=self.binding();nested=self.data(child,'access','data/nested.pgstore')
        with self.assertRaisesRegex(psycopg.Error,'CONTROL_AUTHORITY'):nested.raw.execute('SELECT orbita_common.provision_managed(%s)',(self.local,))
        reader=self.keep(Connection(Path(self.parent.root)/'control/access.pgstore',family='access',config=replace(self.base,bindings=(self.parent,)),read_only=True))
        with self.assertRaisesRegex(psycopg.Error,'CONTROL_AUTHORITY'):reader.raw.execute("SELECT orbita_common.managed_binding(%s,'maintenance')",(self.local,))
        for bad in (None,'../ws',str(uuid.uuid4())):
            with self.assertRaisesRegex(psycopg.Error,'MANAGED_ID'):self.control.raw.execute('SELECT orbita_common.provision_managed(%s)',(bad,))

    def test_membership_rotates_worker_but_not_maintenance_or_external_copy(self):
        self.create();worker=self.binding('worker');maint=self.binding();s=self.session(worker);m=self.session(maint)
        original=self.metadata()['epoch'];self.update(externalCopies=[dict(id='copy',state='outstanding')])
        self.assertEqual(self.metadata()['epoch'],original)
        self.control.execute("INSERT INTO members VALUES(?,'reader','reader',1)",(self.local,))
        self.assertEqual(self.metadata()['epoch'],original+1)
        self.assertIsNone(s.raw.execute('SELECT orbita_common.workspace_id()').fetchone()[0])
        self.assertEqual(s.raw.execute('SELECT count(*) FROM orbita_common.entries').fetchone(),(0,))
        self.assertEqual(m.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone(),(maint.workspace_id,))
        with self.assertRaises(StoreError):Session(self.base,worker)
        fresh=self.binding('worker');self.assertNotEqual(worker.capability,fresh.capability)
        self.session(fresh)
        self.control.execute("DELETE FROM members WHERE workspace=? AND user='reader'",(self.local,))
        with self.assertRaises(StoreError):Session(self.base,fresh)

    def test_suspend_resume_never_revives_old_worker_capability(self):
        self.create();old=self.binding('worker');s=self.session(old);maint=self.binding()
        self.update(status='suspended')
        with self.assertRaisesRegex(psycopg.Error,'MANAGED_INACTIVE'):self.binding('worker')
        self.assertIsNone(s.raw.execute('SELECT orbita_common.workspace_id()').fetchone()[0])
        self.session(maint);self.update(status='active')
        with self.assertRaises(StoreError):Session(self.base,old)
        self.session(self.binding('worker'))

    def test_real_server_deadline_revokes_existing_and_new_workers(self):
        self.create();body=self.body()
        with connect_operator(self.operator) as operator:
            until=operator.execute("SELECT clock_timestamp()+interval '700 milliseconds'").fetchone()[0]
        body['policy']['rightsUntil']=until.isoformat(timespec='milliseconds').replace('+00:00','Z')
        self.update(policy=body['policy']);worker=self.binding('worker');s=self.session(worker)
        self.assertEqual(s.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone(),(worker.workspace_id,))
        limit=time.monotonic()+3
        while s.raw.execute('SELECT orbita_common.workspace_id()').fetchone()[0] is not None:
            self.assertLess(time.monotonic(),limit);time.sleep(.03)
        with self.assertRaises(StoreError):Session(self.base,worker)
        self.session(self.binding())

    def test_parent_revocation_also_denies_maintenance(self):
        self.create();worker=self.binding('worker');maint=self.binding();w=self.session(worker);m=self.session(maint)
        with connect_operator(self.operator) as db:db.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.parent.workspace_id,))
        for s in (w,m):self.assertIsNone(s.raw.execute('SELECT orbita_common.workspace_id()').fetchone()[0])
        for binding in (worker,maint):
            with self.assertRaises(StoreError):Session(self.base,binding)
        with self.assertRaisesRegex(psycopg.Error,'CONTROL_AUTHORITY'):self.metadata('maintenance')

    def test_purge_rejects_each_live_reader_writer_export_lease_and_database(self):
        self.create();binding=self.binding();cfg=replace(self.base,bindings=(binding,))
        self.update(status='purge_prepared')
        db=self.data(binding);db.execute("INSERT INTO parents VALUES('p','literal')");db.close()
        for kind in ('session','reader','writer','export','lease','database'):
            with self.subTest(kind=kind):
                files=None
                if kind=='session':held=Session(self.base,binding)
                elif kind in ('reader','writer'):
                    files=ObjectStore(self.base,binding);held=files.open_read('data/library.json') if kind=='reader' else files.open_write('data/unpublished')
                    if kind=='writer':held.write(b'unpublished')
                elif kind=='export':held=StoreExport(Path(binding.root)/'data/future.pgstore',config=cfg)
                elif kind=='lease':held=StoreLease(Path(binding.root)/'data',config=cfg)
                else:held=Connection(Path(binding.root)/'data/future.pgstore',family='managed_fixture',config=cfg)
                try:
                    with self.assertRaisesRegex(psycopg.errors.ObjectInUse,'LIVE_CONSUMER'):self.purge()
                    self.assertFalse(self.metadata()['purged'])
                finally:
                    if kind=='writer':held.abort()
                    else:held.close()
                    if files:files.close()
        result=self.purge();self.assertTrue(result['purged']);self.assertEqual(result['rows'],1)

    def test_consumer_inventory_counts_actual_revoked_sessions_pins_and_leases(self):
        self.create();binding=self.binding();worker=self.binding('worker');cfg=replace(self.base,bindings=(binding,))
        observe=lambda:self.control.raw.execute('SELECT orbita_common.managed_consumers(%s)',(self.local,)).fetchone()[0]
        self.assertEqual(observe()['backends'],0)
        session=self.session(worker);files=self.keep(ObjectStore(self.base,binding));reader=files.open_read('data/library.json')
        lease=self.keep(StoreLease(Path(binding.root)/'data',config=cfg))
        current=observe();self.assertEqual((current['backends'],current['sessions'],current['pins'],current['leases']),(3,3,1,1))
        with self.assertRaisesRegex(psycopg.Error,'CONTROL_AUTHORITY_REQUIRED'):
            session.raw.execute('SELECT orbita_common.managed_consumers(%s)',(self.local,))
        self.update(status='suspended')
        self.assertEqual(observe(),current)
        # The pin survives reassignment, so the inventory cannot rely on the
        # session table alone, nor on current RLS visibility after revocation.
        files.raw.execute('SELECT orbita_common.authorize_workspace(%s,%s,false)',(self.parent.workspace_id,self.parent.capability))
        rebound=observe();self.assertEqual((rebound['backends'],rebound['sessions'],rebound['pins'],rebound['leases']),(3,2,1,1))
        files.raw.execute('SELECT orbita_common.authorize_workspace(%s,%s,false)',(binding.workspace_id,binding.capability))
        reader.close();files.close();lease.close();session.close()
        self.assertEqual(observe(),dict(workspaceId=binding.workspace_id,backends=0,sessions=0,pins=0,leases=0))

    def test_live_pin_remains_busy_after_its_owner_binds_another_workspace(self):
        self.create();binding=self.binding();self.update(status='purge_prepared')
        files=self.keep(ObjectStore(self.base,binding));reader=files.open_read('data/library.json')
        # Explicit deauthorize is the existing release-all-pins operation.
        # Rebinding instead retains the real pin but removes the child's
        # session row, so purge must inspect pins as well as authorizations.
        files.raw.execute('SELECT orbita_common.authorize_workspace(%s,%s,false)',(self.parent.workspace_id,self.parent.capability))
        with self.assertRaisesRegex(psycopg.errors.ObjectInUse,'LIVE_CONSUMER'):self.purge()
        # Reauthenticate the exact owner before releasing its pin normally.
        files.raw.execute('SELECT orbita_common.authorize_workspace(%s,%s,false)',(binding.workspace_id,binding.capability))
        reader.close();files.close();self.purge()

    def test_purge_rolls_back_on_real_lock_failure_then_removes_all_child_data(self):
        self.create();binding=self.binding();db=self.data(binding)
        db.execute("INSERT INTO parents VALUES('p','literal')");db.execute("INSERT INTO children VALUES('c','p')");db.close()
        history=self.data(binding,'semantic','data/history.pgstore')
        history.execute("INSERT INTO record_versions VALUES('r','scope',1,'now','{}','hash','req','request-hash')");history.close()
        with ObjectStore(self.base,binding) as files:
            files.write_bytes('data/bytes',b'only this child')
            files.raw.execute("SELECT orbita_common.prepare_restore('data','{\"schema\":\"orbita-restore-2\",\"id\":\"12345678-1234-1234-1234-123456789abc\"}'::jsonb)")
        self.update(status='purge_failed')
        with connect_operator(self.operator) as locker:
            with locker.transaction():
                locker.execute('LOCK TABLE orbita_common.chunk_blobs IN ACCESS EXCLUSIVE MODE')
                with self.assertRaises(psycopg.errors.LockNotAvailable):
                    with self.control.raw.transaction():
                        self.control.raw.execute("SET LOCAL lock_timeout='100ms'");self.purge()
        self.assertFalse(self.metadata()['purged'])
        with ObjectStore(self.base,binding) as files:self.assertEqual(files.read_bytes('data/bytes'),b'only this child')
        restored=self.data(binding);self.assertEqual(restored.execute('SELECT id,parent FROM children').fetchall(),[('c','p')]);restored.close()
        result=self.purge();self.assertEqual((result['stores'],result['rows'],result['files']),(2,3,2));self.assertEqual(result,self.purge())
        with connect_operator(self.operator) as operator:
            for schema,table,column in [('orbita_private','stores','workspace_id'),('orbita_common','entries','workspace_id'),('orbita_common','objects','workspace_id'),('orbita_common','object_chunks','workspace_id'),('orbita_common','chunk_blobs','workspace_id'),('orbita_private','restore_controls','workspace_id'),('orbita_private','restore_control_events','workspace_id')]:
                self.assertEqual(operator.execute(f'SELECT count(*) FROM {schema}.{table} WHERE {column}=%s',(binding.workspace_id,)).fetchone(),(0,))
        self.update(status='purged',policy={})
        self.assertEqual(self.metadata()['purge'],result)
        with self.assertRaises(StoreError):Session(self.base,binding)
        with self.assertRaisesRegex(psycopg.Error,'MANAGED_PURGE_STATE'):self.update(status='active',policy=self.body()['policy'])

    def test_control_tombstone_cannot_be_removed_by_generic_tree_purge(self):
        self.create();self.update(status='purge_prepared');self.purge();self.control.close()
        with ObjectStore(self.base,self.parent) as files:
            with self.assertRaises(psycopg.errors.ForeignKeyViolation):files.purge_tree('control',recursive=True)
            self.assertTrue(files.exists('control/access.pgstore'))

    def test_unknown_unprepared_and_held_workspace_are_not_purged(self):
        with self.assertRaisesRegex(psycopg.Error,'MANAGED_UNKNOWN'):self.purge()
        self.create()
        with self.assertRaisesRegex(psycopg.Error,'NOT_PREPARED'):self.purge()

        with self.assertRaisesRegex(psycopg.Error,'PURGE_STATE'):self.update(status='purged',policy={})
        self.update(status='purge_prepared',legalHold=True)
        with self.assertRaisesRegex(psycopg.Error,'NOT_PREPARED'):self.purge()
        self.update(legalHold=False,externalCopies=[dict(state='outstanding')])
        with self.assertRaisesRegex(psycopg.Error,'NOT_PREPARED'):self.purge()

    def test_delegation_never_exports_maintenance_or_revoked_authority(self):
        self.create()
        worker=self.session(self.binding('worker'))
        maintenance=self.session(self.binding('maintenance'))
        allowed=lambda session:session.raw.execute('SELECT orbita_common.worker_delegation_allowed()').fetchone()[0]
        self.assertTrue(allowed(self.control.session))
        self.assertTrue(allowed(worker));self.assertFalse(allowed(maintenance))
        self.update(status='suspended')
        self.assertFalse(allowed(worker));self.assertFalse(allowed(maintenance))

    def test_waiting_admission_reads_purge_commit_and_cannot_reopen_child(self):
        self.create();binding=self.binding();self.update(status='purge_prepared');started=threading.Event()
        def admit():
            with psycopg.connect(**self.base.connection_parameters(),autocommit=True) as db:
                db.execute("SET statement_timeout='5s'");started.set()
                db.execute('SELECT orbita_common.authorize_workspace(%s,%s,false)',(binding.workspace_id,binding.capability))
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.control.raw.transaction():
                self.control.raw.execute("SELECT pg_advisory_xact_lock(hashtextextended('managed-admission:' || %s,0))",(binding.workspace_id,))
                pending=pool.submit(admit);self.assertTrue(started.wait(2))
                with self.assertRaises(TimeoutError):pending.result(timeout=.05)
                result=self.purge();self.assertTrue(result['purged'])
            with self.assertRaisesRegex(psycopg.Error,'ACCESS_DENIED'):pending.result(timeout=5)

    def test_purge_waits_for_uncommitted_admission_then_observes_live_owner(self):
        self.create();binding=self.binding();self.update(status='purge_prepared');started=threading.Event()
        def purge_other():
            db=Connection(Path(self.parent.root)/'control/access.pgstore',family='access',config=replace(self.base,bindings=(self.parent,)))
            try:started.set();return db.raw.execute('SELECT orbita_common.purge_managed(%s)',(self.local,)).fetchone()[0]
            finally:db.close()
        with psycopg.connect(**self.base.connection_parameters(),autocommit=True) as owner,ThreadPoolExecutor(max_workers=1) as pool:
            owner_identity=owner.execute('SELECT pid,backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()').fetchone()
            with owner.transaction():
                owner.execute('SELECT orbita_common.authorize_workspace(%s,%s,false)',(binding.workspace_id,binding.capability))
                pending=pool.submit(purge_other);self.assertTrue(started.wait(2))
                with self.assertRaises(TimeoutError):pending.result(timeout=.05)
            with self.assertRaisesRegex(psycopg.errors.ObjectInUse,'LIVE_CONSUMER'):pending.result(timeout=5)
        # Closing the client socket does not acknowledge the server's exit.
        # Keep the live-consumer protection intact and observe this exact backend.
        deadline=time.monotonic()+5
        while True:
            self.control.raw.execute('SELECT pg_stat_clear_snapshot()')
            if not self.control.raw.execute('SELECT 1 FROM pg_stat_activity WHERE pid=%s AND backend_start=%s',owner_identity).fetchone():break
            self.assertLess(time.monotonic(),deadline,'Owner backend remained alive after local close')
            time.sleep(.005)
        self.assertTrue(self.purge()['purged'])


if __name__=='__main__':unittest.main()

"""Revocation must cross old MVCC snapshots without sacrificing READ ONLY.

All sixteen inherited managed contracts run in the same class. New cases keep
three admitted readers alive while another owned connection commits authority
changes. No historical data, capabilities, or user text is emitted.
"""
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor, TimeoutError
import hashlib
import threading
import time
import unittest

import psycopg
from psycopg import sql

import test_common_postgres_managed as managed_fixture
from orbita_store import StoreError
from orbita_store.admin import connect_operator
from orbita_store.objects import ObjectStore
from orbita_store.session import Session


class SnapshotAuthority(managed_fixture.ManagedCommon):
    levels=('READ COMMITTED','REPEATABLE READ','SERIALIZABLE')

    def readers(self,binding):
        result=[]
        for level in self.levels:
            session=self.keep(Session(self.base,binding,read_only=True))
            session.raw.execute('BEGIN ISOLATION LEVEL '+level+' READ ONLY')
            self.assertEqual(session.raw.execute('SHOW transaction_read_only').fetchone(),('on',))
            self.assertEqual(session.raw.execute('SHOW transaction_isolation').fetchone(),(level.lower(),))
            self.assertEqual(session.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone(),(binding.workspace_id,))
            count=session.raw.execute('SELECT count(*) FROM orbita_common.entries').fetchone()[0]
            self.assertGreater(count,0)
            result.append((level,session,binding.workspace_id,count))
        return result

    def visible(self,readers,expected):
        for level,session,identity,count in readers:
            # Read both before asserting so the red receipt includes the data
            # exposure, not only a stale authorization identifier.
            authority=session.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone()[0]
            observed=session.raw.execute('SELECT count(*) FROM orbita_common.entries').fetchone()[0]
            with self.subTest(isolation=level,expectedVisible=expected,observedRows=observed):
                self.assertEqual((authority,observed),(identity,count) if expected else (None,0))

    def pair(self):
        self.create()
        return self.readers(self.binding('worker')),self.readers(self.binding('maintenance'))

    def test_snapshot_member_revocation_preserves_maintenance(self):
        workers,maintenance=self.pair()
        self.control.execute("INSERT INTO members VALUES(?,'reader','reader',1)",(self.local,))
        self.visible(workers,False);self.visible(maintenance,True)

    def test_snapshot_suspension_preserves_maintenance(self):
        workers,maintenance=self.pair()
        self.update(status='suspended')
        self.visible(workers,False);self.visible(maintenance,True)

    def test_snapshot_shortened_deadline_preserves_maintenance(self):
        workers,maintenance=self.pair();policy=self.body()['policy']
        policy['rightsUntil']=(datetime.now(timezone.utc)-timedelta(days=1)).isoformat(timespec='milliseconds').replace('+00:00','Z')
        self.update(policy=policy)
        self.visible(workers,False);self.visible(maintenance,True)

    def test_snapshot_parent_revocation_denies_worker_and_maintenance(self):
        workers,maintenance=self.pair()
        with connect_operator(self.operator) as operator:
            operator.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.parent.workspace_id,))
        self.visible(workers,False);self.visible(maintenance,False)

    def test_snapshot_child_revocation_denies_worker_and_maintenance(self):
        workers,maintenance=self.pair()
        with connect_operator(self.operator) as operator:
            operator.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(workers[0][2],))
        self.visible(workers,False);self.visible(maintenance,False)

    def test_snapshot_real_clock_deadline_without_policy_change(self):
        self.create();policy=self.body()['policy']
        with connect_operator(self.operator) as operator:
            until=operator.execute("SELECT clock_timestamp()+interval '1200 milliseconds'").fetchone()[0]
        policy['rightsUntil']=until.isoformat(timespec='milliseconds').replace('+00:00','Z')
        self.update(policy=policy);workers=self.readers(self.binding('worker'));maintenance=self.readers(self.binding())
        deadline=time.monotonic()+4
        while workers[0][1].raw.execute('SELECT statement_timestamp()<%s',(until,)).fetchone()[0]:
            self.assertLess(time.monotonic(),deadline);time.sleep(.02)
        self.visible(workers,False);self.visible(maintenance,True)

    def test_snapshot_nonmanaged_capability_rotation_denies_old_sessions(self):
        readers=self.readers(self.parent)
        with connect_operator(self.operator) as operator:
            capability='synthetic-replacement-'+self.run_id
            operator.execute('UPDATE orbita_private.workspaces SET capability_secret=%s,capability_hash=%s WHERE id=%s',
                (capability,hashlib.sha256(capability.encode()).digest(),self.parent.workspace_id))
        self.visible(readers,False)
        with self.assertRaises(StoreError):Session(self.base,self.parent)

    def test_snapshot_content_remains_repeatable_before_revocation(self):
        self.create();binding=self.binding('worker');readers=self.readers(binding)
        with ObjectStore(self.base,self.binding()) as files:
            files.write_bytes('data/later',b'owned synthetic concurrent content')
        for level,session,identity,count in readers:
            with self.subTest(isolation=level):
                self.assertEqual(session.raw.execute('SELECT count(*) FROM orbita_common.entries').fetchone()[0],count+1 if level=='READ COMMITTED' else count)
                self.assertEqual(session.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone(),(identity,))
        self.update(status='suspended');self.visible(readers,False)

    def test_rolled_back_membership_invalidates_old_readers_but_keeps_policy(self):
        self.create();binding=self.binding('worker');readers=self.readers(binding);before=self.metadata()['epoch']
        with self.assertRaisesRegex(RuntimeError,'owned rollback'):
            with self.control.raw.transaction():
                self.control.execute("INSERT INTO members VALUES(?,'rollback-reader','reader',1)",(self.local,))
                raise RuntimeError('owned rollback')
        self.assertEqual(self.metadata()['epoch'],before)
        self.assertEqual(self.control.execute("SELECT count(*) FROM members WHERE user='rollback-reader'").fetchone(),(0,))
        self.visible(readers,False)
        with Session(self.base,binding,read_only=True) as fresh:
            self.assertEqual(fresh.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone(),(binding.workspace_id,))

    def test_revocation_in_one_domain_keeps_other_domain_readers(self):
        self.create();first=self.readers(self.binding('worker'))
        parent,control=self.make_control('independent-domain')
        with control.raw.transaction():self.seed(control);self.provision(control)
        other=self.readers(self.binding('worker',control,parent))
        self.control.execute("INSERT INTO members VALUES(?,'reader','reader',1)",(self.local,))
        self.visible(first,False);self.visible(other,True)

    def test_sequence_fences_and_mutators_are_inaccessible_to_runtime(self):
        self.create();binding=self.binding('worker');worker=self.session(binding)
        name='authg_'+binding.workspace_id.replace('-','')
        commands=[(sql.SQL('SELECT last_value FROM orbita_private.{}').format(sql.Identifier(name)),()),
            ('SELECT nextval(%s::regclass)',('orbita_private.'+name,)),
            ('SELECT setval(%s::regclass,1,true)',('orbita_private.'+name,)),
            ('SELECT orbita_private.advance_authority(%s,false)',(binding.workspace_id,)),
            ('SELECT orbita_private.prepare_authority(%s)',(binding.workspace_id,))]
        for statement,parameters in commands:
            with self.subTest(statement=str(statement)):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):worker.raw.execute(statement,parameters)
        with connect_operator(self.operator) as operator:
            rows=operator.execute("SELECT cache_size,cycle,data_type::text FROM pg_sequences WHERE schemaname='orbita_private' AND sequencename=ANY(%s)",
                ([name,'authw_'+binding.workspace_id.replace('-','')],)).fetchall()
            self.assertEqual(rows,[(1,False,'bigint'),(1,False,'bigint')])
        self.assertEqual(worker.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone(),(binding.workspace_id,))

    def waiting_admission(self,binding,started):
        started.set()
        with Session(self.base,binding,read_only=True) as session:
            return session.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone()[0]

    def test_waiting_admission_observes_committed_suspension(self):
        self.create();binding=self.binding('worker');started=threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.control.raw.transaction():
                self.update(status='suspended')
                pending=pool.submit(self.waiting_admission,binding,started);self.assertTrue(started.wait(2))
                with self.assertRaises(TimeoutError):pending.result(timeout=.05)
            with self.assertRaises(StoreError):pending.result(timeout=5)

    def test_waiting_admission_after_rollback_captures_current_fences(self):
        self.create();binding=self.binding('worker');started=threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.assertRaisesRegex(RuntimeError,'owned rollback'):
                with self.control.raw.transaction():
                    self.update(status='suspended')
                    pending=pool.submit(self.waiting_admission,binding,started);self.assertTrue(started.wait(2))
                    with self.assertRaises(TimeoutError):pending.result(timeout=.05)
                    raise RuntimeError('owned rollback')
            self.assertEqual(pending.result(timeout=5),binding.workspace_id)

    def test_waiting_admission_observes_parent_commit_for_both_capabilities(self):
        self.create();bindings=[self.binding('worker'),self.binding('maintenance')]
        with connect_operator(self.operator) as operator,ThreadPoolExecutor(max_workers=2) as pool:
            with operator.transaction():
                operator.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.parent.workspace_id,))
                pending=[]
                for binding in bindings:
                    started=threading.Event();pending.append(pool.submit(self.waiting_admission,binding,started));self.assertTrue(started.wait(2))
                for future in pending:
                    with self.assertRaises(TimeoutError):future.result(timeout=.05)
            for future in pending:
                with self.assertRaises(StoreError):future.result(timeout=5)

    def test_existing_snapshots_never_revive_after_suspend_or_parent_reactivation(self):
        workers,maintenance=self.pair()
        self.update(status='suspended');self.update(status='active')
        self.visible(workers,False);self.visible(maintenance,True)
        with connect_operator(self.operator) as operator:
            operator.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.parent.workspace_id,))
            operator.execute('UPDATE orbita_private.workspaces SET active=true WHERE id=%s',(self.parent.workspace_id,))
        self.visible(workers,False);self.visible(maintenance,False)

    def test_parent_identity_kind_change_invalidates_existing_snapshots(self):
        workers,maintenance=self.pair()
        with connect_operator(self.operator) as operator:
            operator.execute("UPDATE orbita_private.workspaces SET kind='personal' WHERE id=%s",(self.parent.workspace_id,))
        self.visible(workers,False);self.visible(maintenance,False)


if __name__=='__main__':unittest.main()

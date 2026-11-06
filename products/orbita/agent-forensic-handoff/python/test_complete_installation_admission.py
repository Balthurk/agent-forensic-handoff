"""Deterministic overlapping admissions, only on the dedicated empty service.

The deployed function is paused after its activity snapshot, without changing
its admission logic. Every test restores its exact definition before leaving.
"""
from contextlib import contextmanager
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
from orbita_store.objects import ObjectStore
from orbita_store.pool import close_idle
from orbita_store.session import Session


FUNCTION = 'orbita_private.admit_session(orbita_private.workspaces,boolean,boolean,bigint)'
ANCHOR = '  SELECT backend_start INTO STRICT started FROM pg_catalog.pg_stat_get_activity(pg_backend_pid());'


class AdmissionConcurrency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator = json.loads(Path(os.environ['ORBITA_INSTALLATION_TEST_OPERATOR']).read_text())
        assert cls.operator['dbname'] == 'orbita_installation'
        assert cls.operator['user'] == 'orbita_install_owner' and cls.operator['port'] != 15438
        assert cls.operator['instanceId'] != 'dc1b1f4a-a445-48a1-9b12-0679686424cf'
        with connect_operator(cls.operator) as db:
            assert db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0] == cls.operator['instanceId']
            cls.original = db.execute('SELECT pg_get_functiondef(%s::regprocedure)', (FUNCTION,)).fetchone()[0]
        assert cls.original.count(ANCHOR) == 1
        cls.run_id = str(uuid.uuid4())
        cls.ids = []
        row = provision_workspace(cls.operator, label='qualification:' + cls.run_id + ':admission-config', kind='test')
        cls.ids.append(row['workspaceId'])
        config = {k: cls.operator[k] for k in ('host', 'port', 'dbname')}
        config.update(schema=1, user='orbita_runtime', password=cls.operator['runtimePassword'], instanceId=cls.operator['instanceId'], bindings=[dict(root=str(Path(os.environ['ORBITA_POSTGRES_TEST_ROOT']) / row['workspaceId']), **row)])
        cls.config = parse_config(config)

    def setUp(self):
        close_idle()
        self.a = self.workspace('victim')
        self.b = self.workspace('delayed')

    def workspace(self, label):
        row = provision_workspace(self.operator, label='qualification:' + self.run_id + ':' + label, kind='test')
        self.ids.append(row['workspaceId'])
        return Binding(str(Path(os.environ['ORBITA_POSTGRES_TEST_ROOT']) / row['workspaceId']), row['workspaceId'], row['capability'])

    def tearDown(self):
        close_idle()
        with connect_operator(self.operator) as db:
            self.assertEqual(db.execute('SELECT pg_get_functiondef(%s::regprocedure)', (FUNCTION,)).fetchone()[0], self.original)

    @classmethod
    def tearDownClass(cls):
        close_idle()
        target = Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS']) / ('fixtures-admission-' + cls.run_id + '.json')
        target.write_text(json.dumps(dict(workspaceIds=cls.ids, instanceId=cls.config.instance_id, temporaryFunctionRestored=True)))

    @contextmanager
    def delayed(self):
        nonce = str(uuid.uuid4())
        key = 100000 + uuid.uuid4().int % 1000000000
        hook = ANCHOR + "\n  IF current_setting('orbita_qualification.admission_barrier',true)='" + nonce + "' THEN PERFORM pg_advisory_xact_lock(" + str(key) + '); END IF;'
        failures = []
        ready = threading.Event()
        identity = {}
        thread = None
        released = False
        with connect_operator(self.operator) as db:
            self.assertEqual(db.execute('SELECT pg_get_functiondef(%s::regprocedure)', (FUNCTION,)).fetchone()[0], self.original)
            db.execute(self.original.replace(ANCHOR, hook, 1))
            db.execute('SELECT pg_advisory_lock(%s)', (key,))

            def admit():
                try:
                    with psycopg.connect(**self.config.connection_parameters(), connect_timeout=5, autocommit=True, application_name='orbita-admission-barrier-test') as client:
                        client.execute("SET statement_timeout='10s'")
                        client.execute("SELECT set_config('orbita_qualification.admission_barrier',%s,false)", (nonce,))
                        identity['pid'] = client.info.backend_pid
                        ready.set()
                        client.execute('SELECT orbita_common.authorize_workspace(%s::uuid,%s,false)', (self.b.workspace_id, self.b.capability))
                        self.assertEqual(client.execute('SELECT orbita_common.workspace_id()::text').fetchone()[0], self.b.workspace_id)
                        client.execute('SELECT orbita_common.deauthorize()')
                except BaseException as error:
                    failures.append(type(error).__name__)
                    ready.set()

            def release():
                nonlocal released
                if not released:
                    released = True
                    db.execute('SELECT pg_advisory_unlock(%s)', (key,))
                thread.join(12)
                self.assertFalse(thread.is_alive(), 'OWNED_ADMISSION_THREAD_NOT_CLOSED')
                self.assertEqual(failures, [])

            try:
                thread = threading.Thread(target=admit, daemon=True)
                thread.start()
                self.assertTrue(ready.wait(5), 'ADMISSION_CONNECTION_NOT_READY')
                deadline = time.monotonic() + 5
                while True:
                    self.assertEqual(failures, [])
                    waiting = db.execute("SELECT count(*) FROM pg_locks WHERE pid=%s AND locktype='advisory' AND objid=%s AND NOT granted", (identity['pid'], key)).fetchone()[0]
                    if waiting:
                        break
                    self.assertLess(time.monotonic(), deadline, 'ADMISSION_BARRIER_NOT_REACHED')
                    time.sleep(.01)
                yield release
            finally:
                try:
                    if thread is not None:
                        release()
                finally:
                    db.execute(self.original)

    def test_new_session_keeps_its_authority_after_older_admission_resumes(self):
        with self.delayed() as release:
            with Session(self.config, self.a) as victim:
                victim.open_store('case.pgstore', 'case', create=True)
                self.assertEqual(victim.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone()[0], self.a.workspace_id)
                self.assertGreater(victim.raw.execute("SELECT count(*) FROM orbita_common.catalogue('case')").fetchone()[0], 0)
                release()
                self.assertEqual(victim.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone()[0], self.a.workspace_id)
                self.assertGreater(victim.raw.execute("SELECT count(*) FROM orbita_common.catalogue('case')").fetchone()[0], 0)

    def test_new_readonly_pinned_reader_keeps_exact_object_bytes(self):
        content = ('literal café 😀\r\n' * 300).encode()
        with ObjectStore(self.config, self.a) as writer:
            writer.mkdir('', parents=True, exist_ok=True)
            writer.write_bytes('literal.bin', content)
        close_idle()
        with self.delayed() as release:
            with ObjectStore(self.config, self.a, read_only=True) as objects:
                with objects.open_read('literal.bin') as reader:
                    release()
                    try:
                        actual = reader.read()
                    except StoreError as error:
                        actual = dict(error=error.code)
                    self.assertEqual(actual, content)

    def test_session_present_in_activity_snapshot_is_a_positive_control(self):
        with Session(self.config, self.a) as victim:
            with self.delayed() as release:
                release()
                self.assertEqual(victim.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone()[0], self.a.workspace_id)

    def test_stale_row_for_same_pid_cannot_authorize_a_new_backend_identity(self):
        with psycopg.connect(**self.config.connection_parameters(), connect_timeout=5, autocommit=True) as client:
            pid, started = client.execute('SELECT pg_backend_pid(),backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()').fetchone()
            with connect_operator(self.operator) as db:
                old = db.execute("SELECT %s::timestamptz-interval '1 second'", (started,)).fetchone()[0]
                db.execute('INSERT INTO orbita_private.sessions(pid,backend_start,workspace_id,read_only,authority_fence,worker_fence) VALUES(%s,%s,%s,true,orbita_private.authority_value(%s,false),orbita_private.authority_value(%s,true))', (pid, old, self.a.workspace_id, self.a.workspace_id, self.a.workspace_id))
                try:
                    self.assertIsNone(client.execute('SELECT orbita_common.workspace_id()').fetchone()[0])
                    self.assertEqual(client.execute("SELECT count(*) FROM orbita_common.catalogue('case')").fetchone()[0], 0)
                finally:
                    db.execute('DELETE FROM orbita_private.sessions WHERE pid=%s AND backend_start=%s', (pid, old))

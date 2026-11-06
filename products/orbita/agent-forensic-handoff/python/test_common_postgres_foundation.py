"""Real PostgreSQL isolation tests. Missing private test configuration is a failure."""
from dataclasses import replace
from pathlib import Path
import json
import os
import unittest
import uuid

import psycopg

from orbita_store import StoreError
from orbita_store.admin import connect_operator, provision_workspace
from orbita_store.config import Binding, parse_config, binding_for
from orbita_store.session import Session


class CommonStoreFoundation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_OPERATOR_CONFIG']).read_text(encoding='utf8'))
        cls.config=parse_config(json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text(encoding='utf8')))
        with connect_operator(cls.operator) as db:
            actual=db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0]
        if actual!=cls.config.instance_id:
            raise RuntimeError('TEST_INSTANCE_MISMATCH')
        cls.run_id=str(uuid.uuid4())
        cls.fixture_ids=[]

    def setUp(self):
        self.sessions=[]
        self.a=self.workspace('a')
        self.b=self.workspace('b')

    def workspace(self,label):
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':'+self._testMethodName+':'+label,kind='test')
        self.fixture_ids.append(value['workspaceId'])
        return Binding(str(Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/value['workspaceId']),value['workspaceId'],value['capability'])

    def session(self,binding,**options):
        s=Session(self.config,binding,**options)
        self.sessions.append(s)
        return s

    def tearDown(self):
        for session in self.sessions:session.close()

    @classmethod
    def tearDownClass(cls):
        # Persist only identities, never capabilities. Cleanup is performed only
        # after the owning runner has preserved the result and evidence.
        output=Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixtures-'+cls.run_id+'.json')
        output.write_text(json.dumps(dict(runId=cls.run_id,instanceId=cls.config.instance_id,workspaceIds=cls.fixture_ids),indent=2),encoding='utf8')

    def test_identical_store_names_have_separate_identity_in_one_database(self):
        a=self.session(self.a);b=self.session(self.b)
        x=a.open_store('cases/same/case','case',create=True)
        y=b.open_store('cases/same/case','case',create=True)
        self.assertNotEqual(x,y)
        self.assertEqual(a.open_store('cases/same/case','case'),x)
        self.assertEqual(a.raw.execute('SELECT current_database()').fetchone(),b.raw.execute('SELECT current_database()').fetchone())
        self.assertEqual(a.raw.execute('SELECT orbita_common.workspace_id()::text,orbita_common.store_id()::text').fetchone(),(self.a.workspace_id,x))
        with self.assertRaises(StoreError):a.open_store('cases/same/case','semantic')
        # A reused transport must lose the former owner's authority, custom
        # settings and session locks before it can serve another workspace.
        backend=b.raw.info.backend_pid
        b.raw.execute("SET orbita_test.previous_owner='must-reset'")
        b.raw.execute('SELECT pg_advisory_lock(77661234)')
        a.close();b.close()
        fresh=self.session(self.a,read_only=True)
        self.assertEqual(fresh.raw.info.backend_pid,backend)
        self.assertEqual(fresh.raw.execute('SELECT orbita_common.workspace_id()::text,orbita_common.store_id()::text,orbita_common.can_write()').fetchone(),(self.a.workspace_id,None,False))
        self.assertIn(fresh.raw.execute("SELECT current_setting('orbita_test.previous_owner',true)").fetchone()[0],(None,''))
        with connect_operator(self.operator) as operator:
            self.assertTrue(operator.execute('SELECT pg_try_advisory_lock(77661234)').fetchone()[0])
            operator.execute('SELECT pg_advisory_unlock(77661234)')
        transport=fresh.raw;fresh.close()
        from orbita_store.pool import close_idle
        close_idle();self.assertTrue(transport.closed)

    def test_no_rows_without_authorization_and_no_setting_can_grant_it(self):
        with psycopg.connect(**self.config.connection_parameters(),autocommit=True) as db:
            db.execute("SELECT set_config('orbita.workspace_id',%s,false)",(self.a.workspace_id,))
            self.assertIsNone(db.execute('SELECT orbita_common.workspace_id()').fetchone()[0])
            self.assertEqual(db.execute('SELECT count(*) FROM orbita_common.entries').fetchone()[0],0)
            with self.assertRaises(psycopg.Error):
                db.execute("INSERT INTO orbita_common.entries(workspace_id,path,kind) VALUES(%s,'hidden','directory')",(self.a.workspace_id,))

    def test_prepared_transport_discards_plans_and_reauthorizes_each_workspace(self):
        for binding,marker in ((self.a,'a-only'),(self.b,'b-only')):
            writer=self.session(binding)
            writer.raw.execute('INSERT INTO orbita_common.entries(path,kind) VALUES(%s,\'directory\')',(marker,))
            writer.close()
        backend=None
        query='SELECT path FROM orbita_common.entries ORDER BY path'
        for binding,marker in ((self.a,'a-only'),(self.b,'b-only'),(self.a,'a-only')):
            reader=self.session(binding,read_only=True)
            if backend is not None:self.assertEqual(reader.raw.info.backend_pid,backend)
            backend=reader.raw.info.backend_pid
            self.assertEqual(reader.raw.execute('SELECT count(*) FROM pg_prepared_statements',prepare=False).fetchone()[0],0)
            for _ in range(8):self.assertEqual(reader.raw.execute(query).fetchall(),[(marker,)])
            self.assertGreater(reader.raw.execute('SELECT count(*) FROM pg_prepared_statements',prepare=False).fetchone()[0],0)
            self.assertFalse(reader.raw.execute('SELECT orbita_common.can_write()').fetchone()[0])
            self.assertEqual(reader.raw.execute("UPDATE orbita_common.entries SET path='forbidden'").rowcount,0)
            reader.close()

    def test_prepared_session_close_rolls_back_uncommitted_content(self):
        writer=self.session(self.a)
        writer.begin()
        writer.raw.execute("INSERT INTO orbita_common.entries(path,kind) VALUES('uncommitted','directory')")
        query='SELECT path FROM orbita_common.entries ORDER BY path'
        for _ in range(8):self.assertEqual(writer.raw.execute(query).fetchall(),[('uncommitted',)])
        self.assertGreater(writer.raw.execute('SELECT count(*) FROM pg_prepared_statements',prepare=False).fetchone()[0],0)
        backend=writer.raw.info.backend_pid;writer.close()
        reader=self.session(self.a,read_only=True)
        self.assertEqual(reader.raw.info.backend_pid,backend)
        self.assertEqual(reader.raw.execute(query).fetchall(),[])
        self.assertEqual(reader.raw.execute('SELECT count(*) FROM pg_prepared_statements',prepare=False).fetchone()[0],0)

    def test_prepared_read_in_repeatable_snapshot_obeys_live_revocation(self):
        writer=self.session(self.a)
        writer.raw.execute("INSERT INTO orbita_common.entries(path,kind) VALUES('before-revocation','directory')")
        writer.close()
        reader=self.session(self.a,read_only=True);reader.begin()
        self.assertEqual(reader.raw.execute('SHOW transaction_isolation').fetchone()[0],'repeatable read')
        query='SELECT path FROM orbita_common.entries ORDER BY path'
        for _ in range(8):self.assertEqual(reader.raw.execute(query).fetchall(),[('before-revocation',)])
        self.assertGreater(reader.raw.execute('SELECT count(*) FROM pg_prepared_statements',prepare=False).fetchone()[0],0)
        with connect_operator(self.operator) as operator:
            operator.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.a.workspace_id,))
        self.assertEqual(reader.raw.execute(query).fetchall(),[])
        self.assertIsNone(reader.raw.execute('SELECT orbita_common.workspace_id()').fetchone()[0])
        reader.close()
        with self.assertRaises(StoreError):Session(self.config,self.a)

    def test_wrong_capability_and_wrong_instance_fail_before_use(self):
        with self.assertRaises(StoreError):Session(self.config,replace(self.a,capability=self.b.capability))
        with self.assertRaises(StoreError):Session(replace(self.config,instance_id=str(uuid.uuid4())),self.a)

    def test_rows_and_foreign_keys_cannot_cross_workspace(self):
        a=self.session(self.a);b=self.session(self.b)
        oid=a.raw.execute('INSERT INTO orbita_common.objects DEFAULT VALUES RETURNING id').fetchone()[0]
        # A file locator can reference only a finalized immutable byte object.
        a.raw.execute("UPDATE orbita_common.objects SET complete=true,size=0,sha256=encode(sha256(''::bytea),'hex') WHERE id=%s",(oid,))
        a.raw.execute("INSERT INTO orbita_common.entries(path,kind,object_id) VALUES('original','file',%s)",(oid,))
        self.assertEqual(b.raw.execute('SELECT count(*) FROM orbita_common.objects').fetchone()[0],0)
        with self.assertRaises(psycopg.Error):b.raw.execute("INSERT INTO orbita_common.entries(path,kind,object_id) VALUES('stolen','file',%s)",(oid,))
        with self.assertRaises(psycopg.Error):a.raw.execute('UPDATE orbita_common.objects SET workspace_id=%s WHERE id=%s',(self.b.workspace_id,oid))
        # Direct deletion is no longer granted, including a zero-row foreign
        # delete. The scoped reclamation API must also retain foreign objects.
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):b.raw.execute('DELETE FROM orbita_common.objects WHERE id=%s',(oid,))
        self.assertEqual(b.raw.execute('SELECT orbita_common.collect_objects(%s::uuid[])',([oid],)).fetchone()[0],0)
        self.assertEqual(a.raw.execute('SELECT count(*) FROM orbita_common.objects WHERE id=%s',(oid,)).fetchone()[0],1)

    def test_runtime_cannot_change_policy_catalogue_or_whole_table(self):
        s=self.session(self.a)
        for command in [
            'SELECT capability_secret FROM orbita_private.workspaces',
            'DELETE FROM orbita_private.sessions',
            'TRUNCATE orbita_common.objects',
            'ALTER TABLE orbita_common.objects DISABLE ROW LEVEL SECURITY',
            'CREATE TABLE public.unowned_test(id integer)',
            'CREATE SCHEMA unowned_test',
            'SET ROLE orbita_admin',
        ]:
            with self.subTest(command=command):
                with self.assertRaises(psycopg.Error):s.raw.execute(command)

    def test_read_only_session_cannot_write_even_outside_explicit_transaction(self):
        writer=self.session(self.a)
        writer.open_store('records','semantic',create=True)
        writer.raw.execute("INSERT INTO orbita_common.entries(path,kind) VALUES('retained','directory')")
        reader=self.session(self.a,read_only=True)
        reader.open_store('records','semantic')
        with self.assertRaises(psycopg.Error):reader.raw.execute('INSERT INTO orbita_common.objects DEFAULT VALUES')
        self.assertEqual(reader.raw.execute("UPDATE orbita_common.entries SET path='changed' WHERE path='retained'").rowcount,0)
        self.assertEqual(reader.raw.execute("DELETE FROM orbita_common.entries WHERE path='retained'").rowcount,0)
        with self.assertRaises(psycopg.Error):reader.raw.execute("SELECT orbita_common.next_rowid('record_versions')")
        self.assertEqual(reader.raw.execute("SELECT path FROM orbita_common.entries WHERE path='retained'").fetchone()[0],'retained')
        with self.assertRaises(StoreError):reader.open_store('new','semantic',create=True)

    def test_revocation_applies_to_existing_connection_and_new_connection(self):
        s=self.session(self.a)
        s.raw.execute("INSERT INTO orbita_common.entries(path,kind) VALUES('owned','directory')")
        with connect_operator(self.operator) as db:db.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.a.workspace_id,))
        self.assertIsNone(s.raw.execute('SELECT orbita_common.workspace_id()').fetchone()[0])
        self.assertEqual(s.raw.execute('SELECT count(*) FROM orbita_common.entries').fetchone()[0],0)
        with self.assertRaises(psycopg.Error):s.raw.execute("INSERT INTO orbita_common.entries(path,kind) VALUES('late','directory')")
        with self.assertRaises(StoreError):Session(self.config,self.a)

    def test_backend_birth_mismatch_denies_same_pid_and_spoofed_settings(self):
        # A stale private session row must not authorize a reused PID. Derive
        # the real birth from the independent system view, then corrupt only
        # this owned synthetic session's birth and restore it in finally.
        from datetime import timedelta
        session=self.session(self.a)
        session.raw.execute("INSERT INTO orbita_common.entries(path,kind) VALUES('retained','directory')")
        pid,born=session.raw.execute('SELECT pid,backend_start FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()').fetchone()
        wrong=born+timedelta(microseconds=1)
        with connect_operator(self.operator) as operator:
            self.assertEqual(operator.execute('UPDATE orbita_private.sessions SET backend_start=%s WHERE pid=%s AND backend_start=%s AND workspace_id=%s',(wrong,pid,born,self.a.workspace_id)).rowcount,1)
        try:
            session.raw.execute("SELECT set_config('orbita.backend_start',%s,false)",(wrong.isoformat(),))
            session.raw.execute("SELECT set_config('orbita.workspace_id',%s,false)",(self.a.workspace_id,))
            self.assertEqual(session.raw.execute('SELECT orbita_common.workspace_id(),orbita_common.can_write()').fetchone(),(None,False))
            self.assertEqual(session.raw.execute('SELECT count(*) FROM orbita_common.entries').fetchone()[0],0)
            with self.assertRaises(psycopg.Error):
                session.raw.execute("INSERT INTO orbita_common.entries(path,kind) VALUES('must-not-appear','directory')")
        finally:
            with connect_operator(self.operator) as operator:
                self.assertEqual(operator.execute('UPDATE orbita_private.sessions SET backend_start=%s WHERE pid=%s AND backend_start=%s AND workspace_id=%s',(born,pid,wrong,self.a.workspace_id)).rowcount,1)
        self.assertEqual(session.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone()[0],self.a.workspace_id)
        self.assertEqual(session.raw.execute('SELECT path FROM orbita_common.entries ORDER BY path').fetchall(),[('retained',)])

    def test_store_counters_are_transactional_and_scoped(self):
        a=self.session(self.a);b=self.session(self.b)
        a.open_store('same','case',create=True);b.open_store('same','case',create=True)
        self.assertEqual(a.raw.execute("SELECT orbita_common.next_rowid('event')").fetchone()[0],1)
        self.assertEqual(b.raw.execute("SELECT orbita_common.next_rowid('event')").fetchone()[0],1)
        a.begin(immediate=True)
        self.assertEqual(a.raw.execute("SELECT orbita_common.next_rowid('event')").fetchone()[0],2)
        a.raw.execute('ROLLBACK')
        self.assertEqual(a.raw.execute("SELECT orbita_common.next_rowid('event')").fetchone()[0],2)

    def test_binding_rejects_escape_and_accepts_long_logical_path(self):
        cfg=replace(self.config,bindings=(self.a,))
        long=Path(self.a.root)/('x'*180)/('y'*150)/'original.jsonl'
        binding,key=binding_for(long,cfg)
        self.assertEqual(binding.workspace_id,self.a.workspace_id)
        self.assertGreater(len(str(long)),260)
        self.assertTrue(key.endswith('original.jsonl'))
        with self.assertRaises(StoreError):binding_for(Path(self.a.root)/'..'/'escape',cfg)
        with self.assertRaises(StoreError):binding_for(Path(self.a.root).parent/'other',cfg)

    def test_binding_rechecks_native_hardlinks_after_an_earlier_plain_lookup(self):
        # This is an explicit native attack fixture, not an operational path.
        # Keep it outside the root whose nonexistence the Node suites verify.
        root=Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/'native-path-safety'/self.a.workspace_id
        cfg=replace(self.config,bindings=(replace(self.a,root=str(root)),))
        root.mkdir(parents=True)
        target=root/'native-original';alias=root/'native-alias'
        target.write_bytes(b'preserved path-safety fixture')
        self.assertEqual(binding_for(target,cfg)[1],'native-original')
        os.link(target,alias)
        for name in (target,alias):
            with self.subTest(name=name.name),self.assertRaisesRegex(StoreError,'HARDLINK'):binding_for(name,cfg)
        self.assertEqual(target.read_bytes(),b'preserved path-safety fixture')
        self.assertEqual(alias.read_bytes(),target.read_bytes())


if __name__=='__main__':unittest.main()

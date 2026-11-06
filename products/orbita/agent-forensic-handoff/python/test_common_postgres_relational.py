"""Real relational semantics and failures in the shared PostgreSQL service."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
import json
import os
import re
import threading
import time
import unittest
import uuid

import psycopg

from orbita_store import StoreError
from orbita_store.admin import connect_operator, provision_workspace
from orbita_store.config import Binding, parse_config
from orbita_store.connection import Connection, Row
from orbita_store.schema import install_family, definitions

ROOT=Path(__file__).resolve().parents[1]


class CommonRelational(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_OPERATOR_CONFIG']).read_text(encoding='utf8'))
        cls.config=parse_config(json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text(encoding='utf8')))
        cls.run_id=str(uuid.uuid4());cls.fixture_ids=[]
        cls.case_schema=(ROOT/'src/schema.sql').read_text(encoding='utf8')
        access=(ROOT.parent/'app/access-store.mjs').read_text(encoding='utf8')
        cls.access_schema=re.search(r'this\.db\.exec\(`(.*?)`\);',access,re.S)[1]
        with connect_operator(cls.operator) as db:
            if db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0]!=cls.config.instance_id:
                raise RuntimeError('TEST_INSTANCE_MISMATCH')
            install_family(db,'case',cls.case_schema)
            install_family(db,'access',cls.access_schema)

    def setUp(self):
        self.connections=[]
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':'+self._testMethodName,kind='test')
        self.fixture_ids.append(value['workspaceId'])
        self.binding=Binding(str(Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/value['workspaceId']),value['workspaceId'],value['capability'])
        self.config=replace(type(self).config,bindings=(self.binding,))

    def connect(self,key='access',family='access',**options):
        db=Connection(Path(self.binding.root)/key,family=family,config=self.config,**options)
        self.connections.append(db)
        return db

    def tearDown(self):
        for db in self.connections:db.close()

    @classmethod
    def tearDownClass(cls):
        target=Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixtures-'+cls.run_id+'.json')
        target.write_text(json.dumps(dict(runId=cls.run_id,instanceId=cls.config.instance_id,workspaceIds=cls.fixture_ids),indent=2),encoding='utf8')

    def source(self,db,id='s',uri='input',sha='hash'):
        return db.execute('INSERT INTO source(id,harness,native_uri,source_kind,raw_sha256,byte_length,compression,availability) VALUES(?,?,?,?,?,?,?,?)',(id,'test',uri,'jsonl',sha,10,'none','retained'))

    def test_real_schema_catalogue_and_unknown_ddl_rejected(self):
        db=self.connect(create=True)
        self.assertEqual(db.execute('SELECT count(*) FROM sqlite_master').fetchone(),(0,))
        ddl=';\n'.join(item['source_sql'] for item in definitions(self.access_schema,'access'))
        with self.assertRaises(psycopg.Error):db.executescript(ddl+'; CREATE TABLE uninstalled(id TEXT);')
        self.assertEqual(db.execute('SELECT count(*) FROM sqlite_master').fetchone(),(0,))
        for item in definitions(self.access_schema,'access'):db.execute(item['source_sql'])
        self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall(),[(n,) for n in sorted(['users','sessions','workspaces','members','audit','attempts','archives','plans'])])
        with self.assertRaises(psycopg.Error):db.execute('CREATE TABLE uninstalled(id TEXT)')
        with self.assertRaises(StoreError):db.execute('PRAGMA integrity_check')
        with self.assertRaises(StoreError):db.execute('SELECT 1; DELETE FROM users')

    def test_rows_insert_without_columns_named_and_positional_access(self):
        db=self.connect(create=True)
        self.assertEqual(db.execute('INSERT INTO members VALUES(?,?,?,1)',('w','u','reader')).rowcount,1)
        db.row_factory=Row
        row=db.execute('SELECT * FROM members').fetchone()
        self.assertEqual(row.keys(),['workspace','user','role','revision'])
        self.assertEqual(tuple(row),('w','u','reader',1))
        self.assertEqual(dict(row),dict(workspace='w',user='u',role='reader',revision=1))
        self.assertEqual(row['ROLE'],'reader')
        self.assertEqual(row[1:3],('u','reader'))

    def test_same_keys_and_foreign_keys_are_store_scoped(self):
        a=self.connect('a',family='case',create=True);b=self.connect('b',family='case',create=True)
        self.source(a)
        self.assertEqual(b.execute('SELECT count(*) FROM source').fetchone(),(0,))
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            b.execute("INSERT INTO source_record(source_id,ordinal,byte_offset,byte_length,sha256,parse_status) VALUES('s',1,0,10,'h','ok')")
        self.source(b)
        b.execute("INSERT INTO source_record(source_id,ordinal,byte_offset,byte_length,sha256,parse_status) VALUES('s',1,0,10,'h','ok')")
        self.assertEqual(a.execute('SELECT count(*) FROM source_record').fetchone(),(0,))

    def test_composite_upsert_updates_only_the_current_store(self):
        a=self.connect('a',create=True);b=self.connect('b',create=True)
        query='INSERT INTO members VALUES(?,?,?,1) ON CONFLICT(workspace,user) DO UPDATE SET role=excluded.role,revision=members.revision+1'
        a.execute(query,('w','u','reader'));b.execute(query,('w','u','reader'))
        self.assertEqual(a.execute(query,('w','u','owner')).rowcount,1)
        self.assertEqual(a.execute('SELECT role,revision FROM members').fetchone(),('owner',2))
        self.assertEqual(b.execute('SELECT role,revision FROM members').fetchone(),('reader',1))

    def test_ignore_unique_conflict_has_zero_changes(self):
        db=self.connect(create=True)
        query='INSERT OR IGNORE INTO attempts VALUES(?,?,?)'
        first=db.execute(query,('a',1,10))
        duplicate=db.execute(query,('a',5,50))
        self.assertEqual((first.rowcount,duplicate.rowcount),(1,0))
        self.assertEqual(duplicate.lastrowid,first.lastrowid)
        self.assertEqual(db.execute('SELECT count,until_at FROM attempts').fetchone(),(1,10))

    def test_replace_deletes_every_unique_conflict_and_allocates_new_rowid(self):
        db=self.connect(create=True)
        db.execute('INSERT INTO users VALUES(?,?,?,?,1,0,1)',('a','one','s','p'))
        db.execute('INSERT INTO users VALUES(?,?,?,?,1,0,1)',('b','two','s','p'))
        replacement=db.execute('INSERT OR REPLACE INTO users VALUES(?,?,?,?,1,1,1)',('a','two','new','new'))
        self.assertEqual(replacement.rowcount,1)
        self.assertGreater(replacement.lastrowid,2)
        self.assertEqual(db.execute('SELECT id,name,admin FROM users').fetchall(),[('a','two',1)])

    def test_replace_fk_failure_rolls_back_statement_not_prior_transaction(self):
        db=self.connect(family='case',create=True)
        self.source(db)
        db.execute("INSERT INTO source_record(source_id,ordinal,byte_offset,byte_length,sha256,parse_status) VALUES('s',1,0,10,'h','ok')")
        db.execute('BEGIN IMMEDIATE')
        self.source(db,id='kept',uri='other')
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            db.execute("INSERT OR REPLACE INTO source(id,harness,native_uri,source_kind,raw_sha256,byte_length,compression,availability) VALUES('s','test','replacement','jsonl','h',20,'none','retained')")
        db.commit()
        self.assertEqual(db.execute('SELECT id,native_uri FROM source ORDER BY id').fetchall(),[('kept','other'),('s','input')])

    def test_explicit_and_null_integer_primary_keys_update_transactional_counter(self):
        db=self.connect(create=True)
        db.execute('INSERT INTO audit(seq,action) VALUES(40,?)',('imported',))
        self.assertEqual(db.execute('INSERT INTO audit(seq,action) VALUES(NULL,?)',('next',)).lastrowid,41)
        db.execute('BEGIN IMMEDIATE')
        self.assertEqual(db.execute("INSERT INTO audit(action) VALUES('rollback')").lastrowid,42)
        db.rollback()
        self.assertEqual(db.execute("INSERT INTO audit(action) VALUES('retained')").lastrowid,42)
        self.assertEqual(db.execute('SELECT seq,rowid FROM audit ORDER BY seq').fetchall(),[(40,40),(41,41),(42,42)])

    def test_returning_and_executemany_keep_rows_and_changes(self):
        db=self.connect(create=True)
        cur=db.execute('INSERT INTO attempts VALUES(?,?,?) RETURNING name,count',('a',1,10))
        self.assertEqual(cur.rowcount,1);self.assertEqual(cur.lastrowid,1);self.assertEqual(cur.fetchone(),('a',1))
        self.assertIsNone(cur.fetchone())
        with db.transaction():
            with self.assertRaises(psycopg.errors.UniqueViolation):
                db.execute('INSERT INTO attempts VALUES(?,?,?) RETURNING name',('a',99,99))
            self.assertEqual(db.execute('SELECT count,until_at FROM attempts WHERE name=?',('a',)).fetchone(),(1,10))
            cur=db.executemany('INSERT INTO attempts VALUES(?,?,?)',[('b',2,20),('c',3,30)])
        self.assertEqual(cur.rowcount,2)
        self.assertEqual(cur.lastrowid,3)
        self.assertEqual(db.execute('UPDATE attempts SET count=count+1 WHERE count>1 RETURNING name,count').fetchall(),[('b',3),('c',4)])

    def test_upsert_update_and_rollback_do_not_replace_last_insert_identity(self):
        db=self.connect(create=True)
        db.execute("INSERT INTO attempts VALUES('a',1,10)")
        self.assertEqual(db.execute("INSERT INTO attempts VALUES('b',2,20)").lastrowid,2)
        upsert="INSERT INTO attempts VALUES('a',3,30) ON CONFLICT(name) DO UPDATE SET count=excluded.count RETURNING *"
        cur=db.execute(upsert)
        self.assertEqual(cur.lastrowid,2)
        self.assertEqual([c[0] for c in cur.description],['name','count','until_at'])
        self.assertEqual(cur.fetchone(),('a',3,10))
        db.execute('BEGIN IMMEDIATE')
        inserted=db.execute("INSERT INTO attempts VALUES('c',4,40)").lastrowid
        db.rollback()
        self.assertEqual(db.execute(upsert).lastrowid,inserted)

    def test_literals_comments_parameters_utf8_blob_and_percent(self):
        db=self.connect(create=True)
        value='á\\x41 ? :name 100% " 😀'
        db.execute('INSERT INTO plans VALUES(:id,:workspace,:payload)',dict(id='a',workspace='w',payload=value))
        row=db.execute("SELECT payload, length(cast(payload AS BLOB)), '100% ? :text' FROM plans WHERE id=? /* ? ignored */",('a',)).fetchone()
        self.assertEqual(row,(value,len(value.encode('utf8')),'100% ? :text'))
        self.assertEqual(db.execute('SELECT :x, :x -- ? ignored',{'x':5}).fetchone(),(5,5))
        with self.assertRaises(StoreError):db.execute('SELECT ?',())

    def test_json_ascii_like_and_null_semantics(self):
        db=self.connect(create=True)
        db.execute('INSERT INTO workspaces VALUES(?,?,?)',('AbC',1,'{"role":"owner","n":3}'))
        self.assertEqual(db.execute("SELECT json_extract(payload,'$.role') FROM workspaces WHERE id LIKE ?",('a%c',)).fetchone(),('owner',))
        self.assertEqual(db.execute("SELECT NULL IS NULL, 'É' LIKE 'é'").fetchone(),(True,False))

    def test_stars_in_join_cte_and_derived_table_do_not_expose_scope(self):
        db=self.connect(create=True)
        db.execute("INSERT INTO members VALUES('w','u','reader',1)")
        db.row_factory=Row
        for query in ['SELECT m.* FROM members m', 'WITH picked AS (SELECT * FROM members) SELECT * FROM picked', 'SELECT d.* FROM (SELECT * FROM members) d']:
            with self.subTest(query=query):
                row=db.execute(query).fetchone()
                self.assertEqual(row.keys(),['workspace','user','role','revision'])

    def test_read_only_blocks_sql_mutation_and_metadata_changes(self):
        writer=self.connect(create=True)
        writer.execute("INSERT INTO attempts VALUES('a',1,10)")
        reader=self.connect(read_only=True)
        self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(1,))
        reader.execute('BEGIN')
        with self.assertRaises(psycopg.errors.UndefinedFunction):reader.execute('SELECT deliberately_uninstalled_function()')
        self.assertTrue(reader.in_transaction)
        self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(1,))
        reader.rollback()
        for source in ["INSERT INTO attempts VALUES('b',2,20)",'DELETE FROM attempts','UPDATE attempts SET count=0']:
            with self.subTest(source=source):
                with self.assertRaises(StoreError):reader.execute(source)
        with self.assertRaises(psycopg.Error):reader.execute(next(definitions(self.access_schema,'access'))['source_sql'])
        ddl=';\n'.join(item['source_sql'] for item in definitions(self.access_schema,'access'))
        with self.assertRaises(psycopg.Error):reader.executescript(ddl)

    def test_no_scope_column_qualified_tables_or_sqlite_fallback(self):
        db=self.connect(create=True)
        for source in ['SELECT _store_id FROM users','SELECT * FROM orbita_access.users','ATTACH DATABASE x AS other','PRAGMA integrity_check']:
            with self.subTest(source=source):
                with self.assertRaises(StoreError):db.execute(source)
        self.assertFalse(Path(self.binding.root).exists())
        with self.assertRaises(StoreError):self.connect('absent',read_only=True)

    def test_concurrent_connections_allocate_unique_rows_in_one_store(self):
        self.connect(create=True)
        def insert(worker):
            db=Connection(Path(self.binding.root)/'access',family='access',config=self.config)
            try:
                with db.transaction(immediate=True):
                    return [db.execute('INSERT INTO audit(action) VALUES(?)',(f'w{worker}:{i}',)).lastrowid for i in range(10)]
            finally:db.close()
        with ThreadPoolExecutor(max_workers=3) as pool:ids=[item for batch in pool.map(insert,range(3)) for item in batch]
        self.assertEqual(sorted(ids),list(range(1,31)))
        self.assertEqual(self.connections[0].execute('SELECT count(*) FROM audit').fetchone(),(30,))

    def test_disconnect_rolls_back_and_never_reconnects_or_replays(self):
        db=self.connect(create=True)
        db.execute('BEGIN IMMEDIATE')
        db.execute("INSERT INTO attempts VALUES('uncommitted',1,10)")
        pid=db.raw.info.backend_pid
        with connect_operator(self.operator) as admin:
            self.assertTrue(admin.execute('SELECT pg_terminate_backend(%s)',(pid,)).fetchone()[0])
        with self.assertRaises(psycopg.Error):db.commit()
        with self.assertRaises(psycopg.Error):db.execute('SELECT count(*) FROM attempts')
        self.assertEqual(self.connect().execute('SELECT count(*) FROM attempts').fetchone(),(0,))

    def test_real_server_cancellation_leaves_no_running_query(self):
        db=self.connect(create=True)
        timer=threading.Timer(0.15,db.interrupt)
        started=time.monotonic();timer.start()
        try:
            with self.assertRaises(psycopg.errors.QueryCanceled):db.execute('SELECT pg_sleep(5)')
        finally:timer.join()
        self.assertLess(time.monotonic()-started,3)
        self.assertEqual(db.execute('SELECT 1').fetchone(),(1,))
        self.assertFalse(db.in_transaction)

    def test_context_rolls_back_exception_and_implicit_transaction_is_explicit(self):
        db=self.connect(create=True,isolation_level='DEFERRED')
        db.execute("INSERT INTO attempts VALUES('a',1,10)")
        self.assertTrue(db.in_transaction)
        self.assertEqual(self.connect().execute('SELECT count(*) FROM attempts').fetchone(),(0,))
        db.commit()
        with self.assertRaisesRegex(ValueError,'fixture rollback'):
            with db:
                db.execute("INSERT INTO attempts VALUES('b',2,20)")
                raise ValueError('fixture rollback')
        self.assertEqual(db.execute('SELECT name FROM attempts').fetchall(),[('a',)])

    def test_compiled_reads_bind_fresh_parameters_and_preserve_savepoint_recovery(self):
        db=self.connect(create=True)
        for name,count in [('first',1),('second',2)]:db.execute('INSERT INTO attempts VALUES(?,?,?)',(name,count,10))
        query="SELECT name,count,? AS supplied,'50% literal' AS literal FROM attempts WHERE name=?"
        for name,count in [('first',1),('second',2),('first',1)]:
            self.assertEqual(db.execute(query,('literal_%:'+name,name)).fetchone(),(name,count,'literal_%:'+name,'50% literal'))
        db.execute('BEGIN IMMEDIATE')
        for unused in range(2):
            self.assertEqual(db.execute('SELECT 10 / ?',(0,)).fetchone(),(None,))
            self.assertEqual(db.execute('SELECT 10 / ?',(2,)).fetchone(),(5,))
            with self.assertRaises(psycopg.errors.InvalidTextRepresentation):db.execute('SELECT CAST(? AS BIGINT)',('invalid-integer',))
            self.assertEqual(db.execute('SELECT CAST(? AS BIGINT)',('7',)).fetchone(),(7,))
            self.assertTrue(db.in_transaction)
        db.execute("UPDATE attempts SET count=3 WHERE name='first'");db.commit()
        self.assertEqual(db.execute(query,('fresh','first')).fetchone(),('first',3,'fresh','50% literal'))

    def test_compiled_read_shapes_and_scopes_never_cache_data_or_authority(self):
        a=self.connect(create=True);a.execute("INSERT INTO attempts VALUES('a',1,10)")
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':compiled-reader-other',kind='test')
        self.fixture_ids.append(value['workspaceId'])
        binding=Binding(str(Path(self.binding.root).parent/value['workspaceId']),value['workspaceId'],value['capability'])
        b=Connection(Path(binding.root)/'access',family='access',config=replace(self.config,bindings=(binding,)),create=True)
        self.connections.append(b);b.execute("INSERT INTO attempts VALUES('b',2,20)")
        query='SELECT * FROM attempts ORDER BY name'
        self.assertEqual(a.execute(query).fetchall(),[('a',1,10)])
        self.assertEqual(b.execute(query).fetchall(),[('b',2,20)])
        a.execute("UPDATE attempts SET count=4")
        self.assertEqual(a.execute(query).fetchall(),[('a',4,10)])
        other_family=self.connect('case',family='case',create=True)
        with self.assertRaises(StoreError):other_family.execute(query)
        with connect_operator(self.operator) as admin:
            admin.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.binding.workspace_id,))
        self.assertEqual(a.execute(query).fetchall(),[])
        self.assertEqual(b.execute(query).fetchall(),[('b',2,20)])
        with self.assertRaises(StoreError):self.connect(read_only=True)


    def test_server_insert_status_rollback_and_same_backend_readmission(self):
        db=self.connect(create=True)
        status=lambda:db.raw.execute('SELECT * FROM orbita_common.insert_status()').fetchone()
        self.assertEqual(status(),(0,None))
        db.execute("INSERT INTO attempts VALUES('a',1,10),('b',2,20),('c',3,30)")
        self.assertEqual(status(),(3,3))
        db.execute('BEGIN IMMEDIATE')
        db.raw.execute('SAVEPOINT status_checkpoint')
        db.execute("INSERT INTO attempts VALUES('d',4,40),('e',5,50)")
        self.assertEqual(status(),(5,5))
        db.raw.execute('ROLLBACK TO SAVEPOINT status_checkpoint')
        db.raw.execute('RELEASE SAVEPOINT status_checkpoint')
        self.assertEqual(status(),(3,3))
        with self.assertRaises(psycopg.errors.UniqueViolation):
            db.execute("INSERT INTO attempts VALUES('a',99,99)")
        self.assertEqual(status(),(3,3));db.commit()
        pid=db.raw.info.backend_pid
        db.raw.execute('SELECT orbita_common.authorize_workspace(%s::uuid,%s,false)',(self.binding.workspace_id,self.binding.capability))
        self.assertEqual(db.raw.info.backend_pid,pid)
        self.assertEqual(status(),(0,None))
        db.session.open_store(db.store_key,'access')
        self.assertEqual(db.execute('SELECT count(*) FROM attempts').fetchone(),(3,))
        self.assertEqual(db.execute("INSERT INTO attempts VALUES('d',4,40)").lastrowid,4)
        self.assertEqual(status(),(1,4))

    def test_server_insert_status_obeys_live_revocation_in_old_snapshot(self):
        db=self.connect(create=True);db.execute("INSERT INTO attempts VALUES('a',1,10)")
        db.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
        self.assertEqual(db.raw.execute('SELECT * FROM orbita_common.insert_status()').fetchall(),[(1,1)])
        with connect_operator(self.operator) as admin:
            admin.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.binding.workspace_id,))
        self.assertEqual(db.raw.execute('SELECT * FROM orbita_common.insert_status()').fetchall(),[])
        db.rollback()
        self.assertEqual(db.raw.execute('SELECT * FROM orbita_common.insert_status()').fetchall(),[])

    def test_server_insert_receipts_are_private_and_close_only_owned_backend(self):
        a=self.connect(create=True);b=self.connect('other',create=True)
        for db in (a,b):db.execute("INSERT INTO attempts VALUES('a',1,10)")
        identity=lambda db:db.raw.execute('SELECT pg_backend_pid(),backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()').fetchone()
        aid,bid=identity(a),identity(b)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            a.raw.execute('SELECT * FROM orbita_private.insert_events')
        a.raw.execute("SET orbita.insert_serial='999'; SET orbita.last_insert_rowid='999'")
        self.assertEqual(a.raw.execute('SELECT * FROM orbita_common.insert_status()').fetchone(),(1,1))
        a.close()
        with connect_operator(self.operator) as admin:
            count=lambda ident:admin.execute('SELECT count(*) FROM orbita_private.insert_events WHERE pid=%s AND backend_start=%s',ident).fetchone()[0]
            self.assertEqual(count(aid),0);self.assertEqual(count(bid),1)
        self.assertEqual(b.raw.execute('SELECT * FROM orbita_common.insert_status()').fetchone(),(1,1))


    def test_raw_concurrent_first_allocations_are_unique_without_adapter_lock(self):
        self.connect(create=True)
        ready=threading.Barrier(3)
        def insert(worker):
            db=Connection(Path(self.binding.root)/'access',family='access',config=self.config)
            try:
                ready.wait(timeout=10)
                return db.raw.execute('INSERT INTO orbita_access.audit(action) VALUES(%s) RETURNING seq,rowid',(f'raw-{worker}',)).fetchone()
            finally:db.close()
        with ThreadPoolExecutor(max_workers=3) as pool:
            rows=list(pool.map(insert,range(3)))
        self.assertEqual(sorted(rows),[(1,1),(2,2),(3,3)])
        self.assertEqual(self.connections[0].execute('SELECT seq,rowid FROM audit ORDER BY seq').fetchall(),[(1,1),(2,2),(3,3)])

    def test_counter_changed_after_repeatable_snapshot_fails_without_replay(self):
        writer=self.connect(create=True);reader=self.connect()
        writer.execute("INSERT INTO audit(action) VALUES('initial')")
        reader.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
        self.assertEqual(reader.raw.execute('SELECT seq FROM orbita_access.audit').fetchall(),[(1,)])
        writer.raw.execute("INSERT INTO orbita_access.audit(action) VALUES('concurrent')")
        with self.assertRaises(psycopg.errors.SerializationFailure):
            reader.raw.execute("INSERT INTO orbita_access.audit(action) VALUES('stale')")
        reader.rollback()
        self.assertEqual(writer.execute('SELECT action FROM audit ORDER BY seq').fetchall(),[('initial',),('concurrent',)])
        self.assertEqual(reader.execute("INSERT INTO audit(action) VALUES('fresh')").lastrowid,3)


    def test_counter_planner_preference_does_not_leak_on_success_or_failure(self):
        for preference in ('on','off'):
            with self.subTest(preference=preference):
                db=self.connect('planner-'+preference,create=True)
                db.raw.execute('SET enable_sort='+preference)
                try:
                    db.raw.execute("INSERT INTO orbita_access.audit(seq,action) VALUES(9223372036854775806,'near-limit')")
                    self.assertEqual(db.raw.execute("INSERT INTO orbita_access.audit(action) VALUES('last') RETURNING seq").fetchone(),(9223372036854775807,))
                    self.assertEqual(db.raw.execute('SHOW enable_sort').fetchone(),(preference,))
                    with self.assertRaises(psycopg.errors.NumericValueOutOfRange):
                        db.raw.execute("INSERT INTO orbita_access.audit(action) VALUES('overflow')")
                    self.assertEqual(db.raw.execute('SHOW enable_sort').fetchone(),(preference,))
                    self.assertEqual(db.raw.execute('SELECT action FROM orbita_access.audit ORDER BY seq').fetchall(),[('near-limit',),('last',)])
                finally:db.raw.execute('RESET enable_sort')


    def test_atomic_batch_visibility_failure_and_default_statement_recovery(self):
        db=self.connect(create=True);reader=self.connect(read_only=True)
        db.execute("INSERT INTO attempts VALUES('seed',1,10)")
        db.begin_atomic_batch()
        db.execute("INSERT INTO attempts VALUES('first',2,20),('second',3,30)")
        self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(1,))
        db.commit()
        self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(3,))
        db.begin_atomic_batch();db.execute("INSERT INTO attempts VALUES('discard',4,40)")
        with self.assertRaises(psycopg.errors.UniqueViolation):db.execute("INSERT INTO attempts VALUES('seed',9,90)")
        with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_FAILED'):db.commit()
        with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_FAILED'):db.execute('SELECT count(*) FROM attempts')
        db.execute('ROLLBACK')
        self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(3,))
        db.begin_atomic_batch();db.execute("INSERT INTO attempts VALUES('fresh',5,50)");db.commit()
        db.execute('BEGIN IMMEDIATE');db.execute("INSERT INTO attempts VALUES('ordinary',6,60)")
        with self.assertRaises(psycopg.errors.UniqueViolation):db.execute("INSERT INTO attempts VALUES('seed',9,90)")
        db.commit()
        self.assertEqual(reader.execute('SELECT name FROM attempts ORDER BY name').fetchall(),[(n,) for n in ('first','fresh','ordinary','second','seed')])

    def test_atomic_batch_post_write_client_failure_prevents_commit(self):
        db=self.connect(create=True);reader=self.connect(read_only=True)
        original=db._insert
        def fail_after_write(node,values):
            original(node,values).close()
            raise ValueError('result validation failed after write')
        db.begin_atomic_batch();db._insert=fail_after_write
        try:
            with self.assertRaisesRegex(ValueError,'after write'):db.execute("INSERT INTO attempts VALUES('written',1,10)")
        finally:db._insert=original
        self.assertEqual(db.raw.execute('SELECT count(*) FROM orbita_access.attempts').fetchone(),(1,))
        self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(0,))
        with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_FAILED'):db.executescript('COMMIT')
        db.rollback()
        self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(0,))
        db.begin_atomic_batch();db.execute("INSERT INTO attempts VALUES('retry',2,20)");db.commit()
        self.assertEqual(reader.execute('SELECT name FROM attempts').fetchone(),('retry',))

    def test_atomic_batch_cursor_conversion_failure_prevents_commit(self):
        db=self.connect(create=True);reader=self.connect(read_only=True)
        def broken_factory(cursor,row):raise ValueError('unreadable result')
        db.begin_atomic_batch();cursor=db.execute("INSERT INTO attempts VALUES('written',1,10) RETURNING name")
        db.row_factory=broken_factory
        try:
            with self.assertRaisesRegex(ValueError,'unreadable result'):cursor.fetchone()
        finally:db.row_factory=None;cursor.close()
        self.assertEqual(db.raw.execute('SELECT count(*) FROM orbita_access.attempts').fetchone(),(1,))
        with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_FAILED'):db.commit()
        db.rollback()
        self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(0,))

    def test_atomic_batch_local_sql_and_ddl_errors_require_full_rollback(self):
        db=self.connect(create=True);reader=self.connect(read_only=True)
        operations=[lambda:db.execute('PRAGMA integrity_check'),lambda:db.executescript('CREATE TABLE uninstalled(id TEXT)'),lambda:db.execute('SELECT 1; SELECT 2')]
        for index,operation in enumerate(operations):
            with self.subTest(index=index):
                db.begin_atomic_batch();db.execute("INSERT INTO attempts VALUES('discard',1,10)")
                with self.assertRaises((StoreError,psycopg.Error)):operation()
                with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_FAILED'):db.executescript('COMMIT')
                db.executescript('ROLLBACK')
                self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(0,))


    def test_atomic_writes_match_ordinary_conflicts_rowids_and_change_counts(self):
        batch=self.connect('batched',create=True);ordinary=self.connect('ordinary',create=True)
        writes=[
            dict(sql='INSERT INTO attempts VALUES(?,?,?),(?,?,?),(?,?,?)',params=['a',1,10,'b',2,20,'c',3,30]),
            dict(sql="INSERT OR IGNORE INTO attempts VALUES('b',99,990)"),
            dict(sql="INSERT OR REPLACE INTO attempts VALUES('a',9,90),('b',8,80)"),
            dict(sql='UPDATE attempts SET count=count+? WHERE name=?',params=[4,'c']),
            dict(sql="DELETE FROM attempts WHERE name='b'"),
            dict(sql='INSERT INTO attempts VALUES($name,$count,$until) ON CONFLICT(name) DO UPDATE SET count=excluded.count',params={'name':'c','count':11,'until':110}),
            dict(sql='INSERT INTO audit(seq,action) VALUES(?,?)',params=[9007199254740992,'exact']),
        ]
        batch.begin_atomic_batch();ordinary.begin_atomic_batch()
        self.assertEqual(batch.execute_atomic_writes(writes),len(writes))
        for item in writes:ordinary.execute(item['sql'],item.get('params',())).close()
        for table in ('attempts','audit'):
            sql='SELECT rowid,* FROM '+table+' ORDER BY rowid'
            self.assertEqual(batch.execute(sql).fetchall(),ordinary.execute(sql).fetchall())
        self.assertEqual(batch.lastrowid,ordinary.lastrowid)
        self.assertEqual(batch.total_changes,ordinary.total_changes)
        batch.commit();ordinary.commit()

    def test_atomic_writes_prevalidate_every_member_before_sending_any(self):
        db=self.connect(create=True)
        invalid=['COMMIT','SELECT 1','CREATE TABLE forbidden(id TEXT)',"INSERT INTO attempts VALUES('bad',2,20) RETURNING name",'DELETE FROM attempts; SELECT 1']
        for sql in invalid:
            with self.subTest(sql=sql):
                db.begin_atomic_batch();db.execute_atomic_writes([dict(sql="INSERT INTO attempts VALUES('prior',1,10)")])
                with self.assertRaises(StoreError):db.execute_atomic_writes([dict(sql="INSERT INTO attempts VALUES('unsent',3,30)"),dict(sql=sql)])
                self.assertEqual(db.raw.execute('SELECT count(*) FROM orbita_access.attempts').fetchone(),(1,))
                with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_FAILED'):db.commit()
                db.rollback()
        self.assertEqual(db.execute('SELECT count(*) FROM attempts').fetchone(),(0,))

    def test_atomic_writes_sql_failure_rolls_back_earlier_segments(self):
        db=self.connect(create=True);reader=self.connect(read_only=True)
        db.begin_atomic_batch();db.execute_atomic_writes([dict(sql="INSERT INTO attempts VALUES('prior',1,10)")])
        with self.assertRaises(psycopg.Error):
            db.execute_atomic_writes([dict(sql="INSERT INTO attempts VALUES('written',2,20)"),dict(sql="INSERT INTO attempts VALUES('prior',3,30)"),dict(sql="INSERT INTO attempts VALUES('later',4,40)")])
        with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_FAILED'):db.commit()
        db.rollback();self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(0,))
        db.begin_atomic_batch();db.execute_atomic_writes([dict(sql="INSERT INTO attempts VALUES('retry',5,50)")]);db.commit()
        self.assertEqual(reader.execute('SELECT name FROM attempts').fetchall(),[('retry',)])

    def test_atomic_writes_compiled_plan_keeps_fresh_parameters_scope_and_authority(self):
        db=self.connect('a',create=True);other=self.connect('b',create=True)
        query='INSERT INTO attempts VALUES(?,?,?)'
        for connection,name in ((db,'one'),(other,'two')):
            connection.begin_atomic_batch();connection.execute_atomic_writes([dict(sql=query,params=[name,1,10])]);connection.commit()
        self.assertEqual(db.execute('SELECT name FROM attempts').fetchall(),[('one',)])
        self.assertEqual(other.execute('SELECT name FROM attempts').fetchall(),[('two',)])
        case=self.connect('case',family='case',create=True);case.begin_atomic_batch()
        with self.assertRaisesRegex(StoreError,'SQL_TABLE_NOT_INSTALLED'):case.execute_atomic_writes([dict(sql=query,params=['no-alias',1,10])])
        case.rollback()
        db.begin_atomic_batch();db.execute_atomic_writes([dict(sql=query,params=['before-revocation',2,20])])
        with connect_operator(self.operator) as admin:admin.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.binding.workspace_id,))
        try:
            with self.assertRaises(psycopg.Error):db.execute_atomic_writes([dict(sql=query,params=['after-revocation',3,30])])
            with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_FAILED'):db.commit()
            db.rollback()
        finally:
            with connect_operator(self.operator) as admin:admin.execute('UPDATE orbita_private.workspaces SET active=true WHERE id=%s',(self.binding.workspace_id,))
        # Re-enabling a workspace never readmits an already revoked session.
        self.assertEqual(db.execute('SELECT name FROM attempts').fetchall(),[])
        fresh=self.connect('a',read_only=True)
        self.assertEqual(fresh.execute('SELECT name FROM attempts').fetchall(),[('one',)])

    def test_atomic_writes_bounds_and_explicit_transaction(self):
        db=self.connect(create=True)
        with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_REQUIRED'):db.execute_atomic_writes([])
        db.begin_atomic_batch();self.assertEqual(db.execute_atomic_writes([]),0)
        with self.assertRaisesRegex(StoreError,'ATOMIC_WRITES_LIMIT'):db.execute_atomic_writes([dict(sql="INSERT INTO attempts VALUES('no',1,10)")]*129)
        self.assertEqual(db.raw.execute('SELECT count(*) FROM orbita_access.attempts').fetchone(),(0,))
        with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_FAILED'):db.commit()
        db.rollback()

    def test_atomic_writes_post_write_status_failure_poisoning(self):
        db=self.connect(create=True);reader=self.connect(read_only=True)
        original=db.raw.execute
        def fail_status(query,*args,**kwargs):
            cursor=original(query,*args,**kwargs)
            if query=='SELECT * FROM orbita_common.insert_status()':raise ValueError('status unavailable after writes')
            return cursor
        db.begin_atomic_batch();db.raw.execute=fail_status
        try:
            with self.assertRaisesRegex(ValueError,'status unavailable'):db.execute_atomic_writes([dict(sql="INSERT INTO attempts VALUES('written',1,10)")])
        finally:db.raw.execute=original
        self.assertEqual(db.raw.execute('SELECT count(*) FROM orbita_access.attempts').fetchone(),(1,))
        with self.assertRaisesRegex(StoreError,'ATOMIC_BATCH_FAILED'):db.commit()
        db.rollback();self.assertEqual(reader.execute('SELECT count(*) FROM attempts').fetchone(),(0,))


if __name__=='__main__':unittest.main()

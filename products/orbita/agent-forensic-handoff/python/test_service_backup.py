"""Real crypto, independent Docker restore, and observable authority negatives.

All database mutations are confined to the freshly created qualification
service named by the runner. No test can select the operational port15438.
"""
from pathlib import Path
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import uuid

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

from orbita_store import StoreError
from orbita_store.admin import connect_operator, provision_workspace
from orbita_store.config import parse_config
from orbita_store.pool import close_idle
from orbita_store.session import Session
from orbita_store.service_archive import AuthenticatedServiceArchive, MAGIC, MEMBERS, canonical, durable_json, encrypt_member, mac, private_key
from orbita_store.service_backup import backup, capture, describe_service, restore, stop_owned_restore
from orbita_store.service_maintenance import Maintenance, _load, _lock_catalogues, _role, _save, recover
from orbita_store.service_catalog import sequence_state
from orbita_store.service_archive import _crypt as real_crypt

REAL_POPEN=subprocess.Popen


class ServiceArchiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node=Path(os.environ['ORBITA_TEST_NODE']);cls.root=Path(os.environ['TEMP'])/('service-archive-'+str(uuid.uuid4()));cls.root.mkdir()
        cls.original=cls.root/'original';cls.original.mkdir();cls.key_file=cls.root/'key.bin';cls.key=private_key(cls.key_file,create=True)
        cls.backup_id=str(uuid.uuid4());cls.instance=str(uuid.uuid4());cls.plain=b'synthetic-service-archive\0\xff\n'*100000;cls.digest=hashlib.sha256(cls.plain).hexdigest()
        members=[]
        for name in MEMBERS:
            command=[str(cls.node),'-e',"process.stdout.write(Buffer.from('synthetic-service-archive\\0\\xff\\n','latin1').toString('latin1').repeat(100000),'latin1')"]
            members.append(encrypt_member(cls.original/name,command,node=cls.node,key=cls.key,backup_id=cls.backup_id,instance_id=cls.instance,deadline=time.monotonic()+30))
        payload=dict(schema=2,backupId=cls.backup_id,instanceId=cls.instance,members=members)
        durable_json(cls.original/'manifest.json',dict(payload=payload,hmac=mac(cls.key,payload)),exclusive=True)

    def setUp(self):
        self.directory=self.root/str(uuid.uuid4());shutil.copytree(self.original,self.directory);self.children=[]

    def tearDown(self):
        self.assertTrue(all(child.poll() is not None for child in self.children),'OWNED_SERVICE_CHILD_LIVE')

    def spawn(self,command,**options):
        self.assertNotIn(self.key.hex(),json.dumps(command));self.assertNotIn(self.key.hex(),json.dumps(options.get('env',{})))
        child=REAL_POPEN(command,**options);self.children.append(child);return child

    def archive(self,**options):
        return AuthenticatedServiceArchive(self.directory,key=options.pop('key',self.key),node=self.node,deadline=time.monotonic()+30,**options)

    def reauthenticate_manifest(self):
        path=self.directory/'manifest.json';value=json.loads(path.read_text())['payload']
        for member in value['members']:
            content=(self.directory/member['name']).read_bytes();member['sha256']=hashlib.sha256(content).hexdigest();member['bytes']=len(content)
            member['plaintextBytes']=len(content)-(len(canonical(member['header']))+len(MAGIC)+4)-16
        durable_json(path,dict(payload=value,hmac=mac(self.key,value)))

    def test_both_members_restore_exact_bytes_from_held_handles(self):
        with patch('orbita_store.service_archive.subprocess.Popen',side_effect=self.spawn),self.archive() as archive:
            for name in MEMBERS:
                command=[str(self.node),'-e',"const h=require('crypto').createHash('sha256');process.stdin.on('data',b=>h.update(b));process.stdin.on('end',()=>{process.exitCode=h.digest('hex')===process.argv[1]?0:43;});",self.digest]
                result=archive.restore_member(name,command);self.assertEqual(result['bytes'],len(self.plain));self.assertEqual(result['consumerExit'],0)
        self.assertEqual(len(self.children),6)

    def test_holds_block_overwrite_delete_and_rename_between_passes(self):
        with self.archive():
            for name in (*MEMBERS,'manifest.json'):
                path=self.directory/name
                with self.assertRaises(PermissionError):path.open('r+b')
                with self.assertRaises(PermissionError):path.unlink()
                with self.assertRaises(PermissionError):path.rename(path.with_suffix('.other'))

    def test_wrong_key_fails_before_any_crypto_or_restore_process(self):
        with patch('orbita_store.service_archive.subprocess.Popen',side_effect=self.spawn),self.assertRaisesRegex(StoreError,'MANIFEST_AUTHENTICATION'):
            self.archive(key=secrets.token_bytes(64))
        self.assertEqual(self.children,[])

    def test_changed_manifest_and_missing_extra_or_escaping_members_rejected(self):
        for mode in ('manifest','missing','extra','escape'):
            with self.subTest(mode=mode):
                self.directory=self.root/str(uuid.uuid4());shutil.copytree(self.original,self.directory)
                if mode=='missing':(self.directory/'database.enc').unlink()
                elif mode=='extra':(self.directory/'extra').write_bytes(b'only synthetic')
                else:
                    path=self.directory/'manifest.json';value=json.loads(path.read_text())
                    if mode=='escape':value['payload']['members'][0]['name']='../globals.enc';value['hmac']=mac(self.key,value['payload'])
                    else:value['payload']['backupId']=str(uuid.uuid4())
                    durable_json(path,value)
                with self.assertRaises(StoreError):self.archive()

    def test_bad_tag_body_header_and_truncation_never_start_restore(self):
        for mode in ('tag','body','header','truncate'):
            with self.subTest(mode=mode):
                self.directory=self.root/str(uuid.uuid4());shutil.copytree(self.original,self.directory)
                member=self.directory/'database.enc';data=bytearray(member.read_bytes())
                if mode=='tag':data[-1]^=1
                elif mode=='body':data[1024]^=1
                elif mode=='truncate':data=data[:-1]
                else:data[0]^=1
                member.write_bytes(data);self.reauthenticate_manifest()
                before=len(self.children)
                with patch('orbita_store.service_archive.subprocess.Popen',side_effect=self.spawn),patch('orbita_store.service_backup.capture',side_effect=AssertionError('SQL TARGET MUST NOT START')),self.assertRaises(StoreError):
                    restore(self.directory,key_file=self.key_file,private_directory=self.root/str(uuid.uuid4()),node=self.node,max_seconds=30)
                if mode!='header':self.assertEqual(len(self.children)-before,2)

    def test_interchanged_members_rejected(self):
        a=(self.directory/'globals.enc').read_bytes();b=(self.directory/'database.enc').read_bytes()
        (self.directory/'globals.enc').write_bytes(b);(self.directory/'database.enc').write_bytes(a);self.reauthenticate_manifest()
        with self.assertRaises(StoreError):self.archive()

    def test_producer_failure_cannot_create_complete_archive(self):
        target=self.root/str(uuid.uuid4());target.mkdir()
        with patch('orbita_store.service_archive.subprocess.Popen',side_effect=self.spawn),self.assertRaises(StoreError):
            encrypt_member(target/'globals.enc',[str(self.node),'-e',"process.stdout.write('synthetic');process.exitCode=77"],node=self.node,key=self.key,backup_id=self.backup_id,instance_id=self.instance,deadline=time.monotonic()+10)
        self.assertFalse((target/'manifest.json').exists())

    def test_byte_budget_aborts_both_owned_processes(self):
        target=self.root/str(uuid.uuid4());target.mkdir()
        with patch('orbita_store.service_archive.subprocess.Popen',side_effect=self.spawn),self.assertRaises(StoreError):
            encrypt_member(target/'globals.enc',[str(self.node),'-e',"process.stdout.write(Buffer.alloc(4000000))"],node=self.node,key=self.key,backup_id=self.backup_id,instance_id=self.instance,deadline=time.monotonic()+10,limit=1024)
        self.assertEqual(len(self.children),2)

    def test_deadline_closes_stalled_crypto_and_producer(self):
        target=self.root/str(uuid.uuid4());target.mkdir()
        def stalled(command,**options):
            if command[-1].endswith('service_cipher.mjs'):command=[str(self.node),'-e','setInterval(()=>{},1000)']
            return self.spawn(command,**options)
        started=time.monotonic()
        with patch('orbita_store.service_archive.subprocess.Popen',side_effect=stalled),self.assertRaises(StoreError):
            encrypt_member(target/'globals.enc',[str(self.node),'-e',"process.stdout.write(Buffer.alloc(4000000))"],node=self.node,key=self.key,backup_id=self.backup_id,instance_id=self.instance,deadline=time.monotonic()+1)
        self.assertLess(time.monotonic()-started,8)

    def test_consumer_failure_is_not_reported_as_restore_success(self):
        with patch('orbita_store.service_archive.subprocess.Popen',side_effect=self.spawn),self.archive() as archive:
            with self.assertRaises((StoreError,BrokenPipeError,OSError)):
                archive.restore_member('database.enc',[str(self.node),'-e','process.exit(79)'])

    def bootstrap_fixture(self,count):
        role='orbita_test_bootstrap';creation='CREATE ROLE "'+role+'";\n'
        rest='-- synthetic globals\nALTER ROLE "'+role+'" LOGIN;\n-- end\n'
        raw=(creation*count+rest).encode('utf8')
        (self.directory/'globals.enc').unlink()
        member=encrypt_member(self.directory/'globals.enc',[str(self.node),'-e','process.stdout.write(process.argv[1])','--',raw.decode()],
                              node=self.node,key=self.key,backup_id=self.backup_id,instance_id=self.instance,deadline=time.monotonic()+10)
        path=self.directory/'manifest.json';payload=json.loads(path.read_text())['payload'];payload['members'][0]=member;payload['sourceBootstrapRole']=role
        durable_json(path,dict(payload=payload,hmac=mac(self.key,payload)))
        return rest.encode(),len(creation.encode())

    def test_only_existing_bootstrap_creation_is_omitted_and_attributes_preserved(self):
        expected,omitted=self.bootstrap_fixture(1)
        with self.archive() as archive:
            command=[str(self.node),'-e',"const h=require('crypto').createHash('sha256');process.stdin.on('data',b=>h.update(b));process.stdin.on('end',()=>{process.exitCode=h.digest('hex')===process.argv[1]?0:43;});",hashlib.sha256(expected).hexdigest()]
            result=archive.restore_member('globals.enc',command)
            self.assertEqual(result['alreadyCreatedBootstrapBytes'],omitted);self.assertEqual(result['bytes'],len(expected))

    def test_missing_or_duplicate_bootstrap_creation_rejected_before_sql(self):
        for count in (0,2):
            with self.subTest(count=count):
                self.directory=self.root/str(uuid.uuid4());shutil.copytree(self.original,self.directory);self.bootstrap_fixture(count)
                with patch('orbita_store.service_backup.capture',side_effect=AssertionError('SQL TARGET MUST NOT START')),self.assertRaises(StoreError):
                    restore(self.directory,key_file=self.key_file,private_directory=self.root/str(uuid.uuid4()),node=self.node,max_seconds=30)


class ServiceDatabaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        close_idle();cls.node=Path(os.environ['ORBITA_TEST_NODE'])
        source=json.loads(Path(os.environ['ORBITA_SERVICE_TEST_DESCRIPTION']).read_text())
        cls.operator=json.loads(Path(source['operatorConfig']).read_text())
        assert cls.operator['port']!=15438 and source['name'].startswith(('orbita-backend-identity-','orbita-cumulative-installation-'))
        assert cls.operator['port']==source['port'] and cls.operator['instanceId']==source['instanceId']
        cls.cid=source['containerId'];cls.service=describe_service(cls.cid,cls.operator,deadline=time.monotonic()+30)
        cls.root=Path(os.environ['TEMP'])/('service-database-'+str(uuid.uuid4()));cls.root.mkdir();cls.restores=[]
        workspace=provision_workspace(cls.operator,label='service-backup-qualification',kind='test')
        cls.runtime=dict(schema=1,host=cls.operator['host'],port=cls.operator['port'],dbname=cls.operator['dbname'],user='orbita_runtime',password=cls.operator['runtimePassword'],instanceId=cls.operator['instanceId'],bindings=[dict(root=str(cls.root/'virtual'),**workspace)])
        with connect_operator(cls.operator) as db:
            db.execute('CREATE SCHEMA service_qualification')
            db.execute('CREATE TABLE service_qualification.typed_values(id text PRIMARY KEY,b bool,blob bytea,f float8,i int4,j int8,document jsonb,t text,at timestamptz,u uuid,g int4 GENERATED ALWAYS AS (length(t)) STORED)')
            entries=[('null',None,None,None,None,None,None,None,None,None),
                     ('empty',False,b'',-0.0,0,0,Jsonb({}),'','2000-01-01T00:00:00Z',str(uuid.uuid4())),
                     ('unicode',True,b'synthetic\x00\xff'*200000,1.23456789012345,2147483647,9223372036854775807,Jsonb({'texto':'á 漢字 😀\n\t','null':None}),'é\n\t😀','9999-12-31T23:59:59Z',str(uuid.uuid4())),
                     ('nan',True,b'a',float('nan'),-2147483648,-9223372036854775808,Jsonb([None,'x']),'nan','1900-01-01T00:00:00Z',str(uuid.uuid4())),
                     ('inf',False,b'b',float('inf'),1,1,Jsonb(True),'inf','2001-01-01T00:00:00Z',str(uuid.uuid4())),
                     ('negative-inf',False,b'c',float('-inf'),2,2,Jsonb(False),'-inf','2001-01-01T00:00:00Z',str(uuid.uuid4()))]
            with db.cursor() as cursor:cursor.executemany('INSERT INTO service_qualification.typed_values(id,b,blob,f,i,j,document,t,at,u) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',entries)
            db.execute('CREATE SEQUENCE service_qualification.counter');db.execute("SELECT nextval('service_qualification.counter')")
            db.execute("SELECT setval('service_qualification.counter',41,false)")
            for i in range(257):db.execute(sql.SQL('CREATE SEQUENCE {} START WITH {}').format(sql.Identifier('service_qualification','capacity_'+str(i)),sql.Literal(i+7)))
            db.execute("COMMENT ON TABLE service_qualification.typed_values IS 'synthetic all-nine-types independent restore'")

    @classmethod
    def tearDownClass(cls):
        close_idle()
        for receipt in cls.restores:
            receipt['closure']=stop_owned_restore(receipt,deadline=time.monotonic()+30)
        durable_json(cls.root/'RESTORE-CLOSURES.json',cls.restores,exclusive=True)

    def setUp(self):
        close_idle();self.work=self.root/str(uuid.uuid4());self.work.mkdir();self.key_file=self.work/'key.bin';self.intent=self.work/'intent.json'

    def key(self):
        return private_key(self.key_file,create=not self.key_file.exists())

    def barrier(self,**options):
        key=self.key()
        with connect_operator(self.operator) as db:db.execute("SET timezone='UTC'");expected=_role(db,key,'orbita_runtime')
        return Maintenance(self.operator,instance_id=self.operator['instanceId'],service=self.service,intent=self.intent,key=key,backup_id=str(uuid.uuid4()),expected_role=expected,**options)

    def recovered(self,intent=None,service=None):
        return recover(self.operator,instance_id=self.operator['instanceId'],service=service or self.service,intent=intent or self.intent,key=self.key())

    def crashed(self,event):
        self.key();config=self.work/'operator.json';durable_json(config,self.operator,exclusive=True)
        program="from pathlib import Path;import os,json,sys;from orbita_store.admin import connect_operator;from orbita_store.service_maintenance import Maintenance,_role;from orbita_store.service_archive import private_key;from orbita_store.service_backup import describe_service;import time,uuid\np=json.loads(Path(sys.argv[1]).read_text());key=private_key(sys.argv[2]);service=describe_service(sys.argv[4],p,deadline=time.monotonic()+30)\nwith connect_operator(p) as db:\n db.execute(\"SET timezone='UTC'\");expected=_role(db,key,'orbita_runtime')\nwith Maintenance(p,instance_id=p['instanceId'],service=service,intent=sys.argv[3],key=key,backup_id=str(uuid.uuid4()),expected_role=expected,progress=lambda e:os._exit(71) if e==sys.argv[5] else None):pass\n"
        child=REAL_POPEN([sys.executable,'-X','utf8','-B','-c',program,str(config),str(self.key_file),str(self.intent),self.cid,event],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
        try:output,error=child.communicate(timeout=15)
        finally:
            if child.poll() is None:child.kill();child.wait(5)
        self.assertEqual(child.returncode,71,error.decode('utf8'))

    def test_full_service_restore_preserves_all_types_schema_roles_and_runtime(self):
        with connect_operator(self.operator) as db:
            source_tables=db.execute("SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE' ORDER BY 1,2").fetchall()
        self.assertIn(('orbita_private','workspaces'),source_tables)
        self.assertIn(('service_qualification','typed_values'),source_tables)
        result=backup(self.operator,container_id=self.cid,destination=self.work/'archive',key_file=self.key_file,intent=self.intent,node=self.node,max_seconds=120)
        self.assertEqual(result['status'],'COMPLETE_SERVICE_BACKUP_ENCRYPTED')
        restored=restore(self.work/'archive',key_file=self.key_file,private_directory=self.work/'independent',node=self.node,max_seconds=120);self.restores.append(restored)
        self.assertEqual(restored['status'],'PASS_INDEPENDENT_COMPLETE_SERVICE_RESTORE')
        self.assertEqual(restored['nativeVerification'],'PASS_PG_VERIFYBACKUP_ALL_FILES_AND_WAL')
        self.assertEqual(restored['databaseFormat'],'postgresql-basebackup-tar-with-wal-v1')
        self.assertTrue(all(item['closure']['stopped'] for item in restored['helperClosures']))
        self.assertEqual(restored['tables'],len(source_tables))
        comparison=json.loads((self.work/'independent/COMPARISON.json').read_text())
        self.assertTrue(comparison['equal'])
        self.assertEqual([(item['schema'],item['name']) for item in comparison['actual']['tables']],source_tables)
        config=parse_config(dict(self.runtime,port=restored['service']['port']))
        with Session(config,config.bindings[0],read_only=True) as session:
            self.assertTrue(session.raw.execute('SELECT orbita_common.workspace_id() IS NOT NULL').fetchone()[0])
        close_idle()
        wrong=dict(config.connection_parameters(),password='synthetic-wrong-password')
        with self.assertRaises(psycopg.OperationalError):psycopg.connect(**wrong,connect_timeout=2)
        child=REAL_POPEN([sys.executable,'-X','utf8','-B','-m','orbita_store.service_backup','stop-restored','--receipt',str(self.work/'independent/OWNED-SERVICE.json')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
        try:output,errors=child.communicate(timeout=35)
        finally:
            if child.poll() is None:child.kill();child.wait(5)
        self.assertEqual(child.returncode,0);self.assertTrue(json.loads(output)['stopped'])
        restored['closure']=stop_owned_restore(restored,deadline=time.monotonic()+30)

    def test_sequence_reader_does_not_accumulate_snapshot_relation_locks(self):
        with connect_operator(self.operator) as snapshot,connect_operator(self.operator) as reader:
            snapshot.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            expected=snapshot.execute("SELECT count(*) FROM pg_class WHERE relkind='S'").fetchone()[0]
            result=sequence_state(snapshot,reader,deadline=time.monotonic()+15)
            self.assertEqual(len(result),expected)
            counter=next(row for row in result if row['schema']=='service_qualification' and row['name']=='counter')
            self.assertEqual((counter['lastValue'],counter['isCalled']),(41,False))
            locks=reader.execute("SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.pid IN (%s,%s) AND c.relkind='S'",(snapshot.info.backend_pid,reader.info.backend_pid)).fetchone()[0]
            self.assertEqual(locks,0)
            with self.assertRaisesRegex(StoreError,'SEQUENCE_READER_TRANSACTION'):sequence_state(snapshot,snapshot)
            snapshot.rollback()

    def test_native_backup_cancellation_closes_owned_replication_and_recovers_login(self):
        seen=[]
        def cancel(*args,**options):
            producer=options.get('producer')
            if producer is not None and 'pg_basebackup' in producer.args:
                tag=next(value.split('application_name=',1)[1] for value in producer.args if value.startswith('--dbname=application_name='))
                until=time.monotonic()+10
                with connect_operator(self.operator) as db:
                    while time.monotonic()<until:
                        rows=db.execute("SELECT pid,backend_start FROM pg_stat_activity WHERE application_name=%s AND backend_type='walsender'",(tag,)).fetchall()
                        if rows:seen.extend(rows);break
                        time.sleep(.02)
                self.assertEqual(len(seen),1)
                raise StoreError('ORBITA_PG_TEST_CANCEL_NATIVE')
            return real_crypt(*args,**options)
        with patch('orbita_store.service_archive._crypt',side_effect=cancel),self.assertRaisesRegex(StoreError,'TEST_CANCEL_NATIVE'):
            backup(self.operator,container_id=self.cid,destination=self.work/'archive',key_file=self.key_file,intent=self.intent,node=self.node,max_seconds=60)
        self.assertEqual(len(seen),1)
        self.assertFalse((self.work/'archive/manifest.json').exists())
        with connect_operator(self.operator) as db:
            self.assertTrue(db.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname='orbita_runtime'").fetchone()[0])
            self.assertEqual(db.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'orbita-service-backup-%'").fetchone()[0],0)

    def test_crash_recovery_covers_all_durable_boundaries(self):
        for event in ('after_intent_before_alter','after_alter_before_commit','after_nologin_commit_before_receipt','after_restore_commit_before_receipt'):
            with self.subTest(event=event):
                self.work=self.root/str(uuid.uuid4());self.work.mkdir();self.key_file=self.work/'key.bin';self.intent=self.work/'intent.json';self.crashed(event)
                result=self.recovered();self.assertIn(result['status'],('ORIGINAL_AUTHORITY_ALREADY_PRESENT','OWN_LOGIN_CHANGE_RESTORED'))
                with connect_operator(self.operator) as db:self.assertTrue(db.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname='orbita_runtime'").fetchone()[0])

    def test_live_maintenance_owner_prevents_recovery_and_runtime_login(self):
        with self.barrier():
            with self.assertRaisesRegex(StoreError,'OWNER_LIVE'):self.recovered()
            with self.assertRaises(psycopg.OperationalError):psycopg.connect(**parse_config(self.runtime).connection_parameters(),connect_timeout=2)

    def test_existing_client_prevents_any_login_change(self):
        barrier=self.barrier()
        with psycopg.connect(**parse_config(self.runtime).connection_parameters(),connect_timeout=2):
            with self.assertRaisesRegex(StoreError,'CLIENTS_ACTIVE'):barrier.__enter__()
        self.assertFalse(self.intent.exists())

    def test_later_role_version_is_not_reverted(self):
        self.crashed('after_nologin_commit_before_receipt')
        try:
            with connect_operator(self.operator) as db:
                db.execute('ALTER ROLE orbita_runtime NOLOGIN');version=db.execute("SELECT xmin::text FROM pg_authid WHERE rolname='orbita_runtime'").fetchone()[0]
            with self.assertRaisesRegex(StoreError,'VERSION_NOT_OWNED'):self.recovered()
            with connect_operator(self.operator) as db:self.assertEqual(db.execute("SELECT xmin::text,rolcanlogin FROM pg_authid WHERE rolname='orbita_runtime'").fetchone(),(version,False))
        finally:
            with connect_operator(self.operator) as db:db.execute('ALTER ROLE orbita_runtime LOGIN')

    def test_altered_membership_is_not_reverted(self):
        self.crashed('after_nologin_commit_before_receipt')
        try:
            with connect_operator(self.operator) as db:db.execute('GRANT pg_read_all_settings TO orbita_runtime')
            with self.assertRaisesRegex(StoreError,'CHANGED_EXTERNALLY'):self.recovered()
        finally:
            with connect_operator(self.operator) as db:db.execute('REVOKE pg_read_all_settings FROM orbita_runtime');db.execute('ALTER ROLE orbita_runtime LOGIN')

    def test_bad_intent_identity_and_transaction_epoch_are_rejected(self):
        self.crashed('after_nologin_commit_before_receipt');original=_load(self.intent,self.key())
        try:
            other=self.work/'bad-intent.json';envelope=json.loads(self.intent.read_text());envelope['hmac']='0'*64;durable_json(other,envelope,exclusive=True)
            with self.assertRaisesRegex(StoreError,'INTENT_AUTHENTICATION'):self.recovered(intent=other)
            with self.assertRaisesRegex(StoreError,'RECOVERY_IDENTITY'):self.recovered(service=dict(self.service,containerId='0'*64))
            outside=dict(original,mutationXid8=str(int(original['mutationXid8'])-2**32));_save(other,outside,self.key())
            with self.assertRaisesRegex(StoreError,'VERSION_NOT_OWNED'):self.recovered(intent=other)
        finally:self.recovered()

    def test_catalogue_locks_block_alter_and_membership_then_release(self):
        with connect_operator(self.operator) as first,connect_operator(self.operator) as second:
            second.execute("SET lock_timeout='150ms'")
            with first.transaction():
                _lock_catalogues(first)
                for statement in ('ALTER ROLE orbita_runtime NOLOGIN','GRANT pg_read_all_settings TO orbita_runtime'):
                    with self.assertRaises(psycopg.errors.LockNotAvailable):second.execute(statement)
            second.execute('ALTER ROLE orbita_runtime NOLOGIN');second.execute('ALTER ROLE orbita_runtime LOGIN')
            second.execute('GRANT pg_read_all_settings TO orbita_runtime');second.execute('REVOKE pg_read_all_settings FROM orbita_runtime')

    def test_recovery_lock_timeout_preserves_owned_role_version(self):
        self.crashed('after_nologin_commit_before_receipt')
        with connect_operator(self.operator) as blocker:
            with blocker.transaction():
                blocker.execute('LOCK TABLE pg_catalog.pg_authid IN ROW EXCLUSIVE MODE')
                with self.assertRaises(psycopg.errors.LockNotAvailable):self.recovered()
        self.recovered()

    def test_repeatable_read_lock_precedes_snapshot_after_waiting_writer(self):
        outcomes=[];started=threading.Event()
        def reader():
            try:
                with connect_operator(self.operator) as db:
                    db.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');started.set()
                    db.execute('LOCK TABLE service_qualification.typed_values IN SHARE MODE')
                    outcomes.append(db.execute("SELECT t FROM service_qualification.typed_values WHERE id='empty'").fetchone()[0]);db.rollback()
            except BaseException as error:outcomes.append(type(error).__name__)
        with connect_operator(self.operator) as writer:
            with writer.transaction():
                writer.execute("UPDATE service_qualification.typed_values SET t='committed-before-snapshot' WHERE id='empty'")
                thread=threading.Thread(target=reader);thread.start();self.assertTrue(started.wait(3));time.sleep(.2);self.assertEqual(outcomes,[])
            thread.join(5);self.assertFalse(thread.is_alive());self.assertEqual(outcomes,['committed-before-snapshot'])
            writer.execute("UPDATE service_qualification.typed_values SET t='' WHERE id='empty'")

    def test_backup_locks_deny_writer_and_detect_ddl_drift(self):
        observed=[]
        def progress(event):
            if event=='snapshot_locked':
                with connect_operator(self.operator) as db:
                    db.execute("SET lock_timeout='150ms'")
                    with self.assertRaises(psycopg.errors.LockNotAvailable):db.execute("UPDATE service_qualification.typed_values SET t='forbidden' WHERE id='empty'")
                observed.append('write-blocked')
            if event=='database_encrypted':
                with connect_operator(self.operator) as db:db.execute('CREATE TABLE service_qualification.external_drift(id text PRIMARY KEY)')
                observed.append('ddl-inserted')
        try:
            with self.assertRaisesRegex(StoreError,'SOURCE_CHANGED_DURING_BACKUP'):
                backup(self.operator,container_id=self.cid,destination=self.work/'archive',key_file=self.key_file,intent=self.intent,node=self.node,max_seconds=120,progress=progress)
            self.assertEqual(observed,['write-blocked','ddl-inserted']);self.assertFalse((self.work/'archive/manifest.json').exists())
        finally:
            with connect_operator(self.operator) as db:db.execute('DROP TABLE IF EXISTS service_qualification.external_drift')


if __name__=='__main__':unittest.main()

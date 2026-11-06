"""Authenticated hostile frames, original SQLite and real crash boundaries."""
from contextlib import closing
from dataclasses import replace
from pathlib import Path
import hashlib,json,os,sqlite3,struct,subprocess,sys,time,unittest,uuid
from unittest.mock import patch
from orbita_store import StoreError
from orbita_store.admin import provision_workspace
from orbita_store.config import Binding,parse_config
from orbita_store.connection import Connection
from orbita_store.legacy_frames import PrivateStage
from orbita_store.legacy_restore import restore_legacy,inspect_restore
from orbita_store.objects import ObjectStore
from orbita_store.pool import close_idle

PASSWORD='synthetic-v1-restore-password-only'
SHA=lambda b:hashlib.sha256(b).hexdigest()
FRAME=lambda v:(lambda b:struct.pack('>I',len(b))+b)(json.dumps(v,ensure_ascii=False,separators=(',',':')).encode('utf8'))


class LegacyRestore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_OPERATOR_CONFIG']).read_text());cls.raw_config=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text());cls.base=parse_config(cls.raw_config)
        cls.node=Path(os.environ['ORBITA_TEST_NODE']);cls.run_id=str(uuid.uuid4());cls.ids=[];cls.crash_stages=[]
        cls.native=Path(os.environ['TEMP'])/('legacy-restore-'+cls.run_id);cls.oracle=Path(os.environ['ORBITA_TEST_I05_ORACLE'])
        cls.producer=Path(__file__).resolve().parents[2]/'app/legacy-restore-producer-fixture.mjs'
        cls.original=cls.node_fixture('original',cls.native);cls.archive=cls.native/'archive.orbita'
        cls.native_before={str(p):SHA(p.read_bytes()) for p in cls.native.rglob('*') if p.is_file()}
        cls.reference=cls.original['receipt'];assert cls.reference['validation']['databases']==1

    @classmethod
    def node_fixture(cls,mode,target,payload=None):
        command=[str(cls.node),str(cls.producer),mode,str(cls.oracle),str(target)]+([str(payload)] if payload else [])
        env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
        child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
        try:stdout,stderr=child.communicate(timeout=45)
        finally:
            if child.poll() is None:child.kill();child.wait(5)
        if child.returncode:raise AssertionError('FIXTURE_FAILED: '+stderr.decode('utf8'))
        return json.loads(stdout)

    @classmethod
    def tearDownClass(cls):
        close_idle();(Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixtures-restore-'+cls.run_id+'.json')).write_text(json.dumps(dict(workspaceIds=cls.ids,crashPrivateStages=cls.crash_stages)))

    def setUp(self):
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':legacy-restore',kind='test');self.ids.append(value['workspaceId'])
        self.root=Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/value['workspaceId'];self.binding=Binding(str(self.root),value['workspaceId'],value['capability']);self.config=replace(self.base,bindings=(self.binding,))
        self.operation=str(uuid.uuid4());self.private=Path(os.environ['TEMP'])/('private-'+str(uuid.uuid4()));self.private.mkdir()
        self.destination=self.root/'restored';self.stage=self.root/'stage';self.source=self.archive;self.expected=self.reference['archiveSha256'];self.leave_crash=False

    def tearDown(self):
        self.assertFalse(self.root.exists());self.assertEqual({p:SHA(Path(p).read_bytes()) for p in self.native_before},self.native_before)
        if not self.leave_crash:self.assertEqual(list(self.private.iterdir()),[])
        close_idle()

    def call(self,**options):
        return restore_legacy(self.source,self.expected,self.destination,self.stage,config=self.config,node=self.node,password=options.pop('password',PASSWORD),private_parent=self.private,operation_id=self.operation,**options)

    def absent(self):
        self.assertEqual(inspect_restore(self.destination,self.operation,self.expected,config=self.config)['status'],'NOT_PUBLISHED')
        with ObjectStore(self.config,self.binding) as files:self.assertFalse(files.exists('restored'));self.assertFalse(files.exists('stage/cipher/payload'))

    def frames(self,entries,*,end_changes=None,tail=b'',raw=None):
        body=bytearray();h=hashlib.sha256();files=total=count=0
        for entry,content in entries:
            framed=FRAME(entry);h.update(framed);body.extend(framed);body.extend(content);count+=1
            if entry['type']=='file':files+=1;total+=entry['size']
        end=dict(type='end',schema='orbita-memory-1',id=str(uuid.uuid4()),createdAt='2026-10-31T00:00:00.000Z',sourceRoot='C:\\synthetic-original',files=files,bytes=total,entries=count,treeHash=h.hexdigest(),validation=dict(conversations=0,records=0,databases=0,originalsVerified=True))
        if end_changes:end.update(end_changes)
        body.extend(FRAME(end));body.extend(tail)
        seed=Path(os.environ['TEMP'])/('frames-'+str(uuid.uuid4())+'.bin');seed.write_bytes(bytes(body) if raw is None else raw)
        self.source=Path(os.environ['TEMP'])/('frames-'+str(uuid.uuid4())+'.orbita');self.expected=self.node_fixture('encrypt',self.source,seed)['archiveSha256']

    def file(self,name,content=b'[]'):
        return dict(type='file',path=name,size=len(content),sha256=SHA(content)),content

    def test_original_writer_sqlite_custody_typed_rows_empty_directories_and_pause(self):
        result=self.call();self.assertEqual(result['status'],'PASS_EXPLICIT_V1_RESTORE');self.assertTrue(result['nativeStageRemoved'])
        self.assertEqual(result['application'],dict(conversations=0,records=0,databases=1,originalsVerified=True))
        with ObjectStore(self.config,self.binding) as files:
            self.assertEqual(files.stat('restored/empty')['kind'],'directory')
            self.assertEqual(files.read_bytes('restored/ficticio.txt'),'Literal ficticio ñ 😀\n'.encode())
            self.assertEqual(SHA(files.read_bytes('restored/.orbita-legacy/originals/embedding-cache/embeddings.sqlite.bin')),self.original['sqliteSha256'])
            self.assertFalse(files.exists('restored/embedding-cache/embeddings.sqlite'));self.assertFalse(files.exists('stage/cipher/payload'))
        with closing(Connection(self.destination/'embedding-cache/embeddings.pgstore',family='embedding',config=self.config,read_only=True)) as db:
            self.assertEqual(db.execute('SELECT text,vector,rowid FROM vectors').fetchall(),[('literal ñ😀','[1,0]',1)])
        state=result['publication']['state'];self.assertFalse(state['automaticWork']);self.assertFalse(state['externalAccess']);self.assertEqual(state['archiveSha256'],self.expected)

    def test_original_archive_can_be_read_from_common_store(self):
        with ObjectStore(self.config,self.binding) as files:files.mkdir('',exist_ok=True);files.write_bytes('archive',self.archive.read_bytes())
        self.source=self.root/'archive';self.assertEqual(self.call(storage='postgresql-common')['status'],'PASS_EXPLICIT_V1_RESTORE')

    def test_bad_password_never_creates_native_stage_or_parses(self):
        with patch('orbita_store.legacy_restore.PrivateStage') as stage,self.assertRaisesRegex(StoreError,'AUTHENTICATION_FAILED'):self.call(password=PASSWORD+'bad')
        stage.assert_not_called();self.absent()

    def test_dangerous_paths_and_windows_aliases_rejected(self):
        for name in ('../escape','/absolute','a\\b','a:b','CON','lpt¹.txt','trailing.','trailing ','a//b','e\u0301'):
            with self.subTest(name=name):
                self.operation=str(uuid.uuid4());self.stage=self.root/('stage-'+self.operation);self.frames([self.file(name)])
                with self.assertRaisesRegex(StoreError,'FRAME_PATH'):self.call()
                self.assertFalse((self.private/'escape').exists());self.assertEqual(list(self.private.iterdir()),[])
        self.absent()

    def test_duplicate_casefold_names_rejected(self):
        self.frames([self.file('library.json'),self.file('LIBRARY.JSON')])
        with self.assertRaisesRegex(StoreError,'FRAME_ALIAS'):self.call()
        self.absent()

    def test_parent_is_required_and_must_be_directory_with_exact_spelling(self):
        for entries in ([self.file('a/b')],[self.file('a'),self.file('a/b')],[(dict(type='dir',path='A'),b''),self.file('a/b')]):
            self.operation=str(uuid.uuid4());self.stage=self.root/('stage-'+self.operation);self.frames(entries)
            with self.assertRaisesRegex(StoreError,'FRAME_PARENT'):self.call()
            self.assertEqual(list(self.private.iterdir()),[])
        self.absent()

    def test_unknown_entry_type_rejected(self):
        self.frames([(dict(type='symlink',path='library.json'),b'')])
        with self.assertRaisesRegex(StoreError,'FRAME_TYPE'):self.call()
        self.absent()

    def test_noncanonical_or_duplicate_json_rejected(self):
        for raw in (b'{"type": "file"}',b'{"type":"dir","type":"dir","path":"a"}'):
            self.operation=str(uuid.uuid4());self.stage=self.root/('stage-'+self.operation);self.frames([],raw=struct.pack('>I',len(raw))+raw)
            with self.assertRaisesRegex(StoreError,'FRAME_(CANONICAL|DUPLICATE_FIELD)'):self.call()
        self.absent()

    def test_oversized_frame_rejected(self):
        self.frames([],raw=struct.pack('>I',8193)+b' '*8193)
        with self.assertRaisesRegex(StoreError,'FRAME_BUDGET'):self.call()
        self.absent()

    def test_bad_member_hash_rejected(self):
        entry,content=self.file('library.json');entry['sha256']='0'*64;self.frames([(entry,content)])
        with self.assertRaisesRegex(StoreError,'MEMBER_HASH'):self.call()
        self.absent()

    def test_truncated_frame_data_rejected(self):
        self.frames([],raw=FRAME(dict(type='file',path='library.json',size=100,sha256='0'*64))+b'[]')
        with self.assertRaisesRegex(StoreError,'FRAME_TRUNCATED'):self.call()
        self.absent()

    def test_trailing_bytes_after_end_rejected(self):
        self.frames([self.file('library.json')],tail=b'not-another-archive')
        with self.assertRaisesRegex(StoreError,'FRAME_END'):self.call()
        self.absent()

    def test_manifest_count_and_tree_hash_cannot_lie(self):
        self.frames([self.file('library.json')],end_changes=dict(files=2,treeHash='0'*64))
        with self.assertRaisesRegex(StoreError,'FRAME_MANIFEST'):self.call()
        self.absent()

    def test_limits_apply_to_decrypted_entries_not_ciphertext_only(self):
        self.frames([self.file('library.json'),self.file('extra')])
        with self.assertRaisesRegex(StoreError,'FRAME_QUOTA'):self.call(max_files=1)
        self.absent()

    def test_missing_library_does_not_publish(self):
        self.frames([self.file('opaque.bin',b'bytes')])
        with self.assertRaisesRegex(StoreError,'LIBRARY_REQUIRED'):self.call()
        self.absent()

    def test_live_wal_in_authenticated_archive_requires_coherent_conversion(self):
        db=(self.native/'source/embedding-cache/embeddings.sqlite').read_bytes()
        self.frames([self.file('library.json'),(dict(type='dir',path='embedding-cache'),b''),self.file('embedding-cache/embeddings.sqlite',db),self.file('embedding-cache/embeddings.sqlite-wal',b'uncheckpointed')])
        with self.assertRaisesRegex(StoreError,'COHERENT_SNAPSHOT_REQUIRED'):self.call()
        self.absent()

    def test_hostile_sqlite_schema_is_not_executed_or_published(self):
        file=Path(os.environ['TEMP'])/('hostile-'+str(uuid.uuid4())+'.sqlite')
        with closing(sqlite3.connect(file)) as db:db.executescript('CREATE TABLE vectors(untrusted TEXT); INSERT INTO vectors VALUES(\'opaque\');');db.commit()
        self.frames([self.file('library.json'),(dict(type='dir',path='embedding-cache'),b''),self.file('embedding-cache/embeddings.sqlite',file.read_bytes())])
        with self.assertRaises(StoreError):self.call()
        self.absent()

    def test_fresh_application_failure_blocks_publication(self):
        with patch('orbita_store.legacy_restore.application_validation',side_effect=StoreError('ORBITA_PG_SYNTHETIC_APPLICATION_FAILURE')),self.assertRaisesRegex(StoreError,'SYNTHETIC_APPLICATION_FAILURE'):self.call()
        self.absent()

    def test_failed_readback_blocks_publication(self):
        with patch('orbita_store.legacy_restore.verify_import',side_effect=StoreError('ORBITA_PG_SYNTHETIC_READBACK_FAILURE')),self.assertRaisesRegex(StoreError,'SYNTHETIC_READBACK_FAILURE'):self.call()
        self.absent()

    def crash(self,point):
        raw=dict(self.raw_config,bindings=[dict(root=self.binding.root,workspaceId=self.binding.workspace_id,capability=self.binding.capability)])
        body=dict(config=raw,archive=str(self.source),sha256=self.expected,destination=str(self.destination),stage=str(self.stage),private=str(self.private),node=str(self.node),password=PASSWORD,operationId=self.operation,crash=point)
        env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
        child=subprocess.Popen([sys.executable,'-X','utf8','-B',str(Path(__file__).with_name('legacy_restore_child.py'))],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
        try:stdout,stderr=child.communicate(json.dumps(body).encode(),timeout=60)
        finally:
            if child.poll() is None:child.kill();child.wait(5)
        self.assertEqual(child.returncode,86,stderr.decode('utf8'));self.leave_crash=True;self.crash_stages.append(str(self.private/('orbita-v1-'+self.operation)))

    def test_real_crash_before_commit_keeps_destination_absent(self):
        self.crash('before-promotion')
        self.assertEqual(inspect_restore(self.destination,self.operation,self.expected,config=self.config)['status'],'NOT_PUBLISHED')
        with ObjectStore(self.config,self.binding) as files:self.assertFalse(files.exists('restored'))

    def test_real_crash_after_commit_is_resolved_without_replay(self):
        self.crash('after-promotion');observed=inspect_restore(self.destination,self.operation,self.expected,config=self.config)
        self.assertEqual(observed['status'],'PUBLISHED_PAUSED');self.assertFalse(observed['state']['automaticWork']);self.assertFalse(observed['state']['externalAccess'])
        with self.assertRaisesRegex(StoreError,'DESTINATION_EXISTS'):self.call()
        self.assertEqual(inspect_restore(self.destination,self.operation,self.expected,config=self.config),observed)

    def test_wrong_operation_cannot_claim_published_receipt(self):
        self.call()
        with self.assertRaisesRegex(StoreError,'OPERATION_CONFLICT'):inspect_restore(self.destination,str(uuid.uuid4()),self.expected,config=self.config)

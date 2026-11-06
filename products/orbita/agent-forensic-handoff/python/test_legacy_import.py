"""Independent native SQLite oracles and hostile/resumed common imports."""
from contextlib import closing
from dataclasses import replace
import hashlib,io,json,os,sqlite3,struct,subprocess,sys,unittest,uuid
from pathlib import Path

import test_common_postgres_catalog as fixture
from orbita_store import StoreError
from orbita_store.config import Binding
from orbita_store.connection import Connection
from orbita_store.legacy_import import import_bundle
from orbita_store.legacy_sqlite import NativeReadHold,SqliteTransfer,installed_structure,VEC_SHA256
from orbita_store.manifests import Limits
from orbita_store.objects import ObjectStore,BLOCK
from orbita_store.transfers import import_stream

PYROOT=Path(__file__).resolve().parent

def oracle(root):
    root.mkdir(parents=True)
    env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
    completed=subprocess.run([sys.executable,'-I','-X','utf8','-B',str(PYROOT/'legacy_fixtures/i05_semantic/generate.py'),str(root)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
    if completed.returncode:raise RuntimeError('LEGACY_ORACLE_FAILED: '+completed.stderr.decode('utf8'))
    return json.loads(completed.stdout)

class LegacyImport(unittest.TestCase):
    setUpClass=classmethod(fixture.CommonCatalogue.setUpClass.__func__)
    tearDownClass=classmethod(fixture.CommonCatalogue.tearDownClass.__func__)
    tearDown=fixture.CommonCatalogue.tearDown
    connect=fixture.CommonCatalogue.connect
    def setUp(self):
        fixture.CommonCatalogue.setUp(self)
        self.native=Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/'native-legacy'/str(uuid.uuid4());self.native.mkdir(parents=True)
        self.destination=Path(self.binding.root)/'imported';self.stage=Path(self.binding.root)/'staging'
    def plan(self,items):
        return dict(schema='orbita-legacy-plan-1',sourceRoot=str(self.native),entries=[dict(source=name,target=target,kind=kind,sha256=hashlib.sha256((self.native/name).read_bytes()).hexdigest(),**({'family':family} if kind=='store' else {})) for name,target,kind,family in items])
    def seed(self,text='literal ñ😀'):
        path=self.native/'cache.sqlite'
        with closing(sqlite3.connect(path)) as db:
            db.executescript((self.root/'embedding.sql').read_text(encoding='utf8'))
            db.execute('INSERT INTO vectors VALUES(?,?,?,?,?)',('model','one',text,'[1,0]','hash'));db.commit()
        return self.plan([('cache.sqlite','cache.pgstore','store','embedding')])
    def run_import(self,plan,**kwargs):return import_bundle(plan,self.destination,self.stage,config=self.config,**kwargs)
    def absent(self):
        with ObjectStore(self.config,self.binding,read_only=True) as files:self.assertFalse(files.exists('imported'))

    def exported_oracle(self,name):
        original=oracle(self.native/name)
        env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
        completed=subprocess.run([sys.executable,'-I','-X','utf8','-B',str(PYROOT/'legacy_fixtures/i05_application/generate_export_metadata.py'),str(self.native/name/'semantic')],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(completed.returncode,0,completed.stderr.decode('utf8'))
        proof=json.loads(completed.stdout)
        self.assertEqual(proof['writerSha256'],'203390cb9beb82c9104c661509e2c92ee3ec5d32000e0b963d11d25fa919e87b')
        for item in original['plan']['entries']:item['sha256']=hashlib.sha256((Path(original['plan']['sourceRoot'])/item['source']).read_bytes()).hexdigest()
        return original

    def test_original_i05_export_helpers_are_custody_and_semantic_results_stay_exact(self):
        original=self.exported_oracle('exported');result=self.run_import(original['plan'])
        self.assertEqual(result['status'],'PASS_EXPLICIT_IMPORT')
        self.assertEqual([len(r['provenance']['custody']) for r in result['entries']],[1,9])
        for entry in result['entries']:
            self.assertFalse(any(t['name'].startswith('orbita_export_') for t in entry['result']['manifest']['tables']))
            self.assertEqual(next(c['revision'] for c in entry['provenance']['custody'] if c['name']=='orbita_export_revision'),7)
            with closing(Connection(self.destination/entry['target'],family=entry['result']['family'],config=self.config,read_only=True)) as db:
                self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE name LIKE 'orbita_export_%'").fetchall(),[])
        from unittest.mock import patch
        from afh_semantic.host import dispatch
        raw=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text())
        raw['bindings']=[dict(root=self.binding.root,workspaceId=self.binding.workspace_id,capability=self.binding.capability)]
        with patch.dict(os.environ,{'ORBITA_POSTGRES_BINDING':json.dumps(raw)}):
            os.environ.pop('ORBITA_POSTGRES_CONFIG',None)
            request=dict(root=str(self.destination/'semantic'),scope='scope',sources=original['sources'],op='context_query',question='staging',knownAt='2099-01-01T00:00:00Z',validAt='2026-10-25T00:00:00Z')
            self.assertEqual(dispatch(request),original['before'])
        for item in original['plan']['entries']:self.assertEqual(hashlib.sha256((Path(original['plan']['sourceRoot'])/item['source']).read_bytes()).hexdigest(),item['sha256'])

    def test_export_helper_names_do_not_authorize_changed_bodies_or_incomplete_sets(self):
        variants={
            'body':"DROP TRIGGER orbita_export_update_record_versions; CREATE TRIGGER orbita_export_update_record_versions AFTER UPDATE ON record_versions BEGIN UPDATE orbita_export_revision SET revision=revision+99 WHERE id=1; END;",
            'index':"DROP INDEX orbita_export_first_source; CREATE INDEX orbita_export_first_source ON record_versions(record_id);",
            'missing':"DROP TRIGGER orbita_export_delete_record_versions;",
            'extra':"CREATE INDEX orbita_export_intruder ON record_versions(scope);"}
        for label,statement in variants.items():
            with self.subTest(label=label):
                original=self.exported_oracle('forged-'+label);plan=original['plan'];file=Path(plan['sourceRoot'])/'semantic/records.sqlite3'
                with closing(sqlite3.connect(file)) as db:db.executescript(statement);db.commit()
                plan['entries'][1]['sha256']=hashlib.sha256(file.read_bytes()).hexdigest()
                destination=Path(self.binding.root)/('forged-'+label)
                with self.assertRaisesRegex(StoreError,'LEGACY_EXPORT_METADATA'):
                    import_bundle(plan,destination,Path(self.binding.root)/('stage-'+label),config=self.config)
                with ObjectStore(self.config,self.binding,read_only=True) as files:self.assertFalse(files.exists('forged-'+label))

    def test_export_revision_requires_original_schema_one_row_and_nonnegative_integer(self):
        variants={
            'schema':'DROP TABLE orbita_export_revision; CREATE TABLE orbita_export_revision(id INTEGER PRIMARY KEY,revision INTEGER); INSERT INTO orbita_export_revision VALUES(1,7);',
            'negative':'UPDATE orbita_export_revision SET revision=-1;',
            'missing':'DELETE FROM orbita_export_revision;',
            'text':"UPDATE orbita_export_revision SET revision='untyped';"}
        for label,statement in variants.items():
            with self.subTest(label=label):
                original=self.exported_oracle('revision-'+label);plan=original['plan'];file=Path(plan['sourceRoot'])/'semantic/corpus.sqlite3'
                with closing(sqlite3.connect(file)) as db:db.executescript(statement);db.commit()
                plan['entries'][0]['sha256']=hashlib.sha256(file.read_bytes()).hexdigest()
                destination=Path(self.binding.root)/('revision-'+label)
                with self.assertRaisesRegex(StoreError,'LEGACY_EXPORT_METADATA'):
                    import_bundle(plan,destination,Path(self.binding.root)/('revision-stage-'+label),config=self.config)
                with ObjectStore(self.config,self.binding,read_only=True) as files:self.assertFalse(files.exists('revision-'+label))

    def test_export_prefix_cannot_attach_authority_to_a_different_family(self):
        plan=self.seed();file=self.native/'cache.sqlite'
        with closing(sqlite3.connect(file)) as db:
            db.executescript('CREATE TABLE orbita_export_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT INTO orbita_export_revision VALUES(1,0);');db.commit()
        plan['entries'][0]['sha256']=hashlib.sha256(file.read_bytes()).hexdigest()
        with self.assertRaisesRegex(StoreError,'LEGACY_EXPORT_METADATA_FAMILY'):self.run_import(plan)
        self.absent()

    def long_native_source(self):
        original=self.seed();root=self.native/('long-a-ñ #%'+'a'*85)/('long-b-'+'b'*85)/'source'
        while len(str(root))<=260:
            root=root.parent/('long-c-'+'c'*85)/root.name
        extended=Path('\\\\?\\'+str(root));self.assertGreater(len(str(root)),260);extended.mkdir(parents=True)
        raw=(self.native/'cache.sqlite').read_bytes();(extended/'cache.sqlite').write_bytes(raw)
        plan=dict(original,sourceRoot=str(root))
        return root,extended,plan

    def test_long_native_sqlite_and_original_bytes_import_without_shortening_paths(self):
        root,extended,plan=self.long_native_source();literal=b'long original\x00\xff'
        (extended/'original.bin').write_bytes(literal)
        plan['entries'].append(dict(source='original.bin',target='original.bin',kind='file',sha256=hashlib.sha256(literal).hexdigest()))
        with NativeReadHold(root/'original.bin') as held:
            with self.assertRaises(OSError):(extended/'original.bin').write_bytes(b'changed')
            held.verify()
        result=self.run_import(plan);self.assertEqual(result['status'],'PASS_EXPLICIT_IMPORT')
        with ObjectStore(self.config,self.binding,read_only=True) as files:self.assertEqual(files.read_bytes('imported/original.bin'),literal)
        with closing(Connection(self.destination/'cache.pgstore',family='embedding',config=self.config,read_only=True)) as db:self.assertEqual(db.execute('SELECT text FROM vectors').fetchone(),('literal ñ😀',))
        self.assertEqual((extended/'original.bin').read_bytes(),literal)

    def test_long_wal_and_live_owner_guard_cannot_be_ignored_as_absent(self):
        root,extended,plan=self.long_native_source();wal=extended/'cache.sqlite-wal';wal.write_bytes(b'nonempty wal')
        with self.assertRaisesRegex(StoreError,'LEGACY_COHERENT_SNAPSHOT_REQUIRED'):self.run_import(plan)
        self.absent();self.assertTrue((root/'cache.sqlite-wal').is_relative_to(self.native));wal.unlink()
        guard=extended.parent/('.'+root.name+'.orbita-access.sqlite')
        with closing(sqlite3.connect(str(guard))) as db:
            db.execute('CREATE TABLE owners(token TEXT PRIMARY KEY,pid INTEGER NOT NULL,mode TEXT NOT NULL)')
            db.execute('INSERT INTO owners VALUES(?,?,?)',('own-live-guard',os.getpid(),'shared'));db.commit()
        before=hashlib.sha256(guard.read_bytes()).hexdigest()
        with self.assertRaisesRegex(StoreError,'LEGACY_STORE_BUSY'):self.run_import(plan)
        self.assertEqual(hashlib.sha256(guard.read_bytes()).hexdigest(),before);self.absent()

    def test_independent_i05_sqlite_evidence_and_restricted_diagnostics_remain_exact(self):
        original=oracle(self.native/'oracle');result=self.run_import(original['plan'])
        self.assertEqual(result['status'],'PASS_EXPLICIT_IMPORT');self.assertGreater(sum(len(r['result']['manifest']['tables']) for r in result['entries']),5)
        from unittest.mock import patch
        from afh_semantic.host import dispatch
        from orbita_store.config import read_config
        import afh_semantic.common_backend as backend
        import orbita_store.paths as paths
        # Both consumers get explicit instance/workspace binding, no native
        # operational path and no copied legacy PostgreSQL credential.
        raw=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text())
        raw['bindings']=[dict(root=self.binding.root,workspaceId=self.binding.workspace_id,capability=self.binding.capability)]
        with patch.dict(os.environ,{'ORBITA_POSTGRES_BINDING':json.dumps(raw)}):
            with patch.dict(os.environ):
                os.environ.pop('ORBITA_POSTGRES_CONFIG',None)
                request=dict(root=str(self.destination/'semantic'),scope='scope',sources=original['sources'],op='context_query',question='staging',knownAt='2099-01-01T00:00:00Z',validAt='2026-10-25T00:00:00Z')
                self.assertEqual(dispatch(request),original['before'])
                self.assertEqual(dispatch(dict(request,sources=original['sources'][:1])),original['beforeRestricted'])
        self.assertFalse(Path(self.binding.root).exists())
        for item in original['plan']['entries']:self.assertEqual(hashlib.sha256((Path(original['plan']['sourceRoot'])/item['source']).read_bytes()).hexdigest(),item['sha256'])

    def test_partial_prefix_tampering_rejects_resume_without_destination(self):
        (self.native/'bytes').write_bytes(b'a'*(BLOCK+17));plan=self.plan([('bytes','payload','file',None)])
        def stop(event):
            if event['event']=='durable-prefix':raise InterruptedError('synthetic interrupted copy')
        with self.assertRaises(InterruptedError):self.run_import(plan,progress=stop)
        self.absent()
        with ObjectStore(self.config,self.binding) as files:files.write_bytes('staging/payload/.orbita-legacy/originals/bytes.bin',b'z'*BLOCK)
        with self.assertRaisesRegex(StoreError,'LEGACY_RESUME_PREFIX_MISMATCH'):self.run_import(plan)
        self.absent()

    def test_actual_process_crash_has_no_early_promotion_and_resumes_verified_prefix(self):
        plan=self.seed('crash-safe literal')
        raw=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text())
        raw['bindings']=[dict(root=self.binding.root,workspaceId=self.binding.workspace_id,capability=self.binding.capability)]
        env=dict(os.environ,ORBITA_POSTGRES_BINDING=json.dumps(raw));env.pop('ORBITA_POSTGRES_CONFIG',None)
        request=dict(plan=plan,destination=str(self.destination),stage=str(self.stage),crashAt='durable-prefix')
        completed=subprocess.run([sys.executable,'-I','-B',str(PYROOT/'legacy_import_fixture.py')],input=json.dumps(request).encode(),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(completed.returncode,86,completed.stderr.decode());self.absent()
        # Closing the held child precedes a fresh lease attempt. A live backend
        # remains busy; there is no stale PID timeout or forced unlock.
        import time
        deadline=time.monotonic()+5
        while True:
            try:result=self.run_import(plan);break
            except StoreError as error:
                if 'RECOVERY_STORE_BUSY' not in str(error) or time.monotonic()>=deadline:raise
                time.sleep(.02)
        self.assertEqual(result['status'],'PASS_EXPLICIT_IMPORT')
        with closing(Connection(self.destination/'cache.pgstore',family='embedding',config=self.config,read_only=True)) as db:self.assertEqual(db.execute('SELECT text FROM vectors').fetchone(),('crash-safe literal',))

    def test_converted_store_is_reverified_before_resume(self):
        plan=self.seed()
        def stop(event):
            if event['event']=='entry-verified':raise InterruptedError('before promotion')
        with self.assertRaises(InterruptedError):self.run_import(plan,progress=stop)
        with closing(Connection(Path(self.binding.root)/'staging/payload/cache.pgstore',family='embedding',config=self.config)) as db:db.execute("UPDATE vectors SET text='corrupt prefix'")
        with self.assertRaisesRegex(StoreError,'LEGACY_RESUME_STORE_MISMATCH'):self.run_import(plan)
        self.absent()

    def test_live_native_owner_is_rejected_without_mutating_guard(self):
        plan=self.seed();guard=self.native.parent/('.'+self.native.name+'.orbita-access.sqlite')
        with closing(sqlite3.connect(guard)) as db:
            db.execute('CREATE TABLE owners(token TEXT PRIMARY KEY,pid INTEGER NOT NULL,mode TEXT NOT NULL)');db.execute('INSERT INTO owners VALUES(?,?,?)',('live',os.getpid(),'shared'));db.commit()
        before=guard.read_bytes()
        with self.assertRaisesRegex(StoreError,'LEGACY_STORE_BUSY'):self.run_import(plan)
        self.assertEqual(guard.read_bytes(),before);self.absent()

    def test_open_native_writer_and_nonempty_wal_are_rejected(self):
        plan=self.seed();path=self.native/'cache.sqlite'
        with path.open('r+b'):
            with self.assertRaisesRegex(StoreError,'LEGACY_SOURCE_BUSY_OR_UNAVAILABLE'):self.run_import(plan)
        Path(str(path)+'-wal').write_bytes(b'uncheckpointed evidence')
        with self.assertRaisesRegex(StoreError,'LEGACY_COHERENT_SNAPSHOT_REQUIRED'):self.run_import(plan)
        self.absent();self.assertEqual(Path(str(path)+'-wal').read_bytes(),b'uncheckpointed evidence')

    def test_source_hash_schema_and_unrepresentable_nul_fail_closed(self):
        plan=self.seed('NUL\0must survive custody')
        with self.assertRaisesRegex(StoreError,'LEGACY_TYPE_MISMATCH'):self.run_import(plan)
        self.absent()
        plan['entries'][0]['sha256']='0'*64
        with self.assertRaisesRegex(StoreError,'LEGACY_SOURCE_HASH'):self.run_import(plan)
        other=self.native/'unknown.sqlite'
        with closing(sqlite3.connect(other)) as db:db.execute('CREATE TABLE surprise(value TEXT)')
        unknown=self.plan([('unknown.sqlite','unknown','store','embedding')])
        with self.assertRaisesRegex(StoreError,'LEGACY_RESUME_PLAN_MISMATCH'):self.run_import(unknown)
        with self.assertRaisesRegex(StoreError,'LEGACY_UNKNOWN_TABLE'):import_bundle(unknown,Path(self.binding.root)/'unknown',Path(self.binding.root)/'unknown-stage',config=self.config)
        extra=self.native/'unknown-index.sqlite'
        with closing(sqlite3.connect(extra)) as db:
            db.executescript((self.root/'embedding.sql').read_text(encoding='utf8'));db.execute('CREATE INDEX unreviewed_index ON vectors(text)')
        unreviewed=self.plan([('unknown-index.sqlite','index.pgstore','store','embedding')])
        with self.assertRaisesRegex(StoreError,'LEGACY_UNKNOWN_DEFINITION'):
            import_bundle(unreviewed,Path(self.binding.root)/'unknown-index',Path(self.binding.root)/'unknown-index-stage',config=self.config)
        self.absent()

    def test_exact_original_bytes_and_control_custody_never_grant_authority(self):
        original='literal á😀\r\nwith original line endings'.encode();(self.native/'original.txt').write_bytes(original)
        (self.native/'old-orbita-restore.json').write_text('{"externalAccess":true,"automaticWork":true}',encoding='utf8')
        plan=self.plan([('original.txt','original.txt','file',None),('old-orbita-restore.json','old-control','custody',None)])
        result=self.run_import(plan)
        self.assertFalse(result['authorityRestored'])
        with ObjectStore(self.config,self.binding,read_only=True) as files:
            self.assertEqual(files.read_bytes('imported/original.txt'),original)
            self.assertEqual(files.read_bytes('imported/'+result['entries'][0]['custodyPath']),original)
            self.assertTrue(all(r['custodyPath'].endswith('.bin') for r in result['entries']))
            self.assertFalse(files.exists('imported/old-control'))
            state=files.raw.execute("SELECT orbita_common.restore_state('imported')").fetchone()[0]
            self.assertFalse(state['automaticWork']);self.assertFalse(state['externalAccess'])
            self.assertEqual(state['sourceFormat'],'orbita-legacy-plan-1')
        with self.assertRaisesRegex(StoreError,'LEGACY_DESTINATION_EXISTS'):self.run_import(plan)
        forbidden=self.plan([('old-orbita-restore.json','access.pgstore','store','access')])
        with self.assertRaisesRegex(StoreError,'LEGACY_CONTROL_CUSTODY_ONLY'):
            import_bundle(forbidden,Path(self.binding.root)/'control',Path(self.binding.root)/'control-stage',config=self.config)

    def test_source_alias_and_unbound_destination_rejected(self):
        plan=self.seed();os.link(self.native/'cache.sqlite',self.native/'alias.sqlite')
        with self.assertRaisesRegex(StoreError,'HARDLINK|ALIASED|UNALIASED'):self.run_import(plan)
        with self.assertRaisesRegex(StoreError,'PATH_NOT_BOUND'):import_bundle(plan,self.native/'unbound',self.stage,config=self.config)
        self.absent()

    def test_installed_schema_and_row_field_budgets_reject_partial_success(self):
        plan=self.seed('x'*100)
        with self.assertRaisesRegex(StoreError,'LEGACY_FIELD_BUDGET'):self.run_import(plan,limits=Limits(field_bytes=16))
        self.absent()
        with self.assertRaisesRegex(StoreError,'LEGACY_BYTE_BUDGET'):self.run_import(plan,limits=Limits(bytes=1))
        self.absent()
        structure=installed_structure(Path(self.binding.root)/'probe','embedding',self.config)
        structure['shape']['tables'][0]['sourceHash']='0'*64
        with self.assertRaisesRegex(StoreError,'LEGACY_INSTALLED_SCHEMA_MISMATCH'):SqliteTransfer(self.native/'cache.sqlite',plan['entries'][0]['sha256'],family='embedding',structure=structure)

    def vector_fixture(self,old=False):
        dll=Path(os.environ['ORBITA_LEGACY_VEC_EXTENSION'])
        self.assertEqual(hashlib.sha256(dll.read_bytes()).hexdigest(),VEC_SHA256)
        schema=(self.root/'vector.sql').read_text(encoding='utf8').replace('CREATE TABLE vector_index(rowid INTEGER PRIMARY KEY,embedding BLOB NOT NULL)','CREATE VIRTUAL TABLE vector_index USING vec0(embedding float[2] distance_metric=cosine)')
        if old:schema=schema.replace(', start_cp INTEGER, end_cp INTEGER, token_count INTEGER, representation_id TEXT, source_text_sha256 TEXT','')
        path=self.native/'vectors.sqlite';vector=struct.pack('<ff',1,0)
        with closing(sqlite3.connect(path)) as db:
            db.enable_load_extension(True);db.load_extension(str(dll));db.enable_load_extension(False);db.executescript(schema)
            for rowid in (1000,7,99):
                db.execute('INSERT INTO semantic_embedding VALUES(?,?,?,?,?,?)',(rowid,str(rowid),vector,hashlib.sha256(vector).hexdigest(),2,'now'))
                db.execute('INSERT INTO vector_index(rowid,embedding) VALUES(?,?)',(rowid,vector))
            db.execute('INSERT INTO semantic_chunk(id,content_hash,embedding_rowid,event_id,source_id,record_ordinal,evidence_uri,session_id,event_kind,chunk_index,text,text_sha256,redaction_state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',('c','h',7,'e','s',1,'afh://s/1','session','event',0,'literal','h','raw','now'))
            db.commit()
            expected=db.execute('SELECT rowid,distance FROM vector_index WHERE embedding MATCH ? AND k=3 ORDER BY distance',(vector,)).fetchall()
        return self.plan([('vectors.sqlite','vectors.pgstore','store','vector')]),dll,vector,expected

    def test_native_vec0_bits_and_physical_tie_order_survive_import(self):
        plan,dll,vector,expected=self.vector_fixture()
        receipt=self.run_import(plan,vector_extension=dll)
        self.assertTrue(any(m['kind']=='vec0-physical-order' for m in receipt['entries'][0]['provenance']['mappings']))
        with closing(Connection(self.destination/'vectors.pgstore',family='vector',config=self.config,read_only=True)) as db:
            self.assertEqual(db.raw.execute('SELECT rowid,_index_ordinal,embedding FROM orbita_vector.vector_index ORDER BY _index_ordinal').fetchall(),[(1000,1,vector),(7,2,vector),(99,3,vector)])
            from orbita_store.vectors import nearest
            actual=nearest(db,vector,3)
            self.assertEqual(actual,expected)
        other=self.native/'l2.sqlite'
        with closing(sqlite3.connect(other)) as native:
            native.enable_load_extension(True);native.load_extension(str(dll));native.enable_load_extension(False)
            native.execute('CREATE VIRTUAL TABLE vector_index USING vec0(embedding float[2])')
        bad=self.plan([('l2.sqlite','bad','store','vector')])
        with self.assertRaisesRegex(StoreError,'LEGACY_VECTOR_SCHEMA'):
            import_bundle(bad,Path(self.binding.root)/'l2',Path(self.binding.root)/'l2-stage',config=self.config,vector_extension=dll)

    def test_old_vector_coordinates_stay_explicitly_absent(self):
        plan,dll,vector,expected=self.vector_fixture(old=True)
        receipt=self.run_import(plan,vector_extension=dll)
        self.assertTrue(any(m['kind']=='absent-nullable-columns' and len(m['columns'])==5 for m in receipt['entries'][0]['provenance']['mappings']))
        with closing(Connection(self.destination/'vectors.pgstore',family='vector',config=self.config,read_only=True)) as db:
            self.assertEqual(db.execute('SELECT start_cp,end_cp,token_count,representation_id,source_text_sha256 FROM semantic_chunk').fetchone(),(None,)*5)

if __name__=='__main__':unittest.main()

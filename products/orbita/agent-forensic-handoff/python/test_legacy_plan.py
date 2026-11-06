"""Adversarial planning and an independently written SQLite import/readback."""
from contextlib import closing
import hashlib,json,os,sqlite3,subprocess,sys,unittest,uuid
from pathlib import Path
from unittest.mock import patch

import test_common_postgres_catalog as fixture
from orbita_store import StoreError
from orbita_store.legacy_plan import build_plan
from orbita_store.legacy_import import import_bundle,checked_plan,serialize_plan,MAX_PLAN_ENTRIES,MAX_PLAN_BYTES
from orbita_store.connection import Connection
from orbita_store.objects import ObjectStore
from orbita_store.legacy_sqlite import NativeReadHold
from afh_semantic.path_safety import native_path


class LegacyPlan(unittest.TestCase):
    setUpClass=classmethod(fixture.CommonCatalogue.setUpClass.__func__)
    tearDownClass=classmethod(fixture.CommonCatalogue.tearDownClass.__func__)
    tearDown=fixture.CommonCatalogue.tearDown
    def setUp(self):
        fixture.CommonCatalogue.setUp(self)
        self.native=Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/'planner-native'/str(uuid.uuid4());self.native.mkdir(parents=True)
    def write(self,name,raw):
        p=native_path(self.native/name);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw);return p
    def database(self,name='embedding-cache/embeddings.sqlite',family='embedding'):
        p=native_path(self.native/name);p.parent.mkdir(parents=True,exist_ok=True)
        with closing(sqlite3.connect(p)) as db:
            db.executescript((self.root/(family+'.sql')).read_text(encoding='utf8'))
            if family=='embedding':db.execute('INSERT INTO vectors VALUES(?,?,?,?,?)',('old-writer','one','literal ñ😀','[1,0]','hash'))
            db.commit()
        return p
    def rejects(self,code):
        return self.assertRaisesRegex(StoreError,code)

    def test_deterministic_plan_and_import_preserve_all_bytes_and_typed_rows(self):
        self.database();self.write('opaque/nota.txt','histórico ñ😀'.encode());self.write('library.json',b'[]')
        plan=build_plan(self.native);self.assertEqual(plan,build_plan(self.native))
        result=import_bundle(plan,Path(self.binding.root)/'data',Path(self.binding.root)/'stage',config=self.config)
        with ObjectStore(self.config,self.binding,read_only=True) as files:
            for r in result['entries']:self.assertEqual(files.read_bytes('data/'+r['custodyPath']),native_path(self.native/r['source']).read_bytes())
            state=files.raw.execute("SELECT orbita_common.restore_state('data')").fetchone()[0]
            self.assertFalse(state['automaticWork']);self.assertFalse(state['externalAccess'])
        with closing(Connection(Path(self.binding.root)/'data/embedding-cache/embeddings.pgstore',family='embedding',config=self.config,read_only=True)) as db:
            self.assertEqual(db.execute('SELECT text FROM vectors').fetchall(),[('literal ñ😀',)])
        self.assertFalse(Path(self.binding.root).exists())

    def test_control_lock_and_marker_are_exact_custody_not_authority(self):
        with closing(sqlite3.connect(self.native/'library-lock.sqlite')) as db:db.execute('PRAGMA user_version=1')
        self.write('semantic/postgres-storage.json',b'{"active":true,"old":true}')
        self.write('runtime.json',b'{"private":"synthetic"}')
        plan=build_plan(self.native);self.assertTrue(all(e['kind']=='custody' for e in plan['entries']))
        self.assertEqual(plan['schema'],'orbita-legacy-plan-1')
        result=import_bundle(plan,Path(self.binding.root)/'data',Path(self.binding.root)/'stage',config=self.config)
        with ObjectStore(self.config,self.binding,read_only=True) as files:
            self.assertFalse(files.exists('data/runtime.json'));self.assertFalse(files.exists('data/library-lock.pgstore'))
            for r in result['entries']:self.assertEqual(files.read_bytes('data/'+r['custodyPath']),native_path(self.native/r['source']).read_bytes())

    def test_unknown_sqlite_and_wrong_known_header_fail_without_source_changes(self):
        p=self.database('unrecognized.bin');before=p.read_bytes()
        with self.rejects('LEGACY_PLAN_UNKNOWN_STORE'):build_plan(self.native)
        self.assertEqual(p.read_bytes(),before);p.unlink()
        self.write('embedding-cache/embeddings.sqlite',b'not a SQLite database')
        with self.rejects('LEGACY_PLAN_SQLITE_HEADER'):build_plan(self.native)

    def test_nonempty_wal_or_journal_and_orphan_sidecar_are_rejected(self):
        self.database()
        for suffix in ('-wal','-journal'):
            p=self.write('embedding-cache/embeddings.sqlite'+suffix,b'original nonempty')
            with self.rejects('LEGACY_COHERENT_SNAPSHOT_REQUIRED'):build_plan(self.native)
            self.assertEqual(p.read_bytes(),b'original nonempty');p.unlink()
        self.write('absent.sqlite-wal',b'')
        with self.rejects('LEGACY_PLAN_ORPHAN_SIDECAR'):build_plan(self.native)

    def test_live_parent_guard_hardlink_and_source_budgets_are_not_ignored(self):
        p=self.write('bytes.txt',b'original')
        guard=self.native.parent/('.'+self.native.name+'.orbita-access.sqlite')
        with closing(sqlite3.connect(guard)) as db:db.execute('CREATE TABLE owners(pid INTEGER)');db.execute('INSERT INTO owners VALUES(?)',(os.getpid(),));db.commit()
        with self.rejects('LEGACY_STORE_BUSY'):build_plan(self.native)
        guard.unlink()
        os.link(p,self.native/'alias.txt')
        with self.rejects('LEGACY_REGULAR_UNALIASED_FILE_REQUIRED'):build_plan(self.native)
        (self.native/'alias.txt').unlink()
        with self.rejects('LEGACY_PLAN_SOURCE_BUDGET'):build_plan(self.native,max_bytes=1)
        self.write('second.txt',b'x')
        with self.rejects('LEGACY_PLAN_SOURCE_BUDGET'):build_plan(self.native,max_files=1)

    def test_duplicate_metadata_missing_case_and_orphan_store_are_rejected(self):
        self.write('library.json',b'[{"id":"missing","path":"C:/historical/missing"}]')
        with self.rejects('LEGACY_LIBRARY_MAPPING'):build_plan(self.native)
        self.write('library.json',b'[]');self.database('cases/a/case.sqlite','case')
        with self.rejects('LEGACY_PLAN_ORPHAN_CONTENT_STORE'):build_plan(self.native)
        self.write('cases/a/case.json',b'{"status":"COMPLETE","caseHash":"'+b'a'*64+b'","caseHash":"'+b'a'*64+b'"}')
        with self.rejects('LEGACY_METADATA_DUPLICATE_KEY'):build_plan(self.native)

    def test_case_and_library_mapping_does_not_follow_original_absolute_path(self):
        self.database('cases/a/case.sqlite','case')
        self.write('cases/a/case.json',json.dumps(dict(status='COMPLETE',caseHash='a'*64,sourceSnapshotHash='b'*64)).encode())
        self.write('library.json',b'[{"id":"a","path":"C:/must-never-be-opened/a","selection":false}]')
        plan=build_plan(self.native);self.assertEqual([d['kind'] for d in plan['derivations']],['case','library'])
        result=import_bundle(plan,Path(self.binding.root)/'data',Path(self.binding.root)/'stage',config=self.config)
        with ObjectStore(self.config,self.binding,read_only=True) as files:
            library=json.loads(files.read_bytes('data/library.json'));self.assertFalse(library[0]['selection']);self.assertEqual(library[0]['path'],str(Path(self.binding.root)/'data/cases/a'))
        self.assertEqual(result['status'],'PASS_EXPLICIT_IMPORT')

    def test_long_paths_and_directory_addition_during_retained_scan(self):
        self.native=self.native/('a'*90)/('b'*90)
        while len(str(self.native))<=260:
            self.native=self.native/('c'*90)
        native_path(self.native).mkdir(parents=True)
        self.database();self.assertGreater(len(str(self.native)),260)
        plan=build_plan(self.native);self.assertEqual(len(plan['entries']),1)
        original=NativeReadHold.verify;added=False
        def change(held):
            nonlocal added
            if not added:added=True;self.write('added-after-enumeration.txt',b'new')
            original(held)
        with patch.object(NativeReadHold,'verify',change),self.rejects('LEGACY_PLAN_ENUMERATION_CHANGED'):build_plan(self.native)

    def test_cli_is_explicit_hash_bound_and_will_not_overwrite_or_write_into_source(self):
        self.database();output=self.native.parent/(self.native.name+'.plan.json')
        def run(source,dest):
            done=subprocess.run([sys.executable,'-X','utf8','-B','-m','orbita_store.legacy_plan','--source',str(source),'--output',str(dest)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(done.stderr,b'');return done,json.loads(done.stdout)
        done,receipt=run(self.native,output);self.assertEqual(done.returncode,0);self.assertFalse(receipt['imported'])
        raw=output.read_bytes();self.assertEqual(receipt['planSha256'],hashlib.sha256(raw).hexdigest())
        done,receipt=run(self.native,output);self.assertNotEqual(done.returncode,0);self.assertEqual(output.read_bytes(),raw)
        done,receipt=run(self.native,self.native/'plan.json');self.assertNotEqual(done.returncode,0);self.assertFalse((self.native/'plan.json').exists())
        done,receipt=run('.',output.parent/'relative.json');self.assertNotEqual(done.returncode,0);self.assertEqual(receipt['code'],'ORBITA_PG_CLI_ABSOLUTE_PATH_REQUIRED')

    def test_original_volume_writer_and_all_parquet_are_planned_and_imported(self):
        self.database('cases/a/case.sqlite','case')
        self.write('cases/a/case.json',json.dumps(dict(status='COMPLETE',caseHash='a'*64,sourceSnapshotHash='b'*64)).encode())
        self.write('library.json',json.dumps([dict(id='a',path=str(self.native/'cases/a'),title='synthetic')]).encode())
        script=Path(__file__).parent/'legacy_fixtures/i05_application/generate_volume.py'
        env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
        done=subprocess.run([sys.executable,'-I','-X','utf8','-B',str(script),str(self.native)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(done.returncode,0,done.stderr.decode('utf8'));oracle=json.loads(done.stdout)
        plan=build_plan(self.native);volume=next(d for d in plan['derivations'] if d['kind']=='volume')
        self.assertEqual({plan['entries'][i]['source'] for i in volume['parquet']},{p.relative_to(self.native).as_posix() for p in (self.native/'volume/lake').glob('*.parquet')})
        result=import_bundle(plan,Path(self.binding.root)/'data',Path(self.binding.root)/'stage',config=self.config)
        self.assertEqual(result['derivations'][-1]['cut'],3)
        with closing(Connection(Path(self.binding.root)/'data/volume/operational.pgstore',family='volume',config=self.config,read_only=True)) as db:
            meta=dict(db.execute('SELECT k,v FROM meta').fetchall());self.assertEqual(json.loads(meta['catalog']),oracle['catalog']['sources'])
            self.assertEqual(hashlib.sha256(meta['secret'].encode()).hexdigest(),oracle['secretSha256'])

    def test_orphan_lake_and_projection_identity_mismatch_are_rejected(self):
        p=self.write('volume/lake/orphan.parquet',b'PAR1')
        with self.rejects('LEGACY_PLAN_ORPHAN_LAKE'):build_plan(self.native)
        p.unlink();self.database('cases/a/case.sqlite','case')
        self.write('cases/a/case.json',json.dumps(dict(status='COMPLETE',caseHash='a'*64,sourceSnapshotHash='b'*64)).encode())
        self.write('cases/a/projections/one/semantic.sqlite',b'SQLite format 3\0')
        self.write('cases/a/projections/one/projection.json',json.dumps(dict(status='COMPLETE',caseHash='f'*64,sourceSnapshotHash='b'*64,projectionHash='c'*64)).encode())
        with self.rejects('LEGACY_PROJECTION_IDENTITY'):build_plan(self.native)

    def incomplete_stage(self):
        return 'cases/document-'+('a'*64)+'.document-staging-12345678-1234-1234-1234-123456789abc.tmp-12345/case.sqlite'

    def test_exact_empty_incomplete_stage_is_custody_and_never_operational(self):
        name=self.incomplete_stage();self.write(name,b'');self.write('library.json',b'[]')
        plan=build_plan(self.native);entry=next(e for e in plan['entries'] if e['source']==name)
        self.assertEqual(entry['kind'],'custody');self.assertNotIn('family',entry)
        result=import_bundle(plan,Path(self.binding.root)/'data',Path(self.binding.root)/'stage',config=self.config)
        receipt=next(e for e in result['entries'] if e['source']==name)
        with ObjectStore(self.config,self.binding,read_only=True) as files:
            self.assertFalse(files.exists('data/'+name));self.assertEqual(files.read_bytes('data/'+receipt['custodyPath']),b'')
        self.assertEqual(native_path(self.native/name).read_bytes(),b'')

    def test_incomplete_stage_rejects_bytes_other_members_unknown_names_and_library_selection(self):
        name=self.incomplete_stage();p=self.write(name,b'not empty')
        with self.rejects('LEGACY_PLAN_INCOMPLETE_STAGE'):build_plan(self.native)
        self.assertEqual(p.read_bytes(),b'not empty');p.write_bytes(b'')
        extra=self.write(str(Path(name).parent.as_posix())+'/nested/extra.txt',b'original')
        with self.rejects('LEGACY_PLAN_INCOMPLETE_STAGE'):build_plan(self.native)
        extra.unlink();p.unlink()
        bad=self.write(name.replace('document-staging-','unknown-stage-'),b'')
        with self.rejects('LEGACY_PLAN_UNKNOWN_STORE'):build_plan(self.native)
        bad.unlink();self.write(name,b'')
        self.write('library.json',json.dumps([dict(id=Path(name).parent.name,path='C:/historical/selected')]).encode())
        with self.rejects('LEGACY_LIBRARY_MAPPING'):build_plan(self.native)

    def test_legacy_janus_ledger_preserves_three_tables_without_activating_mirror(self):
        name='semantic/graph-publications/janus-ledger.sqlite3';p=self.database(name,'graph_ledger')
        with closing(sqlite3.connect(p)) as legacy:
            legacy.execute('INSERT INTO claims VALUES(?,?,?,?,?)',('old-config','old-scope','writer',7,123.5))
            legacy.execute('INSERT INTO receipts VALUES(?,?,?,?,?)',('old-config','old-generation',7,'{"synthetic":true}','old-sha'))
            legacy.execute('INSERT INTO selectors VALUES(?,?,?,?,?)',('old-config','old-scope','old-generation',7,'old-sha'));legacy.commit()
            expected={table:legacy.execute('SELECT rowid,* FROM '+table).fetchall() for table in ('claims','receipts','selectors')}
        plan=build_plan(self.native);self.assertEqual(plan['entries'][0]['family'],'graph_ledger')
        self.assertEqual(plan['entries'][0]['target'],'semantic/graph-publications/janus-ledger.pgstore')
        import_bundle(plan,Path(self.binding.root)/'data',Path(self.binding.root)/'stage',config=self.config)
        with closing(Connection(Path(self.binding.root)/'data/semantic/graph-publications/janus-ledger.pgstore',family='graph_ledger',config=self.config,read_only=True)) as db:
            for table,rows in expected.items():self.assertEqual(db.execute('SELECT rowid,* FROM '+table).fetchall(),rows)
        with ObjectStore(self.config,self.binding,read_only=True) as files:
            self.assertFalse(files.exists('data/semantic/graph-publications/mirror-ledger.pgstore'))

    def test_import_plan_accepts_f36_member_count_and_keeps_absolute_entry_cap(self):
        # Contract check, not a claim to have imported the real 13-GB fixture.
        entries=[dict(source=f'files/{i:05}.bin',target=f'files/{i:05}.bin',sha256='a'*64,kind='file') for i in range(20035)]
        plan=dict(schema='orbita-legacy-plan-1',sourceRoot=str(self.native),entries=entries)
        raw=serialize_plan(plan);self.assertLessEqual(len(raw),MAX_PLAN_BYTES)
        result=checked_plan(plan,Path(self.binding.root)/'data',Path(self.binding.root)/'stage',self.config)
        self.assertEqual(result[0],self.binding);self.assertEqual(len(result[3]['plan']['entries']),20035)
        plan['entries']=[entries[0]]*(MAX_PLAN_ENTRIES+1)
        with self.rejects('LEGACY_PLAN_BUDGET'):checked_plan(plan,Path(self.binding.root)/'data',Path(self.binding.root)/'stage',self.config)
        with self.rejects('LEGACY_PLAN_LIMITS'):build_plan(self.native,max_files=MAX_PLAN_ENTRIES+1)

    def test_serialized_plan_budget_counts_actual_utf8_bytes_before_output(self):
        raw=serialize_plan(dict(literal='ñ😀'));self.assertEqual(json.loads(raw),dict(literal='ñ😀'))
        self.assertEqual(len(raw),len('{"literal":"ñ😀"}'.encode('utf8')))
        with self.rejects('LEGACY_PLAN_DOCUMENT_BUDGET'):serialize_plan(dict(literal='ñ'*(MAX_PLAN_BYTES//2)))


if __name__=='__main__':unittest.main()

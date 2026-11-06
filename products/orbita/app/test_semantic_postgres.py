"""Original 21 guarantees, independent I05 SQLite oracle -> common PG.

Historical test names are retained for traceability. Portable restore now uses
common content snapshots and explicit binding, never a live SQLite fallback.
"""
import copy,hashlib,json,os,pathlib,shutil,sqlite3,subprocess,sys,time,unittest,uuid
from contextlib import closing
from datetime import datetime,timedelta,timezone
from unittest.mock import patch
PYROOT=pathlib.Path(__file__).resolve().parent.parent/'agent-forensic-handoff/python';sys.path.insert(0,str(PYROOT))
from afh_semantic.host import dispatch,digest
from afh_semantic.common_backend import Connection
from orbita_store.config import read_config,binding_for
from orbita_store.legacy_import import import_bundle
from orbita_store.objects import ObjectStore
from orbita_store.session import Session
from orbita_store.pool import close_idle
from orbita_store import StoreError
from common_test_fixture import WorkspaceFixture
from test_legacy_import import oracle
from test_semantic import source

def state(root):
    result=[]
    for family,name in [('corpus','corpus.pgstore'),('semantic','records.pgstore')]:
        with closing(Connection(root/'semantic'/name,family=family,read_only=True)) as db:result.append(db.logical_manifest())
    return result

class SemanticPostgresTest(unittest.TestCase):

    def setUp(self):
        self.tmp=WorkspaceFixture(self._testMethodName);self.addCleanup(self.tmp.cleanup)
        self.config=read_config();self.rawconfig=json.loads(os.environ['ORBITA_POSTGRES_BINDING'])
        self.lab=pathlib.Path(self.tmp.name);self.root=self.lab/'data';self.sem=self.root/'semantic'
        self.native=pathlib.Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/'native-semantic21'/self.tmp.id
        original=oracle(self.native);self.plan=original['plan']
        self.sources=original['sources'];self.first=original['first'];self.second=original['second'];self.cut=original['cut']
        self.before=original['before'];self.beforeRestricted=original['beforeRestricted']
        self.migration=self.import_to(self.root)
    def import_to(self,destination,**options):
        return import_bundle(self.plan,destination,destination.with_name(destination.name+'-staging'),config=self.config,**options)
    def restore_to(self,destination):
        binding,key=binding_for(self.root,self.config);other,newkey=binding_for(destination,self.config);self.assertEqual(other,binding)
        from psycopg.types.json import Jsonb
        with ObjectStore(self.config,binding) as files:
            # A fresh explicit destination stays disabled; copied historical
            # settings cannot activate work or external access.
            files.raw.execute('SELECT orbita_common.prepare_restore(%s,%s)',(newkey,Jsonb(dict(schema='orbita-restore-2',id=str(uuid.uuid4())))))
            return files.clone_tree(key,newkey)
    def tearDown(self):
        close_idle()
    def call(self,op,**args):return dispatch(dict(root=str(self.sem),scope='scope',sources=self.sources,op=op,**args))
    def extract(self,index,name,relation=None):
        s=self.sources[index];e=[dict(sourceId=s['id'],quote=s['text'])]
        clause=dict(key=name,quote=s['text'],predicate='staging',polarity='negative' if index else 'positive',resolution='resolved',arguments=[dict(role='project',literal='Alfa',interpreted='',evidence=e)],conditions=[],temporal=[],relations=[])
        if relation:clause['relations']=[dict(kind='retracts',targetClauseVersionId=relation,evidence=e)]
        act=dict(key=name,targetSourceId=s['id'],type='policy',summary=s['text'],modality='directive',clauses=[clause])
        value=self.call('extract',draft=dict(acts=[act]),producer='synthetic-fixture',sourceCut='cut',requestId='request-'+name)
        self.assertEqual(value['errors'],[]);return value['records'][0]
    def test_full_migration_and_f22_identical_evidence(self):
        self.assertEqual(self.migration['status'],'PASS_EXPLICIT_IMPORT');self.assertGreater(sum(len(x['result']['manifest']['tables']) for x in self.migration['entries']),5)
        after=self.call('context_query',question='staging',knownAt='2099-01-01T00:00:00Z',validAt='2026-10-25T00:00:00Z');self.assertEqual(after,self.before)
        self.assertTrue(after['requiresAbstention']);self.assertEqual(len(after['items']),2)
    def test_bounded_store_keeps_pre_migration_outside_selection_diagnostics(self):
        self.sources=self.sources[:1]
        self.assertEqual(self.call('context_query',question='staging',knownAt='2099-01-01T00:00:00Z',validAt='2026-10-25T00:00:00Z'),self.beforeRestricted)
    def test_current_correction_invalidates_state_but_historical_cut_survives(self):
        old=state(self.root);record=self.call('get',id=self.first['id']);p=copy.deepcopy(record['payload']);p['text']='Revisión explícita; vigencia no demostrada'
        changed=self.call('put',payload=p,expectedVersion=1,requestId='correct-now');self.assertEqual(changed['version'],2)
        self.assertNotEqual(state(self.root),old)
        history=self.call('context_query',question='staging',knownAt=self.cut);self.assertEqual(len(history['items']),1)
        self.assertEqual(history['items'][0]['recordVersion'],1)
    def test_cas_and_idempotency_survive_remote_roundtrip(self):
        p=copy.deepcopy(self.first['payload']);p['text']='Corrección sin apoyo demostrado'
        a=self.call('put',payload=p,expectedVersion=1,requestId='retry');self.assertEqual(a,self.call('put',payload=p,expectedVersion=1,requestId='retry'))
        with self.assertRaisesRegex(Exception,'VERSION_CONFLICT'):self.call('put',payload=p,expectedVersion=1,requestId='stale')
    def test_json_support_index_and_fts_preserve_sqlite_tokenization(self):
        conn=Connection(self.sem/'records.pgstore',family='semantic')
        try:
            conn.execute("CREATE INDEX IF NOT EXISTS support_decision_lookup ON record_versions(scope,json_extract(payload,'$.support.kind'),json_extract(payload,'$.support.detail.decision.caseId'),json_extract(payload,'$.support.detail.alternativeId'),record_id,recorded_at)")
            self.assertEqual(conn.execute("SELECT json_extract(payload,'$.support.kind') AS kind FROM record_versions LIMIT 1").fetchone()['kind'],None)
            conn.execute('CREATE VIRTUAL TABLE IF NOT EXISTS afh_publication_fts USING fts5(outbox_id UNINDEXED,text)')
            conn.execute('INSERT INTO afh_publication_fts VALUES(?,?)',('accent','Éxito alfa_beta revisión'))
            conn.execute('INSERT INTO afh_publication_fts VALUES(?,?)',('other','different'))
            conn.commit()
            for query in ('"exito"','"beta"','"revisión"','"missing" OR "éxito"'):
                rows=conn.execute('SELECT f.outbox_id FROM afh_publication_fts f WHERE afh_publication_fts MATCH ?',(query,)).fetchall()
                self.assertEqual([r['outbox_id'] for r in rows],['accent'])
        finally:conn.close()
    def test_append_only_and_failed_transaction_roll_back(self):
        conn=Connection(self.sem/'records.pgstore',family='semantic')
        try:
            with self.assertRaisesRegex(Exception,'append only'):conn.execute("UPDATE record_versions SET version=99")
            conn.rollback();self.assertEqual(conn.execute('SELECT COUNT(*) FROM record_versions').fetchone()[0],2)
        finally:conn.close()
    def test_dependency_outside_current_selection_blocks(self):
        self.sources=self.sources[1:];result=self.call('context_query',question='revoca')
        self.assertTrue(result['missing']);self.assertTrue(result['requiresAbstention']);self.assertTrue(result['contextUnits'][0]['blocked'])
    def test_current_source_revision_mismatch_fails(self):
        self.sources[0]=source('rep-rule','Altered source')
        with self.assertRaisesRegex(Exception,'AFH_REGISTRY_CORRUPT|REVISION'):self.call('get',id=self.first['id'])
    def test_request_binding_cache_cannot_override_current_selection(self):
        from afh_semantic.host import AFHMemory
        memory=AFHMemory(self.sem,copy.deepcopy(self.sources),'scope')
        try:
            memory.evidence('rep-rule');self.assertIn('rep-rule',memory._binding_cache)
            memory.sources['rep-rule']['revision']='changed'
            with self.assertRaisesRegex(Exception,'AFH_REGISTRY_CORRUPT'):memory.evidence('rep-rule')
            del memory.sources['rep-rule']
            with self.assertRaisesRegex(Exception,'AFH_SOURCE_NOT_SELECTED'):memory.evidence('rep-rule')
        finally:memory.close()
    def test_restored_index_retains_records_with_a_second_selected_source(self):
        a,b=self.sources;e=[dict(sourceId=b['id'],quote=b['text'])]
        clause=dict(key='context',quote=a['text'],predicate='staging',polarity='positive',resolution='resolved',arguments=[dict(role='context',literal=b['text'],interpreted='',evidence=e)],conditions=[],temporal=[],relations=[])
        act=dict(key='multi-source',targetSourceId=a['id'],type='policy',summary=a['text'],modality='directive',clauses=[clause])
        result=self.call('extract',draft=dict(acts=[act]),producer='synthetic-fixture',sourceCut='cut',requestId='multi-source');self.assertEqual(result['errors'],[]);record=result['records'][0]
        dest=self.lab/'indexed-restored';self.restore_to(dest)
        for selected in ([a],[b]):
            output=dispatch(dict(root=str(dest/'semantic'),scope='scope',sources=selected,op='context_query',question='staging'))
            self.assertTrue(any(x.get('record')==record['id'] and x.get('reason')=='source_outside_selection' for x in output['limitations']),output['limitations'])
            self.assertTrue(output['requiresAbstention'])
    def test_restore_exports_remote_correction_to_sqlite_in_fresh_process(self):
        p=copy.deepcopy(self.first['payload']);p['text']='Preservar la corrección remota'
        changed=self.call('put',payload=p,expectedVersion=1,requestId='before-backup')
        dest=self.lab/'restored';self.restore_to(dest)
        request=dict(root=str(dest/'semantic'),scope='scope',sources=self.sources,op='get',id=self.first['id'])
        env=dict(os.environ,AFH_SEMANTIC_PG_CONFIG=str(self.native/'connection-no-longer-exists.json'))
        output=subprocess.check_output([sys.executable,'-I','-X','utf8','-B',str(PYROOT/'bridge.py')],input=json.dumps(request).encode(),env=env,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
        result=json.loads(output);self.assertTrue(result['ok'],result);self.assertEqual(result['result'],changed)
        self.assertFalse(self.lab.exists())
    def test_copied_config_does_not_authorize_a_different_root(self):
        dest=self.native.parent/(self.native.name+'-unauthorized-copy');shutil.copytree(self.native,dest)
        with self.assertRaisesRegex(StoreError,'PATH_NOT_BOUND'):binding_for(dest/'semantic/records.pgstore',self.config)
        with self.assertRaisesRegex(StoreError,'PATH_NOT_BOUND'):dispatch(dict(root=str(dest/'semantic'),scope='scope',sources=self.sources,op='get',id=self.first['id']))
    def test_managed_worker_cannot_inherit_personal_connection(self):
        from orbita_store.connection import Connection as CommonConnection
        from orbita_store.config import parse_config
        control=CommonConnection(self.lab/'control/access.pgstore',family='access',config=self.config,create=True)
        try:
            control.executescript((PYROOT/'orbita_store/schemas/access.sql').read_text())
            control.execute("INSERT INTO users VALUES('owner','owner','salt','derived-only',1,1,1)")
            now=datetime.now(timezone.utc);local='ws-'+str(uuid.uuid4())
            date=lambda days:(now+timedelta(days=days)).isoformat(timespec='milliseconds').replace('+00:00','Z')
            body=dict(id=local,owner='owner',revision=1,status='active',policy=dict(rightsUntil=date(1),retainUntil=date(2)),legalHold=False,externalCopies=[])
            with control.raw.transaction():
                control.execute('INSERT INTO workspaces VALUES(?,?,?)',(local,1,json.dumps(body)))
                control.execute("INSERT INTO members VALUES(?,'owner','owner',1)",(local,))
                control.execute("INSERT INTO audit(at,actor,action,workspace,detail) VALUES('now','owner','workspace_created',?,'{}')",(local,))
                created=control.raw.execute("SELECT orbita_common.provision_managed(%s)",(local,)).fetchone()[0]
            details=control.raw.execute("SELECT orbita_common.managed_binding(%s,'worker')",(local,)).fetchone()[0]
            child=dict(self.rawconfig,bindings=[dict(root=str(self.lab/'control/spaces'/local),workspaceId=details['workspaceId'],capability=details['capability'])])
            receipt=pathlib.Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixtures-semantic21-managed-'+self.tmp.id+'.json')
            receipt.write_text(json.dumps(dict(instanceId=self.config.instance_id,workspaceIds=[self.tmp.workspace_id,created['workspaceId']]),indent=2))
            with patch.dict(os.environ,{'ORBITA_POSTGRES_BINDING':json.dumps(child),'AFH_MANAGED':'1','AFH_SEMANTIC_PG_CONFIG':str(self.native/'personal.json')}):
                with self.assertRaisesRegex(StoreError,'PATH_NOT_BOUND'):self.call('get',id=self.first['id'])
                parsed=parse_config(child)
                with Session(parsed,parsed.bindings[0],read_only=True) as admitted:
                    self.assertEqual(str(admitted.raw.execute('SELECT orbita_common.workspace_id()').fetchone()[0]),created['workspaceId'])
        finally:control.close()
    def test_connection_failure_cannot_fall_back_to_stale_shadow(self):
        broken=dict(self.rawconfig,port=1)
        with patch.dict(os.environ,{'ORBITA_POSTGRES_BINDING':json.dumps(broken)}):
            with self.assertRaisesRegex(StoreError,'CONNECT_OR_AUTHORIZE_FAILED'):self.call('get',id=self.first['id'])
        self.assertTrue((self.native/'semantic/records.sqlite3').is_file());self.assertFalse(self.lab.exists())
    def new_destination(self,name):return self.lab/name
    def test_migration_rejects_a_live_local_owner(self):
        guard=self.native.parent/('.'+self.native.name+'.orbita-access.sqlite')
        with closing(sqlite3.connect(guard)) as db:
            db.execute('CREATE TABLE owners(token TEXT PRIMARY KEY,pid INTEGER NOT NULL,mode TEXT NOT NULL)');db.execute('INSERT INTO owners VALUES(?,?,?)',('live',os.getpid(),'shared'));db.commit()
        before=guard.read_bytes()
        with self.assertRaisesRegex(StoreError,'LEGACY_STORE_BUSY'):self.import_to(self.new_destination('busy'))
        self.assertEqual(guard.read_bytes(),before)
    def test_real_process_crash_resumes_verified_prefix_without_early_promotion(self):
        dest=self.new_destination('crash')
        request=dict(plan=self.plan,destination=str(dest),stage=str(dest.with_name(dest.name+'-staging')),crashAt='durable-prefix')
        env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','path','pathext','comspec','temp','tmp')};env['ORBITA_POSTGRES_BINDING']=json.dumps(self.rawconfig)
        child=subprocess.run([sys.executable,'-I','-X','utf8','-B',str(PYROOT/'legacy_import_fixture.py')],input=json.dumps(request).encode(),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(child.returncode,86,child.stderr.decode('utf8'))
        binding,key=binding_for(dest,self.config)
        with ObjectStore(self.config,binding,read_only=True) as files:self.assertFalse(files.exists(key))
        self.assertFalse((self.native/'semantic/postgres-storage.json').exists())
        deadline=time.monotonic()+5
        while True:
            try:result=self.import_to(dest);break
            except StoreError as error:
                if 'RECOVERY_STORE_BUSY' not in str(error) or time.monotonic()>=deadline:raise
                time.sleep(.02)
        self.assertEqual(result['status'],'PASS_EXPLICIT_IMPORT')
        actual=dispatch(dict(root=str(dest/'semantic'),scope='scope',sources=self.sources,op='context_query',question='staging',knownAt='2099-01-01T00:00:00Z',validAt='2026-10-25T00:00:00Z'))
        self.assertEqual(actual,self.before)
    def corrupt_owned_table(self,table,assignment,parameters=()):
        self.assertIn(table,('record_envelopes','semantic_clause_versions'))
        self.assertIn(assignment,('digest=%s','clause_sha256=%s'));self.assertEqual(len(parameters),1)
        with closing(Connection(self.sem/'records.pgstore',family='semantic')) as conn:
            self.tmp.corrupt(conn,table,{assignment.split('=')[0]:parameters[0]})
    def open_batched_read(self):
        from afh_semantic.host import AFHMemory
        from afh_semantic.knowledge_records import KnowledgeRecords
        memory=AFHMemory(self.sem,copy.deepcopy(self.sources),'scope')
        records=KnowledgeRecords(memory,self.sem/'records.pgstore',read_only=True)
        records.db.execute('BEGIN')
        rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? ORDER BY record_id,version',('scope',)).fetchall()
        records.db.prefetch_integrity(rows);self.assertIsNotNone(records.db.integrity_batch)
        return memory,records,rows
    def test_batch_does_not_hide_a_corrupt_committed_envelope(self):
        self.corrupt_owned_table('record_envelopes','digest=%s',('0'*64,))
        with self.assertRaisesRegex(Exception,'RECORD_CORRUPT'):self.call('context_query',question='staging')
    def test_batch_uses_database_identity_evidence_not_payload_self_assertion(self):
        self.corrupt_owned_table('semantic_clause_versions','clause_sha256=%s',('0'*64,))
        with self.assertRaisesRegex(Exception,'SEMANTIC_IDMAP_MISMATCH'):self.call('context_query',question='staging')
    def test_batch_cannot_carry_a_valid_envelope_into_a_later_transaction(self):
        memory,records,rows=self.open_batched_read()
        try:
            self.assertEqual(records._envelope(rows[0])['integrity'],'envelope_v1')
            records.db.rollback();self.corrupt_owned_table('record_envelopes','digest=%s',('0'*64,))
            records.db.execute('BEGIN')
            with self.assertRaisesRegex(Exception,'RECORD_CORRUPT'):records._envelope(rows[0])
        finally:records.close();memory.close()
    def test_batch_never_caches_current_source_permission(self):
        memory,records,rows=self.open_batched_read()
        try:
            verified=records._envelope(rows[0]);sid=verified['payload']['source_refs'][0]['id'];del memory.sources[sid]
            with self.assertRaisesRegex(Exception,'SOURCE_SCOPE_MISMATCH'):records._envelope(rows[0])
        finally:records.close();memory.close()
    def test_batch_never_treats_an_existing_invalid_admission_as_absent(self):
        conn=Connection(self.sem/'records.pgstore',family='semantic')
        try:
            conn.execute('INSERT INTO semantic_support_admissions VALUES(?,?,?,?,?,?,?,?,?,?)',(self.first['id'],1,digest(self.first['payload']),'{}','{}','0'*64,'synthetic-reviewer','synthetic-producer','{}','0'*64))
            conn.commit()
        finally:conn.close()
        with closing(Connection(self.sem/'records.pgstore',family='semantic',read_only=True)) as fresh:
            self.assertEqual(fresh.execute('SELECT COUNT(*) FROM semantic_support_admissions WHERE record_id=?',(self.first['id'],)).fetchone()[0],1)
        with self.assertRaises(KeyError):self.call('context_query',question='staging')


if __name__=='__main__':
    result=unittest.TextTestRunner(stream=sys.stderr,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(SemanticPostgresTest))
    print(json.dumps(dict(status='PASS' if result.wasSuccessful() else 'FAIL',tests=result.testsRun,skipped=len(result.skipped),failures=len(result.failures),errors=len(result.errors))))
    raise SystemExit(not result.wasSuccessful())

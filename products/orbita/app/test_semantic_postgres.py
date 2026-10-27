"""Real PostgreSQL contract tests. A missing service/config is a failure, never SKIP."""
import copy, hashlib, json, os, pathlib, shutil, sqlite3, subprocess, sys, tempfile, unittest, uuid
PYROOT=pathlib.Path(__file__).resolve().parent.parent/'agent-forensic-handoff/python';sys.path.insert(0,str(PYROOT))
from afh_semantic.host import dispatch, digest
from afh_semantic.postgres_backend import binding, Connection, atomic_json, read_config, state
from afh_semantic.postgres_migration import migrate,export_held
from test_semantic import source

class SemanticPostgresTest(unittest.TestCase):
    def setUp(self):
        self.old=os.environ.pop('AFH_SEMANTIC_PG_CONFIG',None)
        cfg=json.loads(pathlib.Path(os.environ['AFH_SEMANTIC_PG_TEST_CONFIG']).read_text(encoding='utf8'))
        self.lab=pathlib.Path(tempfile.mkdtemp(prefix='semantic-',dir=cfg['testRoot']));self.root=self.lab/'data';self.sem=self.root/'semantic';self.sem.mkdir(parents=True)
        self.config=self.lab/'connection.json';cfg['roots']={str(self.root):dict(namespace=uuid.uuid4().hex,active=False)};atomic_json(self.config,cfg)
        self.sources=[source('rep-rule','Alfa permite staging sólo si pasa QA.'),source('rep-revoke','Alfa revoca staging hasta nueva revisión.','B')]
        self.first=self.extract(0,'rule');self.cut=self.first['recorded_at'];self.second=self.extract(1,'revocation',self.first['payload']['semantic_unit']['clauses'][0]['clause_version_id'])
        self.before=self.call('context_query',question='staging',knownAt='2099-01-01T00:00:00Z',validAt='2026-10-25T00:00:00Z')
        self.beforeRestricted=dispatch(dict(root=str(self.sem),scope='scope',sources=self.sources[:1],op='context_query',question='staging',knownAt='2099-01-01T00:00:00Z',validAt='2026-10-25T00:00:00Z'))
        os.environ['AFH_SEMANTIC_PG_CONFIG']=str(self.config);self.migration=migrate(self.root)
    def tearDown(self):
        if self.old is None:os.environ.pop('AFH_SEMANTIC_PG_CONFIG',None)
        else:os.environ['AFH_SEMANTIC_PG_CONFIG']=self.old
    def call(self,op,**args):return dispatch(dict(root=str(self.sem),scope='scope',sources=self.sources,op=op,**args))
    def extract(self,index,name,relation=None):
        s=self.sources[index];e=[dict(sourceId=s['id'],quote=s['text'])]
        clause=dict(key=name,quote=s['text'],predicate='staging',polarity='negative' if index else 'positive',resolution='resolved',arguments=[dict(role='project',literal='Alfa',interpreted='',evidence=e)],conditions=[],temporal=[],relations=[])
        if relation:clause['relations']=[dict(kind='retracts',targetClauseVersionId=relation,evidence=e)]
        act=dict(key=name,targetSourceId=s['id'],type='policy',summary=s['text'],modality='directive',clauses=[clause])
        value=self.call('extract',draft=dict(acts=[act]),producer='synthetic-fixture',sourceCut='cut',requestId='request-'+name)
        self.assertEqual(value['errors'],[]);return value['records'][0]
    def test_full_migration_and_f22_identical_evidence(self):
        self.assertEqual(self.migration['status'],'PASS');self.assertGreater(self.migration['tables'],5)
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
        conn=Connection(self.sem/'records.sqlite3',binding(self.sem/'records.sqlite3'))
        try:
            conn.execute("CREATE INDEX IF NOT EXISTS support_lookup_test ON record_versions(scope,json_extract(payload,'$.support.kind'))")
            self.assertEqual(conn.execute("SELECT json_extract(payload,'$.support.kind') AS kind FROM record_versions LIMIT 1").fetchone()['kind'],None)
            conn.execute('CREATE VIRTUAL TABLE IF NOT EXISTS afh_publication_fts USING fts5(outbox_id UNINDEXED,text)')
            conn.execute('INSERT INTO afh_publication_fts VALUES(?,?)',('accent','Éxito alfa_beta revisión'))
            conn.execute('INSERT INTO afh_publication_fts VALUES(?,?)',('other','different'))
            for query in ('"exito"','"beta"','"revisión"','"missing" OR "éxito"'):
                rows=conn.execute('SELECT f.outbox_id FROM afh_publication_fts f WHERE afh_publication_fts MATCH ?',(query,)).fetchall()
                self.assertEqual([r['outbox_id'] for r in rows],['accent'])
        finally:conn.close()
    def test_append_only_and_failed_transaction_roll_back(self):
        conn=Connection(self.sem/'records.sqlite3',binding(self.sem/'records.sqlite3'))
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
        guard,_=export_held(self.root)
        try:dest=self.lab/'indexed-restored';shutil.copytree(self.root,dest)
        finally:guard.close()
        atomic_json(dest.parent/('.'+dest.name+'.orbita-restore.json'),dict(externalAccess=False,automaticWork=False))
        for selected in ([a],[b]):
            output=dispatch(dict(root=str(dest/'semantic'),scope='scope',sources=selected,op='context_query',question='staging'))
            self.assertTrue(any(x.get('record')==record['id'] and x.get('reason')=='source_outside_selection' for x in output['limitations']),output['limitations'])
            self.assertTrue(output['requiresAbstention'])
    def test_restore_exports_remote_correction_to_sqlite_in_fresh_process(self):
        p=copy.deepcopy(self.first['payload']);p['text']='Preservar la corrección remota'
        changed=self.call('put',payload=p,expectedVersion=1,requestId='before-backup')
        guard,receipt=export_held(self.root)
        try:
            self.assertEqual(receipt['backend'],'postgres');dest=self.lab/'restored';shutil.copytree(self.root,dest)
        finally:guard.close()
        atomic_json(dest.parent/('.'+dest.name+'.orbita-restore.json'),dict(externalAccess=False,automaticWork=False))
        request=dict(root=str(dest/'semantic'),scope='scope',sources=self.sources,op='get',id=self.first['id'])
        env=dict(os.environ);env['AFH_SEMANTIC_PG_CONFIG']=str(self.lab/'connection-no-longer-exists.json')
        output=subprocess.check_output([sys.executable,'-I','-B',str(PYROOT/'bridge.py')],input=json.dumps(request).encode(),env=env)
        result=json.loads(output);self.assertTrue(result['ok'],result);self.assertEqual(result['result'],changed)
    def test_copied_config_does_not_authorize_a_different_root(self):
        dest=self.lab/'unauthorized-copy';shutil.copytree(self.root,dest)
        with self.assertRaisesRegex(Exception,'CONNECTION_NOT_ADMITTED'):binding(dest/'semantic/records.sqlite3')
    def test_managed_worker_cannot_inherit_personal_connection(self):
        os.environ['AFH_MANAGED']='1'
        try:
            with self.assertRaisesRegex(Exception,'MANAGED_NOT_ADMITTED'):self.call('get',id=self.first['id'])
        finally:os.environ.pop('AFH_MANAGED',None)
    def test_connection_failure_cannot_fall_back_to_stale_shadow(self):
        cfg=read_config();cfg['port']=1;atomic_json(self.config,cfg)
        with self.assertRaisesRegex(Exception,'SEMANTIC_PG_UNAVAILABLE'):self.call('get',id=self.first['id'])
    def new_destination(self,name):
        dest=self.lab/name;shutil.copytree(self.root,dest,ignore=shutil.ignore_patterns('postgres-storage.json'))
        cfg=read_config();cfg['roots'][str(dest)]=dict(namespace=uuid.uuid4().hex,active=False);atomic_json(self.config,cfg);return dest
    def test_migration_rejects_a_live_local_owner(self):
        from afh_semantic.postgres_migration import exclusive
        dest=self.new_destination('busy');release=exclusive(dest)
        try:
            with self.assertRaisesRegex(Exception,'MIGRATION_STORE_BUSY'):migrate(dest)
        finally:release()
    def test_real_process_crash_resumes_verified_prefix_without_early_promotion(self):
        dest=self.new_destination('crash');env=dict(os.environ,AFH_SEMANTIC_CRASH_AT='after-copy-batch')
        result=subprocess.run([sys.executable,'-I','-B',str(PYROOT/'semantic-storage-cli.py')],input=(json.dumps(dict(op='migrate',root=str(dest)))+'\n').encode(),env=env,stdout=subprocess.PIPE)
        self.assertEqual(result.returncode,86);self.assertFalse(read_config()['roots'][str(dest)]['active']);self.assertFalse((dest/'semantic/postgres-storage.json').exists())
        self.assertEqual(migrate(dest)['status'],'PASS')
        result=dispatch(dict(root=str(dest/'semantic'),scope='scope',sources=self.sources,op='context_query',question='staging',knownAt='2099-01-01T00:00:00Z',validAt='2026-10-25T00:00:00Z'))
        self.assertEqual(result,self.before)

    def corrupt_owned_table(self,table,assignment,parameters=()):
        # Negative evidence in this test's isolated, synthetic namespace only.
        self.assertIn(table,('record_envelopes','semantic_clause_versions'))
        conn=Connection(self.sem/'records.sqlite3',binding(self.sem/'records.sqlite3'))
        try:
            with conn.raw.transaction():
                conn.raw.execute('ALTER TABLE '+table+' DISABLE TRIGGER USER')
                conn.raw.execute('UPDATE '+table+' SET '+assignment,parameters)
                conn.raw.execute('ALTER TABLE '+table+' ENABLE TRIGGER USER')
        finally:conn.close()
    def open_batched_read(self):
        from afh_semantic.host import AFHMemory
        from afh_semantic.knowledge_records import KnowledgeRecords
        memory=AFHMemory(self.sem,copy.deepcopy(self.sources),'scope')
        records=KnowledgeRecords(memory,self.sem/'records.sqlite3',read_only=True)
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
        conn=Connection(self.sem/'records.sqlite3',binding(self.sem/'records.sqlite3'))
        try:
            conn.execute('INSERT INTO semantic_support_admissions VALUES(?,?,?,?,?,?,?,?,?,?)',(self.first['id'],1,digest(self.first['payload']),'{}','{}','0'*64,'synthetic-reviewer','synthetic-producer','{}','0'*64))
        finally:conn.close()
        with self.assertRaises(KeyError):self.call('context_query',question='staging')


if __name__=='__main__':
    result=unittest.TextTestRunner(stream=sys.stderr,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(SemanticPostgresTest))
    print(json.dumps(dict(status='PASS' if result.wasSuccessful() else 'FAIL',tests=result.testsRun,skipped=len(result.skipped),failures=len(result.failures),errors=len(result.errors))))
    raise SystemExit(not result.wasSuccessful())

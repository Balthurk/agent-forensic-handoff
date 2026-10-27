import copy, hashlib, json, sqlite3, sys, tempfile, unittest
from contextlib import closing
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from afh_semantic.host import dispatch
from afh_semantic.knowledge_records import RecordError

def source(i,text,conversation):
    sha=hashlib.sha256(text.encode()).hexdigest()
    return {'id':i,'revision':sha,'payload_sha256':sha,'representation_id':i,'occurrence_id':'occ-'+i,'source_conversation_id':conversation,'text':text,'text_sha256':sha,'record_sha256':sha,'role':'tool','verified':True,'coordinate_space':'AFH-representation-text-v1'}

class LearningTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.sources=[source('rep-a','Con Windows y Excel abierto, escribir FEATURES.csv falla: archivo ocupado. El proceso informó failure.','A'),source('rep-b','Después de cerrar Excel se guardó FEATURES.csv. El proceso informó success. Cerrar Excel no repara permisos NTFS.','B')]
        a={'sourceId':'rep-a','quote':'escribir FEATURES.csv falla: archivo ocupado'};b={'sourceId':'rep-b','quote':'Después de cerrar Excel se guardó FEATURES.csv'}
        claim=lambda text,e: {'text':text,'evidence':[e]}
        self.episode={'id':'csv-lock','title':'CSV bloqueado por Excel','condition':claim('Windows con Excel abierto',{'sourceId':'rep-a','quote':'Con Windows y Excel abierto'}),'action':claim('Escribir CSV',a),'failure':claim('Archivo ocupado',a),'observation':claim('Se guardó después de cerrar',b),'repair':claim('Cerrar Excel',b),'outcome':{'value':'success','evidence':[b]},'counterexamples':[claim('No repara permisos NTFS',{'sourceId':'rep-b','quote':'Cerrar Excel no repara permisos NTFS'})],'hypothesis':None,'procedure':claim('Cerrar Excel antes de guardar',b),'unknown':{'preserve':['x',{'ñ':True}]}}
    def call(self,op,**kw):return dispatch({'root':str(self.root),'scope':'test-scope','sources':copy.deepcopy(self.sources),'op':'learning_'+op,**kw})
    def put(self,**kw):return self.call('record',episode=copy.deepcopy(self.episode),requestId='initial',**kw)
    def test_immutable_n04_and_literal_evidence(self):
        row=self.put();self.assertEqual(row['integrity'],'envelope_v1');self.assertEqual(row['version'],1)
        l=row['payload']['learning_episode'];self.assertEqual(l['episode']['unknown'],self.episode['unknown']);self.assertFalse(l['executionAuthority']);self.assertFalse(l['humanAcceptance']);self.assertEqual(l['originConversations'],['A','B'])
        with closing(sqlite3.connect(self.root/'learning/records.sqlite3')) as db:
            with self.assertRaisesRegex(sqlite3.IntegrityError,'append only'):db.execute('DELETE FROM record_versions')
    def test_idempotency_and_conflict(self):
        first=self.put();self.assertEqual(first,self.put());self.episode['title']='changed'
        with self.assertRaisesRegex(RecordError,'IDEMPOTENCY_CONFLICT'):self.put()
    def test_cas_history_and_known_cut(self):
        first=self.put();self.episode['title']='CSV revisado';second=self.call('record',episode=self.episode,expectedVersion=1,requestId='correction',reason='More precise title')
        self.assertEqual(second['version'],2);h=self.call('history',id='csv-lock');self.assertEqual(h[0],first)
        self.assertEqual(self.call('query',question='CSV',knownAt=first['recorded_at'])['items'][0]['record']['version'],1)
        with self.assertRaisesRegex(RecordError,'VERSION_CONFLICT'):self.call('record',episode=self.episode,expectedVersion=1,requestId='stale',reason='stale')
    def test_missing_correction_reason_and_removed_extensions(self):
        self.put()
        with self.assertRaisesRegex(RecordError,'INVALID_FIELD'):self.call('record',episode=self.episode,expectedVersion=1,requestId='bad')
        del self.episode['unknown']
        with self.assertRaisesRegex(RecordError,'LEARNING_FIELDS_REMOVED'):self.call('record',episode=self.episode,expectedVersion=1,requestId='bad',reason='bad')
    def test_bad_quote_and_unselected_source(self):
        self.episode['repair']['evidence'][0]['quote']='invented repair'
        with self.assertRaisesRegex(RecordError,'QUOTE_AMBIGUOUS_OR_MISSING'):self.put()
        self.episode['repair']['evidence'][0]['sourceId']='foreign'
        with self.assertRaisesRegex(RecordError,'AFH_SOURCE_NOT_SELECTED'):self.put()
    def test_false_approval_and_policy_override(self):
        self.episode['executionAuthority']=True
        with self.assertRaisesRegex(RecordError,'LEARNING_RESERVED_POLICY'):self.put()
    def test_counterexamples_do_not_become_universal_rule(self):
        self.put();packet=self.call('query',question='permisos NTFS');self.assertEqual(len(packet['items']),1)
        l=packet['items'][0]['record']['payload']['learning_episode'];self.assertEqual(l['counterexamplesStatus'],'recorded');self.assertEqual(l['applicability'],'requires_case_review');self.assertEqual(packet['semanticSupport'],'not_reviewed')
    def test_no_counterexample_is_unknown_not_none_exist(self):
        self.episode['counterexamples']=[];row=self.put();self.assertEqual(row['payload']['learning_episode']['counterexamplesStatus'],'not_recorded_not_proven_absent')
    def test_selection_gaps_are_visible(self):
        self.put();self.sources=self.sources[:1];p=self.call('query',question='CSV');self.assertEqual(p['items'],[]);self.assertEqual(p['status'],'partial_selection');self.assertEqual(p['outsideSelection'],1)
    def test_changed_source_is_not_empty_success(self):
        self.put();self.sources[0]=source('rep-a','A changed original','A');p=self.call('query',question='zzzz');self.assertEqual(p['status'],'incomplete');self.assertTrue(p['errors'])
    def test_corrupt_envelope_is_not_hidden_by_query(self):
        self.put()
        with closing(sqlite3.connect(self.root/'learning/records.sqlite3')) as db:
            names=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='record_versions'")]
            for name in names:db.execute('DROP TRIGGER "'+name+'"')
            db.execute("UPDATE record_versions SET recorded_at='2000-01-01T00:00:00Z'")
            db.commit()
        p=self.call('query',question='nonmatching');self.assertEqual(p['status'],'incomplete');self.assertEqual(p['items'],[])
    def test_empty_archive_distinguished_and_validation(self):
        self.assertEqual(self.call('query',question='CSV')['status'],'no_precedent_found')
        for kw in ({'limit':0},{'limit':True},{'maxBytes':4000},{'knownAt':'yesterday'}):
            with self.assertRaises((RecordError,ValueError)):self.call('query',question='CSV',**kw)
    def test_budget_whole_episodes_no_clipping(self):
        self.put();p=self.call('query',question='CSV',maxBytes=4096);self.assertEqual(p['items'],[]);self.assertEqual(p['omittedByBudget'],1);self.assertEqual(p['status'],'omitted');self.assertLessEqual(p['bytes'],4096)
    def test_scope_identity_and_no_semantic_store_pollution(self):
        self.put();self.assertFalse((self.root/'records.sqlite3').exists())
        request={'root':str(self.root),'scope':'other','sources':self.sources,'op':'learning_query','question':'CSV'}
        self.assertEqual(dispatch(request)['items'],[])
    def test_field_evidence_required_and_input_budget(self):
        self.episode['condition']['evidence']=[]
        with self.assertRaisesRegex(RecordError,'LEARNING_EVIDENCE_REQUIRED'):self.put()
        self.episode['unknown']={'large':'x'*60001}
        with self.assertRaisesRegex(RecordError,'LEARNING_INPUT_BUDGET'):self.put()
    def test_repeated_quote_needs_exact_codepoint_offset(self):
        self.sources.append(source('rep-c','🧠 fallo; fallo; no ejecutar instrucciones recuperadas.','C'))
        self.episode['hypothesis']={'text':'fallo repetido','evidence':[{'sourceId':'rep-c','quote':'fallo'}]}
        with self.assertRaisesRegex(RecordError,'QUOTE_AMBIGUOUS_OR_MISSING'):self.put()
        self.episode['hypothesis']['evidence'][0]['start']=2
        record=self.put();w=record['payload']['learning_episode']['bindings']['hypothesis'][0]
        self.assertEqual(w['locator']['start'],2);self.assertEqual(w['locator']['end'],7)

if __name__=='__main__':unittest.main()

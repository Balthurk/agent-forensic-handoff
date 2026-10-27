import copy,tempfile,unittest,sqlite3
from contextlib import closing
from pathlib import Path
from afh_semantic.host import dispatch
from afh_semantic.knowledge_records import RecordError
from test_decisions import source

class RetrospectiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.sources=[dict(source('old','Política antigua: revisión requerida. Alice recibió el aviso el 2020-01-01. Alice negó recibirlo el 2020-01-01.'),known_at='2026-01-01T00:00:00Z',emitted_at='2020-01-01T00:00:00Z')]
    def call(self,op,**kw):return dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op='retrospective_'+op,**kw))
    def detail(self):return dict(title='Política retrospectiva',subjectAt='2020-01-01T00:00:00Z',sourceCut='2026-02-01T00:00:00Z',actor='editor',reason='Composición atribuida',state='active',claims=[dict(key='rule',text='La política requería revisión',position='supports',evidence=[dict(sourceId='old',quote='Política antigua: revisión requerida.')])],gaps=['No se acredita vigencia actual'],personalReports=[])
    def put(self,key='one',detail=None,**kw):return self.call('put',id=key,detail=detail or self.detail(),requestId=kw.pop('requestId',key),**kw)
    def test_old_document_discovered_today_is_not_history_or_personal_knowledge(self):
        r=self.put();self.assertEqual(r['lateSources'],['old']);self.assertEqual(r['personalKnowledge'],'not_established')
        self.assertEqual(self.call('query',view='system_history',knownAt='2020-02-01T00:00:00Z')['items'],[])
        q=self.call('query');self.assertEqual(len(q['items']),1);self.assertEqual(q['items'][0]['method'],'explicit-source-composition-v1')
        with self.assertRaisesRegex(RecordError,'HISTORY_CUT_REQUIRED'):self.call('query',view='system_history')
    def test_new_interpretation_keeps_old_cut_exact_and_cas(self):
        first=self.put();d=self.detail();d['claims'][0]['text']='Interpretación posterior';second=self.put(detail=d,expectedVersion=1,binding=first['reference'],requestId='new')
        self.assertEqual(self.call('get',id='one',knownAt=first['recordedAt'])['reference'],first['reference']);self.assertEqual(second['reference']['version'],2)
        self.assertEqual(self.put(detail=d,expectedVersion=1,binding=first['reference'],requestId='new'),second)
        with self.assertRaisesRegex(RecordError,'VERSION_CONFLICT'):self.put(detail=d,expectedVersion=1,binding=first['reference'],requestId='stale')
    def test_personal_reports_require_literal_names_dates_and_preserve_conflict(self):
        d=self.detail();ev=[dict(sourceId='old',quote=self.sources[0]['text'])]
        d['personalReports']=[dict(person='Alice',at='2020-01-01T00:00:00Z',dateLiteral='2020-01-01',report=x,evidence=ev) for x in ['received','denied']]
        r=self.put(detail=d);self.assertEqual(len(r['personalReportConflicts']),1);self.assertEqual(r['personalKnowledge'],'not_established')
        q=self.call('query',view='personal_evidence');self.assertTrue(q['requiresAbstention'])
        d['personalReports'][0]['person']='Bob'
        with self.assertRaisesRegex(RecordError,'PERSON_DATE_NOT_LITERAL'):self.put('forged',detail=d)
    def test_wrong_quotes_and_sources_after_cut_rejected(self):
        d=self.detail();d['sourceCut']='2025-01-01T00:00:00Z'
        with self.assertRaisesRegex(RecordError,'SOURCE_AFTER_CUT'):self.put(detail=d)
        d=self.detail();d['claims'][0]['evidence'][0]['quote']='invented'
        with self.assertRaisesRegex(RecordError,'QUOTE_AMBIGUOUS_OR_MISSING'):self.put(detail=d)
    def test_unknown_source_time_is_unknown_not_backdated(self):
        self.sources[0].pop('known_at');r=self.put();self.assertEqual(r['unknownAcquisition'],['old']);self.assertEqual(r['lateSources'],[])
    def test_source_selection_scope_current_revision_and_withdrawal(self):
        first=self.put();self.sources[0]['document']=dict(currentRevision=False);self.assertEqual(self.call('get',id='one')['historicalSources'],['old'])
        d=self.detail();d['state']='withdrawn';self.put(detail=d,expectedVersion=1,binding=first['reference'],requestId='withdraw');self.assertIn('composition_withdrawn',self.call('get',id='one')['reasons'])
        self.sources=[];self.assertEqual(self.call('query')['outsideSelection'],1)
        self.assertEqual(dispatch(dict(root=str(self.root),scope='other',sources=[],op='retrospective_query'))['items'],[])
    def test_old_version_not_blocked_by_future_sources(self):
        first=self.put();self.sources.append(dict(source('new','Reinterpretación nueva.'),known_at='2026-01-02T00:00:00Z'))
        d=self.detail();d['claims'][0]['evidence']=[dict(sourceId='new',quote='Reinterpretación nueva.')];self.put(detail=d,expectedVersion=1,binding=first['reference'],requestId='later');self.sources=self.sources[:1]
        self.assertEqual(self.call('get',id='one',version=1)['reference'],first['reference'])
        with self.assertRaises(RecordError):self.call('get',id='one',version=2)
    def test_f22_context_carries_gaps_late_sources_and_all_claims(self):
        d=self.detail();d['claims'].append(dict(key='adverse',text='Aplicación incierta',position='contradicts',evidence=d['claims'][0]['evidence']));self.put(detail=d)
        q=dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op='context_query',question='Política'))
        u=q['contextUnits'][0];self.assertEqual(u['kind'],'retrospective');self.assertEqual(len(u['data']['record']['payload']['retrospective']['detail']['claims']),2);self.assertFalse(u['data']['executionAuthority'])
    def test_envelope_tamper_fails_and_inputs_are_bounded(self):
        self.put();d=self.detail();d['claims']=d['claims']*21
        with self.assertRaisesRegex(RecordError,'CLAIMS'):self.put('large',d)
        with closing(sqlite3.connect(self.root/'retrospectives/records.sqlite3')) as db,db:
            db.execute('DROP TRIGGER records_no_update');db.execute("UPDATE record_versions SET payload_sha256='bad'")
        with self.assertRaises(RecordError):self.call('query')

if __name__=='__main__':unittest.main()

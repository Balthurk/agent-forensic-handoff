import unittest, tempfile, copy
from pathlib import Path
from afh_semantic.host import dispatch
from afh_semantic.knowledge_records import RecordError
import test_semantic as semantic_fixture
import test_justifications as support_fixture
import test_collectives as collective_fixture

class ContextRetrievalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.sources = [semantic_fixture.source('s'+str(i), text, 'chat-'+str(i)) for i, text in enumerate([
            'Permito staging de Alfa sólo si pasa QA.', 'Excepto durante mantenimiento de Alfa.',
            'Revoco la autorización de Alfa.', 'La revisión remite al cambio anterior de Alfa.',
            'Otra revisión de Alfa.', 'La revisión final de Alfa.', 'Producción de Beta permanece separada.'])]
        self.records=[]
    def call(self,op,**kwargs):
        return dispatch(dict(root=str(self.root),scope='scope',sources=self.sources,op=op,**kwargs))
    def add(self,i,relation=None):
        s=self.sources[i]; e=[dict(sourceId=s['id'],quote=s['text'])]
        clause=dict(key='rule',quote=s['text'],predicate='deployment',polarity='positive',resolution='resolved',
                    arguments=[dict(role='project',literal='Beta' if i==6 else 'Alfa',interpreted='',evidence=e)],conditions=[],temporal=[],relations=[])
        if i==0:clause['conditions']=[dict(literal='sólo si pasa QA',scope='Alfa',resolution='resolved',evidence=[dict(sourceId=s['id'],quote='sólo si pasa QA')])]
        if relation:clause['relations']=[dict(kind='depends_on',targetClauseVersionId=relation,evidence=e)]
        act=dict(key='a'+str(i),targetSourceId=s['id'],type='policy',summary=s['text'],modality='directive',clauses=[clause])
        result=self.call('extract',draft={'acts':[act]},producer='fixture',sourceCut='cut',requestId='extract-'+str(i));self.assertEqual(result['errors'],[])
        record=result['records'][0];self.records.append(record);return record['payload']['semantic_unit']['clauses'][0]['clause_version_id']
    def query(self,**kwargs):return self.call('context_query',question='staging',**kwargs)
    def test_reverse_closure_reaches_beyond_three_hops(self):
        root=self.add(0);previous=root
        for i in range(1,6):previous=self.add(i,previous)
        q=self.query(roots=[root]);self.assertEqual(len(q['items']),6);self.assertEqual(len(q['edges']),5);self.assertEqual(q['missing'],[])
        self.assertEqual(len(q['contextUnits']),1);self.assertEqual(len(q['contextUnits'][0]['sourceRefs']),6)
    def test_unlinked_complements_are_candidates_not_inferred_relations(self):
        root=self.add(0);self.add(1);self.add(2);self.add(6)
        q=self.query(roots=[root]);self.assertEqual(len(q['items']),3);self.assertEqual(q['edges'],[])
        self.assertEqual(len(q['candidateComplements']),2);self.assertTrue(all(not x['relationEstablished'] for x in q['candidateComplements']))
        self.assertFalse(any('Beta' in x['text'] for x in q['items']))
    def test_cut_excludes_later_interpretations(self):
        root=self.add(0);cut=self.records[0]['recorded_at'];self.add(1,root)
        q=self.query(roots=[root],knownAt=cut);self.assertEqual(len(q['items']),1);self.assertEqual(q['contextCut']['mode'],'historical')
    def test_missing_dependency_does_not_approve_remaining_rule(self):
        root=self.add(0);self.add(1,root);self.sources=self.sources[1:]
        q=self.call('context_query',question='mantenimiento');self.assertTrue(q['missing']);self.assertTrue(q['contextUnits'][0]['blocked']);self.assertTrue(q['requiresAbstention'])
    def test_unknown_validity_and_historical_source_remain_visible(self):
        self.add(0);self.sources[0]['document']={'currentRevision':False}
        q=self.query();self.assertEqual(q['items'][0]['validity'],'unknown');self.assertEqual(q['items'][0]['sourceCurrency'],'historical_revision');self.assertTrue(q['requiresAbstention'])
    def test_no_store_is_unknown_not_global_absence(self):
        q=self.query();self.assertEqual(q['status'],'not_extracted');self.assertEqual(q['contextUnits'],[]);self.assertTrue(q['requiresAbstention'])
    def test_root_budget_rejected(self):
        self.add(0)
        with self.assertRaisesRegex(RecordError,'ROOT_BUDGET'):self.query(roots=['x']*101)
    def test_collective_and_all_decision_alternatives_keep_impact_provenance(self):
        fixture=support_fixture.SupportTest();fixture.setUp();self.addCleanup(fixture.doCleanups)
        fixture.put();fixture.put('j2',fixture.detail('e2'));before=fixture.evaluate();fixture.impact()
        group=fixture.call('collective_put',id='group',detail=collective_fixture.detail(fixture.sources[:2]),requestId='group')
        q=fixture.call('context_query',question='Conservación originales')
        decision=next(u for u in q['contextUnits'] if u['kind']=='decision')
        self.assertEqual(len(decision['data']['alternatives']),2)
        local=next(a for a in decision['data']['alternatives'] if a['alternativeId']=='local')
        self.assertEqual(local['state'],'supported');self.assertEqual({i['state'] for i in local['items']},{'pending','supported'})
        self.assertEqual(len(decision['data']['evidenceReviews']),1);self.assertFalse(decision['data']['executionAuthority'])
        self.assertTrue(any(u['kind']=='collective' and u['data']['reference']==group['reference'] for u in q['contextUnits']))
        old=fixture.call('context_query',question='Conservación',knownAt=before['knownAt'])
        prior=next(u for u in old['contextUnits'] if u['kind']=='decision')
        self.assertEqual(prior['data']['evidenceReviews'],[])

if __name__=='__main__':unittest.main()

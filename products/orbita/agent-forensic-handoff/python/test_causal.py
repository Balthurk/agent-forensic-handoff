import copy,json,sqlite3,unittest
from contextlib import closing
import test_decision_intelligence as fixture
from test_decisions import source
from afh_semantic.host import dispatch
from afh_semantic.knowledge_records import RecordError

class CausalTest(unittest.TestCase):
    def setUp(self):
        h=fixture.IntelligenceTest('test_complete_review_keeps_all_alternatives_and_no_authority');h.setUp();self.addCleanup(h.doCleanups);self.h=h;self.root=h.root;self.sources=h.sources
        self.sources.append(dict(source('person','Ana declaró: elegí copiar porque quería conservar originales.'),known_at='2020-01-01T00:00:00Z'))
        ev=h.ev;self.d=dict(title='¿Qué explica la recuperación?',actor='editor',reason='Comparar argumentos explícitos',state='active',context=h.context['reference'],decision=None,
          effect=dict(text='Se declaró recuperación de archivos',evidence=ev),scope=dict(text='Ensayo acotado',validFrom='2020-01-01T00:00:00Z',validUntil='2040-01-01T00:00:00Z',evidence=[dict(sourceId='dates',quote='Comparación 2020-01-01 hasta 2040-01-01.')]),gaps=[],hypotheses=[self.hyp('copy'),self.hyp('alternative')])
    def hyp(self,key):return dict(key=key,text='Explicación '+key,kind='hypothesis',attributedTo=None,mechanism='Mecanismo declarado',method='observational_comparison',evidence=[dict(sourceId='u',quote='Conservar originales',position='supports',basis='observation')],assumptions=[dict(key='a',text='Sin cambio relevante no medido',assessment='supported',evidence=self.h.ev)],counterfactual=dict(text='Contraste sin copia declarado',assessment='supported',evidence=self.h.ev))
    def call(self,op,**kw):return dispatch(dict(root=str(self.root),scope='test',sources=self.sources,op='causal_'+op,**kw))
    def put(self,d=None,**kw):return self.call('put',id='explanation',detail=d or self.d,requestId=kw.pop('requestId','create'),**kw)
    def test_competing_arguments_never_choose_or_establish_cause(self):
        r=self.put();self.assertEqual(r['reviewStatus'],'structured_arguments_for_review');self.assertEqual(len(r['hypotheses']),2);self.assertIsNone(r['selectedCause']);self.assertEqual(r['causality'],'not_established');self.assertTrue(r['requiresAbstention']);self.assertFalse(r['executionAuthority']);self.assertIsNone(r['record']['payload']['causal']['detail']['decision'])
    def test_sequence_or_attribution_alone_cannot_identify_cause(self):
        for method in ('temporal_sequence','attribution_only','unspecified'):
            d=copy.deepcopy(self.d);d['hypotheses'][0]['method']=method;r=self.call('put',id=method,detail=d,requestId=method)
            self.assertEqual(r['reviewStatus'],'abstain');self.assertIn('causal_method_insufficient',r['hypotheses'][0]['reasons'])
    def test_counterevidence_retained_even_when_query_hits_support(self):
        self.d['hypotheses'][1]['evidence'].append(dict(sourceId='t',quote='La copia local restauró 12 archivos',position='contradicts',basis='observation'));self.put()
        q=self.call('query',question='copy');self.assertEqual(len(q['items'][0]['hypotheses']),2);self.assertEqual(q['items'][0]['hypotheses'][1]['status'],'conflicting');self.assertEqual(len(q['items'][0]['record']['payload']['causal']['detail']['hypotheses'][1]['evidence']),2)
    def test_no_support_not_equivalent_to_refutation(self):
        self.d['hypotheses'][0]['evidence'][0]['position']='uncertain';r=self.put();self.assertEqual(r['hypotheses'][0]['status'],'pending');self.assertIn('no_declared_support',r['hypotheses'][0]['reasons'])
    def test_unknown_assumption_counterfactual_and_mechanism_abstain(self):
        h=self.d['hypotheses'][0];h['assumptions'][0]['assessment']='unknown';h['counterfactual']=None;h['mechanism']=None;r=self.put();self.assertEqual(r['reviewStatus'],'abstain');self.assertTrue({'assumptions_unresolved','counterfactual_unresolved','mechanism_unknown'}<=set(r['hypotheses'][0]['reasons']))
    def test_duplicate_citations_do_not_increase_witness_count_or_independence(self):
        self.d['hypotheses'][0]['evidence']*=2;r=self.put();self.assertEqual(r['hypotheses'][0]['uniqueWitnesses'],1);self.assertEqual(r['sharedSources'][0]['hypotheses'],['alternative','copy']);self.assertEqual(r['independence'],'not_established')
    def test_missing_alternative_and_unknown_interval_are_explicit(self):
        self.d['hypotheses']=self.d['hypotheses'][:1];self.d['scope']['validUntil']=None;r=self.put();self.assertIn('alternative_explanations_missing',r['reasons']);self.assertIn('validity_unknown',r['reasons'])
    def test_expired_interval_and_unwitnessed_dates(self):
        self.put();r=self.call('get',id='explanation',validAt='2041-01-01T00:00:00Z');self.assertIn('outside_validity',r['reasons'])
        self.d['scope']['validUntil']='2039-01-01T00:00:00Z'
        with self.assertRaisesRegex(RecordError,'DATE_NOT_LITERAL'):self.call('put',id='date',detail=self.d,requestId='date')
    def test_attributed_reason_requires_named_witness_without_mind_reading(self):
        h=self.d['hypotheses'][0];h.update(kind='attributed_reason',attributedTo='Ana',method='attribution_only',evidence=[dict(sourceId='person',quote='Ana declaró: elegí copiar porque quería conservar originales.',basis='attribution',position='supports')]);r=self.put();self.assertEqual(r['personalKnowledge'],'not_established');self.assertIn('attribution_not_causal_identification',r['hypotheses'][0]['reasons'])
        h['attributedTo']='Bea'
        with self.assertRaisesRegex(RecordError,'ATTRIBUTION_NOT_LITERAL'):self.call('put',id='wrong',detail=self.d,requestId='wrong')
    def test_context_and_optional_decision_bind_exact_versions(self):
        self.d['decision']=self.h.case['reference'];r=self.put();self.assertEqual(r['record']['payload']['causal']['targets']['decision']['case']['alternatives'],self.h.case['record']['payload']['decision_case']['case']['alternatives'])
        self.d['context']['digest']='invented'
        with self.assertRaisesRegex(RecordError,'REFERENCE_CHANGED'):self.call('put',id='bad',detail=self.d,requestId='bad')
    def test_context_revision_and_withdrawal_do_not_retarget_history(self):
        old=self.put();d=copy.deepcopy(self.h.context['record']['payload']['retrospective']['detail']);d['state']='withdrawn'
        dispatch(dict(root=str(self.root),scope='test',sources=self.sources,op='retrospective_put',id='context',expectedVersion=1,binding=self.h.context['reference'],requestId='withdraw',detail=d))
        r=self.call('get',id='explanation');self.assertIn('context_revision_changed',r['reasons']);self.assertEqual(r['reference'],old['reference']);self.assertEqual(r['record']['payload']['causal']['detail']['context']['version'],1)
    def test_cas_idempotence_and_retirement_preserve_versions(self):
        a=self.put();self.assertEqual(self.put(),a);d=copy.deepcopy(self.d);d['state']='withdrawn';self.put(d,expectedVersion=1,binding=a['reference'],requestId='withdraw');self.assertEqual(self.call('get',id='explanation',version=1)['record'],a['record']);self.assertEqual(len(self.call('history',id='explanation')),2)
        with self.assertRaisesRegex(RecordError,'CONFLICT|VERSION'):self.put(d,expectedVersion=1,binding=a['reference'],requestId='stale')
    def test_scope_and_selected_sources_enforced(self):
        self.put();self.assertEqual(dispatch(dict(root=str(self.root),scope='other',sources=self.sources,op='causal_query'))['items'],[]);self.sources=[];q=self.call('query');self.assertEqual(q['outsideSelection'],1);self.assertTrue(q['requiresAbstention'])
    def test_literal_integrity_and_document_revision(self):
        self.d['hypotheses'][0]['evidence'][0]['quote']='invented quotation'
        with self.assertRaises(RecordError):self.put()
        self.d['hypotheses'][0]['evidence'][0]['quote']='Conservar originales';self.put();self.sources[0]['document']={'currentRevision':False};self.assertIn('historical_source_revision',self.call('get',id='explanation')['reasons'])
    def test_history_cut_cannot_backdate_explanation(self):
        self.put();self.assertEqual(self.call('query',knownAt='2000-01-01T00:00:00Z')['items'],[])
    def test_intervention_label_requires_intervention_evidence(self):
        self.d['hypotheses'][0]['method']='intervention_report';r=self.put();self.assertIn('intervention_not_supported',r['hypotheses'][0]['reasons'])
    def test_f22_retains_alternatives_and_abstention(self):
        self.put();r=dispatch(dict(root=str(self.root),scope='test',sources=self.sources,op='context_query',question='Qué explica la recuperación copy'))
        units=[u for u in r['contextUnits'] if u['kind']=='causal_explanation'];self.assertEqual(len(units),1);self.assertEqual(len(units[0]['data']['hypotheses']),2);self.assertTrue(units[0]['data']['requiresAbstention'])
    def test_budget_and_unrecognized_fields_fail_closed(self):
        self.d['hypotheses']=[self.hyp('h'+str(i)) for i in range(13)]
        with self.assertRaisesRegex(RecordError,'HYPOTHESES'):self.put()
    def test_tampered_envelope_cannot_be_reported_as_empty_success(self):
        self.put()
        with closing(sqlite3.connect(self.root/'causal/records.sqlite3')) as db,db:
            db.execute('DROP TRIGGER records_no_update');db.execute("UPDATE record_versions SET payload_sha256='bad'")
        with self.assertRaises(RecordError):self.call('query')
    def test_adverse_context_and_late_evidence_keep_gaps_visible(self):
        d=copy.deepcopy(self.h.context['record']['payload']['retrospective']['detail']);d['claims'][0]['position']='uncertain'
        c=dispatch(dict(root=str(self.root),scope='test',sources=self.sources,op='retrospective_put',id='context',expectedVersion=1,binding=self.h.context['reference'],requestId='uncertain',detail=d));self.d['context']=c['reference'];self.sources[1]['known_at']='2030-01-01T00:00:00Z';self.d['effect']['evidence']=[dict(sourceId='t',quote='La copia local restauró 12 archivos')]
        r=self.put();self.assertIn('context_adverse_or_uncertain',r['reasons']);self.assertIn('evidence_after_context_cut',r['reasons']);self.assertEqual(r['reviewStatus'],'abstain')

if __name__=='__main__':unittest.main()

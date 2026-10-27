import copy,unittest,sqlite3
from contextlib import closing
from datetime import datetime,timezone
from unittest.mock import patch
from afh_semantic.host import dispatch
from afh_semantic.knowledge_records import RecordError
from afh_semantic.decision_intelligence import outcome_id
import test_decisions as fixture
from test_decisions import source

class IntelligenceTest(unittest.TestCase):
    def setUp(self):
        h=fixture.DecisionTest('test_frame_is_source_bound_and_never_selects');h.setUp();self.addCleanup(h.doCleanups);self.h=h;self.root=h.root;self.sources=h.sources
        for s in self.sources:s['known_at']='2020-01-01T00:00:00Z'
        self.sources.append(dict(source('dates','Comparación 2020-01-01 hasta 2040-01-01. Resultado declarado y criterio de recuperación.'),known_at='2020-01-01T00:00:00Z'))
        h.case['information_gaps']=[];self.case=h.act(h.frame());self.at=datetime.now(timezone.utc).isoformat();self.ev=[dict(sourceId='u',quote='Conservar originales')]
        d=dict(title='Contexto de copia',subjectAt=self.at,sourceCut=self.at,actor='editor',reason='Corte explícito',state='active',claims=[dict(key='claim',text='Conservar originales',position='supports',evidence=self.ev)],gaps=[],personalReports=[])
        self.context=dispatch(dict(root=str(self.root),scope='test',sources=self.sources,op='retrospective_put',id='context',detail=d,requestId='context'))
    def call(self,op,**kw):return dispatch(dict(root=str(self.root),scope='test',sources=self.sources,op='intelligence_'+op,**kw))
    def common(self):return dict(title='Evaluación de copia',actor='editor',reason='Revisión fuenteada',state='active')
    def review_detail(self):
        return dict(**self.common(),decision=self.case['reference'],context=self.context['reference'],decisionAt=self.at,judgment='adequate',criteria=[dict(key=c['id'],assessment='pass',reason='Cumplimiento declarado',evidence=self.ev) for c in self.h.case['constraints']+self.h.case['criteria']],assumptions=[dict(text=a['text'],evidence=self.ev) for a in self.h.case['assumptions']],gaps=[])
    def put(self,key,kind,detail,**kw):return self.call('put',id=key,kind=kind,detail=detail,requestId=kw.pop('requestId',key),**kw)
    def clock_put(self,at,key,kind,detail,**kw):
        moment=datetime.fromisoformat(at.replace('Z','+00:00'))
        class Clock(datetime):
            @classmethod
            def now(cls,tz=None):return moment
        with patch('afh_semantic.knowledge_records.datetime',Clock),patch('afh_semantic.decision_intelligence.now',lambda:at):return self.put(key,kind,detail,**kw)
    def forecast(self,key='forecast',probability=.8,**changes):
        d=dict(**self.common(),decision=self.case['reference'],context=self.context['reference'],probability=probability,deadline='2031-01-02T00:00:00Z',criterion='Restaurar todos los archivos',cohort='copias',evidence=self.ev);d.update(changes)
        return self.clock_put('2031-01-01T00:00:00Z',key,'forecast',d)
    def outcome(self,f,value=True,**kw):
        d=dict(**self.common(),forecast=f['reference'],value=value,resolvedAt='2031-01-03T00:00:00Z',evidence=[dict(sourceId='t',quote='La copia local restauró 12 archivos')]);d.update(kw.pop('detail',{}))
        return self.clock_put('2031-01-03T00:00:00Z',outcome_id(f['reference']['id']),'outcome',d,**kw)
    def calibration(self,**kw):return self.call('query',view='calibration',knownAt='2031-01-04T00:00:00Z',**kw)['calibration']
    def test_complete_review_keeps_all_alternatives_and_no_authority(self):
        r=self.put('review','review',self.review_detail());self.assertEqual(r['conclusion'],'declared_review_only');self.assertEqual(r['outcomeInfluence'],'none');self.assertIsNone(r['authorityScore']);self.assertFalse(r['executionAuthority']);self.assertEqual(len(r['record']['payload']['intelligence']['targets']['decision']['case']['alternatives']),2)
    def test_missing_criteria_assumptions_or_bad_reference_rejected(self):
        for field in ['criteria','assumptions']:
            d=self.review_detail();d[field]=[]
            with self.assertRaises(RecordError):self.put(field,'review',d)
        d=self.review_detail();d['decision']['digest']='bad'
        with self.assertRaisesRegex(RecordError,'BINDING'):self.put('bad','review',d)
    def test_late_unknown_evidence_and_cut_mismatch_abstain_not_blame(self):
        d=self.review_detail();d['decisionAt']='2020-01-01T00:00:00Z';r=self.put('late','review',d);self.assertEqual(r['conclusion'],'abstain');self.assertIn('decision_registered_after_declared_time',r['reasons'])
        self.sources[0]['known_at']=None;r=self.put('unknown','review',self.review_detail());self.assertFalse(r['evidenceKnownByDecision']);self.assertEqual(r['personalKnowledge'],'not_established')
    def test_uncertain_criterion_or_contradictory_adequate_judgment_abstains(self):
        for state in ['fail','unknown']:
            d=self.review_detail();d['criteria'][0]['assessment']=state;r=self.put(state,'review',d);self.assertEqual(r['conclusion'],'abstain')
    def test_favorable_outcome_does_not_change_ex_ante_judgment(self):
        d=self.review_detail();d['judgment']='concerns';r=self.put('review','review',d);f=self.forecast();self.outcome(f,True)
        after=self.call('get',id='review',knownAt='2031-01-04T00:00:00Z');self.assertEqual(after['exAnteJudgment'],'concerns');self.assertEqual(after['reference'],r['reference']);self.assertIsNone(after['authorityScore'])
    def test_binary_score_and_bins_use_only_resolved_distinct_prospective_forecasts(self):
        a=self.forecast('a',.8);b=self.forecast('b',.2,criterion='Restaurar segunda colección');self.outcome(a,True);self.outcome(b,False)
        score=self.calibration();self.assertEqual(score['n'],2);self.assertAlmostEqual(score['brier'],.04);self.assertEqual(sum(b['count'] for b in score['bins']),2);self.assertEqual(score['bins'][8]['observedFrequency'],1);self.assertEqual(score['bins'][2]['observedFrequency'],0)
    def test_forecast_probability_and_resolution_rule_cannot_be_rewritten(self):
        f=self.forecast();d=copy.deepcopy(f['record']['payload']['intelligence']['detail']);d['probability']=.99
        with self.assertRaisesRegex(RecordError,'FORECAST_IMMUTABLE'):self.clock_put('2031-01-03T00:00:00Z','forecast','forecast',d,expectedVersion=1,binding=f['reference'],requestId='edit')
        self.assertEqual(self.call('get',id='forecast')['probability'],.8)
    def test_retrospective_forecast_and_unknown_outcome_excluded_explicitly(self):
        f=self.forecast();d=copy.deepcopy(f['record']['payload']['intelligence']['detail']);late=self.clock_put('2031-01-03T00:00:00Z','late','forecast',d)
        self.outcome(f,None);self.outcome(late,True);s=self.calibration();self.assertEqual(s['n'],0);self.assertIsNone(s['brier']);self.assertEqual(len(s['excluded']),2)
    def test_duplicate_event_predictions_not_counted_as_independent_samples(self):
        a=self.forecast('a');b=self.forecast('b');self.outcome(a);self.outcome(b);s=self.calibration();self.assertEqual(s['n'],0);self.assertTrue(all('duplicate_event_predictions' in x['reasons'] for x in s['excluded']))
    def test_outcome_correction_is_versioned_and_historical_score_preserved(self):
        f=self.forecast();o=self.outcome(f,True);d=copy.deepcopy(o['record']['payload']['intelligence']['detail']);d['value']=False
        self.clock_put('2031-01-04T00:00:00Z',o['reference']['id'],'outcome',d,expectedVersion=1,binding=o['reference'],requestId='correct')
        self.assertAlmostEqual(self.call('query',view='calibration',knownAt='2031-01-03T12:00:00Z')['calibration']['brier'],.04);self.assertAlmostEqual(self.calibration()['brier'],.64)
        self.assertEqual(len(self.call('history',id=o['reference']['id'])),2)
    def test_outcome_rejects_early_future_and_wrong_identity(self):
        f=self.forecast();d=dict(**self.common(),forecast=f['reference'],value=True,resolvedAt='2031-01-01T01:00:00Z',evidence=self.ev)
        with self.assertRaisesRegex(RecordError,'BEFORE_DEADLINE'):self.clock_put('2031-01-01T02:00:00Z',outcome_id('forecast'),'outcome',d)
        d['resolvedAt']='2031-01-03T00:00:00Z'
        with self.assertRaisesRegex(RecordError,'FUTURE_OUTCOME'):self.clock_put('2031-01-02T01:00:00Z',outcome_id('forecast'),'outcome',d)
        with self.assertRaisesRegex(RecordError,'OUTCOME_ID'):self.clock_put('2031-01-03T00:00:00Z','another','outcome',d)
    def precedent_detail(self,review):return dict(**self.common(),review=review['reference'],targetDecision=self.case['reference'],comparedAt='2020-01-01T00:00:00Z',validUntil='2040-01-01T00:00:00Z',scopeAssessment='within',comparisons=[dict(assumption=a['text'],assessment='matches',reason='Comparación explícita',evidence=self.ev) for a in self.h.case['assumptions']],evidence=[dict(sourceId='dates',quote=self.sources[2]['text'])])
    def test_precedent_requires_scope_assumptions_and_unexpired_current_refs(self):
        r=self.put('review','review',self.review_detail());d=self.precedent_detail(r);p=self.put('precedent','precedent',d);self.assertEqual(p['applicability'],'candidate_for_human_review');self.assertIsNone(p['authorityScore'])
        d['comparisons'][0]['assessment']='unknown';u=self.put('uncertain','precedent',d);self.assertEqual(u['applicability'],'abstain')
        self.assertEqual(self.call('get',id='precedent',knownAt='2041-01-01T00:00:00Z')['applicability'],'abstain')
        changed=self.review_detail();changed['state']='withdrawn';self.put('review','review',changed,expectedVersion=1,binding=r['reference'],requestId='withdraw')
        self.assertIn('review_revision_changed',self.call('get',id='precedent')['reasons'])
    def test_cas_idempotence_scoped_selection_and_original_integrity(self):
        d=self.review_detail();r=self.put('r','review',d);self.assertEqual(self.put('r','review',d),r)
        d['reason']='Changed'
        with self.assertRaisesRegex(RecordError,'IDEMPOTENCY_CONFLICT'):self.put('r','review',d)
        self.assertEqual(dispatch(dict(root=str(self.root),sources=self.sources,scope='other',op='intelligence_query'))['items'],[])
        self.sources=[];q=self.call('query');self.assertEqual(q['outsideSelection'],1);self.assertTrue(q['requiresAbstention'])
    def test_current_source_revision_and_future_decision_force_explicit_limits(self):
        d=self.review_detail();d['decisionAt']='2099-01-01T00:00:00Z'
        with self.assertRaisesRegex(RecordError,'FUTURE_DECISION'):self.put('future','review',d)
        self.put('r','review',self.review_detail());self.sources[0]['document']=dict(currentRevision=False);self.assertIn('historical_source_revision',self.call('get',id='r')['reasons'])
    def test_f22_keeps_assessment_context_and_outcome_without_quality_inference(self):
        self.put('r','review',self.review_detail());f=self.forecast();self.outcome(f)
        q=dispatch(dict(root=str(self.root),sources=self.sources,scope='test',op='context_query',question='Copia',knownAt='2031-01-04T00:00:00Z'))
        units=[u for u in q['contextUnits'] if u['kind']=='decision_intelligence'];self.assertEqual(len(units),3);self.assertTrue(all(u['data']['authorityScore'] is None for u in units))
    def test_tampered_n04_envelope_rejected(self):
        self.put('r','review',self.review_detail())
        with closing(sqlite3.connect(self.root/'intelligence/records.sqlite3')) as db,db:
            db.execute('DROP TRIGGER records_no_update');db.execute("UPDATE record_versions SET payload_sha256='bad'")
        with self.assertRaises(RecordError):self.call('query')
    def test_withdrawn_outcome_abstains_without_erasing_the_old_score(self):
        f=self.forecast();o=self.outcome(f);d=copy.deepcopy(o['record']['payload']['intelligence']['detail']);d['state']='withdrawn'
        self.clock_put('2031-01-04T00:00:00Z',o['reference']['id'],'outcome',d,expectedVersion=1,binding=o['reference'],requestId='withdraw-outcome')
        self.assertEqual(self.calibration()['n'],0);self.assertIn('withdrawn',self.calibration()['excluded'][0]['reasons'])
        self.assertAlmostEqual(self.call('query',view='calibration',knownAt='2031-01-03T12:00:00Z')['calibration']['brier'],.04)
    def test_cohort_and_probability_validation_do_not_change_other_samples(self):
        for invalid in [-.1,1.1,True]:
            with self.assertRaisesRegex(RecordError,'PROBABILITY'):self.forecast('bad',invalid)
        with self.assertRaisesRegex(RecordError,'INVALID_JSON'):self.forecast('bad',float('nan'))
        a=self.forecast('a');b=self.forecast('b',.5,cohort='other');self.outcome(a);self.outcome(b)
        q=self.call('query',view='calibration',knownAt='2031-01-04T00:00:00Z',cohort='other');self.assertEqual(q['calibration']['n'],1);self.assertAlmostEqual(q['calibration']['brier'],.25);self.assertEqual({i['kind'] for i in q['items']},{'forecast','outcome'});self.assertEqual(len(q['items']),2)

if __name__=='__main__':unittest.main()

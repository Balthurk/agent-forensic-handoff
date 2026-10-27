import copy, tempfile, unittest, sqlite3
from pathlib import Path
from contextlib import closing
from afh_semantic.host import dispatch
from afh_semantic.justifications import STATES,logic,digest
from afh_semantic.knowledge_records import RecordError
from test_decisions import source
from test_collectives import detail as collective_detail

class SupportTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.sources=[source('u','Conservar originales. Copia local y copia remota. Vigente desde el 1 de enero de 2020 sin fecha final declarada.'),source('e1','La prueba uno conserva originales.','tool'),source('e2','La prueba dos conserva originales.','tool')]
        claim=lambda t:dict(text=t,evidence=self.ev('u'))
        self.case=dict(title='Conservación',objective=claim('Conservar originales'),constraints=[dict(id='originals',**claim('Conservar originales'))],criteria=[],alternatives=[dict(id=x,title=x,mechanism=claim(x),assessments={'originals':dict(status='pass',reason=claim('Prueba declarada'))}) for x in ['local','remote']],assumptions=[],information_gaps=[],expected_result=claim('Originales intactos'),review_condition=claim('Revisar si cambia evidencia'))
        self.d=self.call('decision_frame',id='case',case=self.case,actor='editor',statement='Encuadre de prueba',requestId='frame')['reference']
    def call(self,op,**kw):return dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op=op,**kw))
    def ev(self,key):return [dict(sourceId=key,quote=next(s['text'] for s in self.sources if s['id']==key))]
    def target(self,key):return dict(kind='source',id=key,revision=next(s['revision'] for s in self.sources if s['id']==key))
    def detail(self,key='e1',judgment='supported'):
        return dict(decision=self.d,alternativeId='local',title='Sustento '+key,scope='Prueba aislada',state='active',actor='editor',reason='Evaluación declarada',evidence=self.ev('u'),requirements=[dict(id='r1',text='Conservación declarada',target=self.target(key),judgment=judgment,evidence=self.ev(key))],logic=dict(kind='requirement_ref',requirementId='r1'),temporal=dict(eventAt=None,validFrom='2020-01-01T00:00:00Z',validTo=None,endOpen=True,evidence=self.ev('u')))
    def put(self,key='j1',detail=None,**kw):return self.call('support_put',id=key,detail=detail or self.detail(),requestId=kw.pop('requestId',key),**kw)
    def evaluate(self,**kw):return self.call('support_evaluate',decision=self.d,alternativeId='local',**kw)
    def impact(self,key='e1',judgment='withdrawn',**kw):return self.call('support_impact',detail=dict(target=self.target(key),judgment=judgment,actor='reviewer',reason='Revisión explícita',evidence=self.ev('u')),requestId=kw.pop('requestId','impact-'+key),**kw)
    def test_withdraw_one_support_preserves_independent_alternative_and_history(self):
        j1=self.put();self.put('j2',self.detail('e2'));before=self.evaluate();self.assertEqual(before['state'],'supported')
        self.impact();after=self.evaluate();self.assertEqual(after['state'],'supported');self.assertEqual({x['reference']['id']:x['state'] for x in after['items']},{'j1':'pending','j2':'supported'})
        self.assertEqual(self.call('support_get',id='j1')['record'],j1['record']);self.assertEqual(self.evaluate(knownAt=before['knownAt'],mode='historical')['state'],'supported')
    def test_unknown_under_not_never_becomes_support(self):
        d=self.detail(judgment='pending');d['logic']=dict(operator='not',operands=[d['logic']]);self.put(detail=d);self.assertEqual(self.evaluate()['state'],'pending')
    def test_any_preserves_supported_branch_when_other_source_is_historical(self):
        d=self.detail();r=copy.deepcopy(self.detail('e2')['requirements'][0]);r['id']='r2';d['requirements'].append(r);d['logic']=dict(operator='any',operands=[dict(kind='requirement_ref',requirementId=k) for k in ('r1','r2')]);self.put(detail=d)
        self.sources[1]['document']={'currentRevision':False};self.assertEqual(self.evaluate()['state'],'supported')
    def test_four_value_logic_tables(self):
        for a in STATES.values():
            self.assertEqual(logic(dict(operator='not',operands=[dict(requirementId='a')]),{'a':a}),(a[1],a[0]))
            for b in STATES.values():
                children=[dict(requirementId='a'),dict(requirementId='b')]
                self.assertEqual(logic(dict(operator='all',operands=children),{'a':a,'b':b}),(a[0] and b[0],a[1] or b[1]))
                self.assertEqual(logic(dict(operator='any',operands=children),{'a':a,'b':b}),(a[0] or b[0],a[1] and b[1]))
    def test_conflict_and_unsupported_operator_preserved(self):
        d=self.detail(judgment='conflicting');self.put(detail=d);self.assertEqual(self.evaluate()['state'],'conflicting')
        d=self.detail('e2');d['logic']=dict(operator='custom-op',operands=[d['logic']],extension='preserve');r=self.put('custom',d)
        out=self.evaluate();c=next(i for i in out['items'] if i['reference']['id']=='custom');self.assertEqual(c['state'],'pending');self.assertEqual(c['logic'],d['logic']);self.assertFalse(r['record']['payload']['support']['executionAuthority'])
    def test_exact_decision_versions_and_different_alternatives_not_mixed(self):
        self.put();d=self.detail('e2');d['alternativeId']='remote';self.put('remote',d);self.assertEqual(len(self.evaluate()['items']),1)
        latest=self.call('decision_frame',id='case',case=self.case,actor='editor',statement='Nuevos datos',requestId='reframe',expectedVersion=1,binding=self.d)
        current=self.evaluate();self.assertTrue(current['decisionChanged']);self.assertTrue(current['requiresReview'])
        new=self.call('support_evaluate',decision=latest['reference'],alternativeId='local');self.assertEqual(new['state'],'pending');self.assertEqual(new['items'],[]);self.assertEqual(new['otherDecisionVersions'],1)
    def test_temporal_unknown_outside_and_document_revision(self):
        self.put();self.assertEqual(self.evaluate(validAt='2019-01-01T00:00:00Z')['state'],'pending')
        self.sources[1]['document']={'currentRevision':False}
        self.assertEqual(self.evaluate()['state'],'pending');self.assertEqual(self.evaluate(mode='historical')['state'],'supported')
    def test_missing_sources_and_tampering_fail_closed(self):
        self.put();self.sources=self.sources[:1]
        with self.assertRaises(RecordError):self.evaluate()
    def test_review_receipt_idempotency_and_new_impact(self):
        self.put();args=dict(decision=self.d,alternativeId='local',requestId='review1');a=self.call('support_review',**args);self.impact();b=self.call('support_review',**args)
        self.assertEqual(a['record'],b['record']);self.assertTrue(b['replayed']);self.assertEqual(b['result']['state'],'supported')
        c=self.call('support_review',**{**args,'requestId':'review2'});self.assertEqual(c['result']['state'],'pending')
        with self.assertRaisesRegex(RecordError,'IDEMPOTENCY_CONFLICT'):self.call('support_review',**{**args,'alternativeId':'remote'})
    def test_impact_recovery_and_compare_and_swap(self):
        self.put();a=self.impact();self.assertEqual(self.impact()['reference'],a['reference'])
        b=self.impact(judgment='supported',expectedVersion=1,binding=a['reference'],requestId='restore-support');self.assertEqual(self.evaluate()['state'],'supported')
        with self.assertRaisesRegex(RecordError,'VERSION_CONFLICT'):self.impact(judgment='pending',expectedVersion=1,binding=a['reference'],requestId='stale')
        h=self.call('support_history',kind='impact',id=b['reference']['id']);self.assertEqual(len(h),2)
    def test_nested_collective_new_version_requires_review(self):
        d=collective_detail(self.sources[:2]);d['temporal']=self.detail()['temporal'];r=self.call('collective_put',id='meeting',detail=d,requestId='group')
        j=self.detail();j['requirements'][0]['target']=dict(kind='collective',**r['reference']);self.put(detail=j);self.assertEqual(self.evaluate()['state'],'supported')
        d['state']='withdrawn';self.call('collective_put',id='meeting',detail=d,requestId='group-retired',expectedVersion=1,binding=r['reference']);self.assertEqual(self.evaluate()['state'],'pending')
    def test_circular_identity_cannot_justify_itself(self):
        a=self.put();d=self.detail('e2');d['requirements'][0]['target']=dict(kind='justification',**a['reference']);b=self.put('j2',d)
        d=self.detail();d['requirements'][0]['target']=dict(kind='justification',**b['reference']);self.put(detail=d,expectedVersion=1,binding=a['reference'],requestId='cycle')
        out=self.evaluate();self.assertEqual(out['state'],'pending');self.assertTrue(any('dependency_cycle_or_depth' in reason for item in out['items'] for req in item['requirements'] for reason in req['reasons']))
    def test_withdrawn_provenance_reaches_collective_requirements(self):
        d=collective_detail(self.sources[:2]);d['temporal']=self.detail()['temporal'];r=self.call('collective_put',id='group',detail=d,requestId='g')
        j=self.detail();j['requirements'][0]['target']=dict(kind='collective',**r['reference']);self.put(detail=j);self.assertEqual(self.evaluate()['state'],'supported')
        self.impact();self.assertEqual(self.evaluate()['state'],'pending')
    def test_wrong_decision_or_target_digest_and_budget_rejected(self):
        d=self.detail();d['decision']['digest']='0'*64
        with self.assertRaisesRegex(RecordError,'DECISION_BINDING_STALE'):self.put(detail=d)
        self.d=self.call('decision_get',id='case')['reference'];self.put()
        with self.assertRaisesRegex(RecordError,'SUPPORT_PACKET_BUDGET'):self.evaluate(maxBytes=10)

if __name__=='__main__':unittest.main()

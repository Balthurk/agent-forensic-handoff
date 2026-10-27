import copy, hashlib, json, sqlite3, tempfile, unittest
from contextlib import closing
from pathlib import Path
from afh_semantic.host import dispatch
from afh_semantic.knowledge_records import RecordError

def source(i, text, role='user'):
    sha=hashlib.sha256(text.encode()).hexdigest()
    return dict(id=i,representation_id=i,revision=sha,payload_sha256=sha,
                occurrence_id='occ-'+i,source_conversation_id=i,text=text,text_sha256=sha,
                record_sha256=sha,role=role,verified=True,coordinate_space='AFH-representation-text-v1')

class DecisionTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.root=Path(self.tmp.name)
        self.sources=[source('u','Conservar originales. Comparar copia local y copia remota. Elijo local. Reabrir tras comprobar la copia.'),source('t','La copia local restauró 12 archivos; la copia remota está pendiente.','tool')]
        self.claim=lambda text:dict(text=text,evidence=[dict(sourceId='u',quote='Conservar originales')])
        self.case=dict(title='Copia recuperable',objective=self.claim('Recuperar datos'),
            constraints=[dict(id='intact',**self.claim('Conservar originales'))],
            criteria=[dict(id='latency',**self.claim('Tiempo de recuperación'))],
            alternatives=[dict(id=a,title=a,mechanism=self.claim('Copia '+a),assessments={k:dict(status='pass',reason=self.claim('Declarado viable')) for k in ['intact','latency']}) for a in ['local','remote']],
            assumptions=[self.claim('Acceso a disco')],information_gaps=[self.claim('Remota sin medir')],
            expected_result=self.claim('Recuperar 12 archivos'),review_condition=self.claim('Revisar después de restaurar'),extension={'keep':['ñ',1]})
    def call(self,op,**kw):
        return dispatch(dict(root=str(self.root),scope='test',sources=copy.deepcopy(self.sources),op='decision_'+op,**kw))
    def frame(self,**kw):
        return self.call('frame',id='backup',case=copy.deepcopy(self.case),actor='editor',statement='Encuadre inicial',requestId='frame',**kw)
    def act(self,previous,action='choose',request='choose',**extra):
        detail=dict(actor='operador',actorKind='local_operator',statement='Elección local declarada',evidence=[dict(sourceId='u',quote='Elijo local')]);detail.update(extra)
        if action=='choose':detail.setdefault('alternativeId','local')
        if action=='result':detail.setdefault('observed',dict(text='Se restauraron 12 archivos',evidence=[dict(sourceId='t',quote='La copia local restauró 12 archivos')]))
        return self.call('act',id='backup',action=action,detail=detail,expectedVersion=previous['record']['version'],binding=previous['reference'],requestId=request)
    def test_frame_is_source_bound_and_never_selects(self):
        r=self.frame();self.assertEqual(r['brief']['status'],'pending_choice');self.assertIsNone(r['brief']['selected']);self.assertEqual(r['brief']['disposition'],'compare')
        d=r['record']['payload']['decision_case'];self.assertFalse(d['executionAuthority']);self.assertFalse(d['humanAcceptance']);self.assertEqual(d['case']['extension'],self.case['extension']);self.assertEqual(d['originConversations'],['u'])
    def test_lifecycle_result_binds_exact_choice_reopen_preserves_history(self):
        a=self.frame();b=self.act(a);c=self.act(b,'result','result',choiceBinding=b['reference']);d=self.act(c,'reopen','reopen')
        self.assertEqual(c['brief']['status'],'result_recorded');self.assertEqual(c['brief']['outcome']['choiceBinding'],b['reference'])
        self.assertEqual(d['brief']['status'],'pending_choice');self.assertIsNone(d['brief']['selected']);self.assertIsNone(d['brief']['outcome'])
        history=self.call('history',id='backup');self.assertEqual(len(history),4);self.assertEqual(history[0],a);self.assertEqual(history[2],c)
    def test_exact_retry_after_later_action(self):
        a=self.frame();b=self.act(a);self.act(b,'reopen','reopen');self.assertEqual(self.frame(),a);self.assertEqual(self.act(a),b)
    def test_conflicting_request_and_stale_version_do_not_write(self):
        a=self.frame();self.act(a)
        with self.assertRaisesRegex(RecordError,'IDEMPOTENCY_CONFLICT'):self.act(a,alternativeId='remote')
        with self.assertRaisesRegex(RecordError,'VERSION_CONFLICT'):self.act(a,request='other')
        self.assertEqual(len(self.call('history',id='backup')),2)
    def test_all_unknown_constraints_abstain_and_failed_excluded(self):
        for a in self.case['alternatives']:a['assessments']['intact']['status']='unknown'
        r=self.frame();self.assertEqual(r['brief']['disposition'],'abstain')
        with self.assertRaisesRegex(RecordError,'ALTERNATIVE_NOT_ELIGIBLE'):self.act(r)
    def test_criteria_are_comparison_not_hidden_weights(self):
        self.case['alternatives'][0]['assessments']['latency']['status']='fail';r=self.frame()
        self.assertEqual(r['brief']['alternatives'][0]['eligibility'],'eligible');self.act(r)
    def test_choice_or_frame_after_choice_requires_reopen(self):
        a=self.frame();b=self.act(a)
        with self.assertRaisesRegex(RecordError,'REOPEN_REQUIRED'):self.act(b,request='again')
        with self.assertRaisesRegex(RecordError,'REOPEN_REQUIRED'):self.call('frame',id='backup',case=self.case,actor='editor',statement='Changed',expectedVersion=2,binding=b['reference'],requestId='changed')
    def test_reframe_preserves_prior_frame_and_extensions(self):
        a=self.frame();self.case['title']='Revisión';b=self.call('frame',id='backup',case=self.case,actor='editor',statement='Revisión motivada',expectedVersion=1,binding=a['reference'],requestId='revise')
        self.assertEqual(b['record']['version'],2);self.assertEqual(self.call('get',id='backup',version=1),a)
    def test_agent_cannot_declare_choice_and_user_evidence_required(self):
        a=self.frame()
        with self.assertRaisesRegex(RecordError,'OPERATOR_REQUIRED'):self.act(a,actorKind='agent')
        with self.assertRaisesRegex(RecordError,'USER_DECLARATION_REQUIRED'):self.act(a,evidence=[dict(sourceId='t',quote='La copia local restauró 12 archivos')])
    def test_stale_or_other_brief_binding_rejected(self):
        a=self.frame();bad=copy.deepcopy(a);bad['reference']['digest']='0'*64
        with self.assertRaisesRegex(RecordError,'BRIEF_BINDING_STALE'):self.act(bad)
    def test_result_cannot_precede_or_misattribute_choice(self):
        a=self.frame()
        with self.assertRaisesRegex(RecordError,'CHOICE_REQUIRED'):self.act(a,'result','early',choiceBinding=a['reference'])
        b=self.act(a)
        with self.assertRaisesRegex(RecordError,'RESULT_CHOICE_BINDING'):self.act(b,'result','wrong',choiceBinding=a['reference'])
    def test_defer_reject_and_reopen_transitions(self):
        a=self.frame();b=self.act(a,'defer','defer');c=self.act(b,'reject','reject');d=self.act(c,'reopen','reopen');self.act(d,request='after-reopen')
        self.assertEqual([v['brief']['status'] for v in self.call('history',id='backup')],['pending_choice','deferred','rejected','pending_choice','chosen'])
    def test_reserved_policy_and_choice_smuggling_blocked(self):
        for key in ['choice','selected','humanAcceptance','executionAuthority','weights','score']:
            with self.subTest(key=key):
                c=copy.deepcopy(self.case);c[key]=True
                with self.assertRaisesRegex(RecordError,'DECISION_SEPARATE'):self.call('frame',id='x',case=c,actor='x',statement='x',requestId='bad')
    def test_bad_sources_quotes_and_duplicate_keys(self):
        self.case['objective']['evidence'][0]['quote']='inventado'
        with self.assertRaisesRegex(RecordError,'QUOTE_AMBIGUOUS_OR_MISSING'):self.frame()
        self.case['objective']=self.claim('Objetivo');self.case['criteria'][0]['id']='intact'
        with self.assertRaisesRegex(RecordError,'DUPLICATE_CRITERION'):self.frame()
    def test_unicode_offsets_and_ambiguous_quotes(self):
        self.sources.append(source('r','🧠 copia; copia.'));self.case['objective']['evidence']=[dict(sourceId='r',quote='copia')]
        with self.assertRaisesRegex(RecordError,'QUOTE_AMBIGUOUS_OR_MISSING'):self.frame()
        self.case['objective']['evidence'][0]['start']=2;r=self.frame();self.assertEqual(r['record']['payload']['decision_case']['bindings']['objective'][0]['locator']['start'],2)
    def test_history_hash_tamper_blocks_even_unmatched_listing(self):
        self.frame()
        with closing(sqlite3.connect(self.root/'decisions/records.sqlite3')) as db:
            db.execute('DROP TRIGGER records_no_update');db.execute("UPDATE record_versions SET recorded_at='2000-01-01T00:00:00Z'");db.commit()
        with self.assertRaisesRegex(RecordError,'RECORD_CORRUPT'):self.call('get',id='backup')
        p=self.call('list',question='notfound');self.assertEqual(p['status'],'incomplete');self.assertEqual(p['items'],[]);self.assertTrue(p['errors'])
    def test_source_drift_is_incomplete_not_empty_success(self):
        self.frame();self.sources[0]=source('u','Changed source');p=self.call('list');self.assertEqual(p['status'],'incomplete');self.assertTrue(p['errors'])
    def test_partial_selection_and_whole_item_budget(self):
        a=self.frame();b=self.act(a);self.act(b,'result','result',choiceBinding=b['reference'])
        p=self.call('list',maxBytes=4096);self.assertEqual(p['items'],[]);self.assertEqual(p['omittedByBudget'],1)
        self.sources=self.sources[:1];p=self.call('list');self.assertEqual(p['status'],'partial_selection');self.assertEqual(p['outsideSelection'],1)
    def test_known_time_and_scopes(self):
        a=self.frame();self.act(a);p=self.call('list',knownAt=a['record']['recorded_at']);self.assertEqual(p['items'][0],a)
        other=dispatch(dict(root=str(self.root),scope='other',sources=self.sources,op='decision_list'));self.assertEqual(other['items'],[])
    def test_append_only_and_unknown_action_no_mutation(self):
        a=self.frame()
        with closing(sqlite3.connect(self.root/'decisions/records.sqlite3')) as db:
            with self.assertRaisesRegex(sqlite3.IntegrityError,'append only'):db.execute('DELETE FROM record_versions')
        with self.assertRaisesRegex(RecordError,'INVALID_ACTION'):self.act(a,'execute','execute')
        self.assertEqual(len(self.call('history',id='backup')),1)
    def test_invalid_schema_and_limits(self):
        self.case['alternatives']=self.case['alternatives'][:1]
        with self.assertRaisesRegex(RecordError,'ALTERNATIVES_REQUIRED'):self.frame()
        for kw in [dict(limit=0),dict(limit=True),dict(maxBytes=12),dict(knownAt='yesterday')]:
            with self.assertRaises((RecordError,ValueError)):self.call('list',**kw)
    def test_failed_constraint_blocks_choice_but_other_option_remains(self):
        self.case['alternatives'][0]['assessments']['intact']['status']='fail';a=self.frame()
        self.assertEqual(a['brief']['disposition'],'candidate_for_human_choice')
        with self.assertRaisesRegex(RecordError,'ALTERNATIVE_NOT_ELIGIBLE'):self.act(a)
        self.assertEqual(self.act(a,alternativeId='remote')['brief']['selected'],'remote')
    def test_assessment_coverage_and_extension_preservation(self):
        del self.case['alternatives'][0]['assessments']['latency']
        with self.assertRaisesRegex(RecordError,'ASSESSMENTS_REQUIRED'):self.frame()
    def test_act_cannot_be_used_as_unbound_frame(self):
        a=self.frame()
        with self.assertRaisesRegex(RecordError,'INVALID_ACTION'):self.act(a,'frame','bypass')
    def test_results_search_and_reopened_cycle_cannot_reuse_old_choice(self):
        a=self.frame();b=self.act(a);c=self.act(b,'result','result',choiceBinding=b['reference'])
        self.assertEqual(self.call('list',question='restauraron')['items'][0],c)
        d=self.act(c,'reopen','reopen');e=self.act(d,request='new-choice',alternativeId='remote')
        with self.assertRaisesRegex(RecordError,'RESULT_CHOICE_BINDING'):self.act(e,'result','wrong-cycle',choiceBinding=b['reference'])

if __name__=='__main__':unittest.main()

"""A12 candidate discovery; semantic similarity never admits support or authority."""
import copy
import hashlib
import unittest
from afh_semantic.host import dispatch, manifest
from afh_semantic.knowledge_records import RecordError
import test_context_retrieval as semantic_fixture
import test_collectives as collective_fixture
import test_justifications as support_fixture
import test_identities as identity_fixture
import test_retrospectives as retrospective_fixture
import test_decision_intelligence as intelligence_fixture
import test_causal as causal_fixture


def bindings(sources):
    for source in sources:
        source.setdefault('conversationId', source['source_conversation_id'])
        source.setdefault('caseHash', hashlib.sha256((source['id'] + source['revision']).encode()).hexdigest())
    return sources


def discovery(sources, *keys, hints=()):
    bindings(sources)
    seeds = []
    for key in keys:
        s = next(s for s in sources if s['id'] == key)
        seeds.append(dict(sourceId=s['id'], revision=s['revision'], conversationId=s['conversationId'],
                          caseHash=s['caseHash'], projectionId='sem-synthetic-contract', similarity=.9))
    return dict(schema='afh.context-discovery.v1', channel='semantic_full_text', seedLimit=60,
                candidateCount=len(seeds), omittedSeeds=0, queryHints=list(hints), seeds=seeds)


class ContextDiscoveryTest(unittest.TestCase):
    def fixture(self, cls):
        fixture = cls(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        bindings(fixture.sources)
        return fixture

    def query(self, fixture, scope, keys=(), **options):
        request = dict(root=str(fixture.root), scope=scope, sources=fixture.sources, op='context_query',
                       question='ornitorrinco cuántico', discovery=discovery(fixture.sources, *keys))
        request.update(options)
        return dispatch(request)

    def test_seed_discovers_rules_and_unlinked_adverse_branches_without_relations_or_support(self):
        f = self.fixture(semantic_fixture.ContextRetrievalTest)
        f.add(0); f.add(1); f.add(2); f.add(6)
        result = self.query(f, 'scope', ['s0'])
        self.assertEqual(len(result['items']), 3)
        self.assertEqual(result['edges'], [])
        self.assertEqual(len(result['candidateComplements']), 2)
        self.assertTrue(result['requiresAbstention'])
        self.assertFalse(any('Beta' in item['text'] for item in result['items']))
        self.assertTrue(all(item['support'] != 'supported' for item in result['items']))
        self.assertEqual(result['contextDiscovery']['summary']['acceptedSeeds'], 1)

    def test_only_active_versions_are_seeded_and_explicit_historical_roots_keep_priority(self):
        f = self.fixture(semantic_fixture.ContextRetrievalTest)
        old = f.add(0); first = f.records[0]; cut = first['recorded_at']
        payload = copy.deepcopy(first['payload']); clause = payload['semantic_unit']['clauses'][0]
        clause['clause_version_id'] = 'cv-a12-revised'; clause['predicate']['value'] = 'revised'; manifest(payload['semantic_unit'])
        f.call('put', payload=payload, expectedVersion=1, requestId='a12-new-version')
        current = self.query(f, 'scope', ['s0'])
        self.assertEqual([i['clauseVersionId'] for i in current['items']], ['cv-a12-revised'])
        historical = self.query(f, 'scope', ['s0'], knownAt=cut)
        self.assertEqual([i['clauseVersionId'] for i in historical['items']], [old])
        unrelated = f.add(6)
        explicit = self.query(f, 'scope', ['s6'], roots=[old])
        self.assertEqual({i['clauseVersionId'] for i in explicit['items']}, {old, 'cv-a12-revised'})
        self.assertNotIn(unrelated, [i['clauseVersionId'] for i in explicit['items']])
        self.assertEqual(explicit['candidateComplements'], [dict(version='cv-a12-revised', reason='shared_literal_argument_or_scope', relationEstablished=False)])
        self.assertFalse(next(i for i in explicit['items'] if i['clauseVersionId'] == old)['currentAtCut'])
        self.assertEqual(explicit['edges'], [])

    def test_revision_selection_case_and_conversation_are_rechecked_before_discovery(self):
        f = self.fixture(semantic_fixture.ContextRetrievalTest); f.add(0)
        for field, value in [('sourceId', 'not-selected'), ('revision', '0'*64), ('caseHash', '0'*64), ('conversationId', 'outside')]:
            d = discovery(f.sources, 's0'); d['seeds'][0][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(RecordError, 'CONTEXT_DISCOVERY'):
                self.query(f, 'scope', discovery=d)

    def test_discovery_budgets_counts_and_duplicate_seeds_fail_closed(self):
        f = self.fixture(semantic_fixture.ContextRetrievalTest); f.add(0)
        original = discovery(f.sources, 's0')
        cases = []
        d = copy.deepcopy(original); d['seeds'] *= 61; d['candidateCount'] = 61; cases.append(d)
        d = copy.deepcopy(original); d['seeds'] *= 2; d['candidateCount'] = 2; cases.append(d)
        d = copy.deepcopy(original); d['omittedSeeds'] = 1; cases.append(d)
        d = copy.deepcopy(original); d['seeds'][0]['similarity'] = True; cases.append(d)
        d = copy.deepcopy(original); d['queryHints'] = ['x'] * 61; cases.append(d)
        for index, d in enumerate(cases):
            with self.subTest(index=index), self.assertRaisesRegex(RecordError, 'CONTEXT_DISCOVERY'):
                self.query(f, 'scope', discovery=d)

    def test_same_capture_alias_requires_full_proof_and_keeps_original_binding(self):
        f = self.fixture(semantic_fixture.ContextRetrievalTest); old_id = f.add(0)
        old = copy.deepcopy(f.sources[0]); current = dict(old, id='current', representation_id='current')
        current['caseHash'] = hashlib.sha256(b'current-case').hexdigest()
        alias = dict(old, aliasOf='current', caseHash=current['caseHash'],
                     aliasWitness=dict(conversationId=old['conversationId'], caseHash=old['caseHash'], representationId=old['id'], uri='synthetic://original', recordSha256=old['record_sha256']))
        f.sources = [current, alias]; f.call('sync')
        q = self.query(f, 'scope', ['current'])
        self.assertEqual([i['clauseVersionId'] for i in q['items']], [old_id])
        self.assertEqual(q['items'][0]['sourceRefs'][0]['id'], old['id'])
        alias.pop('aliasWitness')
        with self.assertRaisesRegex(RecordError, 'CONTEXT_DISCOVERY_ALIAS'):
            self.query(f, 'scope', ['current'])

    def test_removed_source_keeps_missing_adverse_dependency_and_abstention(self):
        f = self.fixture(semantic_fixture.ContextRetrievalTest); first = f.add(0); f.add(1, first)
        f.sources = f.sources[1:]
        q = self.query(f, 'scope', ['s1'])
        self.assertTrue(q['missing']); self.assertTrue(q['contextUnits'][0]['blocked']); self.assertTrue(q['requiresAbstention'])

    def test_collectives_and_decisions_keep_all_alternatives_and_withdrawn_evidence(self):
        f = self.fixture(support_fixture.SupportTest)
        f.put(); f.put('j2', f.detail('e2')); f.impact()
        f.call('collective_put', id='group', detail=collective_fixture.detail(f.sources[:2]), requestId='group')
        q = self.query(f, 's', ['u'])
        self.assertEqual({u['kind'] for u in q['contextUnits']}, {'collective', 'decision'})
        decision = next(u for u in q['contextUnits'] if u['kind'] == 'decision')
        self.assertEqual(len(decision['data']['alternatives']), 2)
        self.assertEqual(len(decision['data']['evidenceReviews']), 1)
        local = next(a for a in decision['data']['alternatives'] if a['alternativeId'] == 'local')
        self.assertEqual({i['state'] for i in local['items']}, {'pending', 'supported'})
        self.assertFalse(decision['data']['executionAuthority'])

    def test_identity_seeds_close_different_and_withdrawn_comparisons_without_merge(self):
        f = self.fixture(identity_fixture.IdentityTest)
        a = f.entity('a', 'Alpha'); b = f.entity('b', 'Beta')
        link = f.link(a, b, 'different')
        f.link(a, b, 'different', detail=dict(state='withdrawn'), expectedVersion=1, binding=link['reference'], requestId='withdraw')
        q = self.query(f, 's', ['names']); data = next(u['data'] for u in q['contextUnits'] if u['kind'] == 'identity')
        self.assertEqual(len(data['entities']), 2); self.assertEqual(len(data['links']), 1)
        self.assertEqual(data['links'][0]['judgment'], 'different'); self.assertFalse(data['links'][0]['effective'])
        self.assertEqual(data['groups'], []); self.assertFalse(data['executionAuthority'])

    def test_retrospective_keeps_adverse_claims_gaps_and_withdrawal(self):
        f = self.fixture(retrospective_fixture.RetrospectiveTest); detail = f.detail()
        detail['state'] = 'withdrawn'; detail['claims'].append(dict(key='adverse', text='Aplicación incierta', position='contradicts', evidence=detail['claims'][0]['evidence']))
        f.put(detail=detail)
        q = self.query(f, 's', ['old']); unit = next(u for u in q['contextUnits'] if u['kind'] == 'retrospective')
        self.assertEqual(len(unit['data']['record']['payload']['retrospective']['detail']['claims']), 2)
        self.assertIn('composition_withdrawn', unit['data']['reasons']); self.assertFalse(unit['data']['executionAuthority'])

    def test_intelligence_keeps_linked_adverse_outcome_and_exact_decision(self):
        f = self.fixture(intelligence_fixture.IntelligenceTest)
        f.put('review', 'review', f.review_detail()); forecast = f.forecast(); f.outcome(forecast, False)
        q = self.query(f, 'test', ['u'], knownAt='2031-01-04T00:00:00Z')
        units = [u for u in q['contextUnits'] if u['kind'] == 'decision_intelligence']
        self.assertEqual(len(units), 3)
        self.assertTrue(all(u['data']['executionAuthority'] is False for u in units))
        self.assertTrue(any(u['data']['record']['payload']['intelligence']['detail'].get('value') is False for u in units))

    def test_causal_seeds_keep_all_hypotheses_counterevidence_and_bound_decision(self):
        f = self.fixture(causal_fixture.CausalTest); f.d['decision'] = f.h.case['reference']
        f.d['hypotheses'][1]['evidence'].append(dict(sourceId='t', quote='La copia local restauró 12 archivos', position='contradicts', basis='observation'))
        f.put(); q = self.query(f, 'test', ['u'])
        unit = next(u for u in q['contextUnits'] if u['kind'] == 'causal_explanation')
        self.assertEqual(len(unit['data']['hypotheses']), 2)
        self.assertEqual(unit['data']['hypotheses'][1]['status'], 'conflicting')
        self.assertEqual(len(unit['data']['record']['payload']['causal']['targets']['decision']['case']['alternatives']), 2)
        self.assertIsNone(unit['data']['selectedCause']); self.assertTrue(unit['data']['requiresAbstention'])

    def test_explicit_discovery_omissions_and_hints_are_visible_without_adding_authority(self):
        f = self.fixture(semantic_fixture.ContextRetrievalTest); f.add(0); f.add(6)
        d = discovery(f.sources, 's6', hints=['staging']); d.update(candidateCount=65, omittedSeeds=64)
        q = self.query(f, 'scope', discovery=d)
        self.assertEqual(len(q['items']), 2)
        self.assertEqual(q['contextDiscovery']['summary']['omittedSeeds'], 64)
        self.assertEqual(q['contextDiscovery']['summary']['queryHints'], ['staging'])
        self.assertTrue(q['requiresAbstention'])

    def test_no_discovery_keeps_existing_shape_and_exact_fixed_cut_result(self):
        f = self.fixture(semantic_fixture.ContextRetrievalTest); root = f.add(0); cut = f.records[0]['recorded_at']
        old = f.call('context_query', question='staging', knownAt=cut, roots=[root])
        same = f.call('context_query', question='staging', knownAt=cut, roots=[root], discovery=None)
        self.assertEqual(old, same); self.assertNotIn('contextDiscovery', same)

    def test_private_request_hints_cannot_bypass_the_discovery_contract(self):
        f = self.fixture(semantic_fixture.ContextRetrievalTest); f.add(0)
        q = self.query(f, 'scope', discovery=None, _discovery_refs={('s0', f.sources[0]['revision'])}, _discovery_hints=['staging'])
        self.assertEqual(q['items'], []); self.assertNotIn('contextDiscovery', q)

    def test_semantic_budget_fails_without_returning_a_partial_component(self):
        f = self.fixture(semantic_fixture.ContextRetrievalTest); f.add(0)
        act = dict(key='many', targetSourceId='s0', type='policy', summary=f.sources[0]['text'], modality='stated', clauses=[dict(key='c', quote=f.sources[0]['text'], predicate='rule', polarity='positive', resolution='resolved', arguments=[], conditions=[], temporal=[], relations=[])])
        acts = [dict(act, key='a12-many-'+str(i)) for i in range(100)]
        result = f.call('extract', draft=dict(acts=acts), producer='a12-budget-fixture', sourceCut='cut', requestId='many')
        self.assertEqual(result['errors'], []); self.assertEqual(len(result['records']), 100)
        with self.assertRaisesRegex(RecordError, 'CONTEXT_SEMANTIC_CANDIDATE_BUDGET'):
            self.query(f, 'scope', ['s0'])

    def test_total_unit_budget_fails_without_dropping_adverse_units(self):
        f = self.fixture(retrospective_fixture.RetrospectiveTest)
        for i in range(101):
            d = f.detail(); d['state'] = 'withdrawn' if i % 2 else 'active'; f.put('many-'+str(i), detail=d)
        with self.assertRaisesRegex(RecordError, 'CONTEXT_UNIT_BUDGET'):
            self.query(f, 's', ['old'])


if __name__ == '__main__':
    unittest.main()

import copy, tempfile, unittest, sqlite3
from pathlib import Path
from contextlib import closing
from afh_semantic.host import dispatch
from afh_semantic.knowledge_records import RecordError
from test_decisions import source

class IdentityTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.sources=[source('names','Órbita Alpha Beta Gamma Alice. Alias Orbita. Desde 2026-01-01 hasta 2027-01-01. Revisión local.'),source('other','Alice es otra persona. Incertidumbre registrada.')]
    def call(self,op,**kw):return dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op='identity_'+op,**kw))
    def entity(self,key,label='Alice',**kw):
        d=dict(label=label,aliases=[],entityType='person',namespace='local',origin=None,state='active',actor='editor',reason='Declaración local',evidence=[dict(sourceId='names',quote=self.sources[0]['text'])]);d.update(kw.pop('detail',{}))
        return self.call('put',kind='entity',id=key,detail=d,requestId=kw.pop('requestId',key),**kw)
    def link(self,a,b,judgment='same',**kw):
        evidence=[dict(sourceId='names',quote=self.sources[0]['text'])]
        d=dict(left=a['reference'],right=b['reference'],judgment=judgment,temporal=dict(eventAt=None,validFrom='2026-01-01T00:00:00Z',validTo='2027-01-01T00:00:00Z',endOpen=False,evidence=evidence),state='active',actor='editor',reason='Revisión declarada',evidence=evidence);d.update(kw.pop('detail',{}))
        return self.call('put',kind='link',detail=d,requestId=kw.pop('requestId',a['reference']['id']+'-'+b['reference']['id']),**kw)
    def board(self,**kw):return self.call('resolve',validAt='2026-06-01T00:00:00Z',**kw)
    def test_names_are_only_candidates_and_aliases_literal(self):
        a=self.entity('a');self.entity('b');p=self.board();self.assertEqual(len(p['candidates']),1);self.assertEqual(p['groups'],[]);self.assertFalse(p['candidates'][0]['identityEstablished'])
        with self.assertRaisesRegex(RecordError,'NAME_NOT_LITERAL'):self.entity('invented',detail=dict(aliases=['Inventado']))
        with self.assertRaisesRegex(RecordError,'QUOTE_AMBIGUOUS_OR_MISSING'):self.entity('bad',detail=dict(evidence=[dict(sourceId='names',quote='no existe')]))
    def test_consolidation_versions_undo_historical_and_retry(self):
        a=self.entity('a');b=self.entity('b');r=self.link(a,b);self.assertEqual(r,self.link(a,b));p=self.board();self.assertEqual(p['groups'][0]['status'],'declared_consolidation');self.assertEqual(len({e['canonicalId'] for e in p['entities']}),1)
        withdrawn=self.link(a,b,detail=dict(state='withdrawn'),expectedVersion=1,binding=r['reference'],requestId='undo')
        self.assertEqual(self.board()['groups'],[]);self.assertEqual(len(self.call('history',kind='link',id=r['reference']['id'])),2)
        old=self.board(knownAt=r['record']['recorded_at']);self.assertTrue(old['links'][0]['effective'])
        self.assertEqual(self.call('get',kind='link',id=r['reference']['id'],version=1)['reference'],r['reference'])
        with self.assertRaisesRegex(RecordError,'VERSION_CONFLICT'):self.link(a,b,expectedVersion=1,binding=r['reference'],requestId='stale')
    def test_transitive_conflict_suspends_whole_component_then_reversible(self):
        a,b,c=[self.entity(x,label=x) for x in ['Alpha','Beta','Gamma']];self.link(a,b);self.link(b,c);adverse=self.link(a,c,'different')
        p=self.board();self.assertEqual(p['groups'][0]['status'],'conflict');self.assertFalse(any(l['effective'] for l in p['links']));self.assertEqual(len({e['canonicalId'] for e in p['entities']}),3)
        self.link(a,c,'different',detail=dict(state='withdrawn'),expectedVersion=1,binding=adverse['reference'],requestId='withdraw-adverse');self.assertEqual(self.board()['groups'][0]['status'],'declared_consolidation')
    def test_unknown_and_expired_validity_never_effective(self):
        a=self.entity('a');b=self.entity('b');r=self.link(a,b,detail=dict(temporal=dict(eventAt=None,validFrom=None,validTo=None,endOpen=False,evidence=[])))
        self.assertFalse(self.board()['links'][0]['effective']);self.assertEqual(self.board()['groups'],[])
        self.link(a,b,expectedVersion=1,binding=r['reference'],requestId='known');p=self.call('resolve',validAt='2027-01-01T00:00:00Z');self.assertFalse(p['links'][0]['effective'])
    def test_namespace_type_and_exact_entity_revision_guards(self):
        a=self.entity('a');b=self.entity('b',detail=dict(namespace='elsewhere'));c=self.entity('c',detail=dict(entityType='organization'))
        with self.assertRaisesRegex(RecordError,'NAMESPACE_MISMATCH'):self.link(a,b)
        with self.assertRaisesRegex(RecordError,'TYPE_MISMATCH'):self.link(a,c)
        d=self.entity('d');self.link(a,d);self.entity('a',detail=dict(aliases=['Orbita']),expectedVersion=1,binding=a['reference'],requestId='revision');self.assertEqual(self.board()['groups'],[])
        self.assertIn('entity_revision_changed',self.board()['links'][0]['reasons'])
    def test_unselected_adverse_evidence_blocks_partial_identity(self):
        a=self.entity('a');b=self.entity('b');r=self.link(a,b,detail=dict(evidence=[dict(sourceId='other',quote=self.sources[1]['text'])]))
        self.sources=self.sources[:1];p=self.board();self.assertEqual(p['groups'],[]);self.assertTrue(all('comparison_outside_selection' in e['reasons'] for e in p['entities']))
        q=dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op='context_query',question='Alice'));self.assertTrue(q['contextUnits'][0]['blocked']);self.assertTrue(q['contextBlockers'])
    def test_context_closes_adverse_branch_without_merging_and_no_authority(self):
        a=self.entity('a','Alpha');b=self.entity('b','Beta');self.link(a,b,'different');q=dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op='context_query',question='Alpha'))
        d=q['contextUnits'][0]['data'];self.assertEqual(len(d['entities']),2);self.assertEqual(d['links'][0]['judgment'],'different');self.assertFalse(d['executionAuthority']);self.assertEqual(d['independentCorroboration'],'not_established')
    def test_old_entity_version_does_not_require_future_source(self):
        a=self.entity('a');self.sources.append(source('future','Alice new source.'));self.entity('a',detail=dict(evidence=[dict(sourceId='future',quote='Alice new source.')]),expectedVersion=1,binding=a['reference'],requestId='new');self.sources=self.sources[:2]
        self.assertEqual(self.call('get',kind='entity',id='a',version=1)['reference'],a['reference'])
    def test_tampered_envelope_fails_closed(self):
        self.entity('a')
        with closing(sqlite3.connect(self.root/'identities/records.sqlite3')) as db,db:
            db.execute('DROP TRIGGER records_no_update');db.execute("UPDATE record_versions SET payload_sha256='bad'")
        with self.assertRaises(RecordError):self.board()
    def test_current_obsolete_document_never_consolidates_historical_cut_survives(self):
        a=self.entity('a');b=self.entity('b');r=self.link(a,b);self.sources[0]['document']=dict(currentRevision=False)
        self.assertEqual(self.board()['groups'],[]);self.assertEqual(len(self.board(knownAt=r['record']['recorded_at'])['groups']),1)
    def test_f17_adoption_is_exact_and_origin_revision_change_suspends_group(self):
        evidence=[dict(sourceId='names',quote='Órbita')]
        act=dict(key='project',targetSourceId='names',type='fact',summary='Órbita',modality='assertion',clauses=[dict(key='name',quote=self.sources[0]['text'],predicate='names',polarity='positive',resolution='resolved',arguments=[dict(role='subject',literal='Órbita',interpreted='',evidence=evidence)],conditions=[],temporal=[],relations=[])])
        result=dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op='extract',draft=dict(acts=[act]),producer='test',sourceCut='cut',requestId='extract'));self.assertEqual(result['errors'],[])
        mentions=self.call('mentions');m=mentions['items'][0];a=self.entity('a','Órbita',detail=dict(origin=m['origin']));b=self.entity('b','Órbita');r=self.link(a,b);self.assertEqual(len(self.board()['groups']),1)
        bad=copy.deepcopy(m['origin']);bad['digest']='0'*64
        with self.assertRaisesRegex(RecordError,'ORIGIN_DIGEST'):self.entity('bad','Órbita',detail=dict(origin=bad))
        prior=result['records'][0];payload=copy.deepcopy(prior['payload']);payload['text']='Revisión de la interpretación';dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op='put',payload=payload,expectedVersion=1,requestId='changed'))
        self.assertEqual(self.board()['groups'],[]);self.assertEqual(len(self.board(knownAt=r['record']['recorded_at'])['groups']),1)
    def test_uncertain_adverse_review_and_unicode_offsets_are_preserved(self):
        self.sources[0]=source('names','🪐 Alice Alice Beta Gamma.')
        evidence=[dict(sourceId='names',quote='Alice',start=2)]
        a=self.entity('a',detail=dict(evidence=evidence));b=self.entity('b',detail=dict(evidence=evidence));c=self.entity('c','Beta');self.link(a,b);self.link(b,c)
        unknown=dict(eventAt=None,validFrom=None,validTo=None,endOpen=False,evidence=[]);self.link(a,c,'uncertain',detail=dict(temporal=unknown))
        p=self.board();self.assertEqual(p['groups'][0]['status'],'conflict');self.assertEqual(a['record']['payload']['identity']['bindings']['declaration'][0]['locator']['start'],2)
        self.assertEqual(p['groups'][0]['distinctOriginalOccurrences'],1);self.assertEqual(p['groups'][0]['independentCorroboration'],'not_established')
    def test_concurrent_writers_only_one_exact_version_wins(self):
        from concurrent.futures import ThreadPoolExecutor
        a=self.entity('a')
        def write(i):
            try:return self.entity('a',detail=dict(reason='Concurrent '+str(i)),expectedVersion=1,binding=a['reference'],requestId='concurrent-'+str(i))
            except RecordError as error:return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(write,[1,2]))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1);self.assertTrue(any(isinstance(r,str) and 'VERSION_CONFLICT' in r for r in results));self.assertEqual(len(self.call('history',kind='entity',id='a')),2)
    def test_undo_single_edge_keeps_remaining_component_and_ids(self):
        a,b,c=[self.entity(x,label=x) for x in ['Alpha','Beta','Gamma']];ab=self.link(a,b);bc=self.link(b,c)
        self.link(a,b,detail=dict(state='withdrawn'),expectedVersion=1,binding=ab['reference'],requestId='undo-ab');p=self.board()
        self.assertEqual(len(p['groups']),1);self.assertEqual({m['id'] for m in p['groups'][0]['members']},{'Beta','Gamma'});self.assertEqual(next(e for e in p['entities'] if e['reference']['id']=='Alpha')['canonicalId'],'Alpha')
    def test_superseded_review_source_blocks_current_and_short_names_retrieve(self):
        self.sources[0]=source('names','AI y X son nombres locales.');a=self.entity('a','AI');b=self.entity('b','X');r=self.link(a,b,detail=dict(evidence=[dict(sourceId='other',quote=self.sources[1]['text'])]));self.sources[1]['document']=dict(currentRevision=False)
        self.assertEqual(self.board()['groups'],[]);self.assertIn('historical_source',self.board()['links'][0]['reasons']);self.assertEqual(len(self.board(knownAt=r['record']['recorded_at'])['groups']),1)
        q=dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op='context_query',question='¿Qué es X?'));self.assertEqual(len(q['contextUnits'][0]['data']['entities']),2)
    def test_cross_source_alias_resolution_keeps_both_originals_and_declared_confidence(self):
        self.sources=[source('names','Alpha es el nombre local. Alias: Orión.'),source('other','Orion designa Alpha en este directorio. Vigente desde 2026-01-01 hasta 2027-01-01.')]
        a=self.entity('a','Alpha',detail=dict(aliases=['Orión']));b=self.entity('b','Orion',detail=dict(evidence=[dict(sourceId='other',quote=self.sources[1]['text'])]))
        p=self.board();self.assertEqual(len(p['candidates']),1);self.assertEqual(p['groups'],[]);self.assertEqual(p['candidates'][0]['confidence'],'not_scored')
        r=self.link(a,b,detail=dict(evidence=[dict(sourceId='other',quote=self.sources[1]['text'])]));p=self.board();self.assertEqual(p['groups'][0]['distinctOriginalOccurrences'],2);self.assertEqual(p['groups'][0]['independentCorroboration'],'not_established')
        q=dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op='context_query',question='¿Quién es Orión?',validAt='2026-06-01T00:00:00Z'));u=q['contextUnits'][0];self.assertEqual({e['reference']['id'] for e in u['data']['entities']},{'a','b'});self.assertEqual({e['id'] for e in u['sourceRefs']},{'names','other'})

if __name__=='__main__':unittest.main()

import copy, tempfile, unittest, sqlite3
from contextlib import closing
from pathlib import Path
from afh_semantic.host import dispatch
from afh_semantic.collectives import digest
from afh_semantic.knowledge_records import RecordError
from test_decisions import source

def detail(sources):
    evidence=lambda s:[dict(sourceId=s['id'],quote=s['text'])]
    return dict(title='Reunión de revisión',kind='meeting',scope='Proyecto local',actor='editor',reason='Registro con originales',
        participants=[dict(target=dict(kind='source',id=s['id'],revision=s['revision']),role='participant',label=s['id'],evidence=evidence(s)) for s in sources],
        conditions=[],temporal=dict(eventAt=None,validFrom=None,validTo=None,endOpen=False,evidence=[]),state='active',negated=False,classification='explicit',evidence=evidence(sources[0]))

class CollectiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.sources=[source('alice','Alice revisa el proyecto.'),source('bob','Bob revisa el proyecto.')]
    def call(self,op,**kw):return dispatch(dict(root=str(self.root),scope='s',sources=self.sources,op='collective_'+op,**kw))
    def put(self,key='event-a',d=None,**kw):return self.call('put',id=key,detail=d or detail(self.sources),requestId=kw.pop('requestId',key),**kw)
    def test_distinct_events_same_members_never_pairwise_or_and(self):
        a=self.put();b=self.put('event-b');self.assertNotEqual(a['reference']['id'],b['reference']['id'])
        p=self.call('query');self.assertEqual(len(p['items']),2);self.assertEqual(p['binaryEdges'],[]);self.assertEqual(p['membershipLogic'],'none')
        self.assertTrue(all(r['requiresReview'] and r['validity']=='unknown' for r in p['items']))
    def test_exact_versions_cas_retry_history_and_retirement(self):
        a=self.put();self.assertEqual(self.put()['reference'],a['reference'])
        d=detail(self.sources);d['state']='withdrawn';d['reason']='Interpretación retirada'
        b=self.put(d=d,expectedVersion=1,binding=a['reference'],requestId='v2');self.assertEqual(b['reference']['version'],2)
        with self.assertRaisesRegex(RecordError,'VERSION_CONFLICT'):self.put(d=d,expectedVersion=1,binding=a['reference'],requestId='stale')
        h=self.call('history',id='event-a');self.assertEqual(h[0]['record'],a['record']);self.assertEqual(len(h),2)
        old=self.call('get',id='event-a',knownAt=a['record']['recorded_at']);self.assertEqual(old['reference'],a['reference'])
    def test_scope_missing_and_corrupt_sources_fail_closed(self):
        self.put();self.sources=self.sources[:1]
        self.assertEqual(self.call('query')['outsideSelection'],1)
        with self.assertRaisesRegex(RecordError,'SOURCE_SCOPE_MISMATCH'):self.call('get',id='event-a')
        self.sources=[source('alice','Changed'),source('bob','Bob revisa el proyecto.')]
        with self.assertRaises(RecordError):self.call('get',id='event-a')
    def test_nested_exact_relation_and_target_digest(self):
        a=self.put();d=detail(self.sources);d['participants'][0]['target']=dict(kind='collective',**a['reference'])
        nested=self.put('event-nested',d);self.assertEqual(nested['record']['payload']['collective']['detail']['participants'][0]['target']['version'],1)
        bad=copy.deepcopy(d);bad['participants'][0]['target']['digest']='0'*64
        with self.assertRaisesRegex(RecordError,'TARGET_DIGEST_MISMATCH'):self.put('bad',bad)
        update=detail(self.sources);update['state']='withdrawn';self.put(d=update,expectedVersion=1,binding=a['reference'],requestId='withdraw')
        self.assertEqual(self.call('get',id='event-nested')['reference'],nested['reference'])
    def test_temporal_boundary_negation_and_unknown(self):
        d=detail(self.sources);d['negated']=True;d['temporal']=dict(eventAt='2026-01-01T10:00:00Z',validFrom='2026-01-01T10:00:00Z',validTo='2026-02-01T10:00:00Z',endOpen=False,evidence=d['evidence'])
        self.put(d=d);self.assertEqual(self.call('get',id='event-a',validAt='2026-02-01T10:00:00Z')['validity'],'outside')
        self.assertEqual(self.call('get',id='event-a',validAt='2026-01-02T10:00:00Z')['validity'],'within_declared_interval')
        d['temporal']['validTo']='2026-02-30T10:00:00Z'
        with self.assertRaisesRegex(RecordError,'INVALID_TIME'):self.put('invalid',d)
    def test_pages_bound_to_cut_and_selection_without_loss(self):
        for n in range(6):self.put('event-'+str(n))
        p=self.call('query',limit=2);cut=p['knownAt'];ids=[]
        self.put('later')
        while True:
            ids += [r['reference']['id'] for r in p['items']]
            if p['nextCursor'] is None:break
            p=self.call('query',limit=2,cursor=p['nextCursor']);self.assertEqual(p['knownAt'],cut)
        self.assertEqual(len(ids),6);self.assertEqual(len(set(ids)),6)
        p=self.call('query',limit=1)
        with self.assertRaisesRegex(RecordError,'CURSOR_QUERY_MISMATCH'):self.call('query',question='changed',cursor=p['nextCursor'])
        with self.assertRaisesRegex(RecordError,'EXCEEDS_BUDGET'):self.call('query',maxBytes=4096)
    def test_duplicate_membership_and_invented_quotes_rejected(self):
        d=detail(self.sources);d['participants'][1]=copy.deepcopy(d['participants'][0])
        with self.assertRaisesRegex(RecordError,'DUPLICATE_PARTICIPATION'):self.put(d=d)
        d=detail(self.sources);d['participants'][0]['evidence'][0]['quote']='Fabricated'
        with self.assertRaisesRegex(RecordError,'QUOTE_AMBIGUOUS_OR_MISSING'):self.put(d=d)
    def test_role_filters_large_page_and_time_offset_cut(self):
        for n in range(52):self.put('many-'+str(n))
        p=self.call('query',role='absent');self.assertEqual(p['scanned'],50);self.assertEqual(p['items'],[]);self.assertIsNotNone(p['nextCursor'])
        q=self.call('query',role='absent',cursor=p['nextCursor']);self.assertEqual(q['scanned'],2);self.assertIsNone(q['nextCursor'])
        self.assertEqual(self.call('query',knownAt='2000-01-01T00:00:00-03:00')['items'],[])
    def test_old_version_does_not_require_later_sources_and_roles_match_same_member(self):
        d=detail(self.sources);d['participants'][0]['role']='author';a=self.put(d=d)
        self.assertEqual(self.call('query',targetId='bob',role='author')['items'],[])
        self.sources.append(source('new','New observation.'));d=detail(self.sources);self.put(d=d,expectedVersion=1,binding=a['reference'],requestId='new-source')
        self.sources=self.sources[:2]
        old=self.call('get',id='event-a',version=1);self.assertEqual(old['reference'],a['reference'])
    def test_envelope_tampering_not_reported_as_empty_success(self):
        self.put()
        with closing(sqlite3.connect(self.root/'collectives/records.sqlite3')) as db, db:
            db.execute('DROP TRIGGER records_no_update');db.execute("UPDATE record_versions SET payload_sha256='bad'")
        p=self.call('query');self.assertEqual(p['status'],'incomplete');self.assertEqual(p['items'],[]);self.assertTrue(p['errors'])

if __name__=='__main__':unittest.main()

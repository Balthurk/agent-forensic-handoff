"""New family histories keep source verification, exact versions and known-time cuts."""
import copy,sqlite3,unittest
from contextlib import closing
from datetime import datetime
from unittest.mock import patch
import test_causal as fixture
from afh_semantic.host import dispatch
from afh_semantic.knowledge_records import RecordError

class ExplorerDerivedHistoryTest(unittest.TestCase):
    def setUp(self):
        self.c=fixture.CausalTest('test_competing_arguments_never_choose_or_establish_cause')
        self.c.setUp();self.addCleanup(self.c.doCleanups)
        self.h=self.c.h;self.root=self.c.root;self.sources=self.c.sources
        review=self.h.put('review','review',self.h.review_detail())
        causal=self.c.put()
        self.items={'retrospective':self.h.context,'decision_intelligence':review,'causal_explanation':causal}
        self.payloads={'retrospective':'retrospective','decision_intelligence':'intelligence','causal_explanation':'causal'}
        self.folders={'retrospective':'retrospectives','decision_intelligence':'intelligence','causal_explanation':'causal'}
    def read(self,kind,item=None,**changes):
        item=item or self.items[kind]
        r=dict(root=str(self.root),scope='test',sources=self.sources,op='context_history',target=dict(kind=kind,**item['reference']),knownAt='2090-01-01T00:00:00Z');r.update(changes)
        return dispatch(r)
    def revise(self,kind,previous,reason='Revision',at=None):
        field=self.payloads[kind];d=copy.deepcopy(previous['record']['payload'][field]['detail']);d.update(reason=reason,state='withdrawn')
        args=dict(root=str(self.root),scope='test',sources=self.sources,op={'retrospective':'retrospective_put','decision_intelligence':'intelligence_put','causal_explanation':'causal_put'}[kind],id=previous['reference']['id'],expectedVersion=previous['reference']['version'],binding=previous['reference'],requestId='revision-'+reason,detail=d)
        if kind=='decision_intelligence':args['kind']='review'
        if at:
            moment=datetime.fromisoformat(at.replace('Z','+00:00'))
            class Clock(datetime):
                @classmethod
                def now(cls,tz=None):return moment
            with patch('afh_semantic.knowledge_records.datetime',Clock):return dispatch(args)
        return dispatch(args)
    def test_three_families_return_exact_envelopes_and_withdrawals(self):
        for kind,first in self.items.items():
            with self.subTest(kind=kind):
                second=self.revise(kind,first)
                result=self.read(kind,second)
                self.assertEqual(result['kind'],kind)
                self.assertEqual([x['reference']['version'] for x in result['items']],[1,2])
                self.assertEqual(result['items'][0]['record'],first['record'])
                self.assertEqual(result['items'][-1]['reference'],second['reference'])
                self.assertEqual(result['items'][-1]['record']['payload'][self.payloads[kind]]['detail']['state'],'withdrawn')
    def test_same_timestamp_later_versions_never_enter_the_pinned_chain(self):
        for kind,first in self.items.items():
            with self.subTest(kind=kind):
                second=self.revise(kind,first,at=first['record']['recorded_at'])
                self.assertEqual(second['record']['recorded_at'],first['record']['recorded_at'])
                result=self.read(kind,first)
                self.assertEqual([x['reference'] for x in result['items']],[first['reference']])
                self.assertEqual(len(self.read(kind,second)['items']),2)
    def test_wrong_digest_scope_known_cut_and_invalid_versions_fail_closed(self):
        for kind,item in self.items.items():
            with self.subTest(kind=kind):
                wrong=dict(kind=kind,**item['reference']);wrong['digest']='0'*64
                with self.assertRaisesRegex(RecordError,'EXPLORER_HISTORY_DIGEST'):self.read(kind,target=wrong)
                with self.assertRaises(RecordError):self.read(kind,scope='another-scope')
                with self.assertRaisesRegex(RecordError,'EXPLORER_HISTORY_CUT'):self.read(kind,knownAt='2000-01-01T00:00:00Z')
                for v in (0,101,True):
                    with self.assertRaisesRegex(RecordError,'EXPLORER_HISTORY_VERSION'):self.read(kind,target=dict(kind=kind,**{**item['reference'],'version':v}))
    def test_current_source_selection_is_revalidated_even_for_historical_versions(self):
        for kind in self.items:
            with self.subTest(kind=kind):
                with self.assertRaises(RecordError):self.read(kind,sources=[])
    def test_tampered_envelopes_are_rejected_instead_of_empty_success(self):
        # Corrupt only the family under test; restore its bytes before testing a
        # dependent family, so every assertion discriminates its own store.
        for kind in self.items:
            with self.subTest(kind=kind):
                p=self.root/self.folders[kind]/'records.sqlite3';original=p.read_bytes()
                try:
                    with closing(sqlite3.connect(p)) as db,db:
                        db.execute('DROP TRIGGER records_no_update')
                        db.execute("UPDATE record_versions SET payload_sha256='bad'")
                    with self.assertRaises(RecordError):self.read(kind)
                finally:p.write_bytes(original)
    def test_history_contains_all_thirteen_versions_without_changing_old_reference(self):
        first=self.items['retrospective'];current=first
        for i in range(2,14):current=self.revise('retrospective',current,reason=str(i))
        self.assertEqual([x['reference']['version'] for x in self.read('retrospective',current)['items']],list(range(1,14)))
        self.assertEqual(self.read('retrospective',first)['items'][0]['reference'],first['reference'])

if __name__=='__main__':unittest.main()

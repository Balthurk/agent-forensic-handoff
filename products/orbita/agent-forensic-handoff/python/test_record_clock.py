"""Inclusive wall-time cuts and exact commit/version cuts are separate contracts."""
import copy
import datetime as dt
import unittest
from unittest.mock import patch
import test_semantic as fixtures
from afh_semantic import knowledge_records as records_module
from afh_semantic.host import correct,manifest,query_records

class RecordClockTest(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.SemanticTest('test_known_cut_and_partial_correction_replay')
        self.fixture.setUp()
        self.base=dt.datetime(2026,10,27,8,0,0,123456,tzinfo=dt.timezone.utc)
    def tearDown(self):self.fixture.tearDown()
    def at(self,moment):
        class Clock(dt.datetime):
            @classmethod
            def now(cls,tz=None):return moment.astimezone(tz) if tz else moment.replace(tzinfo=None)
        return patch.object(records_module,'datetime',Clock)
    def original(self):
        with self.at(self.base):return self.fixture.put()
    def correction(self,first,predicate='claims_permission',request_id='clock-correction'):
        payload=copy.deepcopy(first['payload']);clause=payload['semantic_unit']['clauses'][0]
        clause['predicate']['value']=predicate;clause['clause_version_id']='cv-'+request_id
        manifest(payload['semantic_unit'])
        return dict(id=first['id'],scope='scope',expectedVersion=first['version'],payload=payload,requestId=request_id)
    def revise(self,first,moment,**kwargs):
        with self.at(moment):return correct(self.fixture.records,self.correction(first,**kwargs))
    def predicate(self,cut=None):
        request=dict(scope='scope',question='staging')
        if cut is not None:request['knownAt']=cut
        return query_records(self.fixture.records,request)['items'][0]['predicate']
    def counts(self):
        tables=['record_versions','record_envelopes','semantic_act_identity','semantic_clause_identity','semantic_clause_versions','g1_projection_outbox','g1_projection_events']
        return {name:self.fixture.records.db.execute('SELECT count(*) FROM '+name).fetchone()[0] for name in tables}
    def test_equal_times_are_inclusive_and_exact_old_root_remains_accessible(self):
        first=self.original();second=self.revise(first,self.base)
        self.assertEqual(first['recorded_at'],second['recorded_at'])
        self.assertEqual(self.predicate(first['recorded_at']),'claims_permission')
        root=first['payload']['semantic_unit']['clauses'][0]['clause_version_id']
        old=query_records(self.fixture.records,dict(scope='scope',question='',roots=[root]))
        self.assertEqual(old['items'][0]['predicate'],'permits')
        self.assertFalse(old['items'][0]['currentAtCut'])
    def test_three_distinct_observed_ticks_keep_three_historical_cuts(self):
        first=self.original();second=self.revise(first,self.base+dt.timedelta(microseconds=1))
        third=self.revise(second,self.base+dt.timedelta(microseconds=2),predicate='reports_permission',request_id='third')
        self.assertEqual([self.predicate(x['recorded_at']) for x in (first,second,third)],['permits','claims_permission','reports_permission'])
    def test_clock_regression_rolls_back_all_identities_and_allows_explicit_retry(self):
        first=self.original();before=self.counts()
        with self.assertRaisesRegex(records_module.RecordError,'CLOCK_REGRESSION'):
            self.revise(first,self.base-dt.timedelta(microseconds=1))
        self.assertEqual(self.counts(),before)
        second=self.revise(first,self.base)
        self.assertEqual(second['version'],2)
    def test_idempotent_replay_does_not_consult_clock(self):
        first=self.original();request=self.correction(first)
        with self.at(self.base):second=correct(self.fixture.records,request)
        with patch.object(records_module,'datetime') as clock:
            clock.now.side_effect=AssertionError('idempotent replay consulted the clock')
            self.assertEqual(correct(self.fixture.records,request),second)
            clock.now.assert_not_called()
    def test_reopen_preserves_equal_times_and_both_envelopes(self):
        first=self.original();second=self.revise(first,self.base)
        path=self.fixture.records.path;self.fixture.records.close()
        self.fixture.records=records_module.KnowledgeRecords(self.fixture.memory,path)
        self.assertEqual(self.fixture.records.get(first['id'],'scope',version=1),first)
        self.assertEqual(self.fixture.records.get(second['id'],'scope',version=2),second)
        self.assertEqual(self.predicate(first['recorded_at']),'claims_permission')
    def test_rowid_cut_excludes_later_same_timestamp_commit(self):
        first=self.original()
        cut=self.fixture.records.db.execute('SELECT MAX(rowid) FROM record_versions').fetchone()[0]
        second=self.revise(first,self.base)
        old=self.fixture.records.search('staging','scope',as_of=first['recorded_at'],max_rowid=cut)
        current=self.fixture.records.search('staging','scope',as_of=first['recorded_at'])
        self.assertEqual(old,[first]);self.assertEqual(current,[second])
    def test_microsecond_boundary_is_inclusive(self):
        first=self.original();second=self.revise(first,self.base+dt.timedelta(microseconds=1))
        self.assertEqual(self.predicate(first['recorded_at']),'permits')
        self.assertEqual(self.predicate(second['recorded_at']),'claims_permission')
        self.assertEqual(self.fixture.records.search('staging','scope',as_of=(self.base-dt.timedelta(microseconds=1)).isoformat()),[])
    def test_timezone_equivalent_cuts_select_the_same_versions(self):
        first=self.original();second=self.revise(first,self.base+dt.timedelta(microseconds=1))
        offset=dt.timezone(dt.timedelta(hours=2))
        self.assertEqual(self.predicate(self.base.astimezone(offset).isoformat()),'permits')
        self.assertEqual(self.predicate(dt.datetime.fromisoformat(second['recorded_at']).astimezone(offset).isoformat()),'claims_permission')
    def test_utc_day_rollover_uses_observed_times_without_synthesis(self):
        self.base=dt.datetime(2026,10,27,23,59,59,999999,tzinfo=dt.timezone.utc)
        first=self.original();next_day=self.base+dt.timedelta(microseconds=1)
        second=self.revise(first,next_day)
        self.assertEqual(second['recorded_at'],next_day.isoformat(timespec='microseconds'))
        self.assertEqual(self.predicate(first['recorded_at']),'permits')

if __name__=='__main__':unittest.main()

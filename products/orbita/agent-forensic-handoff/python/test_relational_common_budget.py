"""Real common-store relational queries and fail-closed resource bounds."""
import copy
import json
import time
import unittest
import psycopg
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

from common_test_fixture import WorkspaceFixture
from orbita_store.paths import Path
from afh_semantic.host import AFHMemory
from afh_semantic.knowledge_records import KnowledgeRecords, RecordError, approval_statement
from afh_semantic.relational_memory import RelationalMemory
from afh_semantic.relational_budget import Budget, Limit, read_scope
from test_semantic import source


def unknown(kind='unknown'):
    return dict(kind=kind, value=None, precision='unknown', timezone=None)


class RelationalCommonBudget(unittest.TestCase):
    def setUp(self):
        self.fixture = WorkspaceFixture(self._testMethodName)
        self.root = Path(self.fixture.name)
        self.sources = [source('s1', 'Ana permite una prueba á😀.'), source('s2', 'Luis revisa la prueba.')]
        self.memory = AFHMemory(self.root, self.sources, 'scope', register=True)
        self.records = KnowledgeRecords(self.memory, self.root/'records.pgstore')
        self.relations = RelationalMemory(self.records)
        self.extra = []

    def tearDown(self):
        for item in reversed(self.extra): item.close()
        self.records.close(); self.memory.close(); self.fixture.cleanup()

    def payload(self, ident='a', text='Ana', source_index=0):
        s = self.sources[source_index]
        return dict(id=ident, scope='scope', type='fact', text=text,
            actor=dict(id='producer', role='agent'), modality='assertion',
            status='proposed', negated=False, conditions=[], contradicts=[],
            source_refs=[dict(id=s['id'], revision=s['revision'])],
            graph=dict(kind='entity', entity_type='person', classification='explicit'),
            temporal=dict(valid_from=unknown('unbounded'), valid_to=unknown('open'), event_at=unknown()))

    def put(self, ident='a', **changes):
        p = self.payload(ident); p.update(changes)
        return self.relations.put(p, expected_version=0, request_id='put-'+ident)

    def test_get_history_context_use_real_common_store(self):
        a = self.put()
        self.assertEqual(self.relations.get('a', 'scope')['version'], 1)
        self.assertEqual(self.relations.history('a', 'scope')[0]['recorded_at'], a['recorded_at'])
        packet = self.relations.context('scope')
        self.assertEqual(packet['status'], 'records_found')
        self.assertEqual([r['id'] for r in packet['records']], ['a'])
        self.assertFalse(self.records.db.in_transaction)
        self.assertFalse(self.memory.db.in_transaction)

    def error(self, code, call):
        with self.assertRaisesRegex(RecordError, code): call()

    def assert_clean(self):
        for db in (self.records.db, self.memory.db):
            self.assertFalse(db.in_transaction)
            self.assertIsNone(getattr(db, '_read_budget_check', None))
            self.assertEqual(db.raw.execute('SHOW statement_timeout').fetchone()[0], '55s')
            self.assertEqual(db.raw.execute('SELECT 1').fetchone(), (1,))

    def test_exact_source_bytes_revision_scope_and_no_sqlite_fallback(self):
        self.put(); s=self.sources[0]
        self.assertEqual(self.memory.source_size(s['id'],s['revision'],'scope'),len(s['text'].encode('utf8')))
        self.assertIsNone(self.memory.source_size(s['id'],'wrong','scope'))
        self.assertIsNone(self.memory.source_size(s['id'],s['revision'],'foreign'))
        with patch('sqlite3.connect', side_effect=AssertionError('No operational SQLite')):
            self.assertEqual(self.relations.get('a','scope')['id'],'a')
        self.memory.sources[s['id']]['text']+='tampered'
        self.error('AFH_TEXT_HASH',lambda:self.relations.get('a','scope'))

    def test_old_steps_are_explicitly_rejected_and_other_bounds_retained(self):
        self.error('SQL_STEP_BUDGET_UNSUPPORTED',lambda:self.relations.context('scope',budget={'max_sql_steps':300000}))
        for value in ({'max_query_ms':True},{'max_query_ms':50001},{'max_rows':20001},{'max_context_bytes':2047},{'unknown':1}):
            with self.subTest(value=value):self.error('INVALID_BUDGET',lambda:self.relations.context('scope',budget=value))
        packet=self.relations.context('scope')
        self.assertNotIn('max_sql_steps',packet['budget']['limits'])
        self.assertEqual(packet['budget']['limits']['max_query_ms'],5000)

    def test_rows_fail_closed_across_get_history_and_context(self):
        a=self.put();p=copy.deepcopy(a['payload']);p['text']='corrected'
        self.relations.put(p,expected_version=1,request_id='correction')
        for call in (self.relations.get,self.relations.history):
            self.error('QUERY_BUDGET_EXCEEDED: rows',lambda:call('a','scope',budget={'max_rows':1}))
        packet=self.relations.context('scope',budget={'max_rows':1})
        self.assertEqual((packet['status'],packet['records'],packet['paths']),('budget_exceeded',[],[]))
        self.assertEqual(packet['omissions'][0]['reason'],'budget_rows');self.assert_clean()

    def test_input_size_is_charged_before_payload_or_envelope(self):
        self.put()
        with patch.object(self.records,'_envelope',side_effect=AssertionError('Payload must not load')):
            packet=self.relations.context('scope',budget={'max_input_bytes':1})
        self.assertEqual(packet['omissions'][0]['reason'],'budget_input_bytes')
        self.assertEqual(packet['records'],[]);self.assert_clean()

    def test_source_budget_precedes_evidence_and_unique_sources_share_it(self):
        self.put();self.put('b')
        packet=self.relations.context('scope',budget={'max_sources':1})
        self.assertEqual(packet['status'],'records_found');self.assertEqual(packet['budget']['used']['sources'],1)
        with patch.object(self.memory,'evidence',side_effect=AssertionError('Evidence must not load')):
            packet=self.relations.context('scope',budget={'max_source_bytes':1})
        self.assertEqual(packet['omissions'][0]['reason'],'budget_source_bytes')
        self.assertEqual(packet['records'],[])

    def test_approval_evidence_uses_the_same_source_budget(self):
        p=self.payload();p['status']='approved';p['actor']={'id':'declared-user','role':'user'}
        quote=approval_statement(p);s=source('approval',quote)
        self.memory.close();self.memory=AFHMemory(self.root,self.sources+[s],'scope',register=True)
        self.records.memory=self.memory
        p['approval']={'source_ref':{'id':s['id'],'revision':s['revision']},'quote':quote}
        self.relations.put(p,expected_version=0,request_id='approved')
        self.assertEqual(self.relations.get('a','scope')['payload']['status'],'approved')
        packet=self.relations.context('scope',budget={'max_sources':1})
        self.assertEqual(packet['omissions'][0]['reason'],'budget_sources');self.assertEqual(packet['records'],[])

    def test_corrupted_envelope_is_an_error_not_an_empty_or_partial_packet(self):
        self.put();self.fixture.corrupt(self.records.db,'record_envelopes',{'digest':'broken'})
        for call in (lambda:self.relations.get('a','scope'),lambda:self.relations.history('a','scope'),lambda:self.relations.context('scope')):
            self.error('RECORD_CORRUPT',call)
        self.assert_clean()

    def test_nanosecond_known_cut_and_exclusive_valid_to_are_preserved(self):
        at=datetime(2026,10,31,1,tzinfo=timezone.utc)
        with patch('afh_semantic.knowledge_records.datetime') as clock:
            clock.now.side_effect=[at,at+timedelta(microseconds=1)]
            a=self.put();p=copy.deepcopy(a['payload']);p['text']='new'
            p['temporal']['valid_to']={'kind':'known','value':'2027-01-01T00:00:00Z','precision':'s','timezone':'Z'}
            self.relations.put(p,expected_version=1,request_id='later')
        self.assertEqual(self.relations.get('a','scope',known_at='2026-10-31T01:00:00.000000999Z')['version'],1)
        self.assertEqual(self.relations.get('a','scope',known_at='2026-10-31T01:00:00.000001000Z')['version'],2)
        self.assertEqual(self.relations.get('a','scope',valid_at='2026-12-31T23:59:59.999999999Z')['version'],2)
        self.error('NOT_FOUND',lambda:self.relations.get('a','scope',valid_at='2027-01-01T00:00:00Z'))

    def test_paths_keep_negative_parallel_and_cycle_claims_without_causality(self):
        self.put('a');self.put('b',text='Luis')
        for ident,subject,obj,negated in [('e1','a','b',False),('e2','a','b',True),('e3','b','a',False)]:
            self.put(ident,graph=dict(kind='relation',subject=subject,object=obj,predicate='reviews',classification='explicit'),negated=negated)
        packet=self.relations.context('scope',roots=['a'],max_hops=2)
        self.assertEqual(set(r['id'] for r in packet['records']),{'a','b','e1','e2','e3'})
        self.assertTrue(any(p['cycle_closure'] for p in packet['paths']))
        self.assertTrue(any(c['negated'] for p in packet['paths'] for c in p['claims']))
        self.assertTrue(all(p['interpretation']=='connections_between_recorded_claims' and not p['conditions_evaluated'] for p in packet['paths']))
        for key in ('max_edges','max_nodes'):
            p=self.relations.context('scope',roots=['a'],budget={key:1})
            self.assertEqual(p['status'],'budget_exceeded');self.assertEqual(p['records'],[])

    def test_query_and_context_bytes_fail_without_partial_selection(self):
        self.put(text='Ána '*600)
        packet=self.relations.context('scope',query='ána',budget={'max_work':10})
        self.assertEqual(packet['status'],'budget_exceeded');self.assertEqual(packet['selection']['roots'],[])
        packet=self.relations.context('scope',budget={'max_context_bytes':2048})
        self.assertEqual(packet['status'],'budget_exceeded');self.assertEqual(packet['records'],[])
        self.assertLessEqual(len(json.dumps(packet,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()),2048)

    def test_acquisition_deadline_cancels_actual_server_and_keeps_same_connections(self):
        self.put();original=self.relations._acquire
        pids=[db.raw.info.backend_pid for db in (self.records.db,self.memory.db)]
        def slow(*args,**kwargs):
            self.records.db.execute('SELECT pg_sleep(4)').fetchone()
            return original(*args,**kwargs)
        start=time.monotonic()
        with patch.object(self.relations,'_acquire',slow):
            packet=self.relations.context('scope',budget={'max_query_ms':150})
        self.assertEqual(packet['status'],'budget_exceeded');self.assertEqual(packet['omissions'][0]['reason'],'budget_query_ms')
        self.assertLess(time.monotonic()-start,2);self.assert_clean()
        self.assertEqual([db.raw.info.backend_pid for db in (self.records.db,self.memory.db)],pids)
        self.assertEqual(self.relations.get('a','scope')['id'],'a')

    def test_wrapped_evidence_cancellation_is_our_deadline_not_partial_success(self):
        self.put();evidence=self.memory.evidence
        def slow(ident):
            self.memory.db.execute('SELECT pg_sleep(4)').fetchone()
            return evidence(ident)
        start=time.monotonic()
        with patch.object(self.memory,'evidence',slow):
            self.error('QUERY_BUDGET_EXCEEDED: query_ms',lambda:self.relations.get('a','scope',budget={'max_query_ms':150}))
        self.assertLess(time.monotonic()-start,2);self.assert_clean()

    def test_cpu_work_and_point_history_also_obey_the_shared_deadline(self):
        self.put();original=self.relations._acquire
        def slow(*args,**kwargs):
            rows=original(*args,**kwargs)
            until=time.monotonic()+.06
            while time.monotonic()<until: pass
            return rows
        for call in (self.relations.get,self.relations.history):
            with patch.object(self.relations,'_acquire',slow):
                self.error('QUERY_BUDGET_EXCEEDED: query_ms',lambda:call('a','scope',budget={'max_query_ms':40}))
        self.assert_clean()

    def test_stricter_server_timeout_and_unrelated_source_errors_are_not_budget_pass(self):
        self.put();self.records.db.raw.execute("SET statement_timeout='30ms'")
        acquire=self.relations._acquire
        def slow(*args,**kwargs):
            self.records.db.execute('SELECT pg_sleep(4)').fetchone()
            return acquire(*args,**kwargs)
        try:
            with patch.object(self.relations,'_acquire',slow), self.assertRaises(psycopg.errors.QueryCanceled):
                self.relations.context('scope')
            self.assertEqual(self.records.db.raw.execute('SHOW statement_timeout').fetchone()[0],'30ms')
        finally:self.records.db.raw.execute("SET statement_timeout='55s'")
        with patch.object(self.memory,'evidence',side_effect=ValueError('distinct source failure')):
            self.error('SOURCE_UNAVAILABLE',lambda:self.relations.context('scope'))
        self.assert_clean()

    def test_existing_caller_transactions_are_rejected_without_rollback(self):
        self.put()
        for db in (self.records.db,self.memory.db):
            db.execute('BEGIN')
            try:
                self.error('RELATIONAL_OWNED_READ_REQUIRED',lambda:self.relations.context('scope'))
                self.assertTrue(db.in_transaction)
                self.assertEqual(db.raw.execute('SHOW transaction_isolation').fetchone()[0],'read committed')
            finally:db.rollback()
        self.assert_clean()

    def test_read_scope_uses_one_snapshot_and_rejects_writes_on_both(self):
        self.put()
        with read_scope(self.records,Budget(None)):
            snapshots=[db.raw.execute('SELECT pg_current_snapshot()::text').fetchone()[0] for db in (self.records.db,self.memory.db)]
            self.assertEqual(snapshots[0],snapshots[1])
            for db in (self.records.db,self.memory.db):
                self.assertEqual(db.raw.execute('SHOW transaction_read_only').fetchone()[0],'on')
                with self.assertRaises(psycopg.errors.ReadOnlySqlTransaction),db.raw.transaction():
                    db.raw.execute('UPDATE orbita_semantic.record_versions SET payload=payload')
        self.assert_clean()

    def test_concurrent_correction_cannot_change_the_acquired_revision(self):
        self.put();other=KnowledgeRecords(self.memory,self.root/'records.pgstore');self.extra.append(other)
        envelope=self.records._envelope;done=[]
        def concurrent(row,**kwargs):
            if not done:
                p=self.payload();p['text']='changed while reading'
                other.put(p,expected_version=1,request_id='concurrent');done.append(True)
            return envelope(row,**kwargs)
        with patch.object(self.records,'_envelope',concurrent):
            packet=self.relations.context('scope')
        self.assertEqual([r['version'] for r in packet['records']],[1])
        self.assertEqual(self.relations.get('a','scope')['version'],2);self.assert_clean()

    def test_foreign_source_workspace_is_rejected_before_any_transaction(self):
        self.put();foreign=WorkspaceFixture('foreign-authority')
        memory=AFHMemory(Path(foreign.name),self.sources,'scope',register=True)
        prior=self.records.memory;self.records.memory=memory
        try:
            self.error('RELATIONAL_AUTHORITY_MISMATCH',lambda:self.relations.context('scope'))
            self.assertFalse(memory.db.in_transaction);self.assertFalse(self.records.db.in_transaction)
        finally:self.records.memory=prior;memory.close();foreign.cleanup()

    def test_contradictions_do_not_expose_future_or_unselected_targets(self):
        at=datetime(2026,10,31,3,tzinfo=timezone.utc)
        with patch('afh_semantic.knowledge_records.datetime') as clock:
            clock.now.side_effect=[at,at+timedelta(microseconds=1),at+timedelta(microseconds=2)]
            # A contradiction must point to an already admitted record. Its
            # future correction must not make an ineligible old target visible.
            temporal=copy.deepcopy(self.payload()['temporal'])
            temporal['valid_from']={'kind':'known','value':'2027-01-01T00:00:00Z','precision':'s','timezone':'Z'}
            b=self.put('b',temporal=temporal);a=self.put(contradicts=['b'])
            corrected=copy.deepcopy(b['payload']);corrected['temporal']['valid_from']=unknown('unbounded')
            self.relations.put(corrected,expected_version=1,request_id='target-correction')
        past=self.relations.get('a','scope',known_at=a['recorded_at'],valid_at='2026-11-01T00:00:00Z')
        self.assertEqual(past['payload']['contradicts'],[]);self.assertEqual(past['contradictions_omitted'],1)
        self.assertEqual(self.relations.get('a','scope')['payload']['contradicts'],['b'])
        self.error('NOT_FOUND',lambda:self.relations.get('b','scope',known_at=a['recorded_at'],valid_at='2026-11-01T00:00:00Z'))
        self.assertEqual(self.relations.get('b','scope',valid_at='2026-11-01T00:00:00Z')['version'],2)

    def test_source_registry_is_rechecked_when_memory_is_reused(self):
        self.put()
        self.assertEqual(self.relations.get('a','scope')['id'],'a')
        # The shared memory object has already looked up this binding. A new
        # complete read must verify its current registry inside its snapshot.
        self.fixture.corrupt(self.memory.db,'source_bindings',{'digest':'broken'})
        self.error('SOURCE_UNAVAILABLE',lambda:self.relations.get('a','scope'))
        self.assert_clean()


if __name__ == '__main__': unittest.main(verbosity=2)

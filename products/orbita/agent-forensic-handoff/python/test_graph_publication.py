import unittest,copy,json,sqlite3,sys,os,subprocess
from pathlib import Path
from unittest.mock import patch
import test_semantic as fixture
from afh_semantic.host import correct,manifest
from afh_semantic.graph_publication import dispatch_graph,plan,publish,Projection,latest,digest
from afh_semantic.knowledge_records import RecordError

class GraphTest(unittest.TestCase):
    def setUp(self):self.f=fixture.SemanticTest();self.f.setUp();self.r=self.f.records
    def tearDown(self):self.f.tearDown()
    def op(self,op,**kw):return dispatch_graph(self.r,{'op':'graph_'+op,'scope':'scope',**kw})
    def put(self,i=0):self.f.put(i);return latest(self.r,'scope')['outbox_id']
    def publish(self,oid):return self.op('publish',outboxId=oid)
    def query(self,r,**kw):return self.op('query',generation=r['generation'],sourceCut=r['sourceCut'],**kw)
    def error(self,code,fn):
        with self.assertRaisesRegex(RecordError,code):fn()
    def test_exact_members_and_retained_clauses(self):
        oid=self.put();self.put(1);oid=latest(self.r,'scope')['outbox_id'];r=self.publish(oid);q=self.query(r)
        self.assertEqual(r['members'],2);self.assertEqual(len(q['items']),2);self.assertEqual(r['vertices'],4);self.assertTrue(q['requiresAbstention']);self.assertFalse(q['policy']['executionAuthority'])
        for item in q['items']:self.assertEqual(item['record'],self.r.get(item['record']['id'],'scope',version=item['record']['version']))
    def test_n04_commit_is_pending_until_verified_publication(self):
        oid=self.put();self.assertEqual(self.op('status')['entries'][0]['state'],'planned')
        self.error('CURRENT_PROJECTION_PENDING',lambda:self.op('query',generation=plan(self.r,oid)['generation'],sourceCut='cut-1'))
        r=self.publish(oid);self.assertEqual(self.query(r)['receipt']['readbackHash'],r['readbackHash'])
    def test_replay_old_generation_never_rolls_back(self):
        first=self.put();r1=self.publish(first);at=self.query(r1)['selectedAt'];second=self.put(1);r2=self.publish(second)
        self.assertTrue(self.publish(first)['replayed']);self.error('CURRENT_GENERATION',lambda:self.query(r1))
        self.assertEqual(len(self.query(r1,mode='system_history',knownAt=at)['items']),1);self.assertEqual(len(self.query(r2)['items']),2)
    def test_correction_pending_then_exact_history(self):
        oid=self.put();r=self.publish(oid);old=self.query(r);p=copy.deepcopy(old['items'][0]['record']['payload']);p['semantic_unit']['clauses'][0]['predicate']['value']='different';p['semantic_unit']['clauses'][0]['clause_version_id']='cv-corrected';manifest(p['semantic_unit'])
        correct(self.r,{'id':p['id'],'scope':'scope','expectedVersion':1,'payload':p,'requestId':'correction'})
        self.error('CURRENT_PROJECTION_PENDING',lambda:self.query(r));hist=self.query(r,mode='system_history',knownAt=old['selectedAt']);self.assertEqual(hist['items'],old['items']);r2=self.publish(latest(self.r,'scope')['outbox_id']);self.assertEqual(self.query(r2)['items'][0]['record']['version'],2)
    def test_equal_timestamps_do_not_admit_future_or_select_old(self):
        from datetime import datetime,timezone
        class Clock:
            @staticmethod
            def now(zone):return datetime(2026,10,1,tzinfo=timezone.utc)
        with patch('afh_semantic.knowledge_records.datetime',Clock):first=self.put();p=plan(self.r,first);second=self.put(1)
        self.assertEqual(plan(self.r,first),p);r=self.publish(second);self.assertEqual(latest(self.r,'scope')['outbox_id'],second);self.error('SUPERSEDED',lambda:self.publish(first));self.assertEqual(len(self.query(r)['items']),2)
    def test_corrupt_objects_marker_and_receipt_fail_closed(self):
        oid=self.put();r=self.publish(oid);g=Projection(self.r,write=True)
        row=g.db.execute('SELECT kind,key,payload FROM objects LIMIT 1').fetchone();g.db.execute('UPDATE objects SET payload=? WHERE kind=? AND key=?',('{}',row[0],row[1]));g.db.commit();self.error('READBACK_MISMATCH',lambda:self.query(r));g.db.execute('UPDATE objects SET payload=? WHERE kind=? AND key=?',(row[2],row[0],row[1]));g.db.commit()
        g.db.execute("UPDATE markers SET plan_hash='bad'");g.db.commit();self.error('MARKER_MISMATCH',lambda:self.query(r));g.db.execute('UPDATE markers SET plan_hash=?',(digest(plan(self.r,oid)),));g.db.commit();g.close()
        path=self.r.path.parent/'graph-publications'/(r['generation']+'.receipt.json');path.write_text('{}');self.error('RECEIPT_OR_PLAN_MISMATCH',lambda:self.query(r))
    def test_extra_readback_object_is_rejected(self):
        r=self.publish(self.put());g=Projection(self.r,write=True);g.db.execute('INSERT INTO objects VALUES(?,?,?,?)',(r['generation'],'clause','invented','{}'));g.db.commit();g.close();self.error('READBACK_MISMATCH',lambda:self.query(r))
    def test_scope_cut_future_and_unknown_zone_rejected(self):
        r=self.publish(self.put());self.error('SCOPE_MISMATCH',lambda:dispatch_graph(self.r,{'op':'graph_publish','scope':'other','outboxId':r['outboxId']}));self.error('CURRENT_CUT',lambda:self.op('query',generation=r['generation'],sourceCut='wrong'))
        self.error('HISTORY_NOT_AVAILABLE',lambda:self.query(r,mode='system_history',knownAt='2000-01-01T00:00:00Z'));self.error('INVALID_TIME',lambda:self.query(r,mode='system_history',knownAt='2026-10-25T01:00:00-00:00'));self.error('VALID_AT',lambda:self.query(r,validAt='2026-01-01T00:00:00Z'))
    def test_removed_source_stays_denied_in_history(self):
        r=self.publish(self.put());at=self.query(r)['selectedAt'];self.f.memory.sources.pop('rep-a');self.error('SOURCE_SCOPE',lambda:self.query(r,mode='system_history',knownAt=at));self.assertEqual(self.op('status')['entries'],[])
    def test_missing_relation_target_is_explicit(self):
        self.f.linked(target='missing-exact-version');r=self.publish(latest(self.r,'scope')['outbox_id']);q=self.query(r);missing=[m for i in q['items'] for m in i['missingTargets']];self.assertEqual(len(missing),1);self.assertEqual(missing[0]['targetClauseVersionId'],'missing-exact-version');self.assertTrue(q['requiresAbstention'])
    def test_relations_keep_counterclaim_and_literal_sources(self):
        a,b=self.f.linked(kind='retracts');r=self.publish(latest(self.r,'scope')['outbox_id']);q=self.query(r);edges=[e for i in q['items'] for e in i['relations']];self.assertEqual({e['value']['kind'] for e in edges},{'retracts'});self.assertEqual(len(q['items']),2)
        sid=a['payload']['source_refs'][0]['id'];original=self.op('original',generation=r['generation'],sourceCut=r['sourceCut'],recordId=a['id'],sourceId=sid);self.assertEqual(original['source']['text'],self.f.sources[0]['text'])
    def test_whole_member_byte_budget_never_truncates_clause(self):
        r=self.publish(self.put());small=self.query(r,maxBytes=4096);self.assertEqual(small['items'],[]);self.assertEqual(len(small['omissions']),1);self.assertEqual(len(self.query(r,maxBytes=100000)['items']),1)
    def test_member_cap_abstains_before_projection(self):
        oid=self.put();self.put(1)
        with patch('afh_semantic.graph_publication.MAX_MEMBERS',1):self.error('COVERAGE_LIMIT',lambda:self.publish(latest(self.r,'scope')['outbox_id']))
        self.assertEqual(self.r.g1_outbox_entry(oid)['state'],'planned');self.assertFalse((self.r.path.parent/'graph-publications').exists())
    def test_remote_backend_never_silently_falls_back(self):
        oid=self.put();self.error('REMOTE_BACKEND_NOT_QUALIFIED',lambda:self.op('publish',outboxId=oid,backend='janusgraph'));self.assertEqual(self.r.g1_outbox_entry(oid)['state'],'planned')
    def test_stale_fence_cannot_advance_or_select(self):
        first=self.put();p1=plan(self.r,first);e1=self.r.begin_g1_projection(first,p1['generation']);second=self.put(1);p2=plan(self.r,second);self.r.begin_g1_projection(second,p2['generation'])
        self.error('FENCE_OR_STATE_STALE',lambda:self.r.advance_g1_projection(first,expected_state='upserting',state='counts_verified',generation_id=p1['generation'],fence_token=e1['fence_token']))
    def test_different_cut_requires_history(self):
        r1=self.publish(self.put());q1=self.query(r1);p=self.f.payload(1);p['semantic_unit']['context_cut']['source_cut']='cut-2';self.r.put(p,expected_version=0,request_id='other-cut');r2=self.publish(latest(self.r,'scope')['outbox_id']);self.error('CURRENT_CUT',lambda:self.query(r1));self.assertEqual(len(self.query(r2)['items']),1);self.assertEqual(self.query(r1,mode='system_history',knownAt=q1['selectedAt'])['items'],q1['items'])

if __name__=='__main__':unittest.main()

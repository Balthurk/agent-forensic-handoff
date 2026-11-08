"""C02/C03 experiments on isolated synthetic PostgreSQL workspaces.

No application imports this script. Page proof is deliberately a subset proof;
it is never labelled a full-graph readback. Digest memoization caches a pure
calculation only, not validation or authority. All results include raw samples.
"""
import argparse,collections,contextlib,copy,hashlib,json,statistics,sys,time,tracemalloc,unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[3]
sys.path[:0]=[str(ROOT/'app'),str(ROOT/'agent-forensic-handoff/python')]
from common_test_fixture import WorkspaceFixture
from orbita_store.paths import Path as StorePath
from orbita_store.connection import Connection as CommonConnection
from orbita_store.pool import close_idle
from afh_semantic.common_backend import Connection
from afh_semantic.host import AFHMemory,compile_act,manifest,query_records
from afh_semantic.knowledge_records import KnowledgeRecords,RecordError,_json
from afh_semantic.graph_mirror import CommonGraph,binding,MEMBERS,READ_BATCH
from afh_semantic.graph_publication import dispatch_graph,latest,plan,digest,require
from afh_semantic.graph_snapshot import source_snapshot,import_snapshot
from test_semantic import source,SemanticTest

FIELDS=('record_id','scope','version','recorded_at','payload','payload_sha256','request_id','request_sha256')
DIGEST=KnowledgeRecords._envelope_digest

class PureMemo:
    def __init__(self,enabled):
        self.enabled=enabled;self.cache={};self.bytes=0;self.peak=0;self.calls=0;self.hits=0;self.computed=0
    def __call__(self,row):
        self.calls+=1
        key=tuple(row[k] for k in FIELDS)
        if self.enabled and key in self.cache:self.hits+=1;return self.cache[key]
        self.computed+=1;value=DIGEST(row)
        # Conservative retained-object size, not just encoded payload length.
        size=sys.getsizeof(key)+sum(sys.getsizeof(x) for x in key)+sys.getsizeof(value)+128
        if self.enabled and len(self.cache)<256 and self.bytes+size<=1024**2:
            self.cache[key]=value;self.bytes+=size;self.peak=max(self.peak,self.bytes)
        return value
    def stats(self):return dict(calls=self.calls,hits=self.hits,computed=self.computed,entries=len(self.cache),retainedAccountedBytes=self.bytes,peakAccountedBytes=self.peak)
    def clear(self):self.cache.clear();self.bytes=0

@contextlib.contextmanager
def memo_context(enabled):
    memo=PureMemo(enabled)
    try:
        with patch.object(KnowledgeRecords,'_envelope_digest',staticmethod(memo)):yield memo
    finally:
        memo.clear();assert not memo.cache and memo.bytes==0

@contextlib.contextmanager
def counters():
    data=dict(applicationCalls=0,commonExecuteCalls=0,logicalGraphResponseBytes=0,statements=collections.Counter())
    application=Connection.execute;common=CommonConnection.execute;request=CommonGraph._request
    def countapp(db,sql,parameters=()):
        data['applicationCalls']+=1;data['statements'][' '.join(sql.split())]+=1
        return application(db,sql,parameters)
    def countcommon(db,*args,**kw):data['commonExecuteCalls']+=1;return common(db,*args,**kw)
    def countrequest(client,*args,**kw):
        value=request(client,*args,**kw);data['logicalGraphResponseBytes']+=len(_json(value).encode());return value
    with patch.object(Connection,'execute',countapp),patch.object(CommonConnection,'execute',countcommon),patch.object(CommonGraph,'_request',countrequest):yield data

def timed(fn):
    with counters() as data:
        cpu=time.process_time();start=time.perf_counter();value=fn();seconds=time.perf_counter()-start;cpu=time.process_time()-cpu
    return value,dict(seconds=seconds,clientCpuSeconds=cpu,**data)

def page_proof(client,p,page_ids):
    expected=client.expected(p,True);objects={v['key']:v for v in p['vertices']+p['edges']}
    acts={v['key'] for v in p['vertices'] if v['kind']=='act' and v['value']['id'] in page_ids}
    clauses={v['key'] for v in p['vertices'] if v['kind']=='clause' and v['value']['recordId'] in page_ids}
    keys=acts|clauses|{v['key'] for v in p['edges'] if v['from'] in acts and v['to'] in clauses}|{'marker'}
    wanted=[r for r in expected if r['key'] in keys];assert wanted and len(wanted)<len(expected)
    identities=[];results=[];members=[]
    def one(db):
        before=client._request(db,MEMBERS,dict(group=client.group(p),maximum=len(expected)+2))
        require([r['uid'] for r in before]==[r['uid'] for r in expected],'PAGE_MEMBERSHIP_MISMATCH')
        native={r['uid']:r['id'] for r in before};rows=[]
        for start in range(0,len(wanted),150):
            batch=wanted[start:start+150]
            actual=client._request(db,READ_BATCH,dict(group=client.group(p),nativeIds=[native[r['uid']] for r in batch],maxLinks=sum(len(r['links'])+len(r['incoming']) for r in batch)))
            require(actual==batch,'PAGE_READBACK_MISMATCH');rows.extend(actual)
        require(client._request(db,MEMBERS,dict(group=client.group(p),maximum=len(expected)+2))==before,'PAGE_MEMBERSHIP_CHANGED')
        members.append(before);results.append(digest(rows))
        identities.append(dict(pid=db.raw.info.backend_pid,snapshot=db.raw.execute('SELECT pg_current_snapshot()::text').fetchone()[0]))
    with contextlib.ExitStack() as stack:
        readers=[stack.enter_context(contextlib.closing(client.connection())) for _ in range(2)]
        readers[0].raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        snapshot=readers[0].raw.execute('SELECT pg_export_snapshot()').fetchone()[0];import_snapshot(readers[1],snapshot)
        one(readers[0]);one(readers[1])
        fresh=stack.enter_context(contextlib.closing(client.connection()));fresh.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');one(fresh)
        assert len({x['pid'] for x in identities})==3 and identities[0]['snapshot']==identities[1]['snapshot']
        require(members[0]==members[1]==members[2] and len(set(results))==1,'PAGE_READERS_DIVERGED')
    return dict(subsetHash=results[0],subsetObjects=len(wanted),membershipObjects=len(expected),readers=identities,wholeGraphProof=False)

def rejected(fn):
    try:fn();return dict(rejected=False,error=None)
    except RecordError as error:return dict(rejected=True,error=str(error))

def graph_case(count):
    fixture=WorkspaceFixture('i10-graph-'+str(count));memory=records=None
    try:
        root=StorePath(fixture.name)/'data/semantic'
        sources=[source('s'+str(i),'Synthetic original rule '+str(i)+': retain exact evidence.','c'+str(i)) for i in range(count)]
        memory=AFHMemory(root,sources,'scope',register=True);records=KnowledgeRecords(memory,root/'records.pgstore')
        for i,s in enumerate(sources):
            act=dict(key='r'+str(i),targetSourceId=s['id'],type='policy',summary=s['text'],modality='directive',clauses=[dict(key='c',quote=s['text'],predicate='retains',polarity='positive',resolution='resolved',arguments=[],conditions=[],temporal=[],relations=[])])
            records.put(compile_act(memory,act,'i10-synthetic','cut'),expected_version=0,request_id='put'+str(i))
        outbox=latest(records,'scope')['outbox_id']
        publication,publish_stats=timed(lambda:dispatch_graph(records,dict(op='graph_publish',scope='scope',backend='postgresql-verified',outboxId=outbox)))
        p=plan(records,outbox);client=CommonGraph(binding(records));all_ids=sorted(v['value']['id'] for v in p['vertices'] if v['kind']=='act');page_ids=set(all_ids[:10])
        client.verify(p);page_proof(client,p,page_ids)
        samples=[]
        for i in range(3):
            for mode in (('full','page') if i%2==0 else ('page','full')):
                value,stats=timed(lambda:client.verify(p) if mode=='full' else page_proof(client,p,page_ids))
                samples.append(dict(mode=mode,repeat=i,**stats,proof=value))
        adversaries=[]
        for label,record_id in [('on_page',all_ids[0]),('off_page',all_ids[-1])]:
            target=next(v for v in p['vertices'] if v['kind']=='act' and v['value']['id']==record_id)
            uid=next(v['uid'] for v in client.objects(p) if v['key']==target['key'])
            with contextlib.closing(client.connection(write=True)) as writer:
                row=writer.execute('SELECT rowid,payload FROM objects WHERE uid=?',(uid,)).fetchone();assert row
                fixture.corrupt(writer,'objects',dict(payload='{}'),where_rowid=row[0])
                try:
                    full=rejected(lambda:client.verify(p));page=rejected(lambda:page_proof(client,p,page_ids))
                    assert full['rejected']
                    adversaries.append(dict(case=label,current=full,prototype=page))
                finally:fixture.corrupt(writer,'objects',dict(payload=row[1]),where_rowid=row[0])
            client.verify(p)
        return dict(members=count,objects=len(client.expected(p,True)),publication=publish_stats,pageMembers=10,samples=samples,adversaries=adversaries,restoredConsumer=True)
    finally:
        if records:records.close()
        if memory:memory.close()
        close_idle();fixture.cleanup()

def history_case(count):
    fixture=SemanticTest('test_cas_idempotency_unknown_fields');fixture.setUp();memory=records=None
    try:
        first=fixture.put(0);head=first
        for version in range(2,count+1):
            payload=copy.deepcopy(head['payload']);clause=payload['semantic_unit']['clauses'][0];clause['predicate']['value']='permits_'+str(version);clause['clause_version_id']='cv-history-'+str(version);manifest(payload['semantic_unit'])
            head=fixture.records.put(payload,expected_version=version-1,request_id='version-'+str(version))
        for branch in (1,2):
            payload=fixture.payload(branch);clause=payload['semantic_unit']['clauses'][0]
            clause['relations']=[dict(kind='retracts',direction='outgoing',status='candidate',target_clause_version_id=first['payload']['semantic_unit']['clauses'][0]['clause_version_id'],evidence_keys=['/relations/0'])]
            clause['evidence_by_field']['/relations/0']=copy.deepcopy(clause['evidence_by_field']['/predicate']);manifest(payload['semantic_unit'])
            branch_head=fixture.records.put(payload,expected_version=0,request_id='branch-'+str(branch))
        memory=AFHMemory(fixture.root,fixture.sources,'scope',read_only=True);records=KnowledgeRecords(memory,fixture.root/'records.pgstore',read_only=True)
        request=dict(scope='scope',roots=[first['payload']['semantic_unit']['clauses'][0]['clause_version_id']],hops=2,knownAt=branch_head['recorded_at'],validAt='2026-10-21T00:00:00Z')
        def call(kind,mode):
            with memo_context(mode=='memo') as memo,source_snapshot(records):
                identities=[dict(pid=db.raw.info.backend_pid,snapshot=db.raw.execute('SELECT pg_current_snapshot()::text').fetchone()[0]) for db in (records.db,memory.db)]
                assert identities[0]['pid']!=identities[1]['pid'] and identities[0]['snapshot']==identities[1]['snapshot']
                value=records.history(first['id'],'scope') if kind=='history' else query_records(records,request)
                return value,dict(memo=memo.stats(),readers=identities)
        samples=[];expected={}
        for kind in ('history','branches'):
            expected[kind]=call(kind,'current')[0];assert expected[kind]==call(kind,'memo')[0]
            for repeat in range(5):
                for mode in (('current','memo') if repeat%2==0 else ('memo','current')):
                    (value,extra),stats=timed(lambda:call(kind,mode));assert value==expected[kind]
                    samples.append(dict(kind=kind,mode=mode,repeat=repeat,resultHash=digest(value),**extra,**stats))
        memory_profiles=[]
        for mode in ('current','memo'):
            tracemalloc.start()
            try:
                value,extra=call('history',mode);current,peak=tracemalloc.get_traced_memory();assert value==expected['history']
            finally:tracemalloc.stop()
            memory_profiles.append(dict(mode=mode,tracedPeakBytes=peak,tracedCurrentBytes=current,**extra))
        # Existing SQL-integrity batching control, same request and payload.
        controls=[]
        for enabled in (True,False):
            with contextlib.nullcontext() if enabled else patch.object(Connection,'prefetch_integrity',lambda *args:None):
                (value,extra),stats=timed(lambda:call('branches','current'));assert value==expected['branches']
            controls.append(dict(existingIntegrityBatch=enabled,**stats))
        adversaries=[]
        row=fixture.records.db.execute('SELECT rowid,payload_sha256 FROM record_versions WHERE record_id=? AND version=1',(first['id'],)).fetchone()
        fixture.tmp.corrupt(fixture.records.db,'record_versions',dict(payload_sha256='broken'),where_rowid=row[0])
        try:
            for mode in ('current','memo'):adversaries.append(dict(case='historical_corruption',mode=mode,**rejected(lambda:call('history',mode))))
        finally:fixture.tmp.corrupt(fixture.records.db,'record_versions',dict(payload_sha256=row[1]),where_rowid=row[0])
        for mode in ('current','memo'):
            with memo_context(mode=='memo') as memo,source_snapshot(records):
                records.history(first['id'],'scope');removed=memory.sources.pop('rep-a')
                try:adversaries.append(dict(case='withdraw_selection_warm_context',mode=mode,**rejected(lambda:records.history(first['id'],'scope'))))
                finally:memory.sources['rep-a']=removed
        source_row=fixture.memory.db.execute("SELECT rowid,digest FROM source_bindings WHERE id='rep-a'").fetchone()
        call('history','memo')
        fixture.tmp.corrupt(fixture.memory.db,'source_bindings',dict(digest='broken'),where_rowid=source_row[0])
        try:
            for mode in ('current','memo'):adversaries.append(dict(case='source_registry_corruption_new_request',mode=mode,**rejected(lambda:call('history',mode))))
        finally:fixture.tmp.corrupt(fixture.memory.db,'source_bindings',dict(digest=source_row[1]),where_rowid=source_row[0])
        assert all(a['rejected'] for a in adversaries)
        assert call('history','memo')[0]==expected['history']
        return dict(versions=count,branches=2,samples=samples,memoryProfiles=memory_profiles,existingBatchControl=controls,adversaries=adversaries,restoredConsumer=True)
    finally:
        if records:records.close()
        if memory:memory.close()
        fixture.tearDown();close_idle()

def current_oracles():
    from test_janus_native import JanusTest
    from test_graph_common import CommonGraphTests
    from test_causal import CausalTest
    from test_collectives import CollectiveTest
    rows=[]
    for cls in (JanusTest,CommonGraphTests,SemanticTest,CausalTest,CollectiveTest):
        suite=unittest.defaultTestLoader.loadTestsFromTestCase(cls);names=[test.id() for test in suite]
        # Additional semantic oracles run with pure memo in one fresh context
        # per test. This is stricter (longer-lived) than the per-request proposal.
        class Result(unittest.TextTestResult):
            def startTest(self,test):
                self.context=memo_context(cls not in (JanusTest,CommonGraphTests));self.context.__enter__();super().startTest(test)
            def stopTest(self,test):
                try:self.context.__exit__(None,None,None)
                finally:super().stopTest(test)
        result=unittest.TextTestRunner(stream=sys.stderr,verbosity=2,resultclass=Result).run(suite)
        rows.append(dict(testClass=cls.__name__,tests=result.testsRun,names=names,failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped),pureMemoEnabled=cls not in (JanusTest,CommonGraphTests)))
        assert result.wasSuccessful() and result.testsRun==len(names) and not result.skipped
    return rows

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args()
    out=Path(args.output);assert not out.exists()
    data=dict(status='RUNNING',runtimeMutation=False,humanAcceptance=False,metricScope='Application execute calls and common-adapter execute calls exclude raw handshake/snapshot SQL; bytes are serialized logical graph responses, not TCP traffic. CPU is client process only.',crossDependencyScope='Existing causal/collective exact-version/source adversaries rerun with pure-digest memo; no assertion that independently opened foreign consumers share a snapshot.')
    def save():out.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    save()
    try:
        data['oracles']=current_oracles();save()
        data['graph']=[]
        for count in (20,100):data['graph'].append(graph_case(count));save()
        data['history']=[]
        for count in (8,32,64):data['history'].append(history_case(count));save()
        graph_equivalent=all(a['current']['rejected']==a['prototype']['rejected'] for g in data['graph'] for a in g['adversaries'])
        decisions=[]
        for h in data['history']:
            for kind in ('history','branches'):
                current=[s['seconds'] for s in h['samples'] if s['kind']==kind and s['mode']=='current'];memo=[s['seconds'] for s in h['samples'] if s['kind']==kind and s['mode']=='memo']
                decisions.append(dict(versions=h['versions'],kind=kind,currentMedianSeconds=statistics.median(current),memoMedianSeconds=statistics.median(memo),gain=1-statistics.median(memo)/statistics.median(current),allPairsFaster=all(b<a for a,b in zip(current,memo))))
        benefit=all(x['gain']>=0.10 and x['allPairsFaster'] for x in decisions if x['versions'] in (32,64))
        data.update(status='COMPLETE_MEASURED_EXPERIMENT_NOT_OPTIMIZATION_QUALIFICATION',currentOracleTests=sum(r['tests'] for r in data['oracles']),graphEquivalent=graph_equivalent,historyComparisons=decisions,graphDecision='FURTHER_QUALIFICATION_REQUIRED' if graph_equivalent else 'DO_NOT_ADOPT_PAGE_ONLY_BODY_VERIFICATION',historyDecision='FURTHER_QUALIFICATION_REQUIRED' if benefit else 'DO_NOT_ADOPT_PURE_DIGEST_MEMO_FOR_MEASURED_WORKLOADS',historyBenefitCriterionMet=benefit)
        save();print(json.dumps({k:data[k] for k in ('status','currentOracleTests','graphDecision','historyDecision')}),flush=True)
    except BaseException as error:
        data.update(status='FAIL_PRESERVED',error=repr(error));save();raise
    finally:close_idle()

if __name__=='__main__':main()

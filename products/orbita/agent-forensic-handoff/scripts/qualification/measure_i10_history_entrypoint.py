"""Supplement: observe the actual public history request's transaction context.

The evaluated extension reuses IntegrityBatch only inside an already established
read-only repeatable-read context. It does not manufacture or broaden that cut.
This distinguishes a lab component benefit from a product-entrypoint benefit.
"""
import argparse,copy,json,statistics,time
from pathlib import Path
from unittest.mock import patch
from measure_i10_graph_history import SemanticTest,KnowledgeRecords,manifest,digest,timed,close_idle
from afh_semantic.host import dispatch

ORIGINAL=KnowledgeRecords.history

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args();out=Path(args.output);assert not out.exists()
    data=dict(status='RUNNING',runtimeMutation=False,humanAcceptance=False,criterion='Adopt only a context-preserving extension with exact results and >=10% median benefit, every paired sample faster, then full qualification; no manufacture of a shared cut.')
    def save():out.write_text(json.dumps(data,indent=2)+'\n',encoding='utf8')
    fixture=SemanticTest('test_cas_idempotency_unknown_fields');fixture.setUp();save()
    try:
        head=fixture.put(0)
        for version in range(2,65):
            payload=copy.deepcopy(head['payload']);clause=payload['semantic_unit']['clauses'][0];clause['predicate']['value']='permits_'+str(version);clause['clause_version_id']='cv-entry-'+str(version);manifest(payload['semantic_unit'])
            head=fixture.records.put(payload,expected_version=version-1,request_id='entry-version-'+str(version))
        request=dict(op='history',root=str(fixture.root),scope='scope',sources=fixture.sources,id=head['id'])
        observations=[]
        def run(mode):
            def history(records,record_id,scope):
                same_binding=records.db.config==records.memory.db.config and records.db.session.binding==records.memory.db.session.binding
                conns=[records.db,records.memory.db]
                observed=[dict(pid=db.raw.info.backend_pid,inTransaction=db.in_transaction,isolation=db.raw.execute('SHOW transaction_isolation').fetchone()[0]) for db in conns]
                active=all(r['inTransaction'] and r['isolation']=='repeatable read' for r in observed)
                # Equal snapshot text is an observed consistency condition, not
                # proof based on the REPEATABLE READ label alone.
                shared=active and same_binding and len({db.raw.execute('SELECT pg_current_snapshot()::text').fetchone()[0] for db in conns})==1
                observations.append(dict(mode=mode,connections=observed,sharedReadCut=shared,batchApplied=False))
                if mode!='existing_context_batch' or not shared:return ORIGINAL(records,record_id,scope)
                records.get(record_id,scope)
                rows=records.db.execute('SELECT rowid AS _rowid, * FROM record_versions WHERE record_id=? AND scope=? ORDER BY version',(record_id,scope)).fetchall()
                records.db.prefetch_integrity(rows);observations[-1]['batchApplied']=records.db.integrity_batch is not None
                return [records._envelope(row) for row in rows]
            with patch.object(KnowledgeRecords,'history',history):return dispatch(copy.deepcopy(request))
        expected=run('current');assert expected==run('existing_context_batch') and len(expected)==64
        samples=[]
        for repeat in range(5):
            for mode in (('current','existing_context_batch') if repeat%2==0 else ('existing_context_batch','current')):
                value,stats=timed(lambda:run(mode));assert value==expected
                samples.append(dict(mode=mode,repeat=repeat,resultHash=digest(value),**stats))
        current=[s['seconds'] for s in samples if s['mode']=='current'];candidate=[s['seconds'] for s in samples if s['mode']=='existing_context_batch']
        applicable=any(o['batchApplied'] for o in observations)
        data.update(status='COMPLETE_MEASURED_ENTRYPOINT_CONTEXT_ONLY',versions=64,samples=samples,observations=observations,batchApplied=applicable,currentMedianSeconds=statistics.median(current),candidateMedianSeconds=statistics.median(candidate),decision='FURTHER_QUALIFICATION_REQUIRED' if applicable else 'DO_NOT_ADOPT_INAPPLICABLE_EXISTING_CONTEXT_BATCH',scope='Actual host.dispatch history route, fresh consumers per request; no endpoint protocol or snapshot semantics changed. Does not reject a future explicitly designed shared-cut protocol. Pinned-lab batching gains cannot be claimed for this unchanged entrypoint.')
        save();print(json.dumps({k:data[k] for k in ('status','decision','batchApplied')}))
    except BaseException as error:data.update(status='FAIL_PRESERVED',error=repr(error));save();raise
    finally:fixture.tearDown();close_idle()

if __name__=='__main__':main()

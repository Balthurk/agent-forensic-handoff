import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, canonical, digest, pointer, validateRegistry, validateWire, relationalWireChecks, validateNormativeExamples, generatedFiles, packageSnapshot, evaluateGate, acceptancePlan, acceptanceEvidenceProblems, controlPlan } from './validate-package.mjs';
import { runtimeSnapshot, snapshotStability, exactTimestamp, temporalRange, temporalChecks, validateEvidencePair, validateUnresolvedAssignment, assertNativeIdentityObservation, assertHumanDecisionCandidates, inspectHumanDecisionCandidates } from './contract-checks.mjs';
import { auditSession, verifyCaseIntegrity } from '../src/index.js';

const registry=JSON.parse(fs.readFileSync(path.join(ROOT,'specification/contracts.json')));
const fixtures=JSON.parse(fs.readFileSync(path.join(ROOT,'specification/fixtures/critical-contracts.json')));
const run=fs.mkdtempSync(path.join(os.tmpdir(),'afh-spec-tests-'));
const clone=()=>structuredClone(registry);
const bound=(value,precision='ns')=>({kind:'known',value,precision,timezone:'UTC'});
const open={kind:'open',value:null,precision:'ns',timezone:null};
const unknown={kind:'unknown',value:null,precision:'order_only',timezone:null};
const known=(offset='Z')=>bound('2026-01-01T00:00:00.000000001'+offset);

const incomingHarnessPermissions = [
  [2,'test/acceptance/afh-01.test.mjs'], [3,'test/acceptance/afh-02.test.mjs'],
  [4,'test/acceptance/afh-01.test.mjs'], [4,'test/acceptance/afh-03.test.mjs'],
  [6,'test/acceptance/afh-03.test.mjs'], [7,'test/acceptance/afh-01.test.mjs'],
  [7,'test/acceptance/afh-04.test.mjs'], [7,'test/acceptance/afh-05.test.mjs'],
  [7,'test/acceptance/afh-06.test.mjs'], [9,'test/acceptance/afh-08.test.mjs']
];
function scopeCompleteRegistry(){
  const r=clone();
  for(const [order,file]of [...incomingHarnessPermissions,[2,'src/index.js']]){
    const change=r.changes.find(c=>c.order===order);if(!change.write_set.includes(file))change.write_set.push(file);
  }
  return r;
}
for(const [order,file]of incomingHarnessPermissions)test(`SCOPE02 missing consumer${order} permission for ${file} invalidates the package`,()=>{
  const r=scopeCompleteRegistry();const change=r.changes.find(c=>c.order===order);change.write_set=change.write_set.filter(area=>area!==file);
  const result=validateRegistry(r,{checkGenerated:false});assert.equal(result.passed,false,'An executable incoming oracle must be writable at its due milestone');assert.match(result.errors.join('\n'),/acceptance-write-set/);
});
test('SCOPE02 explicitly complete scopes preserve scheduling and diagnostic acceptance override',()=>{
  const r=scopeCompleteRegistry(),before=acceptancePlan(registry),after=acceptancePlan(r);
  assert.deepEqual(after,before);assert.equal(validateRegistry(r,{checkGenerated:false}).passed,true);
  assert.equal(after.filter(s=>s.milestone===2&&s.stage==='CHANGE_EXIT').length,29);
  assert.equal(after.filter(s=>s.milestone===2&&s.owner===1).length,11);
  assert.equal(after.filter(s=>s.milestone>s.owner).length,35);
  assert.equal(after.filter(s=>s.stage==='CHANGE_EXIT').length,286);assert.equal(after.filter(s=>s.stage==='POST_PUBLICATION').length,2);
  const direct=after.find(s=>s.id==='AFH-01-T01');assert.ok(direct.acceptance_entrypoint.args.includes('test/acceptance/afh-01.test.mjs'));assert.ok(!direct.acceptance_entrypoint.args.includes('specification/regression-probes.mjs'));
});
test('SCOPE02 gate independently refuses insufficient scopes even with a claimed successful validation',()=>{
  const r=scopeCompleteRegistry();r.changes[1].write_set=r.changes[1].write_set.filter(file=>file!=='test/acceptance/afh-01.test.mjs');
  const context=acceptedContext();context.writer={task_id:'exclusive-test-writer',exclusive:true,write_set:r.changes[1].write_set};
  const result=evaluateGate({registry:r,validation:{passed:true},snapshot_sha256:snapshot,context,change_id:r.changes[1].id});assert.equal(result.state,'BLOCKED');assert.ok(result.blockers.includes('ACCEPTANCE_WRITE_SET_INVALID'));
});
for(const area of ['test/acceptance','test/acceptance/afh-01.test.mjs.backup','test/acceptance-other/','test/acceptance/afh-01.test'])test('SCOPE02 a partial path permission cannot authorize the incoming test: '+area,()=>{
  const r=scopeCompleteRegistry(),change=r.changes[1];change.write_set=change.write_set.filter(file=>file!=='test/acceptance/afh-01.test.mjs');change.write_set.push(area);
  const result=validateRegistry(r,{checkGenerated:false});assert.equal(result.passed,false);assert.match(result.errors.join('\n'),/acceptance-write-set/);
});
for(const file of ['../test/acceptance/afh-02.test.mjs','test/acceptance/../afh-02.test.mjs','/tmp/test/acceptance/afh-02.test.mjs','C:/test/acceptance/afh-02.test.mjs','test\\acceptance\\afh-02.test.mjs','test/acceptance//afh-02.test.mjs'])test('SCOPE02 malformed canonical acceptance path fails closed: '+file,()=>{
  const r=scopeCompleteRegistry(),s=r.scenarios.find(s=>s.id==='AFH-02-T01');s.entrypoint.args[s.entrypoint.args.length-1]=file;
  const result=validateRegistry(r,{checkGenerated:false});assert.equal(result.passed,false);assert.match(result.errors.join('\n'),/acceptance-write-set/);
});
test('SCOPE02 explicit directory boundaries and postpublication stages remain distinct',()=>{
  const r=scopeCompleteRegistry();r.changes[1].write_set=r.changes[1].write_set.filter(file=>!file.startsWith('test/acceptance/'));r.changes[1].write_set.push('test/acceptance/');
  // A directory permission is accepted only when explicitly declared by the test registry; the guard never adds one.
  const before=structuredClone(r);assert.equal(validateRegistry(r,{checkGenerated:false}).passed,true);assert.deepEqual(r,before);
  assert.deepEqual(acceptancePlan(r).filter(s=>s.stage==='POST_PUBLICATION').map(s=>s.id).sort(),['AFH-14-T17','AFH-14-T20']);
});

test('whole canonical package and generated views validate without writing',()=>{
  const before=packageSnapshot();const mtimes=[...generatedFiles(registry).keys()].map(p=>fs.statSync(path.join(ROOT,p)).mtimeMs);
  const result=validateRegistry(registry);assert.equal(result.passed,true,JSON.stringify(result.errors));
  assert.equal(result.counts.recommendations,22);assert.equal(result.counts.changes,14);assert.ok(result.counts.scenarios>=270);
  assert.deepEqual(packageSnapshot(),before);assert.deepEqual([...generatedFiles(registry).keys()].map(p=>fs.statSync(path.join(ROOT,p)).mtimeMs),mtimes);
});
for(const [name,mutate,expected]of [
 ['empty package',r=>r.changes=[],/fewer than 14/],
 ['broken source reference',r=>r.sources[0].ref='missing-contract.md',/Missing reference/],
 ['broken fixture pointer',r=>r.scenarios[0].fixture_ref.pointer='/cases/absent',/Unresolvable JSON pointer/],
 ['stale oracle digest',r=>r.scenarios[0].oracle_ref.sha256='0'.repeat(64),/stale fixture\/oracle/],
 ['requirement reverse link',r=>r.requirements[0].scenario_ids=[r.scenarios.at(-1).id],/reverse link/],
 ['inherited check removed',r=>r.scenarios[0].required_checks=r.scenarios[0].required_checks.filter(x=>x!=='LOSS_GUARD'),/missing inherited check/],
 ['change cycle',r=>r.changes[0].depends_on=[r.changes[1].id],/cycle/],
 ['profile cycle',r=>r.profiles[0].extends=['writer'],/cycle/],
 ['new inference misattributed',r=>r.recommendations.find(x=>x.id==='N01').origin='HISTORICAL',/attribution mismatch/],
])test('registry rejects '+name,()=>{const r=clone();mutate(r);const v=validateRegistry(r,{checkGenerated:false});assert.equal(v.passed,false);assert.match(v.errors.join('\n'),expected);});

test('AFH-04-T21 submillisecond inverted interval rejected',()=>{
  const from=bound('2026-01-01T00:00:00.000000002Z'),to=bound('2026-01-01T00:00:00.000000001Z');
  assert.equal(validateWire(from,'TemporalBound').passed,true);assert.equal(validateWire(to,'TemporalBound').passed,true);
  assert.throws(()=>temporalRange(from,to),/INVALID_TEMPORAL_RANGE/);
  assert.ok(temporalChecks({nested:{valid_from:from,valid_to:to}}).some(x=>x.includes('INVALID_TEMPORAL_RANGE')));
});
test('AFH-04-T22 open start rejected centrally and by schema',()=>{
  assert.equal(validateWire(open,'TemporalBound').passed,true);assert.equal(validateWire(open,'TemporalStart').passed,false);
  assert.throws(()=>temporalRange(open,known()),/OPEN_START_FORBIDDEN/);
  assert.ok(temporalChecks({promotion:{valid_from:open}}).some(x=>x.includes('OPEN_START_FORBIDDEN')));
  assert.ok(temporalChecks({occurrence:{started:open,ended:known()}}).some(x=>x.includes('OPEN_START_FORBIDDEN')));
});
test('AFH-04-T23 impossible dates and precision mismatches rejected',()=>{
  for(const v of ['2026-02-30T00:00:00Z','2025-02-29T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:00.0000000001Z','2026-01-01T00:00:00+24:00'])assert.throws(()=>exactTimestamp(v),/INVALID_TIMESTAMP/);
  assert.throws(()=>temporalRange(bound('2026-01-01T00:00:00.0001Z','ms'),open),/PRECISION_MISMATCH/);
});
test('AFH-04-T24 exact positive boundaries offset conversion and leap day',()=>{
  assert.equal(exactTimestamp('2026-01-01T01:00:00.000000001+01:00').ns,exactTimestamp('2026-01-01T00:00:00.000000001Z').ns);
  assert.equal(exactTimestamp('2025-12-31T23:00:00.000000001-01:00').ns,exactTimestamp('2026-01-01T00:00:00.000000001Z').ns);
  assert.equal(temporalRange(known(),known()).comparison,'VALID');
  assert.equal(exactTimestamp('2024-03-01T00:00:00Z').ns-exactTimestamp('2024-02-29T00:00:00Z').ns,86400000000000n);
});
test('AFH-04-T25 uncertainty and incomplete precision are not exact matches',()=>{
  assert.equal(temporalRange(bound('2026-01-01T00:00:00Z','day'),known()).comparison,'UNKNOWN_PRECISION_OVERLAP');
  assert.equal(temporalRange(unknown,open).comparison,'UNKNOWN_BOUND');
  assert.equal(exactTimestamp('2026-01-01T00:00:00-00:00').ns,null);
  assert.equal(exactTimestamp('2016-12-31T23:59:60Z').reason,'LEAP_SECOND_UNVERIFIED');
});
test('A/B fixture oracle preserves every assertion segment before validity filter',()=>{
  const data=fixtures.datasets.temporal;
  const select=(knownAt,validAt)=>{
    const latest=new Map();
    for(const row of data.revisions.filter(r=>exactTimestamp(r.recorded_at).ns<=exactTimestamp(knownAt).ns).sort((a,b)=>a.recorded_seq-b.recorded_seq))latest.set(row.assertion_id+'\0'+row.branch_id,row);
    return [...latest.values()].filter(r=>exactTimestamp(r.from).ns<=exactTimestamp(validAt).ns&&(r.to===null||exactTimestamp(validAt).ns<exactTimestamp(r.to).ns)).map(r=>r.value);
  };
  for(const q of data.queries)assert.deepEqual(select(q.known_at,q.valid_at),q.expected);
  assert.deepEqual(select('2026-01-19T00:00:00Z','2026-01-09T00:00:00Z'),[]);
});

test('AFH-07-T21 normative JSON examples conform to their operation',()=>{const v=validateNormativeExamples();assert.equal(v.passed,true,JSON.stringify(v.errors));assert.ok(v.count>0);});
test('AFH-07-T22 request discriminator and protocol cannot be inferred',()=>{
  const body=fs.readFileSync(path.join(ROOT,'docs/programs/afh-v0.4.0/API-CONTRACT.md'),'utf8');const example=JSON.parse(body.match(/```json\s*\n([\s\S]*?)\n```/)[1]);
  for(const mutation of [r=>delete r.kind,r=>r.kind='response',r=>delete r.protocol_version,r=>r.protocol_version='4.1',r=>r.params.undeclared=true]){const r=structuredClone(example);mutation(r);assert.equal(validateWire(r,'Request').passed,false);}
});

const cov={status:'COMPLETE_WITHIN_OBSERVED_BOUNDARY',sources_acquired:1,sources_known_omitted:0,universe_total:null,records_preserved:1,records_parsed:1,records_normalized:1,records_unsupported:0,records_unparsed:0,eligible_chunks:0,indexed_chunks:0,excluded:[],observed_through:'2026-01-01T00:00:00Z'};
const receipt=()=>({archive_id:'archive-a',revision_id:'revision-a',ledger_sha256:'a'.repeat(64),projection_ids:[],engine_version:'0.3.0',requested_mode:null,effective_mode:null,scope:null,time:null,coverage:structuredClone(cov),warnings:[],metrics:{},evidence_refs:[],input_class:'SYNTHETIC',runtime_class:'CONTRACT_ONLY',provider_class:'NONE',model_identity:null});
const extent=(n=3)=>({archive_id:'archive-a',revision_id:'revision-a',source_revision_id:'source-a',uri:'afh://synthetic-evidence-a',format:'base64',request_extent_sha256:'c'.repeat(64),record_sha256:'b'.repeat(64),initial_offset:0,extent_bytes:n,original_extent_bytes:n});
const request=s=>({kind:'request',schema_version:4,protocol_version:'4.0',request_id:'r1',operation:'evidence.read',archive:'/synthetic/archive',revision_id:s.revision_id,params:{uri:s.uri,offset:0,max_bytes:s.extent_bytes,format:s.format}});
function response(s,offset=0,n=1){
  const remaining=s.extent_bytes-offset-n;
  const d={archive_id:s.archive_id,revision_id:s.revision_id,source_revision_id:s.source_revision_id,uri:s.uri,offset,request_extent_sha256:s.request_extent_sha256,format:s.format,payload:Buffer.alloc(n,65).toString('base64'),bytes_returned:n,extent_bytes:s.extent_bytes,original_extent_bytes:s.original_extent_bytes,record_sha256:s.record_sha256,objects_verified:['b'.repeat(64)],partial:remaining>0,availability:'AVAILABLE',continuation:null};
  if(d.partial)d.continuation={archive_id:s.archive_id,revision_id:s.revision_id,source_revision_id:s.source_revision_id,uri:s.uri,format:s.format,request_extent_sha256:s.request_extent_sha256,next_offset:offset+n,remaining_bytes:remaining};
  return {kind:'response',schema_version:4,protocol_version:'4.0',request_id:'r1',operation:'evidence.read',status:'OK',data:d,error:null,receipt:receipt()};
}
test('AFH-07-T23 offset zero plus one byte cannot jump to99',()=>{const s=extent(),r=response(s);r.data.continuation.next_offset=99;assert.equal(validateWire(r,'Response').passed,true);assert.ok(validateEvidencePair(request(s),r,s).includes('NEXT_OFFSET_MISMATCH'));});
test('AFH-07-T24 positive continuation consumes exact extent and ends without cursor',()=>{
  const s=extent(),q=request(s),a=response(s);assert.equal(validateWire(a,'Response').passed,true);assert.deepEqual(relationalWireChecks(a,registry,{request:q,state:s}),[]);
  const q2=request(s);delete q2.params.offset;q2.params.continuation=a.data.continuation;const b=response(s,1,2);
  assert.deepEqual(relationalWireChecks(b,registry,{request:q2,state:s}),[]);assert.equal(b.data.continuation,null);
  assert.equal(Buffer.concat([Buffer.from(a.data.payload,'base64'),Buffer.from(b.data.payload,'base64')]).length,3);
  const broken=structuredClone(a);broken.data.continuation.remaining_bytes=99;assert.ok(validateEvidencePair(q,broken,s).includes('REMAINING_BYTES_MISMATCH'));
  const zero=response(s,0,0);assert.ok(validateEvidencePair(q,zero,s).includes('NO_CONTINUATION_PROGRESS'));
});
test('AFH-07-T25 cursor identity revision digest URI format all remain bound',()=>{
  const s=extent(),q=request(s);
  for(const key of ['archive_id','revision_id','source_revision_id','uri','format','request_extent_sha256']){const a=response(s);a.data.continuation[key]='wrong';assert.ok(validateEvidencePair(q,a,s).some(x=>x==='OUTPUT_CURSOR_'+key));}
  const q2=request(s);q2.params.continuation=response(s).data.continuation;q2.params.continuation.remaining_bytes=99;delete q2.params.offset;
  assert.ok(validateEvidencePair(q2,response(s,1,2),s).includes('INPUT_REMAINING_MISMATCH'));
  q2.params.continuation.revision_id='wrong';assert.ok(validateEvidencePair(q2,response(s,1,2),s).includes('INPUT_CURSOR_revision_id'));
});
test('AFH-07-T26 full encoded envelope cap across a16MiB request',()=>{
  const s=extent(16777216),q=request(s);const tooLarge=response(s,0,6291456);
  assert.equal(Buffer.byteLength(tooLarge.data.payload),8388608);assert.ok(Buffer.byteLength(JSON.stringify(tooLarge))>8388608);assert.ok(validateEvidencePair(q,tooLarge,s).includes('FRAME_TOO_LARGE'));
  let offset=0,previous=null,total=0;
  while(offset<s.extent_bytes){const n=Math.min(6280000,s.extent_bytes-offset),a=response(s,offset,n),rq=request(s);if(previous){delete rq.params.offset;rq.params.continuation=previous;}
    assert.deepEqual(relationalWireChecks(a,registry,{request:rq,state:s}),[]);assert.ok(Buffer.byteLength(JSON.stringify(a))<=8388608);total+=Buffer.from(a.data.payload,'base64').length;offset+=n;previous=a.data.continuation;}
  assert.equal(total,16777216);assert.equal(previous,null);
});
test('AFH-07-T27 captured extent known but original truncated size remains null',()=>{
  const s=extent();s.original_extent_bytes=null;const a=response(s);a.data.availability='TRUNCATED_AT_SOURCE';assert.deepEqual(validateEvidencePair(request(s),a,s),[]);a.data.original_extent_bytes=999;assert.ok(validateEvidencePair(request(s),a,s).includes('UNKNOWN_ORIGINAL_EXTENT_REQUIRED'));
});
test('coverage counters, token budget and error catalog fail closed',()=>{
  const s=extent(),a=response(s);a.receipt.coverage.records_parsed=0;assert.ok(relationalWireChecks(a,registry,{request:request(s),state:s}).includes('PARSE_ACCOUNTING'));
  const req={kind:'request',operation:'context.build',params:{budget_kind:'tokenizer'}};assert.ok(relationalWireChecks(req,registry).includes('TOKENIZER_IDENTITY_REQUIRED'));
  const err=response(s);err.data=null;err.status='ERROR';err.error={code:'INVALID_QUERY',message:'synthetic',retryable:true,details:{}};assert.ok(relationalWireChecks(err,registry).includes('ERROR_CATALOG_MISMATCH'));
  const pack={kind:'response',operation:'context.build',receipt:receipt(),error:null,data:{budget_kind:'tokenizer',tokenizer:null,actual_tokens:null,budget_tokens:512}};assert.ok(relationalWireChecks(pack,registry).includes('TOKENIZER_HARDCAP'));
  const over={kind:'request',operation:'query',params:{question:'x'.repeat(1048576)}};assert.ok(relationalWireChecks(over,registry).includes('REQUEST_TOO_LARGE'));
  let deep={};for(let i=0;i<40;i++)deep={child:deep};assert.ok(relationalWireChecks({kind:'request',params:deep},registry).includes('JSON_DEPTH_LIMIT'));
});

let assignmentFixture;
async function assignmentCase(){
  if(assignmentFixture)return assignmentFixture;
  const dir=path.join(run,'assignment');fs.mkdirSync(dir);const marker='Implement the synthetic parser and preserve all failed attempts.';
  const rows=[{type:'session_meta',payload:{id:'synthetic-child',session_id:'synthetic-child'}},{type:'response_item',payload:{type:'function_call_output',call_id:'create-1',output:`<codex_delegation><source_thread_id>synthetic-parent</source_thread_id><input>${marker}</input></codex_delegation>`}},{type:'response_item',payload:{type:'message',id:'unrelated',role:'user',content:[{type:'input_text',text:'Unrelated task to paint a wall.'}]}}];
  const source=path.join(dir,'source.jsonl');fs.writeFileSync(source,rows.map(JSON.stringify).join('\n')+'\n');
  const before=digest(fs.readFileSync(source));const audit=await auditSession(source,{harness:'codex',caseDir:path.join(dir,'case'),includeChildren:false,workspace:dir});assert.equal((await verifyCaseIntegrity(audit.caseDir)).passed,true);assert.equal(digest(fs.readFileSync(source)),before);
  const db=new DatabaseSync(path.join(audit.caseDir,'case.sqlite'),{readOnly:true});let events;try{events=db.prepare('SELECT e.id,e.kind,r.uri FROM event e JOIN evidence_ref r ON r.event_id=e.id ORDER BY e.record_ordinal').all();}finally{db.close();}
  const transmission=events.find(e=>e.kind.includes('tool')),other=events.find(e=>e.kind==='message.user');assert.ok(transmission);assert.ok(other);
  const expected={marker,recipient:'ses:codex:synthetic-child',origin:'ses:codex:synthetic-parent'};
  const claim={recipient_session_id:expected.recipient,origin_session_id:expected.origin,origin_status:'UNRESOLVED',authority_origin:'UNKNOWN',authority_chain:[{event_id:transmission.id,evidence_uri:transmission.uri}]};
  assignmentFixture={caseDir:audit.caseDir,claim,refs:[transmission.uri],expected,other};return assignmentFixture;
}
test('AFH-05-T21 syntactically present nonexistent provenance rejected',async()=>{const f=await assignmentCase();const c=structuredClone(f.claim);c.authority_chain=[{event_id:'inexistente',evidence_uri:'invalida'}];const v=await validateUnresolvedAssignment(f.caseDir,c,['invalida'],f.expected);assert.equal(v.passed,false);assert.ok(v.problems.includes('CHAIN_REFERENCE_UNRESOLVED'));});
test('AFH-05-T22 registered evidence unrelated to assignment or recipient rejected',async()=>{const f=await assignmentCase();const c=structuredClone(f.claim);c.authority_chain=[{event_id:f.other.id,evidence_uri:f.other.uri}];const v=await validateUnresolvedAssignment(f.caseDir,c,[f.other.uri],f.expected);assert.equal(v.passed,false);assert.ok(v.problems.includes('TRANSMISSION_CONTENT_OR_RECIPIENT_MISMATCH'));const wrong=await validateUnresolvedAssignment(f.caseDir,f.claim,f.refs,{...f.expected,recipient:'another-child'});assert.equal(wrong.passed,false);});
test('AFH-05-T23 observed transmission resolves while human origin remains unresolved',async()=>{const f=await assignmentCase();const v=await validateUnresolvedAssignment(f.caseDir,f.claim,f.refs,f.expected);assert.equal(v.passed,true,JSON.stringify(v.problems));const c=structuredClone(f.claim);c.authority_origin='TRANSMITTED_HUMAN';assert.equal((await validateUnresolvedAssignment(f.caseDir,c,f.refs,f.expected)).passed,false);});

test('AFH-01-T21 effective untracked owned runtime file changes digest',()=>{
  const dir=path.join(run,'runtime');fs.mkdirSync(path.join(dir,'src/archive'),{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),'{}');
  execFileSync('git',['init','--quiet'],{cwd:dir});const a=runtimeSnapshot(dir);fs.writeFileSync(path.join(dir,'src/archive/selector.js'),'export const value=1;\n');
  assert.match(execFileSync('git',['status','--porcelain'],{cwd:dir,encoding:'utf8'}),/\?\? src/);const b=runtimeSnapshot(dir);assert.notEqual(a.sha256,b.sha256);assert.ok(b.files.some(x=>x.file==='src/archive/selector.js'));
});
test('AFH-01-T22 runtime change or removal between captures invalidates evidence',()=>{
  const dir=path.join(run,'unstable');fs.mkdirSync(path.join(dir,'src'),{recursive:true});const file=path.join(dir,'src/example.js');fs.writeFileSync(file,'one');const a=runtimeSnapshot(dir);fs.writeFileSync(file,'two');const b=runtimeSnapshot(dir);assert.equal(snapshotStability(a,b).stable,false);assert.equal(snapshotStability(b,b).stable,true);fs.unlinkSync(file);const c=runtimeSnapshot(dir);assert.equal(snapshotStability(b,c).stable,false);assert.equal(snapshotStability(b,c).changes[0].after,null);
});

const snapshot='d'.repeat(64);
const gateContext=()=>({phase:'specification',authorization_ref:{status:'ACTIVE',scope:['afh-v0.4.0'],source_ref:'synthetic-authorization-ref'},review_ref:{result:'SATISFACTORY',snapshot_sha256:snapshot,source_ref:'synthetic-review-ref',reviewer:'independent-test-reviewer',material_findings:0},evidence:['openspec','schema','package_tests','traceability','oracle_review'].map(check=>({check,result:check==='oracle_review'?'SATISFACTORY':'PASS',evidence_class:check==='oracle_review'?'SEMANTIC_REVIEW':'PACKAGE_VALIDATION',snapshot_sha256:snapshot,source_ref:check==='oracle_review'?'synthetic-review-ref':'synthetic-'+check,mechanical_errors:0}))});
const gate=(context,change_id=null,r=registry)=>evaluateGate({registry:r,validation:{passed:true},snapshot_sha256:snapshot,context,change_id});
test('gate accepts full spec and01 without requiring fourteen GREEN',()=>{const c=gateContext();assert.equal(gate(c).state,'SPECIFICATION_READY');c.writer={task_id:'test-writer',exclusive:true,write_set:registry.changes[0].write_set};assert.equal(gate(c,registry.changes[0].id).state,'IMPLEMENTATION_READY');});
test('gate02 requires predecessor01 and exact exclusive writer',()=>{const c=gateContext();c.writer={task_id:'test-writer',exclusive:true,write_set:registry.changes[1].write_set};assert.ok(gate(c,registry.changes[1].id).blockers.some(x=>x.startsWith('PREDECESSOR_')));c.writer.exclusive=false;assert.ok(gate(c,registry.changes[1].id).blockers.includes('WRITER_OR_WRITE_SET'));});
test('scope authorization persists when review digest becomes stale',()=>{const c=gateContext();c.authorization_ref.snapshot_sha256='old';assert.equal(gate(c).state,'SPECIFICATION_READY');c.review_ref.snapshot_sha256='old';const g=gate(c);assert.ok(g.blockers.includes('SEMANTIC_REVIEW_PENDING_OR_STALE'));assert.ok(!g.blockers.includes('AUTHORIZATION_SCOPE'));});
test('gate rejects PAUSED empty package mechanical stale or fixture evidence',()=>{
  const paused=gateContext();paused.phase='PAUSED';assert.ok(gate(paused).blockers.includes('PAUSED'));
  const empty=clone();empty.changes=[];assert.ok(gate(gateContext(),null,empty).blockers.includes('PACKAGE_INCOMPLETE_OR_INVALID'));
  for(const mutation of [e=>e.mechanical_errors=1,e=>e.snapshot_sha256='old',e=>e.result='UNAVAILABLE']){const c=gateContext();mutation(c.evidence[0]);assert.ok(gate(c).blockers.includes('EVIDENCE_OPENSPEC'));}
  const fixture=gateContext();Object.assign(fixture.evidence[0],{claims_real_runtime:true,runtime_class:'CONTRACT_ONLY',requires_real_model:true,provider_class:'FIXTURE'});assert.ok(gate(fixture).blockers.includes('FIXTURE_AS_REAL'));assert.ok(gate(fixture).blockers.includes('FIXTURE_AS_REAL_MODEL'));
});
test('canonical JSON and pointer preserve Unicode arrays and explicit null',()=>{assert.equal(canonical({b:null,a:['árbol','"',1]}),'{"a":["árbol","\\\"",1],"b":null}');assert.deepEqual(pointer({'a/b':{'~':[1,null]}},'/a~1b/~0'),[1,null]);assert.throws(()=>pointer({},'/missing'),/Unresolvable/);});

test('F1 preserves all288 frozen fixture and oracle identities from audited candidate',()=>{
  assert.equal(registry.scenarios.length,288);assert.equal(registry.requirements.length,86);
  // Digests observed from897849 before editing; works in a shallow CI checkout too.
  assert.equal(digest(registry.scenarios.map(s=>({id:s.id,fixture_ref:s.fixture_ref,oracle_ref:s.oracle_ref,requirement_ids:s.requirement_ids,then:s.then}))),'ba25ffa56c4b4b3b59c96db4f4f15890ced822b1e2db21746dfc7bbe556e6e9e');
  assert.equal(digest(fs.readFileSync(path.join(ROOT,'specification/fixtures/critical-contracts.json'))),'b8f7b4aa56557b474d8f81799978c58a4db15b815d7b866d9090d34d6eb77abc');
});
test('F1 all scenarios resolve ownership and late integrations have exact available milestones',()=>{
  const plan=acceptancePlan(registry);assert.equal(plan.length,288);assert.equal(new Set(plan.map(x=>x.id)).size,288);
  assert.equal(plan.filter(x=>x.milestone>x.owner).length,35);
  for(const [id,due]of [['AFH-04-T17',7],['AFH-08-T07',9],['AFH-01-T07',7],['AFH-01-T10',4],['AFH-03-T20',6]])assert.equal(plan.find(x=>x.id===id).milestone,due);
  assert.equal(plan.find(x=>x.id==='AFH-01-T01').milestone,1);
});
test('F1 counterexamples require acceptance before real consumers exist',()=>{
  for(const [id,wrong]of [['AFH-04-T17',4],['AFH-08-T07',8],['AFH-01-T07',1],['AFH-01-T04',1]]){const r=clone();r.scenarios.find(s=>s.id===id).acceptance_milestone=wrong;assert.throws(()=>acceptancePlan(r),/before consumer availability/);}
  const r=clone();r.scenarios.find(s=>s.id==='AFH-04-T17').execution_requires=r.scenarios.find(s=>s.id==='AFH-04-T17').execution_requires.filter(x=>x!=='context.build');assert.throws(()=>acceptancePlan(r),/Missing fixture consumer context/);
  const r2=clone();r2.acceptance_policy.operation_ownership['resident.query'].available_at=0;assert.throws(()=>acceptancePlan(r2),/ownership\/availability mismatch/);
});
test('F1 cannot hide an integration in arbitrary later or postpublication stage',()=>{
  const r=clone();r.scenarios.find(s=>s.id==='AFH-08-T07').acceptance_milestone=14;assert.throws(()=>acceptancePlan(r),/unjustified deferral/);
  const r2=clone();r2.scenarios.find(s=>s.id==='AFH-04-T17').acceptance_stage='POST_PUBLICATION';assert.throws(()=>acceptancePlan(r2),/cannot hide integration/);
});
function acceptedContext(){
  const c=gateContext(),plan=acceptancePlan(registry);
  c.scenario_results=registry.scenarios.map(s=>({scenario_id:s.id,status:'PASS',role:'FULL_ACCEPTANCE',oracle_sha256:s.oracle_ref.sha256,package_sha256:snapshot,candidate_commit:'e'.repeat(40),evidence_ref:'synthetic-acceptance-'+s.id,mechanical_errors:0,evidence_kind:s.evidence_kind,provider_class:s.required_checks.includes('REAL_MODEL_IDENTITY')?'REAL_LOCAL':'NONE'}));
  // Synthetic receipts only test gate logic; they never become program evidence.
  const controls=new Map(controlPlan(registry,{plan}).map(row=>[row.id,row]));
  for(const e of c.scenario_results){const p=controls.get(e.scenario_id);e.control_plan_sha256=digest(p);e.execution_operations=p.operations;e.check_results=p.checks.map(c=>c.applicability==='APPLICABLE'?{check:c.check,rule_id:c.rule_id,status:'PASS',evidence_ref:'synthetic-control-'+e.scenario_id+'-'+c.check,mechanical_errors:0}:{check:c.check,rule_id:c.rule_id,status:'NOT_APPLICABLE',derivation_sha256:digest(c)});}
  c.predecessors=registry.changes.map(d=>({change_id:d.id,status:'MILESTONE_GREEN',package_sha256:snapshot,candidate_commit:'e'.repeat(40),evidence_ref:'synthetic-milestone-'+d.order,mechanical_errors:0,accepted_scenario_ids:plan.filter(s=>s.milestone===d.order&&s.stage==='CHANGE_EXIT').map(s=>s.id),deferred_scenario_ids:plan.filter(s=>s.owner===d.order&&(s.milestone>d.order||s.stage==='POST_PUBLICATION')).map(s=>s.id)}));
  return c;
}
test('F1 core04 permits entry05 while its five-consumer integration remains pending',()=>{
  const c=acceptedContext();c.scenario_results=c.scenario_results.filter(e=>acceptancePlan(registry).find(s=>s.id===e.scenario_id).milestone<=4);c.writer={task_id:'test-writer',exclusive:true,write_set:registry.changes[4].write_set};
  const g=gate(c,registry.changes[4].id);assert.equal(g.state,'IMPLEMENTATION_READY',JSON.stringify(g.blockers));assert.ok(g.deferred_obligations.some(x=>x.scenario_id==='AFH-04-T17'&&x.milestone===7));
  c.writer.write_set=registry.changes[7].write_set;assert.ok(gate(c,registry.changes[7].id).blockers.includes('SCENARIO_AFH-04-T17'));
});
test('F1 every delayed integration survives into release gate and postpublication remains mandatory',()=>{
  const c=acceptedContext();const call=(context,release_phase)=>evaluateGate({registry,validation:{passed:true},snapshot_sha256:snapshot,context,release_phase});
  assert.equal(call(c,'complete').state,'RELEASE_ACCEPTED');
  for(const id of ['AFH-04-T17','AFH-08-T07']){const bad=structuredClone(c);bad.scenario_results=bad.scenario_results.filter(x=>x.scenario_id!==id);assert.ok(call(bad,'ready').blockers.includes('SCENARIO_'+id));}
  const before=structuredClone(c);before.scenario_results=before.scenario_results.filter(x=>!['AFH-14-T17','AFH-14-T20'].includes(x.scenario_id));assert.equal(call(before,'ready').state,'RELEASE_READY');assert.ok(call(before,'complete').blockers.includes('SCENARIO_AFH-14-T17'));
});
test('F2 all ten diagnostics declare coverage and cannot substitute for full acceptance',()=>{
  const probes=registry.scenarios.filter(s=>s.phase==='OBSERVED_RED');assert.equal(probes.length,10);
  for(const s of probes){assert.equal(s.probe_contract.can_accept_scenario,false);assert.equal(s.probe_contract.role,'BASELINE_DIAGNOSTIC');assert.ok(s.probe_contract.remaining_obligations.length);const c=acceptedContext();c.scenario_results.find(x=>x.scenario_id===s.id).role='BASELINE_DIAGNOSTIC';assert.ok(acceptanceEvidenceProblems(registry,acceptancePlan(registry),c,snapshot,14,{postPublication:true}).includes('DIAGNOSTIC_CANNOT_ACCEPT_'+s.id));}
});
test('F2 native owner plus missing or wrong grouping fails while complete bound identity passes',()=>{
  const expected={event_session:'synthetic-child',grouping:'synthetic-parent'},good={events:[{native_id:'synthetic-child',session_id:'ses:codex:synthetic-child'}],grouping:'synthetic-parent',metadata_provenance:true};
  assert.doesNotThrow(()=>assertNativeIdentityObservation(good,expected));for(const grouping of [null,'wrong-parent'])assert.throws(()=>assertNativeIdentityObservation({...good,grouping},expected),/Grouping/);assert.throws(()=>assertNativeIdentityObservation({...good,metadata_provenance:false},expected),/session_meta/);
});
test('F2 exact human decision supports multiple candidates with real provenance and rejects unrelated actor/content',async()=>{
  const dir=path.join(run,'f2-decisions');fs.mkdirSync(dir);const marker='Usa SQLite y conserva las decisiones anteriores.',session_id='ses:codex:decision-source';
  const source=path.join(dir,'source.jsonl');fs.writeFileSync(source,[{type:'session_meta',payload:{id:'decision-source',session_id:'decision-source'}},...['user','assistant'].map((role,i)=>({type:'response_item',payload:{type:'message',id:'m'+i,role,content:[{type:role==='user'?'input_text':'output_text',text:marker}]}}))].map(JSON.stringify).join('\n')+'\n');
  const a=await auditSession(source,{harness:'codex',caseDir:path.join(dir,'case'),workspace:dir,includeChildren:false});assert.equal((await verifyCaseIntegrity(a.caseDir)).passed,true);
  const db=new DatabaseSync(path.join(a.caseDir,'case.sqlite'),{readOnly:true});let events;try{events=db.prepare("SELECT id,kind FROM event WHERE kind IN ('message.user','message.agent')").all();}finally{db.close();}
  const human=events.find(e=>e.kind==='message.user'),agent=events.find(e=>e.kind==='message.agent');assert.ok(human);assert.ok(agent);
  const candidates=[{id:'candidate-a',decision_text:marker,source_event_id:human.id},{id:'candidate-b',decision_text:marker,source_event_id:human.id}];
  const rows=await inspectHumanDecisionCandidates(a.caseDir,{marker,session_id},candidates);assert.equal(assertHumanDecisionCandidates(rows,{marker,session_id}),2);assert.ok(rows.every(r=>r.evidence_refs.length&&r.provenance_resolved));
  for(const candidate of [{id:'unrelated',decision_text:'Otra decisión',source_event_id:human.id},{id:'wrong-actor',decision_text:marker,source_event_id:agent.id},{id:'missing',decision_text:marker,source_event_id:'inexistente'}]){const bad=await inspectHumanDecisionCandidates(a.caseDir,{marker,session_id},[candidate]);assert.throws(()=>assertHumanDecisionCandidates(bad,{marker,session_id}),/At least one exact human/);}
  assert.throws(()=>assertHumanDecisionCandidates([],{marker,session_id}),/At least one/);
});
test('F2 npm package tests cannot impersonate a global semantic oracle review',()=>{const c=gateContext();Object.assign(c.evidence.find(e=>e.check==='oracle_review'),{result:'PASS',evidence_class:'PACKAGE_VALIDATION',source_ref:'npm-check.txt'});assert.ok(gate(c).blockers.includes('EVIDENCE_ORACLE_REVIEW'));});

test('A1 applicable writer control missing from acceptance evidence blocks release',()=>{
  const c=acceptedContext();
  const evidence=c.scenario_results.find(x=>x.scenario_id==='AFH-02-T01');
  evidence.check_results=[];
  const result=evaluateGate({registry,validation:{passed:true},snapshot_sha256:snapshot,context:c,release_phase:'ready'});
  assert.equal(result.state,'BLOCKED','A scenario-level PASS cannot replace applicable control evidence');
});
test('A1 self-declared nonapplication cannot discharge writer publication',()=>{
  const c=acceptedContext();
  const evidence=c.scenario_results.find(x=>x.scenario_id==='AFH-02-T01');
  evidence.check_results=[{check:'ATOMIC_PUBLICATION',status:'NOT_APPLICABLE',reason:'executor says leaf'}];
  const result=evaluateGate({registry,validation:{passed:true},snapshot_sha256:snapshot,context:c,release_phase:'ready'});
  assert.equal(result.state,'BLOCKED');
});
test('A2 generated checkboxes describe obligations while receipts carry execution state',()=>{
  for(const change of registry.changes){
    const body=generatedFiles(registry).get(`openspec/changes/${change.id}/tasks.md`);
    assert.match(body,/receipts.*execution state/i);
  }
});

test('A1 all288 scenarios retain frozen direct obligations with derived applicability',()=>{
  const fields=['id','fixture_ref','oracle_ref','requirement_ids','given','when','then','required_checks'];
  assert.equal(digest(registry.scenarios.map(s=>Object.fromEntries(fields.map(k=>[k,s[k]])))),'dd5072ca9558ed0756fcbaae31ce56b3f4fa61d486a7098587dae4b9db55bf6c');
  const p=controlPlan(registry);assert.equal(p.length,288);
  for(const row of p){const s=registry.scenarios.find(s=>s.id===row.id);assert.equal(row.oracle_sha256,s.oracle_ref.sha256);for(const check of s.required_checks)assert.ok(row.checks.some(c=>c.check===check));}
  for(const id of ['AFH-01-T01','AFH-01-T03','AFH-01-T19','AFH-01-T21','AFH-01-T22']){
    const row=p.find(x=>x.id===id);
    for(const name of ['ATOMIC_PUBLICATION','IDEMPOTENCE','RECOVERY','SCHEMA_V4']){
      const c=row.checks.find(c=>c.check===name);assert.equal(c.applicability,'NOT_APPLICABLE');assert.ok(c.retained_by.length);assert.ok(c.retained_by.every(d=>d.milestone>=2));
    }
    assert.equal(row.checks.find(c=>c.check==='EXACT_INPUT_IDENTITY').applicability,'APPLICABLE');
  }
  for(const id of ['AFH-02-T01','AFH-02-T08'])for(const check of ['ATOMIC_PUBLICATION','IDEMPOTENCE','RECOVERY','SCHEMA_V4'])assert.equal(p.find(x=>x.id===id).checks.find(c=>c.check===check).applicability,'APPLICABLE');
  for(const s of registry.scenarios.filter(s=>['M3','M4'].includes(s.source_ref)))assert.equal(p.find(x=>x.id===s.id).checks.find(c=>c.check==='SCHEMA_V4').applicability,'APPLICABLE');
});
test('A1 unknown effects, missing classification and false package metadata fail closed',()=>{
  for(const mutate of [r=>delete r.acceptance_policy.control_applicability.operation_effects['archive.init'],r=>r.acceptance_policy.control_applicability.operation_effects['archive.init'].effects=['UNKNOWN_EFFECT'],r=>r.scenarios.find(s=>s.id==='AFH-02-T01').evidence_kind='PACKAGE_VALIDATION']){
    const r=clone();mutate(r);assert.throws(()=>controlPlan(r));assert.ok(gate(gateContext(),null,r).blockers.includes('CONTROL_APPLICABILITY_INVALID'));
  }
});
test('A1 missing, stale, fabricated or skipped individual controls cannot accept a scenario',()=>{
  const invoke=c=>acceptanceEvidenceProblems(registry,acceptancePlan(registry),c,snapshot,2);
  for(const mutate of [e=>e.check_results.pop(),e=>e.control_plan_sha256='stale',e=>e.execution_operations=['package.checks'],e=>e.evidence_kind='PACKAGE_VALIDATION',e=>e.check_results[0].mechanical_errors=1,e=>e.check_results[0].status='UNAVAILABLE',e=>e.check_results.push(e.check_results[0])]){
    const c=acceptedContext();mutate(c.scenario_results.find(e=>e.scenario_id==='AFH-02-T01'));assert.ok(invoke(c).length);
  }
  const c=acceptedContext();const e=c.scenario_results.find(e=>e.scenario_id==='AFH-01-T21');const na=e.check_results.find(c=>c.status==='NOT_APPLICABLE');na.derivation_sha256='invented';assert.ok(invoke(c).some(x=>x.startsWith('FALSE_EXEMPTION_AFH-01-T21')));
});
test('A1 specific checks cannot be exempted by inherited effect rules',()=>{
  const r=clone(),s=r.scenarios.find(s=>s.id==='AFH-01-T03');s.required_checks.push('REAL_MODEL_IDENTITY');
  // Added only to the test registry, never to a product scenario or real receipt.
  assert.equal(controlPlan(r).find(x=>x.id===s.id).checks.find(c=>c.check==='REAL_MODEL_IDENTITY').applicability,'APPLICABLE');
});
test('A1 positive first milestone passes only with complete applicable control evidence',()=>{
  const c=acceptedContext();c.scenario_results=c.scenario_results.filter(e=>controlPlan(registry).find(p=>p.id===e.scenario_id).milestone===1);c.writer={task_id:'test-writer',exclusive:true,write_set:registry.changes[1].write_set};
  assert.equal(gate(c,registry.changes[1].id).state,'IMPLEMENTATION_READY');
  assert.ok(evaluateGate({registry,validation:{passed:true},snapshot_sha256:snapshot,context:c,release_phase:'ready'}).blockers.includes('SCENARIO_AFH-02-T01'));
});
test('A1 package oracle schema surface cannot disappear behind package evidence class',()=>{
  const r=clone(),s=r.scenarios.find(s=>s.source_ref==='M3');
  s.execution_requires=['package.checks'];
  assert.throws(()=>controlPlan(r),/Package oracle surface missing/);
  const typed=controlPlan(registry).filter(row=>row.operations.includes('package.wire_checks'));
  assert.equal(typed.length,7);
  for(const row of typed)assert.equal(row.checks.find(c=>c.check==='SCHEMA_V4').applicability,'APPLICABLE');
});
test('A1 legacy captures retain actual schema and regression controls without claiming v4',()=>{
  const plan=controlPlan(registry),row=plan.find(x=>x.id==='AFH-01-T01');
  assert.ok(row.assignment_operations.includes('capability.native-identity'));
  assert.ok(!row.operations.includes('capability.native-identity'));
  for(const check of ['LEGACY_SCHEMA_IDENTITY','LEGACY_REGRESSION','PROVENANCE_RESOLUTION'])assert.equal(row.checks.find(c=>c.check===check).applicability,'APPLICABLE');
  assert.equal(row.checks.find(c=>c.check==='SCHEMA_V4').applicability,'NOT_APPLICABLE');
  assert.equal(plan.find(x=>x.id==='AFH-01-T03').checks.find(c=>c.check==='IDENTITY_STABILITY').applicability,'APPLICABLE');
});

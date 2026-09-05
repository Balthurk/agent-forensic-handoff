import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, canonical, digest, pointer, validateRegistry, validateWire, relationalWireChecks, validateNormativeExamples, generatedFiles, packageSnapshot, evaluateGate } from './validate-package.mjs';
import { runtimeSnapshot, snapshotStability, exactTimestamp, temporalRange, temporalChecks, validateEvidencePair, validateUnresolvedAssignment } from './contract-checks.mjs';
import { auditSession, verifyCaseIntegrity } from '../src/index.js';

const registry=JSON.parse(fs.readFileSync(path.join(ROOT,'specification/contracts.json')));
const fixtures=JSON.parse(fs.readFileSync(path.join(ROOT,'specification/fixtures/critical-contracts.json')));
const run=fs.mkdtempSync(path.join(os.tmpdir(),'afh-spec-tests-'));
const clone=()=>structuredClone(registry);
const bound=(value,precision='ns')=>({kind:'known',value,precision,timezone:'UTC'});
const open={kind:'open',value:null,precision:'ns',timezone:null};
const unknown={kind:'unknown',value:null,precision:'order_only',timezone:null};
const known=(offset='Z')=>bound('2026-01-01T00:00:00.000000001'+offset);

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
const gateContext=()=>({phase:'specification',authorization_ref:{status:'ACTIVE',scope:['afh-v0.4.0'],source_ref:'synthetic-authorization-ref'},review_ref:{result:'SATISFACTORY',snapshot_sha256:snapshot,source_ref:'synthetic-review-ref',reviewer:'independent-test-reviewer',material_findings:0},evidence:['openspec','schema','package_tests','traceability','oracle_review'].map(check=>({check,result:'PASS',snapshot_sha256:snapshot,source_ref:'synthetic-'+check,mechanical_errors:0}))});
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

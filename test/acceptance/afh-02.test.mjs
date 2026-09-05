import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as publicApi from '../../src/index.js';
import { digest, validateWire, relationalWireChecks } from '../../specification/validate-package.mjs';
import { runtimeSnapshot, snapshotStability } from '../../specification/contract-checks.mjs';

const checkout=fileURLToPath(new URL('../../',import.meta.url));
const registry=JSON.parse(fs.readFileSync(path.join(checkout,'specification/contracts.json')));
const fixtures=JSON.parse(fs.readFileSync(path.join(checkout,'specification/fixtures/critical-contracts.json')));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const origin='00000000-0000-4000-8000-000000000404';
async function scenario(t,id,body){
  const base=process.env.AFH_ACCEPTANCE_RUN||os.tmpdir();fs.mkdirSync(base,{recursive:true});
  const run=fs.mkdtempSync(path.join(base,id+'-')),contract=registry.scenarios.find(s=>s.id===id),fixture=fixtures.cases[id];
  const before=runtimeSnapshot(checkout),receipt={scenario_id:id,role:'COMPONENT_OBSERVATION',acceptance_eligible:false,input_class:'SYNTHETIC',runtime_class:typeof publicApi.archiveRequest==='function'?'REAL_AFH':'CONTRACT_ONLY',provider_class:'NONE',candidate_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim(),node:process.version,platform:process.platform,arch:process.arch,runtime_before:before,runner_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),fixture_sha256:contract.fixture_ref.sha256,oracle_sha256:contract.oracle_ref.sha256,requests:[],phase:'PRECONDITION'};
  try{
    assert.equal(digest(fixture),contract.fixture_ref.sha256);assert.equal(digest(fixtures.oracles[id]),contract.oracle_ref.sha256);assert.equal(digest(fixtures.datasets[fixture.dataset_ref.split('/').at(-1)]),fixture.dataset_sha256);
    if(typeof publicApi.archiveRequest!=='function')throw Object.assign(new Error('Canonical public archiveRequest export is absent'),{code:'NOT_IMPLEMENTED'});
    const archive=path.join(run,'archive');let requestIndex=0;
    const call=async(operation,params,options={})=>{
      const request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:id+'-'+(++requestIndex),operation,archive,revision_id:null,params};
      const requestValidation=validateWire(request,'Request');assert.equal(requestValidation.passed,true,JSON.stringify(requestValidation.errors));
      const response=await publicApi.archiveRequest(request,options);receipt.requests.push({request,response});
      const responseValidation=validateWire(response,'Response');assert.equal(responseValidation.passed,true,JSON.stringify(responseValidation.errors));
      assert.deepEqual(relationalWireChecks(response,registry),[]);assert.equal(response.request_id,request.request_id);assert.equal(response.operation,operation);
      return response;
    };
    const initialized=await call('archive.init',{idempotency_key:'init',origin_domains:[{id:origin,harness:'generic',descriptor:'Frozen synthetic acceptance fixture'}]});
    assert.equal(initialized.error,null);assert.equal(initialized.data.schema_version,4);
    receipt.phase='BEHAVIOR';
    await body({run,archive,call,fixture,expected:fixtures.oracles[id].expected,receipt});
    receipt.status='GREEN_BEHAVIOR';
  }catch(error){
    receipt.status=error.code==='NOT_IMPLEMENTED'?'NOT_IMPLEMENTED':error.code==='ERR_ASSERTION'&&receipt.phase==='BEHAVIOR'?'RED_BEHAVIOR':'ERROR_MECHANICAL_OR_PRECONDITION';receipt.reason=error.message;
    if(receipt.status==='NOT_IMPLEMENTED')t.skip(receipt.reason);else throw error;
  }finally{
    receipt.runtime_after=runtimeSnapshot(checkout);receipt.stability=snapshotStability(before,receipt.runtime_after);if(!receipt.stability.stable)receipt.status='EVIDENCE_UNSTABLE';
    fs.writeFileSync(path.join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});t.diagnostic('Evidence: '+path.join(run,'receipt.json'));assert.equal(receipt.stability.stable,true);
  }
}
function source(run,name,bytes){
  const file=path.join(run,name);fs.writeFileSync(file,bytes,{flag:'wx'});
  return {path:file,harness:'generic',origin_domain_id:origin};
}
function manifest(archive,id){return JSON.parse(fs.readFileSync(path.join(archive,'bronze/sources',id+'.json')));}
function objectFiles(archive){
  const files=[];
  function walk(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())walk(file);else files.push(file);}}
  walk(path.join(archive,'bronze/objects'));return files;
}
function inventory(root){
  const files=[];const walk=dir=>{for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),stat=fs.lstatSync(file);assert.equal(stat.isSymbolicLink(),false);if(stat.isDirectory())walk(file);else files.push({path:path.relative(root,file),bytes:stat.size,sha256:hash(fs.readFileSync(file))});}};walk(root);return files;
}
async function readManifestBytes(call,manifest){
  const pieces=[];
  for(const record of manifest.records){
    const response=await call('evidence.read',{uri:record.evidence_ref.uri,format:'base64'});
    assert.equal(response.error,null);assert.equal(response.data.partial,false);
    const bytes=Buffer.from(response.data.payload,'base64');assert.equal(hash(bytes),record.sha256);pieces.push(bytes);
  }
  return Buffer.concat(pieces);
}

test('AFH-02-T01 identical raw payloads share CAS bytes while retaining ten sources',async t=>scenario(t,'AFH-02-T01',async({run,archive,call,fixture,expected,receipt})=>{
  const bytes=Buffer.from(fixture.input.bytes),sources=Array.from({length:fixture.input.copies},(_,i)=>source(run,'source-'+i+'.jsonl',bytes));
  const response=await call('archive.ingest',{sources,include_children:false,idempotency_key:'ingest'});assert.equal(response.error,null);
  const manifests=response.data.source_revisions.map(id=>manifest(archive,id));
  assert.equal(manifests.length,expected.source_references);assert.equal(new Set(manifests.map(m=>m.source_lineage_id)).size,expected.source_references);
  assert.equal(objectFiles(archive).length,expected.payload_objects);
  for(const item of manifests){assert.equal(item.raw_sha256,hash(bytes));assert.deepEqual(await readManifestBytes(call,item),bytes);}
  for(const item of sources)assert.deepEqual(fs.readFileSync(item.path),bytes);
  receipt.observed={payload_objects:objectFiles(archive).length,source_references:manifests.length};
}));

test('AFH-02-T02 different payloads retain distinct objects and exact roundtrip',async t=>scenario(t,'AFH-02-T02',async({run,archive,call,fixture,expected,receipt})=>{
  const sources=fixture.input.payloads.map((text,i)=>source(run,'payload-'+i+'.jsonl',text));
  const response=await call('archive.ingest',{sources,include_children:false,idempotency_key:'ingest'});assert.equal(response.error,null);
  const roundtrip=[];for(const id of response.data.source_revisions)roundtrip.push((await readManifestBytes(call,manifest(archive,id))).toString('utf8'));
  receipt.observed={payload_objects:objectFiles(archive).length,roundtrip};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T03 source manifest covers CRLF and UTF8 bytes exactly',async t=>scenario(t,'AFH-02-T03',async({run,archive,call,fixture,expected,receipt})=>{
  const bytes=Buffer.from(fixture.input.bytes_utf8),input=source(run,'unicode.jsonl',bytes);
  const response=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'ingest'});assert.equal(response.error,null);
  const captured=manifest(archive,response.data.source_revisions[0]);let offset=0;
  for(const object of captured.objects){assert.equal(object.offset,offset);offset+=object.length;}assert.equal(offset,bytes.length);
  const roundtrip=await readManifestBytes(call,captured);receipt.observed={byte_identical:roundtrip.equals(bytes),digest_match:hash(roundtrip)===captured.raw_sha256};assert.deepEqual(receipt.observed,expected);assert.deepEqual(fs.readFileSync(input.path),bytes);
}));

test('AFH-02-T12 imports cases created by pinned legacy runtimes without changing their bytes',async t=>scenario(t,'AFH-02-T12',async({archive,call,fixture,expected,receipt})=>{
  const fixtureReport=process.env.AFH_LEGACY_FIXTURES;
  if(!fixtureReport||!fs.existsSync(fixtureReport))throw Object.assign(new Error('Pinned legacy runtime fixture report is unavailable; do not synthesize version labels'),{code:'UNAVAILABLE'});
  const legacy=JSON.parse(fs.readFileSync(fixtureReport));assert.deepEqual(legacy.versions.map(v=>v.schema),fixture.input.schemas);
  receipt.legacy_inputs_ref=fixtureReport;receipt.legacy_inputs_sha256=hash(fs.readFileSync(fixtureReport));receipt.legacy_observations=[];
  for(const input of legacy.versions){
    const before=inventory(input.case_dir);assert.deepEqual(before,input.case_inventory);
    const imported=await call('archive.import_case',{case_path:input.case_dir,idempotency_key:'import-'+input.version});assert.equal(imported.error,null);
    assert.equal(imported.data.legacy_case_hash,input.case_hash);assert.equal(imported.data.source_inventory_before,imported.data.source_inventory_after);assert.equal(imported.data.alias_count,input.legacy_event_ids.length);
    for(const ref of input.evidence){const response=await call('evidence.read',{uri:ref.uri,format:'base64'});assert.equal(response.error,null);assert.equal(hash(Buffer.from(response.data.payload,'base64')),ref.sha256);}
    // The importer must retain explicit ID mappings as well as URI compatibility.
    const aliasFile=path.join(archive,'legacy',input.case_hash+'.json'),aliases=JSON.parse(fs.readFileSync(aliasFile));
    assert.deepEqual(aliases.events.map(item=>item.legacy_event_id).sort(),input.legacy_event_ids.toSorted());
    assert.ok(aliases.events.every(item=>item.event_id&&item.evidence_refs.length>0));
    assert.deepEqual(inventory(input.case_dir),before);
    receipt.legacy_observations.push({version:input.version,commit:input.commit,before,after:inventory(input.case_dir),aliases});
  }
  assert.equal(expected.source_inventory_equal,true);assert.equal(expected.all_aliases_resolve,true);
  // SQLite write-attempt instrumentation is a separate mandatory control; no zero is inferred from equal inventories.
  receipt.pending_controls=['LEGACY_DATABASE_WRITE_ATTEMPT_INSTRUMENTATION'];
}));

test('AFH-02-T14 future legacy version is rejected with its source intact',async t=>scenario(t,'AFH-02-T14',async({run,call,fixture,expected,receipt})=>{
  const legacy=path.join(run,'future-case');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'case.json'),JSON.stringify({schemaVersion:fixture.input.schema_version,status:'COMPLETE'}));
  const before=inventory(legacy),response=await call('archive.import_case',{case_path:legacy,idempotency_key:'future'});
  assert.equal(response.error?.code,expected.error);assert.equal(response.data,null);assert.deepEqual(inventory(legacy),before);
  receipt.observed={error:response.error.code,source_untouched:true};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T17 corrupted CAS object never returns unverified payload',async t=>scenario(t,'AFH-02-T17',async({run,archive,call,expected,receipt})=>{
  const input=source(run,'source.jsonl','{"message":"synthetic integrity"}\n');
  const ingested=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'ingest'});assert.equal(ingested.error,null);
  const captured=manifest(archive,ingested.data.source_revisions[0]),files=objectFiles(archive);assert.ok(files.length>0);
  const before=fs.readFileSync(files[0]),damaged=Buffer.from(before);damaged[damaged.length-1]^=1;fs.writeFileSync(files[0],damaged);
  const response=await call('evidence.read',{uri:captured.records[0].evidence_ref.uri,format:'base64'});
  receipt.observed={error:response.error?.code,unverified_payload_returned:response.data!==null};assert.deepEqual(receipt.observed,expected);
  receipt.corruption={object:files[0],before_sha256:hash(before),after_sha256:hash(damaged)};
}));

test('AFH-02-T18 valid unknown JSON and invalid JSON retain distinct coverage states',async t=>scenario(t,'AFH-02-T18',async({run,archive,call,expected,receipt})=>{
  const bytes=Buffer.from('{"unknown_synthetic_record":true}\n{invalid}\n'),input=source(run,'unknown.jsonl',bytes);
  const response=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'ingest'});assert.equal(response.error,null);
  const coverage=response.data.coverage;
  receipt.observed={preserved:coverage.records_preserved,parsed:coverage.records_parsed,unsupported:coverage.records_unsupported,unparsed:coverage.records_unparsed,normalization_pass:coverage.records_normalized===coverage.records_preserved};assert.deepEqual(receipt.observed,expected);
  assert.deepEqual(await readManifestBytes(call,manifest(archive,response.data.source_revisions[0])),bytes);
  assert.equal(response.status,'PARTIAL');
}));

test('AFH-02-T19 exact101 expansion ratio fails limit100 without replacing prior revision',async t=>scenario(t,'AFH-02-T19',async({run,archive,call,fixture,expected,receipt})=>{
  const plain=Buffer.alloc(fixture.input.input_ratio*1000,0x4d),gzip=zlib.gzipSync(plain);
  const header=Buffer.from(gzip.subarray(0,10));header[3]|=16;
  const padding=Buffer.alloc(1000-gzip.length-1,0x61);
  const compressed=Buffer.concat([header,padding,Buffer.from([0]),gzip.subarray(10)]);
  assert.equal(compressed.length,1000);assert.equal(plain.length/compressed.length,fixture.input.input_ratio);assert.deepEqual(zlib.gunzipSync(compressed),plain);
  const input=source(run,'ratio101.jsonl.gz',compressed),before=fs.readFileSync(path.join(archive,'archive.json'));
  const response=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'bomb'});assert.equal(response.error?.code,expected.error);assert.equal(response.data,null);
  assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),before);
  const verification=await call('archive.verify',{deep:true});assert.equal(verification.data.passed,true);
  assert.deepEqual(fs.readFileSync(input.path),compressed);receipt.observed={error:response.error.code,prior_revision_usable:verification.data.passed};assert.deepEqual(receipt.observed,expected);
}));

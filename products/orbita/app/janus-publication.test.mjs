import test from 'node:test';import assert from 'node:assert/strict';import native from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {randomBytes} from 'node:crypto';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
import {lab,artifact,seed,cli,crash,publisher} from './graph-common-fixture.mjs';
const app=path.dirname(fileURLToPath(import.meta.url));
test('F30 mandatory real common PostgreSQL whole readbacks, structural links, current permissions and fencing',()=>{
 const result=JSON.parse(execFileSync(process.env.ORBITA_POSTGRES_PYTHON,['-X','utf8','-B',path.join(app,'test_janus_native.py')],{env:process.env,encoding:'utf8',windowsHide:true,timeout:300000}));assert.equal(result.status,'PASS');assert.equal(result.tests,26);assert.equal(result.skipped,0);console.log('Nested real common graph checks: '+JSON.stringify(result));
});
test('F30 actual processes resume mirror crashes after N04, objects, receipt and selector with one logical generation',async()=>{
 for(const point of ['janus-after-n04','janus-after-objects','janus-after-receipt','janus-after-selector']){
  const data=path.join(lab('mirror-crash-'),'data'),f=seed(data),input={op:'publish',backend:'postgresql-verified',conversationIds:f.ids,outboxId:f.entry.outboxId};
  const crashed=crash(input,data,point,65000);assert.equal(crashed.status,86,crashed.stderr);assert.match(crashed.stderr,/86/);await new Promise(r=>setTimeout(r,12500));
  const result=cli(input,data,65000),replay=cli(input,data,65000);assert.equal(result.state,'selected');assert.equal(result.generation,replay.generation);assert.deepEqual(result.remoteReceipt,replay.remoteReceipt);assert.equal(replay.replayed,true);const q=cli({op:'query',backend:'postgresql-verified',conversationIds:f.ids,generation:result.generation,sourceCut:result.sourceCut},data,65000);assert.equal(q.items.length,2);
 }
});
test('F30 two real publishers serialize and keep the same verified generation and receipt',async()=>{
 const data=path.join(lab('mirror-rivals-'),'data'),f=seed(data);cli({op:'publish',conversationIds:f.ids,outboxId:f.entry.outboxId},data,65000);
 const input={op:'publish',backend:'postgresql-verified',conversationIds:f.ids,outboxId:f.entry.outboxId};
 const [a,b]=await Promise.all([publisher(input,data),publisher(input,data)]);assert.equal(a.generation,b.generation);assert.deepEqual(a.remoteReceipt,b.remoteReceipt);assert.equal(a.state,'selected');assert.equal(b.state,'selected');
});
test('F30 encrypted independent restore preserves graph mirrors and never imports external access rights',async()=>{
 const dir=lab('mirror-restore-'),data=path.join(dir,'data');process.env.AFH_COSMOS_DATA=data;
 const {graphFixture}=await import('./graph-fixture.mjs'),{graphOperation}=await import('./graph-publication.mjs'),f=await graphFixture(),r=await graphOperation('publish',{conversationIds:f.ids,outboxId:f.entry.outboxId,backend:'postgresql-verified'}),request={op:'query',conversationIds:f.ids,generation:r.generation,sourceCut:r.sourceCut},expected=await graphOperation('query',request),verified=await graphOperation('query',{...request,backend:'postgresql-verified'});
 const {createBackup,restoreBackup}=await import('./recovery.mjs'),archive=path.join(artifact('mirror-backup-'),'graph.orbita'),destination=path.join(dir,'restored');const password=randomBytes(24).toString('hex');await createBackup({source:data,archive,password,ownSession:true});await restoreBackup({archive,destination,password});assert.deepEqual(cli(request,destination,65000),expected);
 assert.throws(()=>cli({...request,backend:'janusgraph'},destination,65000),/NOT_QUALIFIED/);
 const fresh=cli({...request,backend:'postgresql-verified'},destination,65000);assert.deepEqual(fresh.items,verified.items);assert.deepEqual(fresh.remoteVerification.receipt,verified.remoteVerification.receipt);assert.ok(fresh.remoteVerification.readAt>verified.remoteVerification.readAt);assert.equal(fresh.remoteVerification.receipt.readbackHashes.length,2);
});
test.after(async()=>{try{const {closeMemory}=await import('./memory.mjs');await closeMemory();}finally{closeCommonStore();assert.equal(native.existsSync(process.env.ORBITA_POSTGRES_TEST_ROOT),false);}});

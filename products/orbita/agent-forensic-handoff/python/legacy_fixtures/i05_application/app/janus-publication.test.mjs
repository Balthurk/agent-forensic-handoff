import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync,spawnSync,spawn} from 'node:child_process';import {randomUUID,randomBytes} from 'node:crypto';
const app=path.dirname(fileURLToPath(import.meta.url)),config=JSON.parse(fs.readFileSync(process.env.AFH_G1_JANUS_TEST_CONFIG,'utf8')),lab=fs.mkdtempSync(path.join(config.testRoot,'node-janus-'));
const run=(file,args,env)=>JSON.parse(execFileSync(file,args,{env,encoding:'utf8',windowsHide:true,timeout:65000}));
function connection(data,dir){const name=path.join(dir,'connection.json');fs.writeFileSync(name,JSON.stringify({schema:1,endpoints:config.endpoints,roots:{[data]:{namespace:randomUUID().replaceAll('-',''),active:true}}}));return name;}
const seed=path.join(lab,'seed.mjs');fs.writeFileSync(seed,`import {graphFixture} from ${JSON.stringify(new URL('./graph-fixture.mjs',import.meta.url).href)};console.log(JSON.stringify(await graphFixture()));`);
function cli(input,env,dir){const request=path.join(dir,'request.json');fs.writeFileSync(request,JSON.stringify(input));return run(process.execPath,[path.join(app,'memory-cli.mjs'),'graph-publication',request],env);}
test('F30 mandatory real JanusGraph whole readbacks, structural links, current permissions and fencing',()=>{
 const result=JSON.parse(execFileSync(process.env.AFH_VOLUME_PYTHON||'python',['-X','utf8','-B',path.join(app,'test_janus_native.py')],{env:process.env,encoding:'utf8',windowsHide:true,timeout:300000}));assert.equal(result.status,'PASS');assert.equal(result.tests,26);assert.equal(result.skipped,0);console.log('Nested real Janus checks: '+JSON.stringify(result));
});
test('F30 actual processes resume Janus crashes after N04, objects, receipt and selector with one logical generation',async()=>{
 for(const point of ['janus-after-n04','janus-after-objects','janus-after-receipt','janus-after-selector']){
  const dir=fs.mkdtempSync(path.join(lab,'crash-')),data=path.join(dir,'data'),env={...process.env,AFH_COSMOS_DATA:data,AFH_G1_JANUS_CONFIG:connection(data,dir),AFH_CRASH_AT:''};const f=run(process.execPath,[seed],env),input={op:'publish',backend:'janusgraph',conversationIds:f.ids,outboxId:f.entry.outboxId},file=path.join(dir,'request.json');fs.writeFileSync(file,JSON.stringify(input));
  const crashed=spawnSync(process.execPath,[path.join(app,'memory-cli.mjs'),'graph-publication',file],{env:{...env,AFH_CRASH_AT:point},encoding:'utf8',windowsHide:true,timeout:65000});assert.notEqual(crashed.status,0);assert.match(crashed.stderr,/86/);await new Promise(r=>setTimeout(r,12500));
  const result=cli(input,env,dir),replay=cli(input,env,dir);assert.equal(result.state,'selected');assert.equal(result.generation,replay.generation);assert.deepEqual(result.remoteReceipt,replay.remoteReceipt);assert.equal(replay.replayed,true);const q=cli({op:'query',backend:'janusgraph',conversationIds:f.ids,generation:result.generation,sourceCut:result.sourceCut},env,dir);assert.equal(q.items.length,2);
 }
});
test('F30 two real publishers serialize and keep the same verified generation and receipt',async()=>{
 const dir=fs.mkdtempSync(path.join(lab,'rivals-')),data=path.join(dir,'data'),env={...process.env,AFH_COSMOS_DATA:data,AFH_G1_JANUS_CONFIG:connection(data,dir),AFH_CRASH_AT:''},f=run(process.execPath,[seed],env);cli({op:'publish',conversationIds:f.ids,outboxId:f.entry.outboxId},env,dir);
 const file=path.join(dir,'parallel.json');fs.writeFileSync(file,JSON.stringify({op:'publish',backend:'janusgraph',conversationIds:f.ids,outboxId:f.entry.outboxId}));
 const worker=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(app,'memory-cli.mjs'),'graph-publication',file],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>{if(code!==0)reject(new Error(err));else try{resolve(JSON.parse(out));}catch(e){reject(e);}});});
 const [a,b]=await Promise.all([worker(),worker()]);assert.equal(a.generation,b.generation);assert.deepEqual(a.remoteReceipt,b.remoteReceipt);assert.equal(a.state,'selected');assert.equal(b.state,'selected');
});
test('F30 encrypted independent restore preserves local graph and keeps remote rights paused even with missing config',async()=>{
 const dir=fs.mkdtempSync(path.join(lab,'restore-')),data=path.join(dir,'data');process.env.AFH_COSMOS_DATA=data;process.env.AFH_G1_JANUS_CONFIG=connection(data,dir);
 const {graphFixture}=await import('./graph-fixture.mjs'),{graphOperation}=await import('./graph-publication.mjs'),f=await graphFixture(),r=await graphOperation('publish',{conversationIds:f.ids,outboxId:f.entry.outboxId,backend:'janusgraph'}),request={op:'query',conversationIds:f.ids,generation:r.generation,sourceCut:r.sourceCut},expected=await graphOperation('query',request);
 const {createBackup,restoreBackup}=await import('./recovery.mjs'),archive=path.join(dir,'graph.orbita'),destination=path.join(dir,'restored');const password=randomBytes(24).toString('hex');await createBackup({source:data,archive,password,ownSession:true});await restoreBackup({archive,destination,password});const env={...process.env,AFH_COSMOS_DATA:destination,AFH_G1_JANUS_CONFIG:path.join(dir,'absent.json')};assert.deepEqual(cli(request,env,dir),expected);
 assert.throws(()=>cli({...request,backend:'janusgraph'},env,dir),/EXTERNAL_ACCESS_PAUSED/);delete process.env.AFH_G1_JANUS_CONFIG;
});

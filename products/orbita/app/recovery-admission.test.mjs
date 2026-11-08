import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {commonFixture} from './common-test-scope.mjs';
import {nativeFixture,runtimeEnv} from './common-test-fixtures.mjs';
import {conversation,original} from './reevaluation-fixture.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=commonFixture('recovery-admission-');
async function start(label){
 const events=new EventEmitter(),messages=[];let output='',errors='';
 const child=spawn(process.execPath,['--import',new URL('./recovery-admission-fixture.mjs',import.meta.url).href,path.join(here,'server.mjs')],{env:{...runtimeEnv({data:path.join(root,label)}),AFH_COSMOS_PORT:'0',ORBITA_RECOVERY_ADMISSION_FIXTURE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 child.on('message',message=>{messages.push(message);events.emit('message',message);});
 child.stdout.on('data',chunk=>{output+=chunk;events.emit('output');});child.stderr.on('data',chunk=>errors+=chunk);
 function wait(kind,type='fixture-held'){
  const existing=messages.find(m=>m.type===type&&m.kind===kind);if(existing)return Promise.resolve(existing);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{events.off('message',receive);reject(Error('FIXTURE_BARRIER_TIMEOUT:'+kind));},30000);
   const receive=m=>{if(m.type===type&&m.kind===kind){clearTimeout(timer);events.off('message',receive);resolve(m);}};events.on('message',receive);
  });
 }
 const ready=()=>output.match(/ORBITA (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(Error('REAL_SERVER_START_TIMEOUT:'+errors)),30000);
  const inspect=()=>{if(ready())finish();},exited=()=>finish(Error('REAL_SERVER_EXITED:'+errors));
  function finish(error){clearTimeout(timer);events.off('output',inspect);child.off('exit',exited);error?reject(error):resolve();}
  events.on('output',inspect);child.once('exit',exited);inspect();
 });}catch(error){if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;throw error;}
 return {url:ready(),child,closed,wait,messages,
  async arm(kind){const ready=wait(kind,'fixture-armed');child.send({type:'fixture-arm',kind});await ready;},
  release(){if(child.connected)child.send({type:'fixture-release'});},
  async stop(){this.release();if(child.connected)child.send({type:'fixture-stop'});let timer;
   try{const value=await Promise.race([closed,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('OWNED_SERVER_CLOSE_TIMEOUT')),20000))]);assert.equal(value.code,0,errors);assert.equal(value.signal,null);}
   finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill();await closed;}}
  }};
}
async function request(server,route,body){
 const response=await fetch(server.url+route,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
 return {status:response.status,value:await response.json()};
}
async function complete(server,id){
 const deadline=Date.now()+60000;
 for(;;){const result=(await request(server,'/api/jobs/'+id)).value;if(result.status!=='running')return result;
  assert.ok(Date.now()<deadline,'OWNED_RECOVERY_JOB_DEADLINE');await delay(20);
 }
}

test('I08 backup waits for a real GET transport and restored originals match in another server',async()=>{
 const server=await start('get-live'),directory=nativeFixture('recovery-admission-get'),archive=path.join(directory,'snapshot.orbita'),password='synthetic-recovery-admission-only';
 let pending,job,recovered;
 try{
  const imported=await request(server,'/api/import',conversation('memory',original));assert.equal(imported.status,200,JSON.stringify(imported));const id=imported.value.result.id;
  const before=await request(server,'/api/retrieve',{question:'reunión',conversationIds:[id],retrieval:{mode:'lexical'}});assert.ok(before.value.evidence.length);
  await server.arm('get');pending=request(server,'/api/bootstrap?recovery-fixture=hold');await server.wait('get');
  job=await request(server,'/api/recovery',{op:'backup',archive,password});assert.equal(job.status,202,JSON.stringify(job));
  const waiting=(await request(server,'/api/jobs/'+job.value.id)).value;
  assert.equal(waiting.admission?.state,'waiting','A08_BACKUP_DID_NOT_WAIT_FOR_TRANSPORT');
  assert.ok(waiting.admission.http>=1);assert.equal(native.existsSync(archive),false);
  server.release();assert.equal((await pending).status,200);pending=null;
  const saved=await complete(server,job.value.id);assert.equal(saved.status,'complete',JSON.stringify(saved));assert.equal(saved.result.validation.conversations,1);
  const destination=path.join(root,'get-restored');job=await request(server,'/api/recovery',{op:'restore',archive,password,destination});assert.equal(job.status,202);
  assert.equal((await complete(server,job.value.id)).status,'complete');
  recovered=await start('get-restored');const after=await request(recovered,'/api/retrieve',{question:'reunión',conversationIds:[id],retrieval:{mode:'lexical'}});
  assert.equal(after.status,200,JSON.stringify(after));assert.deepEqual(after.value.evidence,before.value.evidence);
 }finally{
  server.release();if(pending)await pending;if(job?.value.id)await complete(server,job.value.id);
  if(recovered)await recovered.stop();await server.stop();
 }
});

test('I08 backup admits bounded waiting for an import already inside its real handler',async()=>{
 const server=await start('import-live'),directory=nativeFixture('recovery-admission-import'),archive=path.join(directory,'snapshot.orbita'),password='synthetic-recovery-admission-only';
 let pending,job;
 try{
  await server.arm('import');pending=request(server,'/api/import',conversation('memory',original));await server.wait('import');
  job=await request(server,'/api/recovery',{op:'backup',archive,password});
  assert.equal(job.status,202,'A08_BACKUP_REJECTED_ACTIVE_IMPORT:'+JSON.stringify(job));
  const waiting=(await request(server,'/api/jobs/'+job.value.id)).value;assert.equal(waiting.admission?.state,'waiting');assert.ok(waiting.admission.http>=1);
  assert.equal(native.existsSync(archive),false);server.release();assert.equal((await pending).status,200);pending=null;
  const saved=await complete(server,job.value.id);assert.equal(saved.status,'complete',JSON.stringify(saved));assert.equal(saved.result.validation.conversations,1);
 }finally{server.release();if(pending)await pending;if(job?.value.id)await complete(server,job.value.id);await server.stop();}
});

for(const kind of ['index','query','automatic','resume'])test('I08 recovery drains real '+kind+' work before its exclusive cut',async()=>{
 const server=await start(kind+'-live'),directory=nativeFixture('recovery-admission-'+kind),archive=path.join(directory,'snapshot.orbita'),password='synthetic-recovery-admission-only';
 let pending,job,work;
 try{
  const imported=await request(server,'/api/import',conversation('memory',original));assert.equal(imported.status,200);const id=imported.value.result.id;
  await server.arm(kind);
  if(kind==='index'){work=await request(server,'/api/index',{conversationIds:[id]});assert.equal(work.status,202);}
  else if(kind==='query')pending=request(server,'/api/retrieve',{question:'reunión',conversationIds:[id],retrieval:{mode:'lexical'}});
  else server.child.send({type:'fixture-automatic',kind});
  await server.wait(kind);
  job=await request(server,'/api/recovery',{op:'backup',archive,password});assert.equal(job.status,202);
  const waiting=(await request(server,'/api/jobs/'+job.value.id)).value;
  assert.equal(waiting.admission?.state,'waiting');assert.ok(waiting.admission[kind==='index'?'background':kind==='query'?'http':'automatic']>=1);
  assert.equal(native.existsSync(archive),false);
  assert.equal((await request(server,'/api/recovery',{op:'backup',archive:archive+'.second',password})).status,409);
  assert.equal((await request(server,'/api/bootstrap')).status,503);
  server.release();if(pending){const value=await pending;pending=null;assert.equal(value.status,200);assert.ok(value.value.evidence.length);}
  if(work)assert.equal((await complete(server,work.value.id)).status,'complete');
  const saved=await complete(server,job.value.id);assert.equal(saved.status,'complete',JSON.stringify(saved));assert.equal(saved.result.validation.conversations,1);
  assert.equal((await request(server,'/api/bootstrap')).status,200);
 }finally{server.release();if(pending)await pending;if(work?.value.id)await complete(server,work.value.id);if(job?.value.id)await complete(server,job.value.id);await server.stop();}
});

for(const mode of ['cancel','deadline'])test('I08 '+mode+' during admission creates no archive and permits a fresh retry',async()=>{
 const server=await start(mode+'-live'),directory=nativeFixture('recovery-admission-'+mode),archive=path.join(directory,'snapshot.orbita'),password='synthetic-recovery-admission-only';
 let pending,job;
 try{
  assert.equal((await request(server,'/api/import',conversation('memory',original))).status,200);
  await server.arm('get');pending=request(server,'/api/bootstrap?recovery-fixture=hold');await server.wait('get');
  job=await request(server,'/api/recovery',{op:'backup',archive,password,waitTimeoutMs:mode==='deadline'?500:15000});assert.equal(job.status,202);
  assert.equal((await request(server,'/api/jobs/'+job.value.id)).value.admission.state,'waiting');
  if(mode==='cancel')assert.equal((await request(server,'/api/jobs/'+job.value.id+'/cancel',{})).status,200);
  const ended=await complete(server,job.value.id);assert.equal(ended.status,mode==='cancel'?'cancelled':'error');
  assert.match(ended.error,mode==='cancel'?/CALLER_CANCELLED/:/RECOVERY_DRAIN_TIMEOUT/);assert.equal(ended.cancellable,false);
  assert.equal(native.existsSync(archive),false);assert.equal((await request(server,'/api/recovery/status')).value.busy,false);
  server.release();assert.equal((await pending).status,200);pending=null;
  job=await request(server,'/api/recovery',{op:'backup',archive,password});assert.equal(job.status,202);
  assert.equal((await complete(server,job.value.id)).status,'complete');assert.equal((await request(server,'/api/bootstrap')).status,200);
 }finally{server.release();if(pending)await pending;if(job?.value.id)await complete(server,job.value.id);await server.stop();}
});

test('I08 an active recovery cannot claim cancellation while the real engine continues',async()=>{
 const server=await start('active-cancel'),directory=nativeFixture('recovery-admission-active'),archive=path.join(directory,'snapshot.orbita'),password='synthetic-recovery-admission-only';let job;
 try{
  assert.equal((await request(server,'/api/import',conversation('memory',original))).status,200);
  await server.arm('backup');job=await request(server,'/api/recovery',{op:'backup',archive,password});assert.equal(job.status,202);await server.wait('backup');
  const active=(await request(server,'/api/jobs/'+job.value.id)).value;assert.equal(active.admission.state,'active');assert.equal(active.cancellable,false);
  const cancelled=await request(server,'/api/jobs/'+job.value.id+'/cancel',{});assert.equal(cancelled.status,409);assert.match(cancelled.value.error,/RECOVERY_ALREADY_STARTED/);
  assert.equal((await request(server,'/api/jobs/'+job.value.id)).value.status,'running');assert.equal(native.existsSync(archive),false);
  server.release();assert.equal((await complete(server,job.value.id)).status,'complete');
 }finally{server.release();if(job?.value.id)await complete(server,job.value.id);await server.stop();}
});

test('I08 another real server keeps its shared store lease and a backup retries only after it closes',async()=>{
 const server=await start('external-reader'),directory=nativeFixture('recovery-admission-external'),archive=path.join(directory,'snapshot.orbita'),password='synthetic-recovery-admission-only';let reader,job;
 try{
  assert.equal((await request(server,'/api/import',conversation('memory',original))).status,200);reader=await start('external-reader');
  job=await request(server,'/api/recovery',{op:'backup',archive,password});assert.equal(job.status,202);
  const denied=await complete(server,job.value.id);assert.equal(denied.status,'error');assert.match(denied.error,/RECOVERY_STORE_BUSY/);assert.equal(native.existsSync(archive),false);
  assert.equal((await request(reader,'/api/bootstrap')).status,200);
  await reader.stop();reader=null;job=await request(server,'/api/recovery',{op:'backup',archive,password});assert.equal(job.status,202);
  assert.equal((await complete(server,job.value.id)).status,'complete');
 }finally{if(reader)await reader.stop();if(job?.value.id)await complete(server,job.value.id);await server.stop();}
});

for(const warm of [false,true])test('I08 C01 loss of an owned '+(warm?'indexed':'cold')+' parent drains its real bridges and permits recovery',async()=>{
 const label='parent-loss-'+warm,server=await start(label),directory=nativeFixture('recovery-parent-loss'),archive=path.join(directory,'snapshot.orbita'),password='synthetic-recovery-admission-only';
 let pending,job,restarted,crashed=false;
 try{
  const imported=await request(server,'/api/import',conversation('memory',original));assert.equal(imported.status,200);const id=imported.value.result.id;
  if(warm){const index=await request(server,'/api/index',{conversationIds:[id]});assert.equal(index.status,202);assert.equal((await complete(server,index.value.id)).status,'complete');}
  await server.arm('get');pending=request(server,'/api/bootstrap?recovery-fixture=hold');pending.catch(()=>{});await server.wait('get');
  job=await request(server,'/api/recovery',{op:'backup',archive,password});assert.equal(job.status,202);assert.equal((await request(server,'/api/jobs/'+job.value.id)).value.admission.state,'waiting');
  assert.equal(server.child.kill(),true);const terminated=await server.closed;crashed=true;assert.ok(terminated.code!==0||terminated.signal!==null);
  await assert.rejects(pending);pending=null;assert.equal(native.existsSync(archive),false);
  restarted=await start(label);const evidence=await request(restarted,'/api/retrieve',{question:'reunión',conversationIds:[id],retrieval:{mode:'lexical'}});assert.equal(evidence.status,200);assert.ok(evidence.value.evidence.length);
  job=await request(restarted,'/api/recovery',{op:'backup',archive,password});assert.equal(job.status,202);
  const saved=await complete(restarted,job.value.id);assert.equal(saved.status,'complete',JSON.stringify(saved));assert.equal(saved.result.validation.conversations,1);
 }finally{if(restarted){if(job?.value.id)await complete(restarted,job.value.id);await restarted.stop();}if(!crashed){server.release();if(pending)await pending;if(job?.value.id)await complete(server,job.value.id);await server.stop();}}
});

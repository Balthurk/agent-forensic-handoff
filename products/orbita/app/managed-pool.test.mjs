import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {syncBuiltinESMExports} from 'node:module';
import {AccessStore} from './access-store.mjs';
import {createAccessServer} from './access-server.mjs';
import {terminateOwned} from './owned-process.mjs';

const password='synthetic-worker-pool-only';
const policy=()=>({basis:'Synthetic source permission for worker regression',purpose:'Isolated worker lifecycle checks',rightsUntil:new Date(Date.now()+86400000).toISOString(),retainUntil:new Date(Date.now()+172800000).toISOString()});
async function fixture(count=6){
 const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','a11-')),store=new AccessStore(root,{create:true}),owner=store.createAccount('owner',password,{admin:true});
 const spaces=Array.from({length:count},(_,i)=>{const w=store.createWorkspace(owner.id,{name:'Synthetic space '+i,policy:policy()});return {...w,token:store.issue(owner.id,{workspace:w.id}).token};});store.close();
 const app=createAccessServer({root,port:0});await new Promise((r,j)=>{app.server.once('error',j);app.server.listen(0,'127.0.0.1',r);});const base='http://127.0.0.1:'+app.server.address().port;
 const call=async(i,route='/api/bootstrap',body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{connection:'close',authorization:'Bearer '+spaces[i].token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,value:await r.json()};};
 return {app,root,owner,spaces,base,call};
}
function observeForks(intercept){
 const original=cp.fork,live=new Set(),events=[];let maximum=0;
 cp.fork=function(...args){const child=original.apply(this,args);live.add(child);maximum=Math.max(maximum,live.size);events.push({event:'fork',pid:child.pid,live:live.size});child.once('close',()=>{live.delete(child);events.push({event:'close',pid:child.pid,live:live.size});});intercept?.(child);return child;};syncBuiltinESMExports();
 return {live,events,get maximum(){return maximum;},restore(){cp.fork=original;syncBuiltinESMExports();}};
}

test('I04 A11 five real spaces reuse only a fully idle worker without exceeding four live children',async()=>{
 const observation=observeForks();let f;
 try{
  f=await fixture();for(let i=0;i<4;i++){const r=await f.call(i);assert.equal(r.status,200,JSON.stringify(r.value));assert.equal(r.value.library.length,0);}
  const first=f.app.workers.items.get(f.spaces[0].id),fifth=await f.call(4);assert.equal(fifth.status,200,JSON.stringify(fifth.value));assert.equal(fifth.value.library.length,0);
  assert.ok(observation.events.some(e=>e.event==='close'&&e.pid===first.child.pid),'oldest idle child closed before admission');
  assert.equal(observation.maximum,4);assert.equal(observation.live.size,4);
  assert.equal((await f.call(0)).status,200);assert.notEqual(f.app.workers.items.get(f.spaces[0].id).child.pid,first.child.pid);assert.equal(observation.maximum,4);
 }finally{await f?.app.close();observation.restore();assert.equal(observation.live.size,0);}
});

async function eventually(predicate,label,timeout=20000){
 const end=Date.now()+timeout;while(Date.now()<end){const value=await predicate();if(value)return value;await delay(20);}assert.fail('Timed out: '+label);
}
function partialUpload(f,i){
 let req;const result=new Promise(resolve=>{
  req=http.request(f.base+'/api/documents',{method:'POST',headers:{connection:'close',authorization:'Bearer '+f.spaces[i].token,'content-type':'application/json'}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(text)}));});
  req.on('error',e=>resolve({error:e.code}));req.write('{');
 });
 return {req,result,finish(){req.end(JSON.stringify({filename:'upload-'+i+'.md',content:'# Actual upload '+i+'\nOnly workspace '+i,metadata:{title:'Upload '+i}}).slice(1));}};
}
function preload(f){
 const prior=process.env.NODE_OPTIONS,priorDir=process.env.ORBITA_ACTIVITY_FIXTURE_DIR,dir=path.join(f.root,'activity-barriers');fs.mkdirSync(dir);
 process.env.NODE_OPTIONS=(prior?prior+' ':'')+'--import='+new URL('./managed-activity-fixture.mjs',import.meta.url).href;process.env.ORBITA_ACTIVITY_FIXTURE_DIR=dir;
 return {file(i,name){return path.join(dir,f.spaces[i].id,name);},release(i,kind){fs.writeFileSync(this.file(i,kind+'-release'),'release real operation');},restore(){if(prior===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=prior;if(priorDir===undefined)delete process.env.ORBITA_ACTIVITY_FIXTURE_DIR;else process.env.ORBITA_ACTIVITY_FIXTURE_DIR=priorDir;}};
}

test('I04 A11 partial real uploads reserve workers before body parsing and abort releases only its lease',async()=>{
 const observation=observeForks();let f;const uploads=[];
 try{
  f=await fixture();for(let i=0;i<4;i++)assert.equal((await f.call(i)).status,200);
  for(let i=0;i<4;i++)uploads.push(partialUpload(f,i));await eventually(()=>f.app.workers.holds.size===4,'four incoming HTTP bodies');
  assert.equal((await f.call(4)).status,429);assert.equal(observation.events.filter(e=>e.event==='close').length,0);
  uploads[3].req.destroy();await uploads[3].result;await eventually(()=>!f.app.workers.holds.has(f.spaces[3].id),'aborted HTTP released');
  assert.equal((await f.call(4)).status,200);assert.equal(observation.maximum,4);
  for(let i=0;i<3;i++){uploads[i].finish();assert.equal((await uploads[i].result).status,200);const r=await f.call(i);assert.equal(r.value.library[0].title,'Upload '+i);}
 }finally{for(const u of uploads)u.req.destroy();await f?.app.close();observation.restore();assert.equal(observation.live.size,0);}
});

test('I04 A11 real worker responses remain busy after their handlers return and until transport close',async()=>{
 const observation=observeForks();let f,barriers;const requests=[],controllers=[];
 try{
  f=await fixture();barriers=preload(f);
  for(let i=0;i<4;i++){
   assert.equal((await f.call(i)).status,200);const w=f.app.workers.items.get(f.spaces[i].id),controller=new AbortController();controllers.push(controller);
   requests.push(fetch('http://127.0.0.1:'+w.port+'/api/bootstrap?activity-fixture=hold',{headers:{'x-orbita-worker':w.secret,connection:'close'},signal:controller.signal}).then(async r=>({status:r.status,value:await r.json()})).catch(e=>({error:e.name})));
  }
  await eventually(()=>[0,1,2,3].every(i=>fs.existsSync(barriers.file(i,'response-entered'))),'four actual worker responses');
  assert.equal(f.app.workers.holds.size,0,'direct authenticated responses bypass parent holds');assert.equal((await f.call(4)).status,429);assert.equal(observation.events.filter(e=>e.event==='close').length,0);
  barriers.release(0,'response');assert.equal((await requests[0]).status,200);assert.equal((await f.call(4)).status,200);
  for(let i=1;i<4;i++){barriers.release(i,'response');const r=await requests[i];assert.equal(r.status,200);assert.equal(r.value.library.length,0);}
  assert.equal(observation.maximum,4);
 }finally{for(const c of controllers)c.abort();await f?.app.close();barriers?.restore();observation.restore();assert.equal(observation.live.size,0);}
});

test('I04 A11 real indexing stays protected after202 and after a cancellation label until its promise finishes',{timeout:180000},async()=>{
 const observation=observeForks();let f,barriers;const jobs=[];
 try{
  f=await fixture();barriers=preload(f);
  for(let i=0;i<4;i++){
   assert.equal((await f.call(i,'/api/documents',{filename:'index-'+i+'.md',content:'# Context '+i+'\nThe real local index must retain this source.',metadata:{title:'Indexed '+i}})).status,200);
   const id=(await f.call(i)).value.library[0].id,r=await f.call(i,'/api/index',{conversationIds:[id]});assert.equal(r.status,202,JSON.stringify(r));jobs.push(r.value.id);
  }
  await eventually(()=>[0,1,2,3].every(i=>fs.existsSync(barriers.file(i,'index-entered'))),'four real indexing promises');
  assert.equal(f.app.workers.holds.size,0);assert.equal((await f.call(4)).status,429);assert.equal((await f.call(0,'/api/jobs/'+jobs[0]+'/cancel',{})).value.status,'cancelled');
  assert.equal((await f.call(4)).status,429,'cancelled status does not mean promise completion');assert.equal(observation.events.filter(e=>e.event==='close').length,0);
  for(let i=0;i<4;i++){
   barriers.release(i,'index');const result=await eventually(async()=>{const r=await f.call(i,'/api/jobs/'+jobs[i]);assert.equal(r.status,200);assert.notEqual(r.value.status,'error',JSON.stringify(r.value));return r.value.status==='complete'?r.value:null;},'actual provider/index completion '+i,60000);
   assert.equal(result.result.length,1);const coverage=await f.call(i,'/api/coverage');assert.equal(coverage.value[0].semantic.status,'indexed');assert.ok(coverage.value[0].semantic.records>0);
   if(i===0){assert.equal((await f.call(4)).status,200);for(let j=1;j<4;j++)assert.ok(f.app.workers.items.has(f.spaces[j].id),'other real jobs still alive');}
  }
  assert.equal(observation.maximum,4);
 }finally{await f?.app.close();barriers?.restore();observation.restore();assert.equal(observation.live.size,0);}
});

test('I04 A11 concurrent startup and replacement count children until close and never exceed four',async()=>{
 const ready=[];let holdReady=true;const observation=observeForks(child=>{const emit=child.emit;child.emit=function(type,...args){if(holdReady&&type==='message'&&args[0]?.type==='orbita-ready'){ready.push(()=>emit.call(this,type,...args));return true;}return emit.call(this,type,...args);};});let f;const requests=[];
 try{
  f=await fixture();for(let i=0;i<4;i++)requests.push(f.call(i));await eventually(()=>ready.length===4,'four actual children started with ready pending');
  assert.equal(f.app.workers.slots.size,4);assert.equal(f.app.workers.items.size,0);assert.equal((await f.call(4)).status,429);assert.equal(observation.maximum,4);
  holdReady=false;for(const send of ready)send();for(const r of await Promise.all(requests))assert.equal(r.status,200);
  const results=await Promise.all([f.call(4),f.call(5)]);assert.deepEqual(results.map(r=>r.status),[200,200]);assert.equal(observation.maximum,4);
  assert.equal(f.app.workers.pending.size,0);assert.equal(f.app.workers.slots.size,4);
 }finally{holdReady=false;for(const send of ready)send();await f?.app.close();await Promise.allSettled(requests);observation.restore();assert.equal(observation.live.size,0);}
});

for(const mode of ['wrong-nonce','malformed','late','unconfirmed-resume'])test('I04 A11 '+mode+' IPC never permits eviction without exact idle and resume acknowledgements',async()=>{
 const observation=observeForks();let f,worker,emit;const uploads=[];let blocked=true,injected=false,late;
 try{
  f=await fixture();for(let i=0;i<4;i++)assert.equal((await f.call(i)).status,200);
  for(let i=1;i<4;i++)uploads.push(partialUpload(f,i));await eventually(()=>f.app.workers.holds.size===3,'three busy uploads');
  worker=f.app.workers.items.get(f.spaces[0].id);emit=worker.child.emit;
  worker.child.emit=function(type,...args){
   const m=args[0];
   if(type==='message'&&m?.type==='orbita-quiesced'&&!injected){
    injected=true;
    if(mode==='wrong-nonce')return emit.call(this,type,{...m,nonce:'00000000-0000-0000-0000-000000000000'},...args.slice(1));
    if(mode==='malformed')return emit.call(this,type,{...m,idle:'true'},...args.slice(1));
    if(mode==='late')late=()=>emit.call(this,type,...args);
    return true;
   }
   if(type==='message'&&m?.type==='orbita-resumed'){
    if(mode==='unconfirmed-resume'&&blocked)return true;
    const result=emit.call(this,type,...args);late?.();late=null;return result;
   }
   return emit.call(this,type,...args);
  };
  const r=await f.call(4);assert.equal(r.status,429,JSON.stringify(r));assert.equal(observation.events.filter(e=>e.event==='close').length,0);
  if(mode==='unconfirmed-resume'){
   assert.equal(worker.state,'uncertain');assert.equal(f.app.workers.slots.size,4);const unavailable=await f.call(0);assert.equal(unavailable.status,503);assert.equal(worker.state,'uncertain');blocked=false;
  }else assert.equal(worker.state,'running');
  assert.equal((await f.call(0)).status,200);assert.equal(f.app.workers.items.get(f.spaces[0].id),worker);
  assert.equal((await f.call(4)).status,200);assert.ok(worker.closedSeen);assert.equal(observation.maximum,4);
  for(const upload of uploads){upload.finish();assert.equal((await upload.result).status,200);}
 }finally{if(worker&&emit)worker.child.emit=emit;for(const u of uploads)u.req.destroy();await f?.app.close();observation.restore();assert.equal(observation.live.size,0);}
});

test('I04 A11 a real child exit retains its slot until close is observed',async()=>{
 const observation=observeForks();let f,worker,emit,closeEvent;const uploads=[];
 try{
  f=await fixture();for(let i=0;i<4;i++)assert.equal((await f.call(i)).status,200);
  for(let i=1;i<4;i++)uploads.push(partialUpload(f,i));await eventually(()=>f.app.workers.holds.size===3,'three live HTTP holds');
  worker=f.app.workers.items.get(f.spaces[0].id);emit=worker.child.emit;worker.child.emit=function(type,...args){if(type==='close'){closeEvent=()=>emit.call(this,type,...args);return true;}return emit.call(this,type,...args);};
  terminateOwned(worker.child);await eventually(()=>worker.exited&&closeEvent,'actual exit with close delivery held');
  assert.equal(f.app.workers.slots.size,4);assert.equal((await f.call(4)).status,429);assert.equal(observation.maximum,4);
  worker.child.emit=emit;closeEvent();closeEvent=null;await worker.closed;assert.equal((await f.call(4)).status,200);assert.equal(observation.maximum,4);
  for(const upload of uploads){upload.finish();assert.equal((await upload.result).status,200);}
 }finally{if(worker&&emit)worker.child.emit=emit;closeEvent?.();for(const u of uploads)u.req.destroy();await f?.app.close();observation.restore();assert.equal(observation.live.size,0);}
});

test('I04 A11 suspension during actual startup cannot publish or revive the pending child',async()=>{
 let ready,hold=true;const observation=observeForks(child=>{const emit=child.emit;child.emit=function(type,...args){if(hold&&type==='message'&&args[0]?.type==='orbita-ready'){ready=()=>emit.call(this,type,...args);return true;}return emit.call(this,type,...args);};});let f,pending;
 try{
  f=await fixture();pending=f.call(0);await eventually(()=>ready,'actual ready held before publication');const oldPid=[...observation.live][0].pid;
  f.app.store.policy(f.owner.id,f.spaces[0].id,{suspended:true,reason:'Synthetic suspension during startup'});const stopping=f.app.workers.stop(f.spaces[0].id);hold=false;ready();
  const r=await pending;assert.ok([403,503].includes(r.status));await stopping;assert.equal(f.app.workers.items.size,0);assert.equal(f.app.workers.slots.size,0);assert.equal(observation.live.size,0);
  assert.equal((await f.call(0)).status,403);f.app.store.policy(f.owner.id,f.spaces[0].id,{suspended:false,reason:'Synthetic explicit resume'});
  assert.equal((await f.call(0)).status,200);assert.notEqual(f.app.workers.items.get(f.spaces[0].id).child.pid,oldPid);
 }finally{hold=false;ready?.();await f?.app.close();if(pending)await pending;observation.restore();assert.equal(observation.live.size,0);}
});

test('I04 A11 close during an admission handshake drains pending and exact owned children',async()=>{
 const observation=observeForks();let f,worker,emit,pending,seen=false;
 try{
  f=await fixture();for(let i=0;i<4;i++)assert.equal((await f.call(i)).status,200);
  worker=f.app.workers.items.get(f.spaces[0].id);emit=worker.child.emit;worker.child.emit=function(type,...args){if(type==='message'&&args[0]?.type==='orbita-quiesced'){seen=true;return true;}return emit.call(this,type,...args);};
  pending=f.call(4);await eventually(()=>seen,'actual quiesce awaiting parent acknowledgement');await f.app.close();const r=await pending;assert.equal(r.status,503);
  assert.equal(f.app.workers.pending.size,0);assert.equal(f.app.workers.slots.size,0);assert.equal(f.app.workers.items.size,0);assert.equal(observation.live.size,0);assert.equal(observation.maximum,4);
 }finally{if(worker&&emit)worker.child.emit=emit;await f?.app.close();if(pending)await pending;observation.restore();assert.equal(observation.live.size,0);}
});

for(const mode of ['concurrent','retry'])test('I04 A11 service close '+mode+' waits for the exact close boundary',{timeout:30000},async()=>{
 const observation=observeForks();let f,worker,emit,closeEvent,first,second;
 try{
  f=await fixture();assert.equal((await f.call(0)).status,200);worker=f.app.workers.items.get(f.spaces[0].id);emit=worker.child.emit;
  worker.child.emit=function(type,...args){if(type==='close'){closeEvent=()=>emit.call(this,type,...args);return true;}return emit.call(this,type,...args);};
  first=f.app.close().then(()=>({ok:true}),error=>({error}));await eventually(()=>closeEvent,'actual owned child exit before close delivery');
  if(mode==='concurrent'){
   let complete=false;second=f.app.close().then(()=>{complete=true;});await delay(20);assert.equal(complete,false,'a concurrent close must not report completion early');
  }else{
   const r=await first;assert.match(r.error?.message||'',/ACCESS_WORKER_CLOSE_INCOMPLETE/);assert.equal(f.app.workers.slots.size,1);assert.equal(f.app.server.listening,true);
  }
  worker.child.emit=emit;closeEvent();closeEvent=null;await worker.closed;
  if(mode==='retry')await f.app.close();else{assert.equal((await first).ok,true);await second;}
  assert.equal(f.app.server.listening,false);assert.equal(f.app.workers.slots.size,0);assert.equal(observation.live.size,0);
 }finally{
  if(worker&&emit)worker.child.emit=emit;closeEvent?.();await first;await second;await f?.app.close();
  // Also release this isolated fixture if the expected red close implementation
  // returned early without closing its listener/store.
  if(f?.app.server.listening){await new Promise(r=>f.app.server.close(r));f.app.store.close();}
  observation.restore();assert.equal(observation.live.size,0);
 }
});

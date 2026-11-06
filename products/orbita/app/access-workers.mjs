import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {terminateOwned} from './owned-process.mjs';
import {demand} from './access-store.mjs';
import {plainPath} from './store-access.mjs';

function workerEnvironment(store,id,secret,configuration){
 const allowed=new Set(['systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','pythonutf8','pythondontwritebytecode','orbita_postgres_python','afh_python','afh_model_home']);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toLowerCase())));
 Object.assign(env,{ORBITA_POSTGRES_BINDING:JSON.stringify(configuration),AFH_PYTHON:process.env.AFH_PYTHON||process.env.ORBITA_POSTGRES_PYTHON,AFH_MODEL_HOME:plainPath(process.env.AFH_MODEL_HOME||fileURLToPath(new URL('../runtime/models/',import.meta.url))),AFH_COSMOS_DATA:path.join(store.workspaceRoot(id),'data'),AFH_COSMOS_PORT:'0',AFH_PRIVATE_TOKEN:secret,AFH_MANAGED:'1'});
 // A test may install only these checked-in observers, and only with native
 // barriers inside its explicit receipt root, outside the content namespace.
 const imports=[];
 for(const [name,file] of [['ORBITA_ACTIVITY_FIXTURE_DIR','managed-activity-fixture.mjs'],['ORBITA_TRANSPORT_FIXTURE_DIR','managed-transport-fixture.mjs']]){
  if(!process.env[name])continue;
  demand(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'ACCESS_WORKER_FIXTURE_ROOT');
  const root=plainPath(process.env.ORBITA_POSTGRES_TEST_RECEIPTS),dir=plainPath(process.env[name]),relative=path.relative(root,dir);
  demand(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'ACCESS_WORKER_FIXTURE_ROOT');
  const virtual=process.env.ORBITA_POSTGRES_TEST_ROOT&&path.relative(plainPath(process.env.ORBITA_POSTGRES_TEST_ROOT),dir);
  demand(virtual&&(virtual.startsWith('..')||path.isAbsolute(virtual)),'ACCESS_WORKER_FIXTURE_CONTENT_BOUNDARY');
  env[name]=dir;imports.push('--import='+new URL('./'+file,import.meta.url).href);
 }
 if(imports.length)env.NODE_OPTIONS=imports.join(' ');
 return env;
}

export class Workers{
 constructor(store){
  this.store=store;this.items=new Map();this.pending=new Map();this.stopping=new Map();this.slots=new Map();this.holds=new Map();this.closed=false;this.sequence=0;this.allocator=Promise.resolve();
  this.timer=setInterval(()=>{for(const [id,slot] of this.slots){try{store.active(store.workspace(id));if(slot.epoch!==undefined)demand(store.managedState(id).epoch===slot.epoch,'ACCESS_WORKER_EPOCH');}catch{void this.stop(id).catch(()=>{});}}},500);this.timer.unref();
 }
 admit(id){demand(!this.closed&&!this.stopping.has(id),'ACCESS_WORKER_STOPPING',503);this.store.active(this.store.workspace(id));}
 hold(id){
  this.admit(id);const slot=this.slots.get(id);demand(!slot||!['retiring','stopping'].includes(slot.state),'ACCESS_WORKER_STOPPING',503);
  this.holds.set(id,(this.holds.get(id)||0)+1);if(slot)slot.lastUsed=++this.sequence;let released=false;
  return ()=>{if(released)return;released=true;const n=this.holds.get(id)-1;if(n)this.holds.set(id,n);else this.holds.delete(id);const current=this.slots.get(id);if(current)current.lastUsed=++this.sequence;};
 }
 exclusive(fn){const task=this.allocator.then(fn);this.allocator=task.catch(()=>{});return task;}
 async get(id){
  this.admit(id);const current=this.slots.get(id);
  if(current?.state==='running'){if(this.store.managedState(id).epoch!==current.epoch){await this.stop(id);return this.get(id);}current.lastUsed=++this.sequence;return current;}
  demand(!current||!['retiring','stopping'].includes(current.state),'ACCESS_WORKER_STOPPING',503);
  if(this.pending.has(id))return this.pending.get(id);
  const task=Promise.resolve().then(()=>this.allocate(id)).then(slot=>slot.state==='running'?slot:this.start(id,slot));
  this.pending.set(id,task);try{return await task;}finally{if(this.pending.get(id)===task)this.pending.delete(id);}
 }
 async allocate(id){return this.exclusive(async()=>{
  this.admit(id);
  const own=this.slots.get(id);
  if(own){demand(own.state==='uncertain','ACCESS_WORKER_STOPPING',503);await this.resume(own);this.admit(id);demand(own.state==='running','ACCESS_WORKER_RECOVERY_PENDING',503);return own;}
  // An unanswered pause keeps its slot. A later attempt can recover the same
  // child only after an explicit resume acknowledgement for that exact epoch.
  for(const slot of this.slots.values())if(slot.state==='uncertain'&&!this.stopping.has(slot.id))try{await this.resume(slot);}catch{}
  if(this.slots.size>=4){
   const candidates=[...this.slots.values()].filter(w=>w.state==='running'&&!this.holds.has(w.id)&&!this.stopping.has(w.id)).sort((a,b)=>a.lastUsed-b.lastUsed);
   for(const slot of candidates){
    this.admit(id);if(slot.state!=='running'||this.holds.has(slot.id)||this.slots.get(slot.id)!==slot)continue;
    slot.state='retiring';slot.nonce=randomUUID();let answer;
    try{answer=await this.rpc(slot,'orbita-quiesce','orbita-quiesced');}catch{}
    if(this.slots.get(slot.id)!==slot||slot.state!=='retiring')continue;
    if(answer?.idle===true&&!this.holds.has(slot.id)){
     slot.state='stopping';this.terminate(slot);await this.waitClosed(slot);break;
    }
    if(answer?.idle===false){slot.state='running';slot.nonce=null;continue;}
    slot.state='uncertain';try{await this.resume(slot);}catch{}
   }
  }
  this.admit(id);demand(this.slots.size<4,[...this.slots.values()].some(w=>w.state==='uncertain')?'ACCESS_WORKER_RECOVERY_PENDING':'ACCESS_WORKER_LIMIT',429);
  const slot={id,state:'starting',lastUsed:++this.sequence,child:null,port:null,secret:null,nonce:null,exited:false,closedSeen:false,terminationStarted:false};
  slot.closed=new Promise(resolve=>slot.resolveClosed=resolve);this.slots.set(id,slot);return slot;
 });}
 rpc(slot,type,reply){return new Promise((resolve,reject)=>{
  const child=slot.child,nonce=slot.nonce;let timer,done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);child?.removeListener('message',message);child?.removeListener('exit',exit);child?.removeListener('error',errorEvent);error?reject(error):resolve(value);};
  const exit=()=>finish(new Error('ACCESS_WORKER_EXIT')),errorEvent=e=>finish(e);
  const message=m=>{if(m?.nonce!==nonce||m?.type!==reply)return;if((reply==='orbita-quiesced'&&typeof m.idle!=='boolean')||(reply==='orbita-resumed'&&m.resumed!==true))return finish(new Error('ACCESS_WORKER_PROTOCOL'));finish(null,m);};
  if(!child?.connected||slot.exited||slot.closedSeen)return reject(new Error('ACCESS_WORKER_EXIT'));
  child.on('message',message);child.once('exit',exit);child.once('error',errorEvent);timer=setTimeout(()=>finish(new Error('ACCESS_WORKER_QUIESCE_TIMEOUT')),2000);
  try{child.send({type,nonce},e=>{if(e)finish(e);});}catch(e){finish(e);}
 });}
 async resume(slot){
  await this.rpc(slot,'orbita-resume','orbita-resumed');
  demand(this.slots.get(slot.id)===slot&&!slot.exited&&!this.closed&&!this.stopping.has(slot.id)&&slot.state==='uncertain','ACCESS_WORKER_STOPPING',503);
  demand(this.store.managedState(slot.id).epoch===slot.epoch,'ACCESS_WORKER_EPOCH',503);
  slot.state='running';slot.nonce=null;
 }
 releaseSlot(slot){
  slot.closedSeen=true;slot.state='closed';if(this.slots.get(slot.id)===slot)this.slots.delete(slot.id);if(this.items.get(slot.id)===slot)this.items.delete(slot.id);slot.resolveClosed();
 }
 terminate(slot){
  if(slot.terminationStarted||slot.exited||slot.closedSeen||!slot.child)return;
  slot.terminationStarted=true;slot.stopDeadline??=Date.now()+15000;
  const child=slot.child;let forced=false;
  const force=()=>{if(forced||slot.exited||slot.closedSeen)return;forced=true;terminateOwned(child);};
  // The worker closes its HTTP, providers and common-store bridge, then its
  // own IPC endpoint. Parent-initiated disconnect can omit close in Node24.
  // Keep the slot until the real close event and PostgreSQL drain.
  // The fallback uses the same owned child and never extends the stop deadline.
  if(!child.connected){force();return;}
  const timer=setTimeout(force,5000);child.once('exit',()=>clearTimeout(timer));
  try{child.send({type:'orbita-shutdown',nonce:randomUUID()},error=>{if(error){clearTimeout(timer);force();}});}catch{clearTimeout(timer);force();}
 }
 async drain(id,deadline){
  for(;;){const state=this.store.drainContent(id);if(state.backends===0)return state;demand(Date.now()<deadline,'ACCESS_WORKER_STOP_TIMEOUT',503);await delay(Math.min(100,Math.max(1,deadline-Date.now())));}
 }
 async waitClosed(slot){
  if(slot.finishing)return slot.finishing;
  const deadline=slot.stopDeadline??=Date.now()+15000;
  const task=(async()=>{let timer;try{await Promise.race([slot.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('ACCESS_WORKER_STOP_TIMEOUT')),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}await this.drain(slot.id,deadline);this.releaseSlot(slot);})();
  slot.finishing=task;try{return await task;}finally{if(slot.finishing===task)slot.finishing=null;}
 }
 async start(id,slot){
  try{
   this.admit(id);const binding=this.store.workerConfiguration(id);slot.epoch=binding.epoch;
   slot.secret=randomBytes(32).toString('base64url');const env=workerEnvironment(this.store,id,slot.secret,binding.configuration);
   const child=slot.child=fork(fileURLToPath(new URL('./server.mjs',import.meta.url)),[],{env,execArgv:[],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
   child.once('exit',()=>{slot.exited=true;slot.state='stopping';if(this.items.get(id)===slot)this.items.delete(id);});
   child.once('close',()=>{slot.closedSeen=true;slot.resolveClosed();void this.waitClosed(slot).catch(()=>{});});
   await new Promise((resolve,reject)=>{
    const finish=(error)=>{clearTimeout(timer);child.removeListener('error',errorEvent);child.removeListener('exit',exit);child.removeListener('message',message);error?reject(error):resolve();};
    const errorEvent=e=>finish(e),exit=()=>finish(new Error('ACCESS_WORKER_EXIT')),message=m=>{if(m?.type==='orbita-ready'&&Number.isInteger(m.port)&&m.port>0&&m.port<65536){slot.port=m.port;finish();}};
    const timer=setTimeout(()=>finish(new Error('ACCESS_WORKER_START_TIMEOUT')),20000);child.once('error',errorEvent);child.once('exit',exit);child.on('message',message);
   });
   this.admit(id);demand(this.store.managedState(id).epoch===slot.epoch,'ACCESS_WORKER_EPOCH',503);demand(!slot.exited&&this.slots.get(id)===slot,'ACCESS_WORKER_EXIT',503);slot.state='running';this.items.set(id,slot);return slot;
  }catch(e){if(!slot.child)this.releaseSlot(slot);else{slot.state='stopping';this.terminate(slot);await this.waitClosed(slot);}throw e;}
 }
 async stop(id){
  if(this.stopping.has(id))return this.stopping.get(id);
  // Publish stopping before waiting for admission/startup, so neither can
  // revive this workspace while revocation or maintenance is closing it.
  const task=Promise.resolve().then(async()=>{
   let slot=this.slots.get(id),deadline=Date.now()+15000;if(slot?.child){slot.state='stopping';this.terminate(slot);deadline=slot.stopDeadline??deadline;}
   const pending=this.pending.get(id);if(pending)try{await pending;}catch{}
   slot=this.slots.get(id);if(slot){slot.state='stopping';this.terminate(slot);await this.waitClosed(slot);}else await this.drain(id,deadline);
  });
  this.stopping.set(id,task);try{await task;}finally{if(this.stopping.get(id)===task)this.stopping.delete(id);}
 }
 async close(){
  this.closed=true;clearInterval(this.timer);const results=await Promise.allSettled([...new Set([...this.slots.keys(),...this.pending.keys()])].map(id=>this.stop(id)));
  const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'ACCESS_WORKER_CLOSE_INCOMPLETE');
 }
}

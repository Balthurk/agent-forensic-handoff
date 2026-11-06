import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import files from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore,observeCommonWorker} from '../agent-forensic-handoff/src/common-store.js';
import {nativeFixture} from './common-test-fixtures.mjs';
import {AccessStore} from './access-store.mjs';

files.mkdirSync(process.env.ORBITA_POSTGRES_TEST_ROOT,{recursive:true});
const root=files.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'federation-shutdown-'));
process.env.AFH_COSMOS_DATA=path.join(root,'client');
const {registerStore,queryBackend}=await import('./federation.mjs');
const control=new AccessStore(path.join(root,'control'),{create:true});
const owner=control.createAccount('owner','Synthetic shutdown qualification password',{admin:true});
const filesURL=new URL('../agent-forensic-handoff/src/common-files.js',import.meta.url).href;
test.after(()=>{try{control.close();}finally{closeCommonStore();assert.equal(native.existsSync(root),false);}});

for(const mode of ['invalid','cancel'])test(`real federation ${mode} holder closes when taskkill is unavailable`,{timeout:45000},async()=>{
 const workspace=control.createWorkspace(owner.id,{name:'Synthetic shutdown fixture',policy:{basis:'Synthetic sources only',purpose:'Owned process shutdown',rightsUntil:new Date(Date.now()+86400000).toISOString(),retainUntil:new Date(Date.now()+172800000).toISOString()}});
 const data=path.join(control.workspaceRoot(workspace.id),'data'),route={...registerStore({root:data,scope:'shutdown',initialize:true}),conversationIds:[]};
 const base=nativeFixture('federation-shutdown'),ready=path.join(base,'ready.json'),script=path.join(base,'worker.mjs');
 native.writeFileSync(script,`import native from 'node:fs';import files from ${JSON.stringify(filesURL)};
 process.on('message',message=>{if(message.type!=='query')return;
 files.openSync(process.env.AFH_COSMOS_DATA+'/library.json','r');
 native.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,ownerId:process.env.ORBITA_POSTGRES_OWNER_ID}));
 if(${JSON.stringify(mode)}==='invalid')process.send({ok:true,package:{bytes:1,evidence:[],backends:[]}});
 setInterval(()=>{},1000);
 });`,{flag:'wx'});
 const originalFork=cp.fork,originalExecFile=cp.execFile,controller=new AbortController();
 let child,closed,closeSeen=false,killCalls=0,taskkillCalls=0,pending,info;
 cp.fork=function(...args){
  const actual=Reflect.apply(originalFork,this,args);
  if(args[0]===script){child=actual;actual.once('close',()=>{closeSeen=true;});closed=once(actual,'close');const kill=actual.kill;actual.kill=function(...killArgs){killCalls++;return Reflect.apply(kill,this,killArgs);};}
  return actual;
 };
 cp.execFile=function(command,args,options,callback){
  if(process.platform==='win32'&&String(command).toLowerCase()==='taskkill'){
   assert.ok(child);assert.equal(args[1],String(child.pid));taskkillCalls++;
   queueMicrotask(()=>callback(Object.assign(new Error('SYNTHETIC_TASKKILL_UNAVAILABLE'),{code:'EACCES'}),'',''));
   return undefined;
  }
  return Reflect.apply(originalExecFile,this,arguments);
 };
 syncBuiltinESMExports();
 try{
  pending=queryBackend(route,'synthetic',{maxBytes:10000},{signal:controller.signal,remainingMs:30000,worker:script});
  const deadline=performance.now()+15000;
  while(!native.existsSync(ready)){assert.ok(performance.now()<deadline,'REAL_WORKER_READY_TIMEOUT');await delay(20);}
  info=JSON.parse(native.readFileSync(ready,'utf8'));assert.equal(info.pid,child.pid);assert.ok(observeCommonWorker(info.ownerId).backends>0);
  if(mode==='cancel')controller.abort(new Error('SYNTHETIC_CALLER_CANCEL'));
  const value=await pending;
  assert.equal(value.status,mode==='cancel'?'cancelled':'unavailable');
  assert.equal(value.error,mode==='cancel'?'SYNTHETIC_CALLER_CANCEL':'FEDERATION_BACKEND_BUDGET_OR_INTEGRITY');
  assert.equal(value.cleanupVerified,true);assert.equal(value.package,undefined);
  assert.equal(closeSeen,true);assert.equal(observeCommonWorker(info.ownerId).backends,0);
  if(process.platform==='win32'){assert.equal(taskkillCalls,1);assert.equal(killCalls,1);}
  if(mode==='cancel')assert.equal(value.stopMode,'forced_after_grace');
 }finally{
  cp.fork=originalFork;cp.execFile=originalExecFile;syncBuiltinESMExports();
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  if(closed)await Promise.race([closed,delay(10000,undefined,{ref:false}).then(()=>{throw new Error('OWNED_WORKER_CLEANUP_TIMEOUT');})]);
  if(pending)await pending;
  if(info){const deadline=performance.now()+10000;while(observeCommonWorker(info.ownerId).backends!==0){assert.ok(performance.now()<deadline,'OWNED_POSTGRES_CLEANUP_TIMEOUT');await delay(20);}}
 }
});

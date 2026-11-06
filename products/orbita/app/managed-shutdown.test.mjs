import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import native from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import files from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
import {AccessStore} from './access-store.mjs';
import {createAccessServer} from './access-server.mjs';

test.after(()=>{const closed=closeCommonStore();assert.equal(closed.drained,true);});
const password='synthetic-graceful-worker-only';
async function fixture(){
 files.mkdirSync(process.env.ORBITA_POSTGRES_TEST_ROOT,{recursive:true});
 const root=files.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'managed-shutdown-'));
 const store=new AccessStore(root,{create:true}),owner=store.createAccount('owner',password,{admin:true});
 const workspace=store.createWorkspace(owner.id,{name:'Synthetic managed shutdown',policy:{basis:'Synthetic source permission',purpose:'Real owned-worker shutdown regression',rightsUntil:new Date(Date.now()+86400000).toISOString(),retainUntil:new Date(Date.now()+172800000).toISOString()}});store.close();
 const app=createAccessServer({root,port:0});await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 return {root,app,workspace};
}
function observe(){
 const fork=cp.fork,execFile=cp.execFile,children=[],forced=[];
 cp.fork=function(...args){
  const child=fork.apply(this,args),record={child,shutdowns:0,closed:false,code:null};children.push(record);
  const send=child.send;child.send=function(...values){if(values[0]?.type==='orbita-shutdown'){record.shutdowns++;assert.match(values[0].nonce,/^[a-f0-9-]{36}$/);}return send.apply(this,values);};
  child.once('close',(code,signal)=>{record.closed=true;record.code=code;record.signal=signal;});return child;
 };
 cp.execFile=function(...args){if(/^taskkill(?:\.exe)?$/i.test(path.basename(String(args[0]))))forced.push(args[1]?.[1]);return execFile.apply(this,args);};
 syncBuiltinESMExports();return {children,forced,restore(){cp.fork=fork;cp.execFile=execFile;syncBuiltinESMExports();}};
}
async function entered(file){const deadline=Date.now()+20000;while(Date.now()<deadline){if(native.existsSync(file))return;await delay(20);}assert.fail('Actual worker response did not reach its native observation barrier');}

test('PG01 managed shutdown asks the real server to close and verifies PostgreSQL drain',async()=>{
 const seen=observe();let f;
 try{
  f=await fixture();const worker=await f.app.workers.get(f.workspace.id);
  const response=await fetch('http://127.0.0.1:'+worker.port+'/api/bootstrap',{headers:{'x-orbita-worker':worker.secret,connection:'close'}});assert.equal(response.status,200);assert.equal((await response.json()).library.length,0);
  await f.app.workers.stop(f.workspace.id);
  assert.equal(seen.children.length,1);assert.equal(seen.children[0].shutdowns,1);assert.equal(seen.children[0].closed,true);assert.equal(seen.children[0].code,0);assert.equal(seen.children[0].signal,null);assert.deepEqual(seen.forced,[]);
  assert.equal(worker.exited,true);assert.equal(worker.closedSeen,true);assert.equal(f.app.workers.slots.size,0);assert.equal(f.app.store.drainContent(f.workspace.id).backends,0);
  assert.equal(native.existsSync(f.root),false);
 }finally{try{await f?.app.close();}finally{seen.restore();assert.ok(seen.children.every(c=>c.closed));}}
});

test('PG01 managed shutdown closes an actual retained HTTP response before releasing its slot',async()=>{
 const seen=observe(),previous=process.env.ORBITA_ACTIVITY_FIXTURE_DIR,controller=new AbortController();let f,pending;
 const barrier=native.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'shutdown-response-'));process.env.ORBITA_ACTIVITY_FIXTURE_DIR=barrier;
 try{
  f=await fixture();const worker=await f.app.workers.get(f.workspace.id);
  pending=fetch('http://127.0.0.1:'+worker.port+'/api/bootstrap?activity-fixture=hold',{headers:{'x-orbita-worker':worker.secret,connection:'close'},signal:controller.signal}).then(async r=>({status:r.status,value:await r.json()})).catch(error=>({error}));
  await entered(path.join(barrier,f.workspace.id,'response-entered'));assert.equal(seen.children[0].closed,false);
  await f.app.close();const outcome=await pending;assert.ok(outcome.error instanceof Error);
  assert.equal(seen.children[0].shutdowns,1);assert.equal(seen.children[0].closed,true);assert.equal(seen.children[0].code,0);assert.deepEqual(seen.forced,[]);
  assert.equal(worker.exited,true);assert.equal(worker.closedSeen,true);assert.equal(f.app.workers.slots.size,0);assert.equal(f.app.server.listening,false);assert.equal(native.existsSync(f.root),false);
 }finally{
  controller.abort();await Promise.allSettled([pending]);
  try{await f?.app.close();}finally{if(previous===undefined)delete process.env.ORBITA_ACTIVITY_FIXTURE_DIR;else process.env.ORBITA_ACTIVITY_FIXTURE_DIR=previous;seen.restore();assert.ok(seen.children.every(c=>c.closed));}
 }
});

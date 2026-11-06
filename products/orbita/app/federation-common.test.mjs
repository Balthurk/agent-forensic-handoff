import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import files from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore,commonWorkerConfiguration,observeCommonWorker} from '../agent-forensic-handoff/src/common-store.js';
import {commonWorkerEnv} from './common-worker-env.mjs';
import {nativeFixture} from './common-test-fixtures.mjs';
import {AccessStore} from './access-store.mjs';

files.mkdirSync(process.env.ORBITA_POSTGRES_TEST_ROOT,{recursive:true});
const root=files.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'federation-common-'));
process.env.AFH_COSMOS_DATA=path.join(root,'client');
const {registerStore,queryBackend}=await import('./federation.mjs');
const control=new AccessStore(path.join(root,'control'),{create:true});
const owner=control.createAccount('owner','Synthetic federation common password',{admin:true});
control.createAccount('reader','Synthetic federation reader password');
const policy=()=>({basis:'Synthetic inputs only',purpose:'Federation scope and owned processes',rightsUntil:new Date(Date.now()+86400000).toISOString(),retainUntil:new Date(Date.now()+172800000).toISOString()});
const filesURL=new URL('../agent-forensic-handoff/src/common-files.js',import.meta.url).href;
const commonURL=new URL('../agent-forensic-handoff/src/common-store.js',import.meta.url).href;
const make=()=>{const workspace=control.createWorkspace(owner.id,{name:'Fixture',policy:policy()}),data=path.join(control.workspaceRoot(workspace.id),'data');return {workspace,data,route:{...registerStore({root:data,scope:'same',initialize:true}),conversationIds:[]}};};
const awaitCondition=async(fn,message)=>{const deadline=performance.now()+15000;while(!fn()){if(performance.now()>deadline)throw new Error(message);await delay(20);}};
function fixture(mode='early'){
 const base=nativeFixture('federation-worker'),ready=path.join(base,'ready.json'),release=path.join(base,'release'),script=path.join(base,'worker.mjs');
 const code=`import native from 'node:fs';import files from ${JSON.stringify(filesURL)};import {closeCommonStore} from ${JSON.stringify(commonURL)};let timer,fd;
 process.on('message',message=>{if(message.type!=='query')return;fd=files.openSync(process.env.AFH_COSMOS_DATA+'/library.json','r');
 native.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,ownerId:process.env.ORBITA_POSTGRES_OWNER_ID,envKeys:Object.keys(process.env),execArgv:process.execArgv}));
 const pkg={bytes:0,evidence:[],backends:[]};let old;do{old=pkg.bytes;pkg.bytes=Buffer.byteLength(JSON.stringify(pkg));}while(pkg.bytes!==old);
 if(${JSON.stringify(mode)}!=='ignore')process.send({ok:true,package:${JSON.stringify(mode)}==='invalid'?{...pkg,bytes:pkg.bytes+1}:pkg});
 timer=setInterval(()=>{if(!native.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);files.closeSync(fd);closeCommonStore();process.send({type:'drained',verified:true});process.disconnect();},20);
 });`;
 native.writeFileSync(script,code,{flag:'wx'});
 return {base,ready,release,script};
}
async function started(route,mode='early'){
 const f=fixture(mode),controller=new AbortController();let settled=false;
 const result=queryBackend(route,'fixture',{maxBytes:10000},{signal:controller.signal,remainingMs:30000,worker:f.script}).then(value=>{settled=true;return value;});
 await awaitCondition(()=>native.existsSync(f.ready)||settled,'WORKER_READY_TIMEOUT');assert.equal(settled,false,JSON.stringify(await (settled?result:Promise.resolve(null))));
 return {...f,controller,result,isSettled:()=>settled,readyInfo:JSON.parse(native.readFileSync(f.ready,'utf8'))};
}
test.after(()=>{try{control.close();}finally{closeCommonStore();assert.equal(native.existsSync(root),false);}});

test('delegation keeps the original child root and excludes sibling parent and inherited secrets',()=>{
 const a=make(),b=make(),configuration=commonWorkerConfiguration(a.data),expected=control.workerConfiguration(a.workspace.id).configuration;
 assert.deepEqual(configuration,expected);assert.equal(configuration.bindings.length,1);assert.equal(configuration.bindings[0].root,control.workspaceRoot(a.workspace.id));
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='synthetic-must-not-inherit';
 let env;try{env=commonWorkerEnv(configuration,{data:a.data,ownerId:randomUUID()});}finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
 const code=`import assert from 'node:assert/strict';import files from ${JSON.stringify(filesURL)};import {commonWorkerConfiguration,closeCommonStore} from ${JSON.stringify(commonURL)};try{assert.equal(files.readFileSync(${JSON.stringify(path.join(a.data,'library.json'))},'utf8'),'[]');for(const p of ${JSON.stringify([path.join(b.data,'library.json'),path.join(root,'control/access.pgstore')])})assert.throws(()=>files.readFileSync(p),/PATH_NOT_BOUND/);const cfg=commonWorkerConfiguration(${JSON.stringify(a.data)});const canonicalRoot=x=>process.platform==='win32'?x.toLowerCase():x;assert.equal(canonicalRoot(cfg.bindings[0].root),canonicalRoot(${JSON.stringify(configuration.bindings[0].root)}));for(const key of ['OPENAI_API_KEY','ORBITA_POSTGRES_CONFIG','ORBITA_POSTGRES_TEST_OPERATOR_CONFIG','ORBITA_POSTGRES_TEST_CONFIG','NODE_OPTIONS'])assert.equal(process.env[key],undefined);}finally{closeCommonStore();}`;
 const p=spawnSync(process.execPath,['--input-type=module','-e',code],{env,encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(p.status,0,p.stderr);
 assert.equal(observeCommonWorker(env.ORBITA_POSTGRES_OWNER_ID).backends,0);
});

test('a valid early IPC result stays pending until the actual Node and PostgreSQL owners close',async()=>{
 const a=make(),f=await started(a.route);
 try{assert.ok(observeCommonWorker(f.readyInfo.ownerId).backends>0);await delay(100);assert.equal(f.isSettled(),false);assert.deepEqual(f.readyInfo.execArgv,[]);assert.equal(f.readyInfo.envKeys.some(k=>k.startsWith('ORBITA_POSTGRES_TEST_')||k==='ORBITA_POSTGRES_CONFIG'),false);native.writeFileSync(f.release,'release',{flag:'wx'});const value=await f.result;assert.equal(value.status,'ok');assert.equal(value.cleanupVerified,true);assert.equal(observeCommonWorker(f.readyInfo.ownerId).backends,0);}
 finally{if(!f.isSettled()){f.controller.abort(new Error('TEST_CLEANUP'));await f.result;}}
});

test('actual PostgreSQL ownership keeps a result pending even after its Node worker has exited',async()=>{
 const a=make(),f=await started(a.route),configuration=commonWorkerConfiguration(a.data);
 const code=`import files from ${JSON.stringify(filesURL)};import {closeCommonStore} from ${JSON.stringify(commonURL)};const fd=files.openSync(${JSON.stringify(path.join(a.data,'library.json'))},'r');console.log('READY');process.stdin.once('data',()=>{files.closeSync(fd);closeCommonStore();process.stdin.pause();});`;
 const holder=spawn(process.execPath,['--input-type=module','-e',code],{env:commonWorkerEnv(configuration,{data:a.data,ownerId:f.readyInfo.ownerId}),windowsHide:true,stdio:['pipe','pipe','pipe']});const closed=once(holder,'close');let stderr='';holder.stderr.on('data',b=>stderr+=b);
 try{const ready=await Promise.race([once(holder.stdout,'data',{signal:AbortSignal.timeout(15000)}),closed.then(()=>{throw new Error('HOLDER_EXIT_BEFORE_READY '+stderr);})]);assert.match(ready[0].toString(),/READY/);native.writeFileSync(f.release,'release',{flag:'wx'});
  await awaitCondition(()=>{try{process.kill(f.readyInfo.pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}},'NODE_WORKER_NOT_CLOSED');
  assert.ok(observeCommonWorker(f.readyInfo.ownerId).backends>0);assert.equal(f.isSettled(),false);
  holder.stdin.end('close');assert.equal((await closed)[0],0,stderr);const value=await f.result;assert.equal(value.status,'ok');assert.equal(value.cleanupVerified,true);assert.equal(observeCommonWorker(f.readyInfo.ownerId).backends,0);
 }finally{if(holder.exitCode===null&&holder.signalCode===null){holder.stdin.end('close');await closed;}if(!f.isSettled()){f.controller.abort(new Error('TEST_CLEANUP'));await f.result;}}
});

test('the original 300ms cancellation grace terminates a real PG holder and observes zero backends',async()=>{
 const a=make(),f=await started(a.route,'ignore');assert.ok(observeCommonWorker(f.readyInfo.ownerId).backends>0);
 f.controller.abort(new Error('SYNTHETIC_CALLER_CANCEL'));const value=await f.result;
 assert.equal(value.status,'cancelled');assert.equal(value.error,'SYNTHETIC_CALLER_CANCEL');assert.equal(value.stopMode,'forced_after_grace');assert.equal(value.cleanupVerified,true);assert.equal(observeCommonWorker(f.readyInfo.ownerId).backends,0);
});

test('a membership change between result IPC and publication discards the old authority result',async()=>{
 const a=make(),f=await started(a.route);
 try{control.grant(owner.id,a.workspace.id,'reader','reader');native.writeFileSync(f.release,'release',{flag:'wx'});const value=await f.result;assert.equal(value.status,'unavailable');assert.equal(value.error,'FEDERATION_AUTHORITY_CHANGED');assert.equal(value.package,undefined);assert.equal(value.cleanupVerified,true);}
 finally{if(!f.isSettled()){f.controller.abort(new Error('TEST_CLEANUP'));await f.result;}}
});

test('identity tampering still rejects the actual worker and drains all of its connections',async()=>{
 const a=make(),identity=path.join(a.data,'federation-store.json');files.writeFileSync(identity,'{"schema":"tampered"}');
 const value=await queryBackend(a.route,'fixture',{maxBytes:10000},{remainingMs:30000});assert.equal(value.status,'unavailable');assert.equal(value.error,'FEDERATION_IDENTITY_CHANGED');assert.equal(value.package,undefined);assert.equal(value.cleanupVerified,true);
});

test('a real backend with an invalid byte receipt remains failed after its process tree closes',async()=>{
 const a=make(),f=fixture('invalid');const value=await queryBackend(a.route,'fixture',{maxBytes:10000},{remainingMs:30000,worker:f.script});
 assert.equal(value.status,'unavailable');assert.equal(value.error,'FEDERATION_BACKEND_BUDGET_OR_INTEGRITY');assert.equal(value.package,undefined);assert.equal(value.cleanupVerified,true);const info=JSON.parse(native.readFileSync(f.ready,'utf8'));assert.equal(observeCommonWorker(info.ownerId).backends,0);
});

import {requireExternalAccess} from './recovery.mjs';
import {useStore} from './store-access.mjs';
import fs from '../agent-forensic-handoff/src/common-files.js';import path from 'node:path';import {randomUUID} from 'node:crypto';import {fork} from 'node:child_process';import {fileURLToPath} from 'node:url';import {DATA} from './corpus.mjs';import {openDB,sha} from './common-durable.mjs';import {RequestDeadline} from './deadline.mjs';
import {terminateOwned} from './owned-process.mjs';
import {commonWorkerConfiguration,observeCommonWorker} from '../agent-forensic-handoff/src/common-store.js';
import {commonWorkerEnv} from './common-worker-env.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const WORKER=fileURLToPath(new URL('./federation-worker.mjs',import.meta.url));
const ROUTE_SELECT='SELECT id,scope,root,identityHash AS "identityHash" FROM stores';
function registry(){const db=openDB(path.join(DATA,'federation.pgstore'),'federation');db.exec('CREATE TABLE IF NOT EXISTS stores(id TEXT PRIMARY KEY,scope TEXT,root TEXT UNIQUE,identityHash TEXT);');return db;}
export function registerStore({root,scope,initialize=false}){
 requireExternalAccess(DATA);
 if(typeof scope!=='string'||!/^[-a-zA-Z0-9_:]{1,100}$/.test(scope))throw new Error('FEDERATION_SCOPE_REQUIRED');root=fs.realpathSync(path.resolve(root));if(!fs.existsSync(path.join(root,'library.json')))throw new Error('FEDERATION_STORE_LIBRARY_REQUIRED');
 useStore(root);const file=path.join(root,'federation-store.json');if(!fs.existsSync(file)){if(initialize!==true)throw new Error('FEDERATION_EXPLICIT_INITIALIZATION_REQUIRED');try{fs.writeFileSync(file,JSON.stringify({schema:'afh-store-1',id:randomUUID(),scope},null,2),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}}
 const bytes=fs.readFileSync(file),identity=JSON.parse(bytes);if(identity.schema!=='afh-store-1'||identity.scope!==scope||!/^[-a-f0-9]{36}$/.test(identity.id))throw new Error('FEDERATION_SCOPE_MISMATCH');const db=registry();try{const old=db.prepare(ROUTE_SELECT+' WHERE id=? OR root=?').get(identity.id,root);const route={id:identity.id,scope,root,identityHash:sha(bytes)};if(old&&JSON.stringify({...old})!==JSON.stringify(route))throw new Error('FEDERATION_IMMUTABLE_ROUTE_CONFLICT');db.prepare('INSERT OR IGNORE INTO stores VALUES(?,?,?,?)').run(route.id,scope,route.root,route.identityHash);return route;}finally{db.close();}
}
export function listStores(){const db=registry();try{return db.prepare(ROUTE_SELECT+' ORDER BY id').all();}finally{db.close();}}
export function storeCatalog(id,scope){requireExternalAccess(DATA);const route=listStores().find(s=>s.id===id);if(!route||route.scope!==scope)throw new Error('FEDERATION_SCOPE_MISMATCH');const identity=fs.readFileSync(path.join(route.root,'federation-store.json'));if(sha(identity)!==route.identityHash)throw new Error('FEDERATION_IDENTITY_CHANGED');return JSON.parse(fs.readFileSync(path.join(route.root,'library.json'),'utf8')).map(({id,title,currentRevision})=>({id,title,currentRevision}));}
export function queryBackend(route,question,options,{signal,remainingMs,graceMs=300,worker=WORKER}={}){
 return new Promise(resolve=>{const started=performance.now(),expires=started+(remainingMs??30000),ownerId=randomUUID();let settled=false,forced=false,abortTimer,requestTimer,closeTimer,finalTimer,child,outcome,drained=false,configuration,cancelReason,cleanupDeadline,killTimer,terminationStarted=false;
  const finish=result=>{if(settled)return;settled=true;for(const t of [abortTimer,requestTimer,closeTimer,finalTimer,killTimer])clearTimeout(t);signal?.removeEventListener('abort',cancel);resolve({storeId:route.id,elapsedMs:performance.now()-started,...result});};
  // Keep tree termination, then use the held Node handle if taskkill stalls.
  // Publication still requires the actual close event and zero SQL owners.
  const forceStop=()=>{forced=true;if(terminationStarted)return;terminationStarted=true;terminateOwned(child);killTimer=setTimeout(()=>{if(child?.pid&&child.exitCode===null&&child.signalCode===null){try{child.kill('SIGKILL');}catch{}}},5000);};
  const startClosing=()=>{if(cleanupDeadline)return;cleanupDeadline=performance.now()+15000;closeTimer=setTimeout(()=>{forced=true;forceStop();finalTimer=setTimeout(()=>finish({status:'unavailable',error:'FEDERATION_WORKER_CLOSE_UNVERIFIED',cleanupVerified:false}),1000);},15000);};
  const cancel=()=>{if(settled||cancelReason)return;cancelReason=signal?.reason?.message||'CALLER_CANCELLED';startClosing();try{child.send({type:'cancel',reason:cancelReason});}catch{}abortTimer=setTimeout(()=>{forced=true;forceStop();},graceMs);};
  const closed=async(code,exitSignal)=>{
   clearTimeout(abortTimer);clearTimeout(closeTimer);clearTimeout(finalTimer);clearTimeout(killTimer);startClosing();clearTimeout(closeTimer);
   let observed;try{do{observed=observeCommonWorker(ownerId);if(observed.backends===0)break;await delay(25);}while(performance.now()<cleanupDeadline);}catch{observed=null;}
   if(observed?.backends!==0){finish({status:'unavailable',error:'FEDERATION_POSTGRES_DRAIN_UNVERIFIED',cleanupVerified:false});return;}
   if(performance.now()>=expires)cancelReason??='DEADLINE_EXCEEDED';
   if(signal?.aborted||cancelReason){finish({status:'cancelled',error:signal?.reason?.message||cancelReason,stopMode:forced?'forced_after_grace':drained?'cooperative':'exited_after_cancel',exitSignal,cleanupVerified:true});return;}
   if(code!==0||!drained||forced){finish({status:'unavailable',error:outcome?.error||'FEDERATION_WORKER_SHUTDOWN_UNVERIFIED',exitSignal,cleanupVerified:true});return;}
   if(outcome?.package){try{const current=commonWorkerConfiguration(route.root);if(JSON.stringify(current)!==JSON.stringify(configuration))throw new Error('CHANGED');}catch{finish({status:'unavailable',error:'FEDERATION_AUTHORITY_CHANGED',cleanupVerified:true});return;}}
   finish({...outcome??{status:'unavailable',error:'INVALID_BACKEND_RESPONSE'},cleanupVerified:true});
  };
  try{
   if(signal?.aborted){finish({status:'cancelled',error:signal.reason?.message,stopMode:'cancelled_before_start',cleanupVerified:true});return;}
   configuration=commonWorkerConfiguration(route.root);
   const left=Math.max(0,(remainingMs??30000)-(performance.now()-started));
   if(left===0){finish({status:'cancelled',error:'DEADLINE_EXCEEDED',stopMode:'cancelled_before_start',cleanupVerified:true});return;}
   child=fork(worker,[],{env:commonWorkerEnv(configuration,{data:route.root,ownerId}),execArgv:[],windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});let stderrBytes=0;
   child.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrBytes>1000000){outcome={status:'unavailable',error:'FEDERATION_STDERR_LIMIT'};forced=true;startClosing();forceStop();}});
   child.on('message',r=>{
    if(r?.type==='drained'){drained=r.verified===true;startClosing();return;}
    if(outcome)return;
    startClosing();
    if(!r?.ok){outcome={status:r?.cancelled?'cancelled':'unavailable',error:String(r?.error||'INVALID_BACKEND_RESPONSE'),stopMode:r?.cancelled?'cooperative':null};return;}
    try{const bytes=Buffer.byteLength(JSON.stringify(r.package));if(bytes>options.maxBytes||r.package.bytes!==bytes)throw new Error('BUDGET');outcome={status:r.package.backends?.some(b=>b.status==='unavailable')?'partial':'ok',package:r.package};}
    catch{outcome={status:'unavailable',error:'FEDERATION_BACKEND_BUDGET_OR_INTEGRITY'};forced=true;forceStop();}
   });
   child.on('error',()=>{outcome={status:'unavailable',error:'FEDERATION_WORKER_START_FAILED'};startClosing();});
   child.once('close',(code,exitSignal)=>{void closed(code,exitSignal);});
   signal?.addEventListener('abort',cancel,{once:true});
   requestTimer=setTimeout(()=>{if(!cancelReason){cancelReason='DEADLINE_EXCEEDED';startClosing();try{child.send({type:'cancel',reason:cancelReason});}catch{}abortTimer=setTimeout(()=>{forced=true;forceStop();},graceMs);}},left);
   child.send({type:'query',route,question,options,remainingMs:left});if(signal?.aborted)cancel();
  }catch{if(child){outcome={status:'unavailable',error:'FEDERATION_WORKER_START_FAILED'};startClosing();forceStop();}else finish({status:'unavailable',error:'FEDERATION_WORKER_AUTHORITY_OR_START_FAILED',cleanupVerified:true});}
 });
}
export async function federatedRetrieve({scope,shards,question,maxBytes=100000,deadlineMs=30000,retrieval={},signal},backend=queryBackend){
 requireExternalAccess(DATA);signal?.throwIfAborted();if(!Array.isArray(shards)||!shards.length||shards.length>4||new Set(shards.map(s=>s.storeId)).size!==shards.length)throw new Error('FEDERATION_SELECT_1_TO_4_UNIQUE_STORES');if(typeof question!=='string'||!question.trim()||question.length>8000)throw new Error('FEDERATION_QUESTION_REQUIRED');
 if(!Number.isSafeInteger(maxBytes)||maxBytes>100000||maxBytes<8000+4096*shards.length)throw new Error('FEDERATION_SHARED_BYTE_BUDGET');const stores=listStores();
 // Freeze and validate the whole routing plan before opening any backend store.
 const routes=shards.map(s=>{const row=stores.find(r=>r.id===s.storeId);if(!row||row.scope!==scope)throw new Error('FEDERATION_SCOPE_MISMATCH');if(!Array.isArray(s.conversationIds)||!s.conversationIds.length||s.conversationIds.length>20||s.conversationIds.some(id=>typeof id!=='string'||!/^[-a-zA-Z0-9_]{1,180}$/.test(id)))throw new Error('FEDERATION_CASE_SELECTION');return Object.freeze({...row,conversationIds:[...new Set(s.conversationIds)]});});
 const deadline=new RequestDeadline(deadlineMs,signal),started=performance.now();try{const each=Math.floor((maxBytes-8000)/routes.length);const replies=await Promise.all(routes.map(route=>backend(route,question,{...retrieval,maxBytes:each},{signal:deadline.signal,remainingMs:deadline.remaining()})));signal?.throwIfAborted();
  // Synchronous authority checks can consume the deadline before Node runs
  // its timer callback. Record the actual monotonic boundary as well.
  if(deadline.remaining()===0&&!deadline.signal.aborted)deadline.controller.abort(new Error('DEADLINE_EXCEEDED'));
  const result={schema:'afh-federated-package-1',requestId:randomUUID(),scope,question,maxBytes,bytes:0,elapsedMs:performance.now()-started,deadlineMs,deadlineExceeded:deadline.signal.aborted,backends:replies.map(({package:pkg,...meta})=>({...meta,allocatedBytes:each,returnedBytes:pkg?.bytes??0})),packages:replies.filter(r=>r.package).map(r=>({storeId:r.storeId,package:r.package})),omissions:[],scopePolicy:'Exact immutable store scopes; source IDs and evidence IDs are qualified by storeId.',allocationPolicy:'Equal fixed per-store budgets; unused bytes are not silently redistributed.'};
  function measure(){let old;do{old=result.bytes;result.bytes=Buffer.byteLength(JSON.stringify(result));}while(old!==result.bytes);}measure();while(result.bytes>maxBytes&&result.packages.length){const omitted=result.packages.pop();result.omissions.push({storeId:omitted.storeId,reason:'shared_package_budget',evidence:omitted.package.evidence.length});measure();}if(result.bytes>maxBytes)throw new Error('FEDERATION_DIAGNOSTICS_EXCEED_BUDGET');return result;
 }finally{deadline.close();}
}

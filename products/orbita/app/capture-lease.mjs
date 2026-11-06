import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync,closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';

// Prepare the independent transport before the caller acquires its lease.
// Starting renewal retains the exact job token and never revives expiry.
// A normal stop drains the owned PostgreSQL bridge before the worker exits.
export function prepareCaptureLease(file,id,owner,leaseMs){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{kind:'orbita-capture-lease',file,id,owner,leaseMs}});
  let prepared=false,started=false,ready=false,lost=null,stopping=false,receipt=null,exitCode=null,finishExit,finishRenewal;
  const exited=new Promise(done=>finishExit=done);
  // Resolve the signal even on failure: a caller can be synchronously preserving
  // raw bytes before awaiting readiness, without an unhandled rejection.
  const renewed=new Promise(done=>finishRenewal=done);
  const assert=()=>{if(lost)throw lost;if(!ready)throw new Error('CAPTURE_LEASE_KEEPER_NOT_READY');};
  const start=()=>{if(started||stopping)throw new Error('CAPTURE_LEASE_KEEPER_ALREADY_STARTED_OR_STOPPED');if(lost)throw lost;started=true;worker.postMessage('start');};
  const waitReady=async()=>{if(!started)throw new Error('CAPTURE_LEASE_KEEPER_NOT_STARTED');await renewed;assert();};
  const stop=async()=>{
   stopping=true;if(exitCode===null)worker.postMessage('stop');let timer;
   try{await Promise.race([exited,new Promise((_,fail)=>{timer=setTimeout(()=>fail(new Error('CAPTURE_LEASE_KEEPER_CLOSE_UNVERIFIED')),65000);})]);}
   catch(error){await worker.terminate();throw error;}finally{clearTimeout(timer);}
   if(exitCode!==0||receipt?.drained!==true||receipt.ownedExit!==0||receipt.error)throw new Error('CAPTURE_LEASE_KEEPER_CLOSE_UNVERIFIED');
   return receipt;
  };
  worker.on('message',message=>{
   if(message==='prepared'){prepared=true;resolve({start,waitReady,assert,stop});}
   else if(message==='ready'){ready=true;finishRenewal();}
   else if(message?.kind==='closed')receipt=message;
   else lost=new Error('CAPTURE_STALE_OWNER');
  });
  worker.on('error',()=>{lost=new Error('CAPTURE_LEASE_KEEPER_FAILED');});
  worker.on('exit',code=>{exitCode=code;if(!stopping)lost??=new Error('CAPTURE_LEASE_KEEPER_STOPPED');finishExit(code);finishRenewal();if(!prepared)reject(lost??new Error('CAPTURE_LEASE_KEEPER_FAILED'));});
 });
}
export async function keepCaptureLease(file,id,owner,leaseMs){
 const keeper=await prepareCaptureLease(file,id,owner,leaseMs);
 try{keeper.start();await keeper.waitReady();return keeper;}
 catch(error){await keeper.stop();throw error;}
}
if(!isMainThread&&workerData?.kind==='orbita-capture-lease'){
 const {file,id,owner,leaseMs}=workerData;let db,timer,closed=false,started=false;
 const shutdown=()=>{
  if(closed)return;closed=true;clearInterval(timer);let error=null,result;
  try{db?.close();}catch{error='DATABASE_CLOSE_FAILED';}
  try{result=closeCommonStore();if(result.drained!==true||result.ownedExit!==0)error??='BRIDGE_CLOSE_UNVERIFIED';}catch{error??='BRIDGE_CLOSE_FAILED';}
  parentPort.postMessage({kind:'closed',ownedExit:result?.ownedExit??null,drained:result?.drained===true,error});parentPort.close();
 };
 const renew=()=>{const at=Date.now();try{const result=db.prepare('UPDATE jobs SET lease_until=? WHERE id=? AND owner=? AND lease_until>=?').run(at+leaseMs,id,owner,at);if(result.changes!==1)throw Error('lost');return true;}catch{parentPort.postMessage('lost');return false;}};
 parentPort.on('message',message=>{
  if(message==='stop')shutdown();
  else if(message==='start'&&!closed&&!started){started=true;if(renew()){parentPort.postMessage('ready');timer=setInterval(()=>{if(!renew())shutdown();},Math.max(1,Math.min(1000,Math.floor(leaseMs/3))));}else shutdown();}
 });
 try{db=new DatabaseSync(file,{family:'capture'});parentPort.postMessage('prepared');}
 catch{parentPort.postMessage('lost');shutdown();}
}

import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';

// A separate event loop keeps a live capture lease during synchronous parsing.
// Atomic renewal never revives an expired or replaced owner.
export function keepCaptureLease(file,id,owner,leaseMs){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{kind:'orbita-capture-lease',file,id,owner,leaseMs}});let ready=false,lost=null,stopping=false;
  worker.on('message',message=>{if(message==='ready'){ready=true;resolve({assert:()=>{if(lost)throw lost;},stop:async()=>{stopping=true;await worker.terminate();}});}else{lost=new Error('CAPTURE_STALE_OWNER');if(!ready){reject(lost);worker.terminate();}}});
  worker.on('error',()=>{lost=new Error('CAPTURE_LEASE_KEEPER_FAILED');if(!ready)reject(lost);});
  worker.on('exit',()=>{if(!stopping){lost??=new Error('CAPTURE_LEASE_KEEPER_STOPPED');if(!ready)reject(lost);}});
 });
}
if(!isMainThread&&workerData?.kind==='orbita-capture-lease'){
 const {file,id,owner,leaseMs}=workerData,db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=1000');
 const renew=()=>{const at=Date.now();try{const result=db.prepare('UPDATE jobs SET lease_until=? WHERE id=? AND owner=? AND lease_until>=?').run(at+leaseMs,id,owner,at);if(result.changes!==1)throw Error('lost');return true;}catch{parentPort.postMessage('lost');return false;}};
 if(renew()){parentPort.postMessage('ready');const timer=setInterval(()=>{if(!renew()){clearInterval(timer);db.close();parentPort.close();}},Math.max(1,Math.min(1000,Math.floor(leaseMs/3))));}
 else{db.close();parentPort.close();}
}

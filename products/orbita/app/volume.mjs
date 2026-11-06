import {pythonExecutable} from '../agent-forensic-handoff/src/python-runtime.js';
import fs from '../agent-forensic-handoff/src/common-files.js';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {DatabaseSync,commonWorkerConfiguration,observeCommonWorker} from '../agent-forensic-handoff/src/common-store.js';
import {commonWorkerEnv} from './common-worker-env.mjs';
import {DATA,refreshLibrary} from './corpus.mjs';
import {sha} from './durable.mjs';
import {plainPath} from './store-access.mjs';
import {verifyCaseIntegrity} from '../agent-forensic-handoff/src/integrity.js';
import {terminateOwned} from './owned-process.mjs';
import {Utf8Stream} from './utf8-stream.mjs';

const demand=(ok,code)=>{if(!ok)throw new Error('VOLUME_'+code);};
export const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
function regular(file){plainPath(file);const s=fs.lstatSync(file);demand(s.isFile()&&s.nlink===1,'REGULAR_FILE');return file;}
function casePath(id){demand(typeof id==='string'&&/^[-a-zA-Z0-9_]{1,180}$/.test(id),'SOURCE_ID');return plainPath(path.join(DATA,'cases',id));}
export function volumeCatalog(){
 const sources=refreshLibrary().map(item=>{
  const file=regular(path.join(casePath(item.id),'case.json')),raw=fs.readFileSync(file),manifest=JSON.parse(raw);
  demand(manifest.status==='COMPLETE'&&/^[a-f0-9]{64}$/.test(manifest.caseHash),'CASE_INCOMPLETE');
  const {path:ignored,...metadata}=item;
  let manifestHash=sha(raw);
  if(manifest.storage?.originalManifest!==undefined){
   const origin=manifest.storage.originalManifest,expected='.orbita-legacy/originals/cases/'+item.id+'/case.json.bin';
   demand(origin?.schema==='orbita-legacy-case-manifest-1'&&origin.path===expected&&/^[a-f0-9]{64}$/.test(origin.sha256),'LEGACY_MANIFEST_BINDING');
   const originalFile=regular(path.join(DATA,expected));demand(fs.statSync(originalFile).size<=16*1024**2,'LEGACY_MANIFEST_BUDGET');
   const originalBytes=fs.readFileSync(originalFile);demand(sha(originalBytes)===origin.sha256,'LEGACY_MANIFEST_HASH');
   const original=JSON.parse(originalBytes),{storage:oldStorage,...before}=original,{storage:newStorage,...after}=manifest;
   demand(canonical(before)===canonical(after),'LEGACY_MANIFEST_CHANGED');manifestHash=origin.sha256;
  }
  return {id:item.id,caseHash:manifest.caseHash,manifestHash,metadata};
 }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 demand(sources.length<=10000&&Buffer.byteLength(canonical(sources))<=8*1024**2,'CATALOG_LIMIT');return {sources,token:sha(canonical(sources))};
}
export async function volumeWorker(input,{signal}={}){
 demand(!signal?.aborted,'CANCELLED');
 const started=performance.now(),expires=started+180000,ownerId=randomUUID();
 const configuration=commonWorkerConfiguration(DATA);
 const child=spawn(pythonExecutable(['AFH_VOLUME_PYTHON']),['-X','utf8','-B',fileURLToPath(new URL('./volume_store.py',import.meta.url))],{env:commonWorkerEnv(configuration,{data:DATA,ownerId}),windowsHide:true,stdio:['pipe','pipe','pipe']});
 const output=new Utf8Stream(12*1024**2);let failure=null,stderrBytes=0,closeTimer,finalTimer;
 let settle;const completion=new Promise((resolve,reject)=>{settle={resolve,reject};});let settled=false;
 const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(closeTimer);clearTimeout(finalTimer);signal?.removeEventListener('abort',stop);if(error)settle.reject(error);else settle.resolve(result);};
 const terminate=error=>{failure??=new Error(error);terminateOwned(child);if(!closeTimer)closeTimer=setTimeout(()=>finish(new Error('VOLUME_WORKER_CLOSE_UNVERIFIED')),15000);};
 const stop=()=>terminate('VOLUME_CANCELLED');
 const timer=setTimeout(()=>terminate('VOLUME_WORKER_TIMEOUT'),Math.max(0,expires-performance.now()));
 child.on('error',()=>{failure??=new Error('VOLUME_PYTHON_UNAVAILABLE');});
 child.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrBytes>1024**2)terminate('VOLUME_STDERR_LIMIT');});child.stdin.on('error',()=>{});
 child.stdout.on('data',b=>{try{output.push(b);}catch{terminate('VOLUME_RESPONSE_BUDGET');}});
 child.once('close',async code=>{
  clearTimeout(timer);clearTimeout(closeTimer);const deadline=performance.now()+15000;
  let observed;try{do{observed=observeCommonWorker(ownerId);if(observed.backends===0)break;await delay(25);}while(performance.now()<deadline);}catch{observed=null;}
  if(observed?.backends!==0)return finish(new Error('VOLUME_POSTGRES_DRAIN_UNVERIFIED'));
  if(signal?.aborted)failure??=new Error('VOLUME_CANCELLED');
  if(performance.now()>=expires)failure??=new Error('VOLUME_WORKER_TIMEOUT');
  if(failure)return finish(failure);
  try{
   const result=JSON.parse(output.end());if(code!==0||result.error)throw new Error(/^VOLUME_[A-Z0-9_]+$/.test(result.error||'')?result.error:'VOLUME_WORKER_FAILED');
   if(JSON.stringify(commonWorkerConfiguration(DATA))!==JSON.stringify(configuration))throw new Error('VOLUME_AUTHORITY_CHANGED');
   finish(null,result);
  }catch(e){finish(e.message?.startsWith('VOLUME_')?e:new Error('VOLUME_WORKER_INVALID'));}
 });
 signal?.addEventListener('abort',stop,{once:true});
 try{child.stdin.end(JSON.stringify({...input,root:DATA}));if(signal?.aborted)stop();}catch{terminate('VOLUME_REQUEST_INVALID');}
 return completion;
}
async function verifySource(id){const verified=await verifyCaseIntegrity(casePath(id),{verifyProjections:false});demand(verified.passed,'SOURCE_INTEGRITY');}
function readOriginal(id,uri,expected){
 const match=/^afh:\/\/evidence\/sha256\/([a-f0-9]{64})\/record\/(\d+)#bytes=(\d+):(\d+)$/.exec(uri||'');demand(match,'EVIDENCE_URI');
 const [,sourceHash,ordinal,start,length]=match,offset=Number(start),size=Number(length);
 demand(Number.isSafeInteger(offset)&&Number.isSafeInteger(size)&&offset>=0&&size>0&&size<=8*1024**2,'RECORD_SIZE');
 const file=regular(path.join(casePath(id),'evidence','sources',sourceHash+'.jsonl')),fd=fs.openSync(file,'r');
 try{const bytes=Buffer.alloc(size);demand(fs.readSync(fd,bytes,0,size,offset)===size,'TRUNCATED_RECORD');const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);demand(sha(bytes)===expected,'ORIGINAL_HASH');return {raw,ordinal:Number(ordinal)};}finally{fs.closeSync(fd);}
}
async function syncBatch(catalog,state,signal){
 if(state.ready)return {...state,added:0,processedReferences:0};
 const pending=state.pending[0],source=catalog.sources.find(s=>s.id===pending.id);demand(source,'SOURCE_NOT_SELECTED');
 if(pending.after===0)await verifySource(source.id);
 const db=new DatabaseSync(regular(path.join(casePath(source.id),'case.pgstore')),{family:'case',readOnly:true});let refs;
 try{refs=db.prepare('SELECT rowid AS position,uri,record_sha256 FROM evidence_ref WHERE rowid>? ORDER BY rowid LIMIT 501').all(pending.after);}finally{db.close();}
 const rows=[];let after=pending.after,bytes=0;
 for(const ref of refs.slice(0,500)){
  demand(!signal?.aborted,'CANCELLED');const value=readOriginal(source.id,ref.uri,ref.record_sha256),parsed=JSON.parse(value.raw);
  const row={sourceId:source.id,uri:ref.uri,ordinal:value.ordinal,kind:String(parsed.type||'original_record'),raw:value.raw,sha:ref.record_sha256,caseHash:source.caseHash};
  const n=Buffer.byteLength(canonical(row));demand(n<=8*1024**2,'RECORD_SIZE');if(bytes+n>8*1024**2)break;
  bytes+=n;rows.push(row);after=ref.position;
 }
 const complete=refs.length<=500&&rows.length===refs.length;
 if(complete)await verifySource(source.id);
 demand(volumeCatalog().token===catalog.token,'CATALOG_CHANGED');
 return await volumeWorker({op:'append',source:source.id,expectedAfter:pending.after,after,rows,complete},{signal});
}
let busy=false;
export async function volumeOperation(input={},options={}){
 demand(input&&typeof input==='object'&&!Array.isArray(input),'INPUT');const {op='status'}=input;
 demand(['status','sync','page','lake','verify'].includes(op),'OPERATION');demand(input.backend===undefined||['postgresql-common','postgresql-analytics'].includes(input.backend),'BACKEND');demand(!busy,'BUSY');busy=true;
 try{
  const catalog=volumeCatalog(),state=await volumeWorker({op:'prepare',catalog},options);let result;
  if(op==='status'){
   result={...state,defaultBackend:'postgresql-common',analyticsBackend:'postgresql-analytics',maxBatch:500};
   const {hasSemanticStorage,semanticStorageState}=await import('./semantic-storage.mjs');
   if(hasSemanticStorage(DATA))result.semanticStorage=await semanticStorageState(DATA);
  }else if(op==='sync')result=await syncBatch(catalog,state,options.signal);
  else if(op==='page'){
   demand(!input.sourceIds||Array.isArray(input.sourceIds),'SELECTION');const selected=input.sourceIds?.length?input.sourceIds:catalog.sources.map(s=>s.id);
   demand(selected.every(id=>catalog.sources.some(s=>s.id===id)),'SELECTION');
   for(const id of new Set(selected)){demand(!options.signal?.aborted,'CANCELLED');await verifySource(id);}
   const {query='',limit=200,cursor,backend='postgresql-common'}=input;
   result=await volumeWorker({op:'page',sourceIds:selected,query,limit,cursor,backend},options);
   for(const row of result.rows){
    const {seq,rowHash,...payload}=row;demand(sha(canonical(payload))===rowHash,'ROW_HASH');
    const source=catalog.sources.find(s=>s.id===row.sourceId);demand(source?.caseHash===row.caseHash,'SOURCE_BINDING');
    const value=readOriginal(row.sourceId,row.uri,row.sha);demand(value.raw===row.raw&&value.ordinal===row.ordinal,'ORIGINAL_BINDING');
   }
   result.originalsVerified=true;
  }else{
   for(const source of catalog.sources){demand(!options.signal?.aborted,'CANCELLED');await verifySource(source.id);}
   result=await volumeWorker({op,limit:input.limit??500},options);
  }
  demand(volumeCatalog().token===catalog.token,'CATALOG_CHANGED');demand(!options.signal?.aborted,'CANCELLED');return result;
 }finally{busy=false;}
}

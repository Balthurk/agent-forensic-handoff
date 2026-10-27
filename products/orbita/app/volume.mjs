import {pythonExecutable} from '../agent-forensic-handoff/src/python-runtime.js';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {DATA,refreshLibrary} from './corpus.mjs';
import {sha} from './durable.mjs';
import {plainPath} from './store-access.mjs';
import {requireExternalAccess} from './recovery.mjs';
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
  return {id:item.id,caseHash:manifest.caseHash,manifestHash:sha(raw),metadata};
 }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 demand(sources.length<=10000&&Buffer.byteLength(canonical(sources))<=8*1024**2,'CATALOG_LIMIT');return {sources,token:sha(canonical(sources))};
}
export async function volumeWorker(input,{signal}={}){
 demand(!signal?.aborted,'CANCELLED');
 const child=spawn(pythonExecutable(['AFH_VOLUME_PYTHON']),['-X','utf8','-B',fileURLToPath(new URL('./volume_store.py',import.meta.url))],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
 const output=new Utf8Stream(12*1024**2);let failure=null;
 const stop=()=>{failure??=new Error('VOLUME_CANCELLED');terminateOwned(child);};signal?.addEventListener('abort',stop,{once:true});
 const timer=setTimeout(()=>{failure??=new Error('VOLUME_WORKER_TIMEOUT');terminateOwned(child);},180000);timer.unref();
 try{return await new Promise((resolve,reject)=>{
  child.on('error',()=>{failure??=new Error('VOLUME_PYTHON_UNAVAILABLE');});
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.stdout.on('data',b=>{try{output.push(b);}catch{failure??=new Error('VOLUME_RESPONSE_BUDGET');terminateOwned(child);}});
  child.on('close',code=>{if(failure)return reject(failure);try{const result=JSON.parse(output.end());if(code!==0||result.error)throw new Error(result.error||'VOLUME_WORKER_FAILED');resolve(result);}catch(e){reject(e.message?.startsWith('VOLUME_')?e:new Error('VOLUME_WORKER_INVALID'));}});
  child.stdin.end(JSON.stringify({root:DATA,...input}));
 });}finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
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
 const db=new DatabaseSync(path.toNamespacedPath(regular(path.join(casePath(source.id),'case.sqlite'))),{readOnly:true});let refs;
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
 demand(['status','sync','page','lake','verify','postgres'].includes(op),'OPERATION');demand(!busy,'BUSY');busy=true;
 try{
  const catalog=volumeCatalog(),state=await volumeWorker({op:'prepare',catalog},options);let result;
  const postgres=op==='postgres'||input.backend==='postgres';
  if(postgres){demand(process.env.AFH_MANAGED!=='1','MANAGED_POSTGRES_NOT_ADMITTED');requireExternalAccess(DATA);}
  if(op==='status'){
   let paused=false;try{requireExternalAccess(DATA);}catch{paused=true;}
   result={...state,postgresConfigured:process.env.AFH_MANAGED!=='1'&&Boolean(process.env.AFH_VOLUME_PG_CONFIG),postgresPaused:paused,defaultBackend:'sqlite',maxBatch:500};
   const {hasSemanticStorage,semanticStorageState}=await import('./semantic-storage.mjs');
   if(hasSemanticStorage(DATA))result.semanticStorage=await semanticStorageState(DATA)??{backend:'sqlite',restored:true};
  }else if(op==='sync')result=await syncBatch(catalog,state,options.signal);
  else if(op==='page'){
   demand(!input.sourceIds||Array.isArray(input.sourceIds),'SELECTION');const selected=input.sourceIds?.length?input.sourceIds:catalog.sources.map(s=>s.id);
   demand(selected.every(id=>catalog.sources.some(s=>s.id===id)),'SELECTION');
   for(const id of new Set(selected)){demand(!options.signal?.aborted,'CANCELLED');await verifySource(id);}
   const {query='',limit=200,cursor,backend='sqlite'}=input;
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

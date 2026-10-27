import {requireExternalAccess} from './recovery.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DATA,importCapturedRevision} from './corpus.mjs';
import {sha,now,openDB,transaction,checkpoint} from './durable.mjs';
import {keepCaptureLease} from './capture-lease.mjs';
const root=path.join(DATA,'capture');
function dbOpen(){const db=openDB(path.join(root,'jobs.sqlite'));db.exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,source TEXT UNIQUE NOT NULL,offset INTEGER NOT NULL DEFAULT 0,valid_offset INTEGER NOT NULL DEFAULT 0,prefix TEXT NOT NULL,status TEXT NOT NULL,owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,current_case TEXT,error TEXT);
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,job TEXT,at TEXT,status TEXT,detail TEXT);
 CREATE TABLE IF NOT EXISTS revisions(job TEXT,hash TEXT,bytes INTEGER,case_id TEXT,status TEXT,PRIMARY KEY(job,hash));`);return db;}
function canonical(file){return fs.realpathSync.native(path.resolve(file));}
function authorize(source,allowPaths){if(!Array.isArray(allowPaths)||!allowPaths.some(p=>canonical(p).toLowerCase()===source.toLowerCase()))throw new Error('CAPTURE_PATH_NOT_AUTHORIZED_NOW');const resolved=canonical(source);if(resolved.toLowerCase()!==source.toLowerCase())throw new Error('CAPTURE_PATH_REBOUND');const rel=path.relative(DATA,resolved);if(!rel.startsWith('..')&&!path.isAbsolute(rel))throw new Error('CAPTURE_SOURCE_INSIDE_RUNTIME');return resolved;}
function event(db,id,status,detail){db.prepare('INSERT INTO events(job,at,status,detail) VALUES(?,?,?,?)').run(id,now(),status,JSON.stringify(detail));}
export function registerCapture(source,allowPaths){source=canonical(source);authorize(source,allowPaths);if(!/\.(jsonl|ndjson)$/i.test(source)||!fs.statSync(source).isFile())throw new Error('CAPTURE_REQUIRES_JSONL_FILE');const db=dbOpen();try{return transaction(db,()=>{const prior=db.prepare('SELECT * FROM jobs WHERE source=?').get(source);if(prior)return prior;const id=randomUUID();db.prepare('INSERT INTO jobs(id,source,prefix,status) VALUES(?,?,?,?)').run(id,source,sha(Buffer.alloc(0)),'registered');event(db,id,'registered',{source});return db.prepare('SELECT * FROM jobs WHERE id=?').get(id);});}finally{db.close();}}
export function captureStatus(){const db=dbOpen();try{return {jobs:db.prepare('SELECT * FROM jobs').all(),revisions:db.prepare('SELECT * FROM revisions').all(),events:db.prepare('SELECT * FROM events ORDER BY seq').all(),authorization:'Paths must be explicitly supplied again for each capture call; stored jobs grant no permission.'};}finally{db.close();}}
export async function captureOnce(id,allowPaths,{maxBytes=1048576,retry=false,leaseMs=120000}={}){
 requireExternalAccess(DATA);
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>40*1024*1024)throw new Error('CAPTURE_BYTE_BUDGET');
 if(!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>600000)throw new Error('CAPTURE_LEASE_BUDGET');
 const db=dbOpen(),owner=randomUUID();let claimed=false,keeper=null;
 const owns=()=>{keeper?.assert();const r=db.prepare('SELECT owner,lease_until FROM jobs WHERE id=?').get(id);if(r?.owner!==owner||r.lease_until<Date.now())throw new Error('CAPTURE_STALE_OWNER');};
 try{
  let job=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(!job)throw new Error('CAPTURE_UNKNOWN_JOB');authorize(job.source,allowPaths);
  transaction(db,()=>{job=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(job.owner&&job.lease_until>Date.now())throw new Error('CAPTURE_LEASE_HELD');if(job.status==='failed'&&!retry)throw new Error('CAPTURE_EXPLICIT_RETRY_REQUIRED');db.prepare('UPDATE jobs SET owner=?,lease_until=?,status=?,error=NULL WHERE id=?').run(owner,Date.now()+leaseMs,'capturing',id);event(db,id,'claimed',{owner,previousOffset:job.offset});});claimed=true;
  const spool=path.join(root,id+'.bytes');if(!fs.existsSync(spool))fs.writeFileSync(spool,Buffer.alloc(0));
  const previous=fs.readFileSync(spool);if(previous.length<job.offset||sha(previous.subarray(0,job.offset))!==job.prefix)throw new Error('CAPTURE_CHECKPOINT_CORRUPT');
  if(previous.length>job.offset){fs.writeFileSync(path.join(root,id+'.uncommitted-'+randomUUID()),previous.subarray(job.offset),{flag:'wx'});fs.truncateSync(spool,job.offset);event(db,id,'recovered_uncommitted_bytes',{bytes:previous.length-job.offset});}
  const fd=fs.openSync(job.source,'r');let bytes;
  try{const st=fs.fstatSync(fd);if(st.size<job.offset)throw new Error('CAPTURE_SOURCE_TRUNCATED');if(st.size>40*1024*1024)throw new Error('CAPTURE_SOURCE_EXCEEDS_40_MIB');const prefix=Buffer.alloc(job.offset);fs.readSync(fd,prefix,0,prefix.length,0);if(sha(prefix)!==job.prefix)throw new Error('CAPTURE_SOURCE_REWRITTEN');const count=Math.min(maxBytes,st.size-job.offset),delta=Buffer.alloc(count);const read=fs.readSync(fd,delta,0,count,job.offset);bytes=Buffer.concat([prefix,delta.subarray(0,read)]);}finally{fs.closeSync(fd);}
  const output=fs.openSync(spool,'r+');try{fs.writeSync(output,bytes.subarray(job.offset),0,bytes.length-job.offset,job.offset);fs.fsyncSync(output);}finally{fs.closeSync(output);}checkpoint('capture-after-fsync');
  keeper=await keepCaptureLease(path.join(root,'jobs.sqlite'),id,owner,leaseMs);
  const valid=bytes.lastIndexOf(10)+1;const completed=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,valid));for(const line of completed.split('\n'))if(line.trim())JSON.parse(line);
  authorize(job.source,allowPaths);owns();const revisionHash=valid?sha(bytes.subarray(0,valid)):null,caseId=revisionHash?'capture-'+id+'-'+revisionHash.slice(0,20):null;
  transaction(db,()=>{owns();db.prepare('UPDATE jobs SET offset=?,valid_offset=?,prefix=? WHERE id=?').run(bytes.length,valid,sha(bytes),id);if(valid)db.prepare('INSERT OR IGNORE INTO revisions VALUES(?,?,?,?,?)').run(id,revisionHash,valid,caseId,'pending');event(db,id,'checkpoint',{offset:bytes.length,validOffset:valid,partialTail:bytes.length-valid});});checkpoint('capture-after-checkpoint');
  let item=null;
  if(valid){item=await importCapturedRevision({id:caseId,bytes:bytes.subarray(0,valid),title:path.basename(job.source),captureJob:id,revisionHash,beforePublish:()=>{owns();authorize(job.source,allowPaths);}});checkpoint('capture-after-import');owns();authorize(job.source,allowPaths);transaction(db,()=>{owns();db.prepare('UPDATE revisions SET status=? WHERE job=? AND hash=?').run('published',id,revisionHash);db.prepare('UPDATE jobs SET current_case=? WHERE id=?').run(caseId,id);});}
  transaction(db,()=>{owns();db.prepare('UPDATE jobs SET owner=NULL,lease_until=0,status=? WHERE id=?').run('idle',id);event(db,id,'complete',{caseId,offset:bytes.length,validOffset:valid,partialTail:bytes.length-valid});});
  return {id,caseId,offset:bytes.length,validOffset:valid,partialTail:bytes.length-valid,item};
 }catch(e){if(claimed){transaction(db,()=>{if(db.prepare('SELECT owner FROM jobs WHERE id=?').get(id)?.owner===owner){db.prepare('UPDATE jobs SET status=?,error=?,owner=NULL,lease_until=0 WHERE id=?').run('failed',e.message,id);event(db,id,'failed',{error:e.message});}});}throw e;}finally{await keeper?.stop();db.close();}
}

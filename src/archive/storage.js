import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sqlite from 'node:sqlite';
import { assertSourcePath } from '../discovery.js';
import { canonical,digest,hash,failure } from './protocol.js';

export const CHUNK_BYTES=4*1024*1024;
export function localRoot(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||/^(?:\\\\|\/\/)/.test(value))throw failure('INVALID_REQUEST','Archive requires an explicit local absolute path');
  if(value.includes('\0')||value.slice(path.parse(value).root.length).includes(':'))throw failure('INVALID_REQUEST','Invalid archive path');
  assertSourcePath(value);return path.resolve(value);
}
export function inside(root,...parts){
  const target=path.resolve(root,...parts),relative=path.relative(root,target);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw failure('INTEGRITY_FAILED','Stored path escapes archive');
  assertSourcePath(target);return target;
}
export function writeDurable(file,bytes,{replace=false}={}){
  fs.mkdirSync(path.dirname(file),{recursive:true});assertSourcePath(file);
  const temporary=file+'.stage-'+randomUUID(),fd=fs.openSync(temporary,'wx');
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(!replace&&fs.existsSync(file)){
    if(hash(fs.readFileSync(file))!==hash(bytes))throw failure('INTEGRITY_FAILED','Immutable artifact conflicts with existing bytes');
    fs.unlinkSync(temporary);return;
  }
  fs.renameSync(temporary,file);
  if(process.platform!=='win32'){const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
}
export function writeJson(file,value,options){writeDurable(file,Buffer.from(canonical(value)+'\n'),options);}
export function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')throw failure('EVIDENCE_UNAVAILABLE','Archive artifact unavailable');throw failure('INTEGRITY_FAILED','Archive JSON cannot be decoded');}}
export function objectPath(root,sha){if(!/^[a-f0-9]{64}$/.test(sha))throw failure('INTEGRITY_FAILED','Invalid object identifier');return inside(root,'bronze/objects',sha);}
export function putObject(root,bytes){
  const sha=hash(bytes),file=objectPath(root,sha),reused=fs.existsSync(file);
  if(reused&&hash(fs.readFileSync(file))!==sha)throw failure('INTEGRITY_FAILED','Existing CAS object is corrupt');
  if(!reused)writeDurable(file,bytes);
  return {sha256:sha,length:bytes.length,stored_sha256:sha,stored_length:bytes.length,compression:'none',reused};
}
export function readObject(root,object){
  if(object.compression!=='none'||object.sha256!==object.stored_sha256)throw failure('INTEGRITY_FAILED','Unsupported or inconsistent object encoding');
  const bytes=fs.readFileSync(objectPath(root,object.sha256));
  if(hash(bytes)!==object.sha256||bytes.length!==Number(object.length)||bytes.length!==Number(object.stored_length))throw failure('INTEGRITY_FAILED','CAS object digest or length differs');return bytes;
}
export function sourceManifest(root,id){
  if(!/^src4-[a-f0-9]{64}$/.test(id))throw failure('INTEGRITY_FAILED','Invalid source manifest identifier');
  const manifest=readJson(inside(root,'bronze/sources',id+'.json'));
  const {source_revision_id,...payload}=manifest;payload.records=payload.records.map(({evidence_ref,...record})=>record);
  if(source_revision_id!==id||'src4-'+digest(payload)!==id)throw failure('INTEGRITY_FAILED','Source manifest digest differs');
  for(const record of manifest.records)if(canonical(record.evidence_ref)!==canonical(recordReference(manifest,record)))throw failure('INTEGRITY_FAILED','Derived record reference differs');return manifest;
}
function recordReference(manifest,record){return {uri:record.legacy_uri??`afh://evidence/sha256/${manifest.raw_sha256}/record/${record.ordinal}?source=${manifest.source_revision_id}#bytes=${record.byte_offset}:${record.byte_length}`,source_revision_id:manifest.source_revision_id,record_ordinal:record.ordinal,byte_offset:record.byte_offset,byte_length:record.byte_length,record_sha256:record.sha256,json_pointer:'',availability:'AVAILABLE'};}
export function saveSourceManifest(root,payload){const id='src4-'+digest(payload),manifest={source_revision_id:id,...payload};manifest.records=manifest.records.map(record=>({...record,evidence_ref:recordReference(manifest,record)}));writeJson(inside(root,'bronze/sources',id+'.json'),manifest);return manifest;}
export function revisionManifest(root,id){
  if(!/^cap4-[a-f0-9]{64}$/.test(id))throw failure('INTEGRITY_FAILED','Invalid revision identifier');
  const value=readJson(inside(root,'revisions',id+'.json')),{revision_id,...payload}=value;
  if(revision_id!==id||'cap4-'+digest(payload)!==id)throw failure('INTEGRITY_FAILED','Revision manifest digest differs');return value;
}
export function openSnapshot(root,revisionId=null){
  const pointer=readJson(inside(root,'archive.json'));if(pointer.schema_version!==4)throw failure('UNSUPPORTED_VERSION','Archive schema version is unsupported');
  const active=revisionManifest(root,pointer.revision_id);
  if(active.commit_seq!==pointer.published_seq||['archive_id','access_domain_id','limits','origin_domains'].some(key=>canonical(active[key])!==canonical(pointer[key])))throw failure('INTEGRITY_FAILED','Archive pointer bindings differ from the published manifest');
  const manifest=revisionId&&revisionId!==pointer.revision_id?revisionManifest(root,revisionId):active;
  if(manifest.archive_id!==pointer.archive_id||manifest.commit_seq>pointer.published_seq)throw failure('INTEGRITY_FAILED','Revision is not published in this archive');
  const db=openLedger(root,true);try{db.exec('BEGIN');const row=db.prepare('SELECT manifest_sha256 FROM archive_commit WHERE seq=? AND revision_id=?').get(manifest.commit_seq,manifest.revision_id);if(!row||row.manifest_sha256!==digest(manifest))throw failure('INTEGRITY_FAILED','Published revision is not durably committed');db.exec('COMMIT');}finally{db.close();}
  return {...pointer,...manifest};
}
export function openLedger(root,readOnly=false){return new sqlite.DatabaseSync(inside(root,'ledger.sqlite'),{readOnly});}
export function initializeLedger(root){
  const db=openLedger(root);db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE archive_commit(seq INTEGER PRIMARY KEY,revision_id TEXT UNIQUE NOT NULL,manifest_sha256 TEXT NOT NULL,recorded_at TEXT NOT NULL,job_id TEXT NOT NULL);
    CREATE TABLE source_revision(id TEXT PRIMARY KEY,lineage_id TEXT NOT NULL,commit_seq INTEGER NOT NULL,manifest_json TEXT NOT NULL);
    CREATE TABLE session_version(id TEXT NOT NULL,commit_seq INTEGER NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(id,commit_seq));
    CREATE TABLE logical_event(id TEXT NOT NULL,commit_seq INTEGER NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(id,commit_seq));
    CREATE TABLE association_version(id TEXT NOT NULL,branch_id TEXT NOT NULL,commit_seq INTEGER NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(id,branch_id,commit_seq));
    CREATE TABLE legacy_alias(case_hash TEXT NOT NULL,old_event_id TEXT NOT NULL,event_id TEXT NOT NULL,commit_seq INTEGER NOT NULL,evidence_json TEXT NOT NULL,PRIMARY KEY(case_hash,old_event_id));
    CREATE TABLE mutation_receipt(operation TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,response_json TEXT NOT NULL,commit_seq INTEGER NOT NULL,PRIMARY KEY(operation,idempotency_key));`);db.close();
}
export function processIdentity(pid){
  try{
    process.kill(pid,0);
    if(process.platform==='win32'){
      const executable=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
      const start=execFileSync(executable,['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();
      if(!/^\d+$/.test(start))return {status:'UNKNOWN'};return {status:'ALIVE',start_identity:start};
    }
    if(process.platform==='linux'){const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');return {status:'ALIVE',start_identity:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]};}
    return {status:'UNKNOWN'};
  }catch(error){return error.code==='ESRCH'?{status:'DEAD'}:{status:'UNKNOWN'};}
}
export function acquireLock(root,archiveId,jobId,{recoveryToken=null}={}){
  const guard=inside(root,'recovery.lock');const checkRecovery=()=>{if(fs.existsSync(guard)&&readJson(guard).nonce!==recoveryToken)throw failure('BUSY','Archive recovery is already owned');};checkRecovery();
  const owner=processIdentity(process.pid);if(owner.status!=='ALIVE')throw failure('OWNER_UNVERIFIED','Cannot establish operating-system process identity');
  const lock={schema_version:4,archive_id:archiveId,pid:process.pid,host_id:os.hostname(),process_start_identity:owner.start_identity,nonce:randomUUID(),job_id:jobId};
  const file=inside(root,'writer.lock');let fd;try{fd=fs.openSync(file,'wx');}catch(error){if(error.code==='EEXIST')throw failure('BUSY','Archive writer is already owned');throw error;}
  try{fs.writeFileSync(fd,canonical(lock)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{checkRecovery();}catch(error){releaseLock(root,lock);throw error;}return lock;
}
export function releaseLock(root,lock){const file=inside(root,'writer.lock');if(!fs.existsSync(file))return;const observed=readJson(file);if(observed.nonce!==lock.nonce||observed.pid!==process.pid)throw failure('OWNER_UNVERIFIED','Writer lock ownership changed');fs.unlinkSync(file);}
export function checkpoint(root,jobId,payload){const value={schema_version:4,job_id:jobId,...payload};writeJson(inside(root,'jobs',jobId,'checkpoint.json'),{payload:value,sha256:digest(value)},{replace:true});return value;}
export function readCheckpoint(root,jobId){if(!/^job-[a-f0-9-]{36}$/.test(jobId))throw failure('INVALID_REQUEST','Invalid job identity');const envelope=readJson(inside(root,'jobs',jobId,'checkpoint.json'));if(digest(envelope.payload)!==envelope.sha256||envelope.payload.job_id!==jobId)throw failure('INTEGRITY_FAILED','Checkpoint digest or job identity differs');return envelope.payload;}

export function claimRecovery(root,request,archiveId){
  const lockPath=inside(root,'writer.lock'),guardPath=inside(root,'recovery.lock');
  const owner=readJson(lockPath);
  if(owner.archive_id!==archiveId||owner.job_id!==request.params.job_id||owner.nonce!==request.params.expected_owner_token||owner.host_id!==os.hostname()||!Number.isSafeInteger(owner.pid)||owner.pid<1||!owner.process_start_identity)throw failure('OWNER_UNVERIFIED','Recovery owner identity does not match');
  const observed=processIdentity(owner.pid);
  if(observed.status==='ALIVE'){if(observed.start_identity!==owner.process_start_identity)throw failure('OWNER_UNVERIFIED','Operating-system PID belongs to a different process');throw failure('BUSY','Archive writer process is alive');}
  if(observed.status!=='DEAD')throw failure('OWNER_UNVERIFIED','Operating system cannot confirm that the writer exited');
  const saved=readCheckpoint(root,owner.job_id);if(canonical(saved.owner)!==canonical(owner))throw failure('INTEGRITY_FAILED','Checkpoint owner differs from writer lock');
  const guard={nonce:randomUUID(),pid:process.pid,job_id:owner.job_id};let fd;
  try{fd=fs.openSync(guardPath,'wx');}catch(error){if(error.code==='EEXIST')throw failure('BUSY','Another recovery owns this archive');throw error;}
  try{fs.writeFileSync(fd,canonical(guard)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{
    if(canonical(readJson(lockPath))!==canonical(owner))throw failure('OWNER_UNVERIFIED','Writer ownership changed during recovery');
    fs.unlinkSync(lockPath);
    const lock=acquireLock(root,archiveId,owner.job_id,{recoveryToken:guard.nonce});
    return {saved,lock};
  }finally{if(readJson(guardPath).nonce===guard.nonce)fs.unlinkSync(guardPath);}
}

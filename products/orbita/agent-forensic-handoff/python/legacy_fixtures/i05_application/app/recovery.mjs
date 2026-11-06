import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes,randomUUID,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {plainPath,exclusiveStore} from './store-access.mjs';
import {semanticExportGuard} from './semantic-storage.mjs';
import {verifyCaseIntegrity} from '../agent-forensic-handoff/src/integrity.js';

const MAGIC=Buffer.from('ORBITA-BACKUP-01\0'),BLOCK=1024*1024,HEADER=MAGIC.length+28;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const digest=()=>createHash('sha256');
const demand=(ok,message)=>{if(!ok)throw new Error(message);};
const crash=point=>{if(process.env.AFH_RECOVERY_CRASH_AT===point)process.exit(86);};
const limits=input=>({maxBytes:input?.maxBytes??50*1024**3,maxFiles:input?.maxFiles??1000000});
function validateLimits(l){demand(Number.isSafeInteger(l.maxBytes)&&l.maxBytes>=1&&Number.isSafeInteger(l.maxFiles)&&l.maxFiles>=1,'RECOVERY_LIMITS');}
export function disjoint(a,b){a=path.resolve(a).toLowerCase();b=path.resolve(b).toLowerCase();demand(a!==b&&!a.startsWith(b+path.sep)&&!b.startsWith(a+path.sep),'RECOVERY_OVERLAP');}
export function safeMember(name) {
  demand(typeof name==='string'&&name.length>0&&Buffer.byteLength(name)<=2048&&!name.includes('\\')&&name===name.normalize('NFC'),'RECOVERY_MEMBER_PATH');
  for(const p of name.split('/'))demand(p&&p!=='.'&&p!=='..'&&!/[\x00-\x1f\x7f<>:"|?*]/.test(p)&&!/[. ]$/.test(p)&&!/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p),'RECOVERY_MEMBER_PATH');
  return name;
}
async function* chunks(file,{allowHardlinks=false}={}) {
  plainPath(file);const stat=fs.lstatSync(file);demand(stat.isFile()&&(allowHardlinks||stat.nlink===1),'RECOVERY_NON_REGULAR');
  const handle=fs.openSync(file,'r');
  try{let n;const buffer=Buffer.allocUnsafe(BLOCK);while((n=fs.readSync(handle,buffer,0,BLOCK,null))>0){yield Buffer.from(buffer.subarray(0,n));await tick();}}
  finally{fs.closeSync(handle);}
}
export async function hashFile(file,options){const h=digest();for await(const b of chunks(file,options))h.update(b);return h.digest('hex');}
async function* walk(root,relative='') {
  for(const name of fs.readdirSync(path.join(root,relative)).sort()) {
    const rel=relative?relative+'/'+name:name;safeMember(rel);const full=plainPath(path.join(root,rel)),stat=fs.lstatSync(full);
    demand(!stat.isSymbolicLink(),'RECOVERY_LINK_MEMBER');
    if(stat.isDirectory()){yield {type:'dir',path:rel};yield* walk(root,rel);}
    else {demand(stat.isFile()&&stat.nlink===1,'RECOVERY_NON_REGULAR');yield {type:'file',path:rel,size:stat.size,sha256:await hashFile(full)};}
  }
}
function frame(entry){const b=Buffer.from(JSON.stringify(entry)),n=Buffer.alloc(4);demand(b.length<=8192,'RECOVERY_ENTRY_BUDGET');n.writeUInt32BE(b.length);return Buffer.concat([n,b]);}
export async function inventory(root,options={}){
  root=plainPath(root);const l=limits(options);validateLimits(l);let files=0,bytes=0,entries=0;const h=digest(),names=new Set();
  for await(const e of walk(root)){const folded=e.path.toLowerCase();demand(!names.has(folded),'RECOVERY_ALIASED_MEMBER');names.add(folded);h.update(frame(e));entries++;if(e.type==='file'){files++;bytes+=e.size;}demand(files<=l.maxFiles&&bytes<=l.maxBytes&&entries<=l.maxFiles*4,'RECOVERY_QUOTA');}
  return {files,bytes,entries,treeHash:h.digest('hex')};
}
async function validateCopiedStore(root){
  root=plainPath(root);const libraryPath=path.join(root,'library.json');demand(fs.existsSync(libraryPath)&&fs.statSync(libraryPath).size<=16*1024**2,'RECOVERY_LIBRARY_REQUIRED');
  const library=JSON.parse(fs.readFileSync(libraryPath,'utf8'));demand(Array.isArray(library),'RECOVERY_LIBRARY_INVALID');
  const ids=new Set();let records=0,databases=0;
  for(const item of library){demand(typeof item.id==='string'&&/^[-a-zA-Z0-9_]{1,180}$/.test(item.id)&&!ids.has(item.id),'RECOVERY_CASE_ID');ids.add(item.id);
    // A restore must never fall back to the old absolute path in library.json.
    const local=path.join(root,'cases',item.id);demand(fs.existsSync(local),'RECOVERY_EXTERNAL_CASE');
    const checked=await verifyCaseIntegrity(local,{verifyProjections:false});demand(checked.passed,'RECOVERY_CASE_INTEGRITY:'+item.id);
    records+=JSON.parse(fs.readFileSync(path.join(local,'case.json'),'utf8')).metrics.sourceRecords;
  }
  // Includes canonical N04/N06/learning, outboxes, leases and all local indexes.
  for await(const entry of walk(root))if(entry.type==='file'&&/\.(sqlite|sqlite3|db)$/.test(entry.path)){
    const db=new DatabaseSync(path.toNamespacedPath(path.join(root,entry.path)),{readOnly:true});
    try{const rows=db.prepare('PRAGMA integrity_check').all();demand(rows.length===1&&Object.values(rows[0])[0]==='ok','RECOVERY_SQLITE_INTEGRITY:'+entry.path);databases++;}finally{db.close();}
  }
  return {conversations:ids.size,records,databases,originalsVerified:true};
}
export async function validateStore(root,{scratchRoot}={}){
  // SQLite readOnly connections can still create WAL/SHM sidecars. Validate a
  // private copy so even an inspection cannot mutate source or restored bytes.
  root=plainPath(root);const parent=plainPath(scratchRoot||os.tmpdir());fs.mkdirSync(parent,{recursive:true});const stage=fs.mkdtempSync(path.join(parent,'orbita-verify-'));disjoint(root,stage);
  try{for await(const e of walk(root)){const to=path.join(stage,e.path);if(e.type==='dir')fs.mkdirSync(to);else fs.copyFileSync(path.join(root,e.path),to,fs.constants.COPYFILE_EXCL);}return await validateCopiedStore(stage);}
  finally{demand(path.dirname(stage)===parent&&path.basename(stage).startsWith('orbita-verify-'),'RECOVERY_CLEANUP_SCOPE');fs.rmSync(stage,{recursive:true,force:true});}
}
function keyFor(password,salt){demand(typeof password==='string'&&[...password].length>=12&&Buffer.byteLength(password)<=4096,'RECOVERY_PASSPHRASE_12_CHARACTERS');return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024**2});}
function syncFile(file){const fd=fs.openSync(file,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function receiptFile(root){root=plainPath(root);return path.join(path.dirname(root),'.'+path.basename(root)+'.orbita-restore.json');}
export function restoreState(root){const file=receiptFile(root);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;}
export function requireExternalAccess(root){const s=restoreState(root);demand(!s||s.externalAccess===true,'RECOVERY_EXTERNAL_ACCESS_PAUSED');}
export function automaticAllowed(root){const s=restoreState(root);return !s||s.automaticWork===true;}
function saveState(root,state){const file=receiptFile(root),temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});syncFile(temp);fs.renameSync(temp,file);}
export function activateRestore(root,{automaticWork=false,externalAccess=false,restoreId}){
  const state=restoreState(root);demand(state&&state.id===restoreId,'RECOVERY_RESTORE_ID');demand(typeof automaticWork==='boolean'&&typeof externalAccess==='boolean','RECOVERY_ACTIVATION_FLAGS');
  const next={...state,automaticWork,externalAccess,activationAt:new Date().toISOString()};saveState(root,next);return next;
}
export async function createBackup({source,archive,password,ownSession=false,...options}) {
  source=plainPath(source);archive=plainPath(archive);disjoint(source,archive);demand(!fs.existsSync(archive),'RECOVERY_DESTINATION_EXISTS');
  const l=limits(options);validateLimits(l);const release=exclusiveStore(source,{ownSession}),temporary=archive+'.'+randomUUID()+'.partial';let key,semanticGuard;
  try {
    semanticGuard=await semanticExportGuard(source);
    fs.mkdirSync(path.dirname(archive),{recursive:true});plainPath(path.dirname(archive));
    const before=await inventory(source,l),validation=await validateStore(source,{scratchRoot:options.scratchRoot}),createdAt=new Date().toISOString(),id=randomUUID();
    const salt=randomBytes(16),nonce=randomBytes(12),header=Buffer.concat([MAGIC,salt,nonce]);key=keyFor(password,salt);
    const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(header);
    const stream=fs.createWriteStream(temporary,{flags:'wx',mode:0o600});
    async function* encrypted(){
      yield header;const h=digest();let files=0,bytes=0,entries=0;
      for await(const entry of walk(source)){
        const framed=frame(entry);h.update(framed);entries++;yield cipher.update(framed);
        if(entry.type==='file'){files++;bytes+=entry.size;const actual=digest();let size=0;
          for await(const b of chunks(path.join(source,entry.path))){size+=b.length;actual.update(b);yield cipher.update(b);}
          demand(size===entry.size&&actual.digest('hex')===entry.sha256,'RECOVERY_SOURCE_CHANGED');
        }
      }
      const observed={files,bytes,entries,treeHash:h.digest('hex')};demand(JSON.stringify(observed)===JSON.stringify(before),'RECOVERY_SOURCE_CHANGED');
      yield cipher.update(frame({type:'end',schema:'orbita-memory-1',id,createdAt,sourceRoot:source,...before,validation}));yield cipher.final();yield cipher.getAuthTag();
    }
    await pipeline(Readable.from(encrypted()),stream);syncFile(temporary);
    demand(JSON.stringify(await inventory(source,l))===JSON.stringify(before),'RECOVERY_SOURCE_CHANGED');crash('backup-before-publish');
    semanticGuard?.assertHeld?.();
    // Exclusive hard-link publication cannot replace an existing archive.
    fs.linkSync(temporary,archive);crash('backup-after-publish');fs.unlinkSync(temporary);
    return {id,createdAt,archive,archiveSha256:await hashFile(archive,{allowHardlinks:true}),...before,validation,cipher:'AES-256-GCM',kdf:'scrypt N=32768,r=8,p=1',consistency:'quiescent guarded store'};
  }finally{key?.fill(0);if(fs.existsSync(temporary))fs.unlinkSync(temporary);try{await semanticGuard?.release();}finally{release();}}
}
class Reader {
  constructor(file){this.fd=fs.openSync(file,'r');this.offset=0;this.size=fs.fstatSync(this.fd).size;}
  read(n){demand(Number.isSafeInteger(n)&&n>=0&&n<=BLOCK,'RECOVERY_READ_BUDGET');const b=Buffer.alloc(n);demand(fs.readSync(this.fd,b,0,n,this.offset)===n,'RECOVERY_TRUNCATED');this.offset+=n;return b;}
  entry(){const n=this.read(4).readUInt32BE();demand(n>0&&n<=8192,'RECOVERY_ENTRY_BUDGET');const raw=this.read(n).toString('utf8'),value=JSON.parse(raw);demand(JSON.stringify(value)===raw,'RECOVERY_NONCANONICAL_ENTRY');return value;}
  close(){fs.closeSync(this.fd);}
}
export async function restoreBackup({archive,destination,password,...options}) {
  archive=plainPath(archive);destination=plainPath(destination);disjoint(archive,destination);
  demand(!fs.existsSync(destination),'RECOVERY_DESTINATION_EXISTS');const l=limits(options);validateLimits(l);
  const release=exclusiveStore(destination),operation=randomUUID(),stage=path.join(path.dirname(destination),'.orbita-restore-'+operation);let key;
  try {
    const size=fs.statSync(archive).size;demand(size>HEADER+16&&size<=l.maxBytes+l.maxFiles*32768,'RECOVERY_ARCHIVE_BUDGET');
    const input=fs.openSync(archive,'r');let header,tag;
    try{header=Buffer.alloc(HEADER);tag=Buffer.alloc(16);demand(fs.readSync(input,header,0,HEADER,0)===HEADER&&fs.readSync(input,tag,0,16,size-16)===16,'RECOVERY_TRUNCATED');}finally{fs.closeSync(input);}
    demand(header.subarray(0,MAGIC.length).equals(MAGIC),'RECOVERY_FORMAT');key=keyFor(password,header.subarray(MAGIC.length,MAGIC.length+16));
    fs.mkdirSync(stage,{mode:0o700});const payload=path.join(stage,'authenticated-payload');
    const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(-12));decipher.setAAD(header);decipher.setAuthTag(tag);const archiveDigest=digest().update(header);
    async function* ciphertext(){for await(const bytes of fs.createReadStream(archive,{start:HEADER,end:size-17,highWaterMark:BLOCK})){archiveDigest.update(bytes);yield bytes;}}
    // No paths or JSON from the archive are parsed before authentication finishes.
    try{await pipeline(Readable.from(ciphertext()),decipher,fs.createWriteStream(payload,{flags:'wx',mode:0o600}));}
    catch{throw new Error('RECOVERY_AUTHENTICATION_FAILED');}
    const archiveSha256=archiveDigest.update(tag).digest('hex');
    const target=path.join(stage,'data');fs.mkdirSync(target);const reader=new Reader(payload),seen=new Set(),h=digest();let end,files=0,bytes=0,entries=0;
    try {
      while(reader.offset<reader.size){const e=reader.entry();if(e.type==='end'){end=e;break;}
        demand(e.type==='file'||e.type==='dir','RECOVERY_ENTRY_TYPE');safeMember(e.path);const folded=e.path.toLowerCase();demand(!seen.has(folded),'RECOVERY_ALIASED_MEMBER');seen.add(folded);
        const allowed=e.type==='dir'?['type','path']:['type','path','size','sha256'];demand(JSON.stringify(Object.keys(e))===JSON.stringify(allowed),'RECOVERY_ENTRY_FIELDS');
        const parts=folded.split('/');for(let i=1;i<parts.length;i++)demand(seen.has(parts.slice(0,i).join('/')),'RECOVERY_PARENT_REQUIRED');
        h.update(frame(e));entries++;demand(entries<=l.maxFiles*4,'RECOVERY_QUOTA');const file=path.join(target,...e.path.split('/'));
        if(e.type==='dir'){fs.mkdirSync(file);continue;}
        demand(Number.isSafeInteger(e.size)&&e.size>=0&&/^[a-f0-9]{64}$/.test(e.sha256),'RECOVERY_FILE_FIELDS');files++;bytes+=e.size;demand(files<=l.maxFiles&&bytes<=l.maxBytes,'RECOVERY_QUOTA');
        const fd=fs.openSync(file,'wx',0o600),actual=digest();try{let remaining=e.size;while(remaining){const b=reader.read(Math.min(BLOCK,remaining));let offset=0;while(offset<b.length){const n=fs.writeSync(fd,b,offset,b.length-offset);demand(n>0,'RECOVERY_SHORT_WRITE');offset+=n;}actual.update(b);remaining-=b.length;await tick();}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        demand(actual.digest('hex')===e.sha256,'RECOVERY_MEMBER_HASH');
      }
      demand(end?.schema==='orbita-memory-1'&&reader.offset===reader.size,'RECOVERY_END_REQUIRED');
      demand(files===end.files&&bytes===end.bytes&&entries===end.entries&&h.digest('hex')===end.treeHash,'RECOVERY_MANIFEST_MISMATCH');
    }finally{reader.close();}
    disjoint(end.sourceRoot,destination);demand(!fs.existsSync(destination),'RECOVERY_DESTINATION_EXISTS');
    const validation=await validateStore(target,{scratchRoot:options.scratchRoot}),actual=await inventory(target,l);demand(actual.treeHash===end.treeHash,'RECOVERY_VALIDATION_CHANGED_BYTES');
    const state={schema:'orbita-restore-1',id:operation,snapshotId:end.id,archiveSha256,restoredAt:new Date().toISOString(),destination,sourceRoot:end.sourceRoot,...actual,validation,automaticWork:false,externalAccess:false};
    // The sibling control state precedes publication: even a crash immediately
    // after rename cannot accidentally start automatic work or external routes.
    saveState(destination,state);crash('restore-before-publish');fs.renameSync(target,destination);crash('restore-after-publish');return state;
  }finally{key?.fill(0);if(fs.existsSync(stage)){demand(path.dirname(stage)===path.dirname(destination)&&path.basename(stage)==='.orbita-restore-'+operation,'RECOVERY_CLEANUP_SCOPE');fs.rmSync(stage,{recursive:true,force:true});}release();}
}

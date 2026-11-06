import native from 'node:fs';
import fs from '../agent-forensic-handoff/src/common-files.js';
import {DatabaseSync,exportCommonStore,importCommonStore,restoreControl,objectOperation} from '../agent-forensic-handoff/src/common-store.js';
import path from 'node:path';
import {createHash,randomBytes,randomUUID,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {plainPath,exclusiveStore} from './store-access.mjs';
import {verifyCaseIntegrity} from '../agent-forensic-handoff/src/integrity.js';

const MAGIC=Buffer.from('ORBITA-BACKUP-02\0'),BLOCK=1024*1024,HEADER=MAGIC.length+28;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const digest=()=>createHash('sha256');
const demand=(ok,message)=>{if(!ok)throw new Error(message);};
const crash=point=>{if(process.env.AFH_RECOVERY_CRASH_AT===point)process.exit(86);};
const limits=input=>({maxBytes:input?.maxBytes??50*1024**3,maxFiles:input?.maxFiles??1000000});
function validateLimits(l){demand(Number.isSafeInteger(l.maxBytes)&&l.maxBytes>=1&&Number.isSafeInteger(l.maxFiles)&&l.maxFiles>=1,'RECOVERY_LIMITS');}
function backend(storage){demand(['native','postgresql-common'].includes(storage),'RECOVERY_ARCHIVE_STORAGE');return storage==='native'?native:fs;}
export function disjoint(a,b){a=path.resolve(a).toLowerCase();b=path.resolve(b).toLowerCase();demand(a!==b&&!a.startsWith(b+path.sep)&&!b.startsWith(a+path.sep),'RECOVERY_OVERLAP');}
export function safeMember(name) {
  demand(typeof name==='string'&&name.length>0&&Buffer.byteLength(name)<=2048&&!name.includes('\\')&&name===name.normalize('NFC'),'RECOVERY_MEMBER_PATH');
  for(const p of name.split('/'))demand(p&&p!=='.'&&p!=='..'&&!/[\x00-\x1f\x7f<>:"|?*]/.test(p)&&!/[. ]$/.test(p)&&!/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p),'RECOVERY_MEMBER_PATH');
  return name;
}
async function* chunks(file,{allowHardlinks=false,storage='native'}={}) {
  const io=backend(storage);plainPath(file);const stat=io.lstatSync(file);demand(stat.isFile()&&!stat.isStore?.()&&(allowHardlinks||stat.nlink===1),'RECOVERY_NON_REGULAR');
  const handle=io.openSync(file,'r');
  try{let n;const buffer=Buffer.allocUnsafe(BLOCK);while((n=io.readSync(handle,buffer,0,BLOCK,null))>0){yield Buffer.from(buffer.subarray(0,n));await tick();}}
  finally{io.closeSync(handle);}
}
export async function hashFile(file,options){const h=digest();for await(const b of chunks(file,options))h.update(b);return h.digest('hex');}
async function* walk(root,relative='') {
  for(const name of fs.readdirSync(path.join(root,relative)).sort()) {
    const rel=relative?relative+'/'+name:name;safeMember(rel);const full=plainPath(path.join(root,rel)),stat=fs.lstatSync(full);
    demand(!stat.isSymbolicLink(),'RECOVERY_LINK_MEMBER');
    if(stat.isDirectory()){yield {type:'dir',path:rel};yield* walk(root,rel);}
    else if(stat.isStore()){
      const transfer=exportCommonStore(full);try{const i=transfer.info;yield {type:'store',path:rel,family:i.family,format:i.format,size:i.size,rowsSha256:i.rowsSha256};}finally{transfer.close();}
    }else {demand(stat.isFile()&&stat.nlink===1,'RECOVERY_NON_REGULAR');yield {type:'file',path:rel,size:stat.size,sha256:await hashFile(full,{storage:'postgresql-common'})};}
  }
}
function frame(entry){const b=Buffer.from(JSON.stringify(entry)),n=Buffer.alloc(4);demand(b.length<=8192,'RECOVERY_ENTRY_BUDGET');n.writeUInt32BE(b.length);return Buffer.concat([n,b]);}
export async function inventory(root,options={}){
  root=plainPath(root);const l=limits(options);validateLimits(l);let files=0,bytes=0,entries=0;const h=digest(),names=new Set();
  for await(const e of walk(root)){const folded=e.path.toLowerCase();demand(!names.has(folded),'RECOVERY_ALIASED_MEMBER');names.add(folded);h.update(frame(e));entries++;if(e.type!=='dir'){files++;bytes+=e.size;}demand(files<=l.maxFiles&&bytes<=l.maxBytes&&entries<=l.maxFiles*4,'RECOVERY_QUOTA');}
  return {files,bytes,entries,treeHash:h.digest('hex')};
}
async function validateCopiedStore(root){
  root=plainPath(root);const libraryPath=path.join(root,'library.json');demand(fs.existsSync(libraryPath)&&fs.statSync(libraryPath).size<=16*1024**2,'RECOVERY_LIBRARY_REQUIRED');
  const library=JSON.parse(fs.readFileSync(libraryPath,'utf8'));demand(Array.isArray(library),'RECOVERY_LIBRARY_INVALID');
  const ids=new Set();let records=0,databases=0;
  for(const item of library){demand(typeof item.id==='string'&&/^[-a-zA-Z0-9_]{1,180}$/.test(item.id)&&!ids.has(item.id),'RECOVERY_CASE_ID');ids.add(item.id);
    const local=path.join(root,'cases',item.id);demand(fs.existsSync(local),'RECOVERY_EXTERNAL_CASE');
    const checked=await verifyCaseIntegrity(local,{verifyProjections:false});demand(checked.passed,'RECOVERY_CASE_INTEGRITY:'+item.id);
    records+=JSON.parse(fs.readFileSync(path.join(local,'case.json'),'utf8')).metrics.sourceRecords;
  }
  for await(const entry of walk(root)){
    if(entry.type==='file'&&/\.(pgstore|sqlite|sqlite3|db)$/.test(entry.path))throw new Error('RECOVERY_RELATIONAL_LOCATOR_REQUIRED:'+entry.path);
    if(entry.type==='store'){
      const db=new DatabaseSync(path.join(root,entry.path),{family:entry.family,readOnly:true});
      try{demand(db.logicalManifest().sha256===entry.rowsSha256,'RECOVERY_ROW_INTEGRITY:'+entry.path);databases++;}finally{db.close();}
    }
  }
  return {conversations:ids.size,records,databases,originalsVerified:true};
}
export async function validateStore(root,{scratchRoot}={}){
  root=plainPath(root);const parent=plainPath(scratchRoot||path.dirname(root));fs.mkdirSync(parent,{recursive:true});
  const stage=path.join(parent,'orbita-verify-'+randomUUID());disjoint(root,stage);
  try{fs.cloneTreeSync(root,stage);return await validateCopiedStore(stage);}
  finally{if(fs.existsSync(stage)){demand(path.dirname(stage)===parent&&path.basename(stage).startsWith('orbita-verify-'),'RECOVERY_CLEANUP_SCOPE');fs.rmSync(stage,{recursive:true,force:false});}}
}
function keyFor(password,salt){demand(typeof password==='string'&&[...password].length>=12&&Buffer.byteLength(password)<=4096,'RECOVERY_PASSPHRASE_12_CHARACTERS');return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024**2});}
function syncNative(file){const fd=native.openSync(file,'r+');try{native.fsyncSync(fd);}finally{native.closeSync(fd);}}
export function restoreState(root){return restoreControl('state',plainPath(root));}
export function requireExternalAccess(root){const s=restoreState(root);demand(!s||s.externalAccess===true,'RECOVERY_EXTERNAL_ACCESS_PAUSED');}
export function automaticAllowed(root){const s=restoreState(root);return !s||s.automaticWork===true;}
export function activateRestore(root,{automaticWork=false,externalAccess=false,restoreId}){
  const state=restoreState(root);demand(state&&state.id===restoreId,'RECOVERY_RESTORE_ID');demand(typeof automaticWork==='boolean'&&typeof externalAccess==='boolean','RECOVERY_ACTIVATION_FLAGS');
  return restoreControl('activate',root,{restoreId,automaticWork,externalAccess});
}
export async function createBackup({source,archive,password,ownSession=false,archiveStorage='native',...options}) {
  const io=backend(archiveStorage);source=plainPath(source);archive=plainPath(archive);disjoint(source,archive);demand(!io.existsSync(archive),'RECOVERY_DESTINATION_EXISTS');
  const l=limits(options);validateLimits(l);const release=exclusiveStore(source,{ownSession}),temporary=archive+'.'+randomUUID()+'.partial';let key;
  try {
    io.mkdirSync(path.dirname(archive),{recursive:true});plainPath(path.dirname(archive));
    const before=await inventory(source,l),validation=await validateStore(source,{scratchRoot:options.scratchRoot}),createdAt=new Date().toISOString(),id=randomUUID();
    const salt=randomBytes(16),nonce=randomBytes(12),header=Buffer.concat([MAGIC,salt,nonce]);key=keyFor(password,salt);
    const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(header);
    const stream=io.createWriteStream(temporary,{flags:'wx',mode:0o600});
    async function* encrypted(){
      yield header;const h=digest();let files=0,bytes=0,entries=0;
      for await(const entry of walk(source)){
        const framed=frame(entry);h.update(framed);entries++;yield cipher.update(framed);
        if(entry.type==='file'){files++;bytes+=entry.size;const actual=digest();let size=0;
          for await(const b of chunks(path.join(source,entry.path),{storage:'postgresql-common'})){size+=b.length;actual.update(b);yield cipher.update(b);}
          demand(size===entry.size&&actual.digest('hex')===entry.sha256,'RECOVERY_SOURCE_CHANGED');
        }else if(entry.type==='store'){
          files++;bytes+=entry.size;const transfer=exportCommonStore(path.join(source,entry.path));let size=0;
          try{const info=transfer.info;demand(info.size===entry.size&&info.rowsSha256===entry.rowsSha256&&info.family===entry.family&&info.format===entry.format,'RECOVERY_SOURCE_CHANGED');
            for(;;){const b=transfer.read(BLOCK);if(!b.length)break;size+=b.length;yield cipher.update(b);await tick();}
            demand(size===entry.size,'RECOVERY_SOURCE_CHANGED');
          }finally{transfer.close();}
        }
      }
      const observed={files,bytes,entries,treeHash:h.digest('hex')};demand(JSON.stringify(observed)===JSON.stringify(before),'RECOVERY_SOURCE_CHANGED');
      yield cipher.update(frame({type:'end',schema:'orbita-memory-2',id,createdAt,sourceRoot:source,...before,validation}));yield cipher.final();yield cipher.getAuthTag();
    }
    await pipeline(Readable.from(encrypted()),stream);if(archiveStorage==='native')syncNative(temporary);
    demand(JSON.stringify(await inventory(source,l))===JSON.stringify(before),'RECOVERY_SOURCE_CHANGED');crash('backup-before-publish');
    if(archiveStorage==='native')io.linkSync(temporary,archive);else objectOperation('rename',temporary,{target:archive,replace:false});
    crash('backup-after-publish');if(io.existsSync(temporary))io.unlinkSync(temporary);
    return {id,createdAt,archive,archiveStorage,archiveSha256:await hashFile(archive,{allowHardlinks:true,storage:archiveStorage}),...before,validation,cipher:'AES-256-GCM',kdf:'scrypt N=32768,r=8,p=1',consistency:'quiescent common store with repeatable typed row snapshots'};
  }finally{key?.fill(0);try{if(io.existsSync(temporary))io.unlinkSync(temporary);}finally{release();}}
}
class Reader {
  constructor(file,storage='postgresql-common'){this.io=backend(storage);this.fd=this.io.openSync(file,'r');this.stat=this.io.fstatSync(this.fd);this.offset=0;this.size=this.stat.size;this.cache=Buffer.alloc(0);this.cacheStart=0;}
  read(n){
    demand(Number.isSafeInteger(n)&&n>=0&&n<=BLOCK,'RECOVERY_READ_BUDGET');demand(this.offset+n<=this.size,'RECOVERY_TRUNCATED');
    if(this.offset<this.cacheStart||this.offset+n>this.cacheStart+this.cache.length){
      const b=Buffer.allocUnsafe(Math.min(this.size-this.offset,Math.max(65536,n)));const count=this.io.readSync(this.fd,b,0,b.length,this.offset);
      demand(count>=n,'RECOVERY_TRUNCATED');this.cache=b.subarray(0,count);this.cacheStart=this.offset;
    }
    const start=this.offset-this.cacheStart,result=Buffer.from(this.cache.subarray(start,start+n));this.offset+=n;return result;
  }
  entry(){const n=this.read(4).readUInt32BE();demand(n>0&&n<=8192,'RECOVERY_ENTRY_BUDGET');const raw=this.read(n).toString('utf8'),value=JSON.parse(raw);demand(JSON.stringify(value)===raw,'RECOVERY_NONCANONICAL_ENTRY');return value;}
  close(){this.io.closeSync(this.fd);}
}
export async function restoreBackup({archive,destination,password,archiveStorage='native',...options}) {
  backend(archiveStorage);archive=plainPath(archive);destination=plainPath(destination);disjoint(archive,destination);
  demand(!fs.existsSync(destination),'RECOVERY_DESTINATION_EXISTS');const l=limits(options);validateLimits(l);
  const release=exclusiveStore(destination),operation=randomUUID(),stage=path.join(path.dirname(destination),'.orbita-restore-'+operation);let key,input;
  try {
    input=new Reader(archive,archiveStorage);const size=input.size;demand(size>HEADER+16&&size<=l.maxBytes+l.maxFiles*32768,'RECOVERY_ARCHIVE_BUDGET');
    const header=input.read(HEADER);input.offset=size-16;const tag=input.read(16);input.offset=HEADER;
    demand(header.subarray(0,MAGIC.length).equals(MAGIC),'RECOVERY_FORMAT');key=keyFor(password,header.subarray(MAGIC.length,MAGIC.length+16));
    fs.mkdirSync(stage,{mode:0o700});const payload=path.join(stage,'authenticated-payload');
    const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(-12));decipher.setAAD(header);decipher.setAuthTag(tag);const archiveDigest=digest().update(header);
    async function* ciphertext(){while(input.offset<size-16){const bytes=input.read(Math.min(BLOCK,size-16-input.offset));archiveDigest.update(bytes);yield bytes;await tick();}}
    // No path, frame or JSON from the archive is parsed before authentication.
    // The plaintext is a scoped PG object; there is no local plaintext spool.
    try{await pipeline(Readable.from(ciphertext()),decipher,fs.createWriteStream(payload,{flags:'wx',mode:0o600}));}
    catch{throw new Error('RECOVERY_AUTHENTICATION_FAILED');}
    const archiveSha256=archiveDigest.update(tag).digest('hex');
    const target=path.join(stage,'data');fs.mkdirSync(target);const reader=new Reader(payload),seen=new Set(),h=digest();let end,files=0,bytes=0,entries=0;
    try {
      while(reader.offset<reader.size){const e=reader.entry();if(e.type==='end'){end=e;break;}
        demand(['file','dir','store'].includes(e.type),'RECOVERY_ENTRY_TYPE');safeMember(e.path);const folded=e.path.toLowerCase();demand(!seen.has(folded),'RECOVERY_ALIASED_MEMBER');seen.add(folded);
        const allowed=e.type==='dir'?['type','path']:e.type==='store'?['type','path','family','format','size','rowsSha256']:['type','path','size','sha256'];demand(JSON.stringify(Object.keys(e))===JSON.stringify(allowed),'RECOVERY_ENTRY_FIELDS');
        const parts=folded.split('/');for(let i=1;i<parts.length;i++)demand(seen.has(parts.slice(0,i).join('/')),'RECOVERY_PARENT_REQUIRED');
        h.update(frame(e));entries++;demand(entries<=l.maxFiles*4,'RECOVERY_QUOTA');const file=path.join(target,...e.path.split('/'));
        if(e.type==='dir'){fs.mkdirSync(file);continue;}
        demand(Number.isSafeInteger(e.size)&&e.size>=0,'RECOVERY_FILE_FIELDS');files++;bytes+=e.size;demand(files<=l.maxFiles&&bytes<=l.maxBytes,'RECOVERY_QUOTA');
        if(e.type==='store'){
          demand(/^[a-z][a-z0-9_]{0,39}$/.test(e.family)&&e.format==='orbita-row-transfer-1'&&/^[a-f0-9]{64}$/.test(e.rowsSha256)&&reader.offset+e.size<=reader.size,'RECOVERY_STORE_FIELDS');
          const restored=importCommonStore(payload,reader.offset,e.size,file,{expectedObjectId:reader.stat.objectId,expectedRevision:reader.stat.revision});
          demand(restored.family===e.family&&restored.format===e.format&&restored.size===e.size&&restored.rowsSha256===e.rowsSha256,'RECOVERY_STORE_MANIFEST');reader.offset+=e.size;continue;
        }
        demand(/^[a-f0-9]{64}$/.test(e.sha256),'RECOVERY_FILE_FIELDS');
        const fd=fs.openSync(file,'wx'),actual=digest();let closed=false;
        try{let remaining=e.size;while(remaining){const b=reader.read(Math.min(BLOCK,remaining));let offset=0;while(offset<b.length){const n=fs.writeSync(fd,b,offset,b.length-offset);demand(n>0,'RECOVERY_SHORT_WRITE');offset+=n;}actual.update(b);remaining-=b.length;await tick();}
          demand(actual.digest('hex')===e.sha256,'RECOVERY_MEMBER_HASH');fs.closeSync(fd);closed=true;
        }finally{if(!closed)fs.abortSync(fd);}
      }
      demand(end?.schema==='orbita-memory-2'&&reader.offset===reader.size,'RECOVERY_END_REQUIRED');
      demand(files===end.files&&bytes===end.bytes&&entries===end.entries&&h.digest('hex')===end.treeHash,'RECOVERY_MANIFEST_MISMATCH');
    }finally{reader.close();}
    disjoint(end.sourceRoot,destination);demand(!fs.existsSync(destination),'RECOVERY_DESTINATION_EXISTS');
    const validation=await validateStore(target,{scratchRoot:options.scratchRoot}),actual=await inventory(target,l);demand(actual.treeHash===end.treeHash,'RECOVERY_VALIDATION_CHANGED_BYTES');
    const state=restoreControl('prepare',destination,{state:{schema:'orbita-restore-2',id:operation,snapshotId:end.id,archiveSha256,restoredAt:new Date().toISOString(),destination,sourceRoot:end.sourceRoot,...actual,validation,automaticWork:false,externalAccess:false}});
    // Private control precedes publication and cannot be overwritten by content.
    crash('restore-before-publish');objectOperation('rename',target,{target:destination,replace:false});crash('restore-after-publish');return state;
  }finally{key?.fill(0);try{input?.close();if(fs.existsSync(stage)){demand(path.dirname(stage)===path.dirname(destination)&&path.basename(stage)==='.orbita-restore-'+operation,'RECOVERY_CLEANUP_SCOPE');fs.rmSync(stage,{recursive:true,force:false});}}finally{release();}}
}

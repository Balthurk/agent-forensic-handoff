import {Worker,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {pythonExecutable} from './python-runtime.js';

let current=null,nextId=1;
const error=(code)=>Object.assign(new Error(code),{code});

function timeout(){
  const value=Number(process.env.ORBITA_POSTGRES_BRIDGE_TIMEOUT_MS??60000);
  if(!Number.isSafeInteger(value)||value<100||value>300000)throw error('ORBITA_PG_BRIDGE_TIMEOUT_CONFIG');
  return value;
}
function invalidate(session){
  if(session.failed)return;session.failed=true;
  if(current===session)current=null;
  try{session.worker.postMessage({cancel:true});}catch{}
}
function session(){
  if(current&&!current.failed)return current;
  timeout();
  const python=pythonExecutable(['ORBITA_POSTGRES_PYTHON']);
  // Let Node inherit worker-compatible flags and preloads. Re-submitting the
  // process-wide execArgv would include flags forbidden for Worker instances.
  // A module data URL also works when the caller used --input-type=module.
  const bootstrap='import '+JSON.stringify(new URL('./common-store-worker.js',import.meta.url).href)+';';
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(bootstrap)),{
    workerData:{python,pythonRoot:fileURLToPath(new URL('../python/',import.meta.url))},
  });
  const value={worker,failed:false,closed:false};
  worker.on('error',()=>invalidate(value));worker.on('exit',()=>{if(!value.closed)invalidate(value);});
  worker.unref();current=value;return value;
}
function call(owner,payload){
  if(owner.failed||owner.closed)throw error('ORBITA_PG_BRIDGE_LOST');
  const id=nextId++,request=JSON.stringify({id,...payload});
  if(Buffer.byteLength(request)>8*1024*1024)throw error('ORBITA_PG_REQUEST_LIMIT');
  const sab=new SharedArrayBuffer(4),{port1,port2}=new MessageChannel();let response;
  try{
    owner.worker.postMessage({id,req:request,shutdown:payload.op==='shutdown',port:port2,sab},[port2]);
    if(Atomics.wait(new Int32Array(sab),0,0,timeout())==='timed-out')throw error('ORBITA_PG_BRIDGE_TIMEOUT_OUTCOME_UNKNOWN');
    response=receiveMessageOnPort(port1)?.message;
    if(!response||response.id!==id||typeof response.ok!=='boolean')throw error('ORBITA_PG_BRIDGE_PROTOCOL');
  }catch(e){invalidate(owner);throw e;}
  finally{port1.close();port2.close();}
  if(!response.ok){if(response.fatal)invalidate(owner);throw error(response.code||'ORBITA_PG_OPERATION_FAILED');}
  return response;
}

export function encodeValue(value){
  if(value===undefined)return null;
  if(typeof value==='bigint')return {__integer__:value.toString()};
  if(ArrayBuffer.isView(value))return {__bytes__:Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('base64')};
  if(Array.isArray(value))return value.map(encodeValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encodeValue(v)]));
  return value;
}
export function decodeValue(value,{readBigInts=false}={}){
  if(Array.isArray(value))return value.map(v=>decodeValue(v,{readBigInts}));
  if(value&&typeof value==='object'){
    if(Object.keys(value).length===1&&typeof value.__bytes__==='string')return Buffer.from(value.__bytes__,'base64');
    if(Object.keys(value).length===1&&typeof value.__integer__==='string'){
      if(!readBigInts)throw error('ORBITA_PG_INTEGER_OUT_OF_RANGE');
      return BigInt(value.__integer__);
    }
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,decodeValue(v,{readBigInts})]));
  }
  return value;
}
function params(args){
  if(args.length===1&&args[0]&&typeof args[0]==='object'&&!Array.isArray(args[0])&&!ArrayBuffer.isView(args[0])){
    return Object.fromEntries(Object.entries(args[0]).map(([k,v])=>[k.replace(/^[$:@]/,''),encodeValue(v)]));
  }
  return args.map(encodeValue);
}

class Statement{
  constructor(db,sql){this.db=db;this.sql=String(sql);this.bigints=false;}
  setReadBigInts(value){this.bigints=Boolean(value);return this;}
  request(op,args){this.db.assertOpen();return call(this.db.session,{op,dbId:this.db.id,sql:this.sql,params:params(args),readBigInts:this.bigints});}
  guarded(operation){try{return operation();}catch(e){this.db.failAtomicBatch();throw e;}}
  run(...args){return this.guarded(()=>{const r=this.request('run',args);return decodeValue({changes:r.changes,lastInsertRowid:r.lastInsertRowid},{readBigInts:this.bigints});});}
  get(...args){return this.guarded(()=>{const r=this.request('get',args).row;return r===null?undefined:decodeValue(r,{readBigInts:this.bigints});});}
  all(...args){return this.guarded(()=>decodeValue(this.request('all',args).rows,{readBigInts:this.bigints}));}
}

export class DatabaseSync{
  constructor(path,{family,readOnly=false,create=false}={}){
    if(typeof family!=='string'||!family)throw error('ORBITA_PG_FAMILY_REQUIRED');
    this.session=session();
    this.id=call(this.session,{op:'open',path:String(path),family,readOnly,create}).dbId;
    this.closed=false;
  }
  assertOpen(){if(this.closed)throw error('ORBITA_PG_DATABASE_CLOSED');if(this.session.failed||this.session.closed)throw error('ORBITA_PG_BRIDGE_LOST');}
  failAtomicBatch(){
    if(this.closed||this.session.failed||this.session.closed)return;
    // If notifying the bridge fails, invalidate this exact session. A lost
    // failure notification must never permit a later commit or reconnect.
    try{call(this.session,{op:'fail-atomic-batch',dbId:this.id});}catch{invalidate(this.session);}
  }
  exec(sql){try{this.assertOpen();call(this.session,{op:'exec',dbId:this.id,sql:String(sql)});}catch(e){this.failAtomicBatch();throw e;}}
  beginAtomicBatch(){this.assertOpen();call(this.session,{op:'begin-atomic-batch',dbId:this.id});}
  runAtomicWrites(writes){
    try{
      this.assertOpen();
      const result=call(this.session,{op:'atomic-writes',dbId:this.id,writes:encodeValue(writes)});
      if(!Array.isArray(writes)||result.completed!==writes.length)throw error('ORBITA_PG_BRIDGE_PROTOCOL');
      return result.completed;
    }catch(e){this.failAtomicBatch();throw e;}
  }
  beginConsistentWrite(){this.assertOpen();call(this.session,{op:'begin-consistent-write',dbId:this.id});}
  transactionOpen(path,{mode='r'}={}){this.assertOpen();return objectHandle(this.session,{op:'transaction-object.open',dbId:this.id,path:String(path),mode});}
  transactionMkdir(path){this.assertOpen();call(this.session,{op:'transaction-object.mkdir',dbId:this.id,path:String(path),recursive:true,existOk:true});}
  prepare(sql){this.assertOpen();return new Statement(this,sql);}
  nearestVectors(vector,limit=100){this.assertOpen();return decodeValue(call(this.session,{op:'nearest-vectors',dbId:this.id,vector:encodeValue(vector),limit}).rows,{readBigInts:true});}
  logicalManifest(){this.assertOpen();return decodeValue(call(this.session,{op:'logical-manifest',dbId:this.id}).manifest);}
  tableColumns(table){this.assertOpen();return call(this.session,{op:'table-columns',dbId:this.id,table:String(table)}).columns;}
  registerManagedControl(){this.assertOpen();return call(this.session,{op:'managed.register',dbId:this.id}).control;}
  provisionManaged(localId){this.assertOpen();return call(this.session,{op:'managed.provision',dbId:this.id,localId}).result;}
  managedState(localId){this.assertOpen();return call(this.session,{op:'managed.state',dbId:this.id,localId}).state;}
  managedLegacyArchive(localId,archiveId){this.assertOpen();return call(this.session,{op:'managed.legacy-archive',dbId:this.id,localId,archiveId}).binding;}
  managedWorkerConfiguration(localId){this.assertOpen();return call(this.session,{op:'managed.worker-config',dbId:this.id,localId});}
  purgeManaged(localId){this.assertOpen();return call(this.session,{op:'managed.purge',dbId:this.id,localId}).result;}
  drainManaged(localId){this.assertOpen();return call(this.session,{op:'managed.drain',dbId:this.id,localId}).consumers;}
  close(){if(this.closed)return;this.closed=true;if(!this.session.failed&&!this.session.closed)call(this.session,{op:'close',dbId:this.id});}
}

// Object handles retain the exact bridge identity just like database handles.
export function openObject(path,options={}){
  return objectHandle(session(),{op:'object.open',path:String(path),...options});
}
function objectHandle(owner,opening){
  const {fileId}=call(owner,opening);let closed=false;
  const request=(op,fields={})=>{if(closed)throw error('ORBITA_PG_FILE_CLOSED');return call(owner,{op:'file.'+op,fileId,...fields});};
  return {
    read:(length,position=null)=>decodeValue(request('read',{length,position}).bytes),
    write:bytes=>request('write',{bytes:encodeValue(bytes)}).written,
    flush:()=>request('flush'),
    checkpoint:()=>decodeValue(request('checkpoint').result),
    stat:()=>decodeValue(request('stat').stat),
    close(){if(closed)return;try{return decodeValue(request('close').result);}finally{closed=true;}},
    abort(){if(closed)return;try{return request('abort');}finally{closed=true;}},
  };
}
export function objectOperation(op,path,fields={}){return decodeValue(call(session(),{op:'object.'+op,path:String(path),...fields}));}
export function writeSmallObject(path,bytes,{exclusive=false}={}){return call(session(),{op:'object.write-small',path:String(path),bytes:encodeValue(bytes),exclusive}).written;}
export function exportCommonStore(path){
  const owner=session(),opened=decodeValue(call(owner,{op:'transfer.open',path:String(path)}));let closed=false;
  return {info:opened.info,
    read(length=1024*1024){if(closed)throw error('ORBITA_PG_TRANSFER_CLOSED');return decodeValue(call(owner,{op:'transfer.read',transferId:opened.transferId,length}).bytes);},
    close(){if(closed)return;try{call(owner,{op:'transfer.close',transferId:opened.transferId});}finally{closed=true;}},
  };
}
export function importCommonStore(source,offset,length,path,{expectedObjectId,expectedRevision}={}){return decodeValue(call(session(),{op:'transfer.import',source:String(source),offset,length,path:String(path),expectedObjectId,expectedRevision}).result);}
export function restoreControl(action,path,fields={}){return decodeValue(call(session(),{op:'restore.'+action,path:String(path),...fields}).state);}
export function acquireStoreLease(path,{mode='shared',ownLease}={}){
  const owner=session();
  if(ownLease){ownLease.assertAlive();if(ownLease.owner!==owner)throw error('ORBITA_PG_LEASE_OWNER_MISMATCH');}
  const {leaseId,token}=call(owner,{op:'lease.acquire',path:String(path),mode,ownLeaseId:ownLease?.id});let closed=false;
  return {id:leaseId,token,owner,
    assertAlive(){if(closed||owner.failed||owner.closed)throw error('ORBITA_PG_LEASE_LOST');},
    release(){if(closed)return;try{this.assertAlive();call(owner,{op:'lease.release',leaseId});}finally{closed=true;}},
  };
}
export function commonStoreIdentity(){return call(session(),{op:'identity'});}
export function commonStoreHealth(root){return call(session(),{op:'health',...(root?{path:String(root)}:{})}).health;}
// Delegation retains the original bound root and rechecks current authority.
// Credentials are private process input, never a receipt or diagnostic.
export function commonWorkerConfiguration(path){return call(session(),{op:'worker-configuration',path:String(path)}).configuration;}
export function observeCommonWorker(ownerId){return call(session(),{op:'worker-observe',ownerId}).consumers;}
export function closeCommonStore(){
  if(!current)return {closed:true,alreadyClosed:true};
  const owner=current;const result=call(owner,{op:'shutdown'});
  if(result.ownedExit!==0||result.drained!==true)throw error('ORBITA_PG_BRIDGE_CLOSE_UNVERIFIED');
  owner.closed=true;current=null;return result;
}

// Explicit operations on registered PostgreSQL roots. Native input/export I/O
// keeps its own imports; a missing binding never creates a local output file.
import {openObject,objectOperation,writeSmallObject} from './common-store.js';
import {Readable,Writable} from 'node:stream';
import pathModule from 'node:path';
import {randomBytes} from 'node:crypto';

const BLOCK=1024*1024;
const encoding=options=>typeof options==='string'?options:options?.encoding;
const fail=code=>Object.assign(new Error(code),{code});
const handles=new WeakMap();
function fdValue(fd){const value=handles.get(fd);if(!value)throw fail('EBADF');return value;}
const flags={r:'r',w:'w',wx:'x',x:'x',a:'a'};
export function existsSync(path){return objectOperation('exists',path,{readOnly:true}).exists;}
export function mkdirSync(path,options={}){objectOperation('mkdir',path,{recursive:Boolean(options.recursive),existOk:Boolean(options.recursive)});}
export function mkdtempSync(prefix,options={}){
  if(encoding(options)&&encoding(options)!=='utf8')throw fail('ORBITA_PG_DIRECTORY_ENCODING');
  const path=String(prefix)+randomBytes(12).toString('hex');mkdirSync(path);return path;
}
export function readFileSync(path,options={}){
  const supplied=Boolean(path?.commonStoreHandle);
  if(!supplied){
    // Complete small objects and their metadata share one PostgreSQL snapshot.
    // No name/hash cache survives the call. Large reads retain their pinned FD.
    const small=objectOperation('read-small',path,{readOnly:true});
    if(small.complete)return encoding(options)?small.bytes.toString(encoding(options)):small.bytes;
  }
  const handle=supplied?fdValue(path).handle:openObject(path,{mode:'r',readOnly:true}),blocks=[];let total=0;
  try{
    for(;;){
      const bytes=supplied?Buffer.allocUnsafe(BLOCK):handle.read(BLOCK);
      const n=supplied?readSync(path,bytes):bytes.length;
      if(!n)break;blocks.push(bytes.subarray(0,n));total+=n;
    }
  }finally{if(!supplied)handle.close();}
  const value=Buffer.concat(blocks,total),textEncoding=encoding(options);
  return textEncoding?value.toString(textEncoding):value;
}
export function writeFileSync(path,data,options={}){
  if(path?.commonStoreHandle){writeSync(path,typeof data==='string'?Buffer.from(data,encoding(options)??'utf8'):data);return;}
  const flag=typeof options==='object'?options.flag??'w':'w';
  const mode={w:'w',wx:'x',x:'x',a:'a'}[flag];
  if(!mode)throw Object.assign(new Error('ORBITA_PG_FILE_FLAG_UNSUPPORTED'),{code:'ORBITA_PG_FILE_FLAG_UNSUPPORTED'});
  const bytes=typeof data==='string'?Buffer.from(data,encoding(options)??'utf8'):Buffer.from(data.buffer??data,data.byteOffset??0,data.byteLength);
  if(bytes.length<=BLOCK && mode!=='a'){writeSmallObject(path,bytes,{exclusive:mode==='x'});return;}
  const handle=openObject(path,{mode});
  try{
    for(let start=0;start<bytes.length;start+=BLOCK)handle.write(bytes.subarray(start,start+BLOCK));
    handle.close();
  }catch(error){try{handle.abort();}catch{}throw error;}
}
export function appendFileSync(path,data,options={}){writeFileSync(path,data,{...(typeof options==='string'?{encoding:options}:options),flag:'a'});}
export function renameSync(source,target){objectOperation('rename',source,{target:String(target),replace:true});}
export function unlinkSync(path){objectOperation('unlink',path);}
export function rmdirSync(path){objectOperation('rmdir',path);}
export function rmSync(path,{recursive=false,force=false,maxRetries=0,retryDelay=100}={}){
  if(maxRetries!==0)throw fail('ORBITA_PG_MUTATION_RETRY_FORBIDDEN');
  return objectOperation('purge',path,{recursive,missingOk:force}).result;
}
export function cloneTreeSync(source,target){return objectOperation('clone',source,{target:String(target)}).result;}
export function copyFileSync(source,target,mode=0){
  if(![0,constants.COPYFILE_EXCL].includes(mode))throw fail('ORBITA_PG_COPY_FLAG_UNSUPPORTED');
  objectOperation('copy',source,{target:String(target),exclusive:Boolean(mode&constants.COPYFILE_EXCL)});
}
export function readdirSync(path,{withFileTypes=false}={}){
  const entries=objectOperation('list',path,{readOnly:true}).entries;
  return withFileTypes?entries.map(e=>({name:e.name,kind:e.kind,isFile:()=>e.kind!=='directory',isStore:()=>e.kind==='store',isDirectory:()=>e.kind==='directory',isSymbolicLink:()=>false})):entries.map(e=>e.name);
}
export function statSync(path){
  const s=objectOperation('stat',path,{readOnly:true}).stat;
  return {size:s.st_size,nlink:s.st_nlink,mtimeMs:s.st_mtime*1000,ctimeMs:s.st_ctime*1000,
    mtime:new Date(s.st_mtime*1000),ctime:new Date(s.st_ctime*1000),
    objectId:s.objectId,revision:s.revision,sha256:s.sha256,kind:s.kind,
    isFile:()=>s.kind!=='directory',isStore:()=>s.kind==='store',isDirectory:()=>s.kind==='directory',isSymbolicLink:()=>false};
}
export const lstatSync=statSync;
export function realpathSync(path){statSync(path);return pathModule.resolve(String(path));}
export function containedPathSync(root,relative){
  if(typeof relative!=='string'||pathModule.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(s=>!s||s==='.'||s==='..')||relative.includes(':'))throw fail('ORBITA_PG_OBJECT_PATH_ESCAPE');
  const base=pathModule.resolve(String(root)),target=pathModule.resolve(base,relative);
  if(!target.startsWith(base+pathModule.sep))throw fail('ORBITA_PG_OBJECT_PATH_ESCAPE');
  objectOperation('contained-path',target,{base,readOnly:true});return target;
}
export function openSync(path,flag='r'){
  const mode=flags[flag];if(!mode)throw fail('ORBITA_PG_FILE_FLAG_UNSUPPORTED');
  const fd=Object.freeze({commonStoreHandle:true});
  handles.set(fd,{handle:openObject(path,{mode,readOnly:mode==='r'}),mode});return fd;
}
export function closeSync(fd){const value=fdValue(fd);try{value.handle.close();}finally{handles.delete(fd);}}
export function abortSync(fd){const value=fdValue(fd);try{value.handle.abort();}finally{handles.delete(fd);}}
export function fsyncSync(fd){const value=fdValue(fd);if(value.mode==='r')throw fail('EBADF');return value.handle.checkpoint();}
export function fstatSync(fd){
  const value=fdValue(fd),s=value.handle.stat();
  if(value.mode==='r'&&value.ahead)s.position-=value.ahead.length;
  return {...s,size:s.size,nlink:1,isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};
}
export function readSync(fd,buffer,offset=0,length=buffer.byteLength-offset,position=null){
  const value=fdValue(fd);if(value.mode!=='r')throw fail('EBADF');
  if(!ArrayBuffer.isView(buffer)||!Number.isInteger(offset)||!Number.isInteger(length)||offset<0||length<0||offset+length>buffer.byteLength||position!==null&&(!Number.isSafeInteger(position)||position<0))throw fail('EINVAL');
  const target=Buffer.from(buffer.buffer,buffer.byteOffset,buffer.byteLength);let count=0;
  while(count<length){
    let bytes;
    if(position===null&&value.readAhead){
      // Consumers still receive exactly the requested chunks. The shared FD
      // buffer also serves direct reads, so mixing stream/FD reads loses none.
      if(!value.ahead?.length)value.ahead=value.handle.read(Math.max(64*1024,Math.min(BLOCK,length-count)));
      const n=Math.min(length-count,value.ahead.length);bytes=value.ahead.subarray(0,n);value.ahead=value.ahead.subarray(n);
    }else bytes=value.handle.read(Math.min(BLOCK,length-count),position===null?null:position+count);
    if(!bytes.length)break;bytes.copy(target,offset+count);count+=bytes.length;
  }
  return count;
}
export function writeSync(fd,data,offset=0,length,position=null){
  const value=fdValue(fd);if(value.mode==='r')throw fail('EBADF');
  let bytes;
  if(typeof data==='string'){
    position=arguments.length>2?offset:null;bytes=Buffer.from(data,typeof length==='string'?length:'utf8');
  }else{
    if(!ArrayBuffer.isView(data))throw fail('EINVAL');
    length??=data.byteLength-offset;
    if(!Number.isInteger(offset)||!Number.isInteger(length)||offset<0||length<0||offset+length>data.byteLength)throw fail('EINVAL');
    bytes=Buffer.from(data.buffer,data.byteOffset+offset,length);
  }
  if(position!==null&&value.mode!=='a'&&position!==value.handle.stat().position)throw fail('ORBITA_PG_RANDOM_WRITE_UNSUPPORTED');
  let count=0;
  for(let i=0;i<bytes.length;i+=BLOCK)count+=value.handle.write(bytes.subarray(i,i+BLOCK));
  return count;
}

export function createReadStream(path,options={}){
  if(typeof options==='string')options={encoding:options};
  const start=options.start??0,end=options.end??Infinity;
  if(!Number.isSafeInteger(start)||start<0||!(end===Infinity||Number.isSafeInteger(end)&&end>=start))throw fail('EINVAL');
  let fd,position=start,closed=false;
  const stream=new Readable({...options,highWaterMark:Math.min(options.highWaterMark??64*1024,BLOCK),
    construct(callback){try{fd=options.fd??openSync(path,'r');if(options.fd===undefined&&options.start===undefined)fdValue(fd).readAhead=true;queueMicrotask(()=>{this.emit('open',fd);this.emit('ready');callback();});}catch(e){callback(e);}},
    read(size){
      try{
        const length=Math.min(size,BLOCK,end-position+1);
        if(length<=0){this.push(null);return;}
        const bytes=Buffer.allocUnsafe(length);
        // An explicit start is positional. With a supplied fd and no start,
        // continue that handle's sequential offset, matching the Node contract.
        const n=readSync(fd,bytes,0,length,options.start===undefined?null:position);
        position+=n;this.bytesRead+=n;if(n)this.push(bytes.subarray(0,n));else this.push(null);
      }catch(e){this.destroy(e);}
    },
    destroy(error,callback){
      if(fd&&!closed&&options.autoClose!==false){closed=true;try{closeSync(fd);}catch(e){error??=e;}}
      callback(error);
    }});
  stream.bytesRead=0;return stream;
}

export function createWriteStream(path,options={}){
  if(typeof options==='string')options={encoding:options};
  if(options.start!==undefined&&options.start!==0)throw fail('ORBITA_PG_RANDOM_WRITE_UNSUPPORTED');
  let fd,closed=false;
  const stream=new Writable({...options,highWaterMark:Math.min(options.highWaterMark??64*1024,BLOCK),
    construct(callback){try{fd=options.fd??openSync(path,options.flags??'w');queueMicrotask(()=>{this.emit('open',fd);this.emit('ready');callback();});}catch(e){callback(e);}},
    write(chunk,enc,callback){try{this.bytesWritten+=writeSync(fd,typeof chunk==='string'?Buffer.from(chunk,enc):chunk);callback();}catch(e){callback(e);}},
    final(callback){try{if(options.autoClose===false)fsyncSync(fd);else{closeSync(fd);closed=true;}callback();}catch(e){callback(e);}},
    destroy(error,callback){
      if(fd&&!closed&&options.autoClose!==false){closed=true;try{if(error)abortSync(fd);else closeSync(fd);}catch(e){error??=e;}}
      callback(error);
    }});
  stream.bytesWritten=0;return stream;
}
export const constants=Object.freeze({COPYFILE_EXCL:1});
export default {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,appendFileSync,renameSync,unlinkSync,readdirSync,statSync,lstatSync,realpathSync,containedPathSync,
  rmdirSync,rmSync,cloneTreeSync,copyFileSync,openSync,closeSync,abortSync,fsyncSync,fstatSync,readSync,writeSync,createReadStream,createWriteStream,constants};

// Output objects belong to the registered common store. Native source/model
// paths retain explicit node:fs/util.js imports at their acquisition boundary.
import crypto from 'node:crypto';
import path from 'node:path';
import fs from './common-files.js';
import {objectOperation} from './common-store.js';

export function ensureDir(dir){fs.mkdirSync(dir,{recursive:true});return dir;}
export function atomicWrite(file,value){ensureDir(path.dirname(file));fs.writeFileSync(file,value);}
export function readJson(file,fallback=null){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return fallback;throw error;}
}
export async function hashFile(file,byteLimit=null){
  const hash=crypto.createHash('sha256');if(byteLimit===0)return hash.digest('hex');
  if(byteLimit!==null&&(!Number.isSafeInteger(byteLimit)||byteLimit<0))throw Object.assign(new Error('EINVAL'),{code:'EINVAL'});
  // The same bounded, hash-checked MVCC read as readFileSync. It hashes actual
  // bytes each time; no object digest or previous integrity result is reused.
  const small=objectOperation('read-small',file,{readOnly:true});
  if(small.complete){
    if(byteLimit!==null&&small.bytes.length<byteLimit)throw new Error('ORBITA_PG_OBJECT_SHORT_READ');
    return hash.update(byteLimit===null?small.bytes:small.bytes.subarray(0,byteLimit)).digest('hex');
  }
  let size=0;
  for await(const bytes of fs.createReadStream(file,byteLimit==null?{}:{start:0,end:byteLimit-1})){hash.update(bytes);size+=bytes.length;}
  if(byteLimit!=null&&size!==byteLimit)throw new Error('ORBITA_PG_OBJECT_SHORT_READ');
  return hash.digest('hex');
}
export function walkFiles(root,predicate=()=>true,limit=200000){
  const result=[],pending=[root];
  while(pending.length){
    const current=pending.pop();
    for(const entry of fs.readdirSync(current,{withFileTypes:true})){
      const file=path.join(current,entry.name);
      if(entry.isDirectory())pending.push(file);else if(predicate(file))result.push(file);
      if(result.length>limit)throw new Error('ORBITA_PG_TREE_FILE_BUDGET');
    }
  }
  return result.sort();
}

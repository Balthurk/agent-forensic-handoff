// Rows and byte objects use one PostgreSQL connection and one transaction.
// This adapter is explicit: it never changes native fs or general object I/O.
import path from 'node:path';

const BLOCK=1024*1024;
export function transactionIO(database){
  const db=database.db??database;
  function ensureDir(dir){db.transactionMkdir(dir);return dir;}
  function readFile(file,encoding){
    const handle=db.transactionOpen(file),parts=[];let size=0;
    try{
      for(;;){const bytes=handle.read(BLOCK);if(!bytes.length)break;parts.push(bytes);size+=bytes.length;}
    }finally{handle.close();}
    const value=Buffer.concat(parts,size);return encoding?value.toString(encoding):value;
  }
  function readRange(file,offset,length){
    if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||length>64*1024*1024)throw new Error('ORBITA_PG_EVIDENCE_RANGE');
    const handle=db.transactionOpen(file),parts=[];let size=0;
    try{
      while(size<length){const bytes=handle.read(Math.min(BLOCK,length-size),offset+size);if(!bytes.length)break;parts.push(bytes);size+=bytes.length;}
    }finally{handle.close();}
    return Buffer.concat(parts,size);
  }
  function atomicWrite(file,value,{exclusive=false}={}){
    ensureDir(path.dirname(file));
    const bytes=typeof value==='string'?Buffer.from(value,'utf8'):Buffer.from(value);
    const handle=db.transactionOpen(file,{mode:exclusive?'x':'w'});
    try{
      for(let offset=0;offset<bytes.length;offset+=BLOCK)handle.write(bytes.subarray(offset,offset+BLOCK));
      handle.close();
    }catch(error){try{handle.abort();}catch{}throw error;}
  }
  function readJson(file,fallback=null){
    try{return JSON.parse(readFile(file,'utf8'));}
    catch(error){if(error.code==='ENOENT')return fallback;throw error;}
  }
  return Object.freeze({ensureDir,readFile,readRange,readJson,atomicWrite});
}

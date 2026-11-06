import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const now=()=>new Date().toISOString();
export function writeDurable(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
export function writeJSON(file,value){writeDurable(file,JSON.stringify(value,null,2));}
export function openDB(file){fs.mkdirSync(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');return db;}
export function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
export function checkpoint(name){if(process.env.AFH_CRASH_AT===name)process.exit(86);}

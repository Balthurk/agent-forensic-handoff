import {createHash} from 'node:crypto';
import {DatabaseSync} from '../agent-forensic-handoff/src/common-store.js';
import path from 'node:path';
import files from '../agent-forensic-handoff/src/common-files.js';

export const sha=value=>createHash('sha256').update(value).digest('hex');
export const now=()=>new Date().toISOString();
export function openDB(locator,family){return new DatabaseSync(locator,{family,create:true});}
export function writeDurable(locator,bytes){files.mkdirSync(path.dirname(locator),{recursive:true});files.writeFileSync(locator,bytes);}
export function writeJSON(locator,value){writeDurable(locator,JSON.stringify(value,null,2));}
export function checkpoint(name){if(process.env.AFH_CRASH_AT===name)process.exit(86);}
export function transaction(db,fn){
  db.exec('BEGIN IMMEDIATE');
  try{const result=fn();db.exec('COMMIT');return result;}
  catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}

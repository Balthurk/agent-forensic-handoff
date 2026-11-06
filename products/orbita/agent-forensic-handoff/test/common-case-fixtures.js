import native from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import stored from '../src/common-files.js';
import {closeCommonStore} from '../src/common-store.js';

const root=process.env.ORBITA_POSTGRES_TEST_ROOT;
const receipts=process.env.ORBITA_POSTGRES_TEST_RECEIPTS;
assert.ok(root&&receipts,'EXPLICIT_CASE_TEST_ROOTS_REQUIRED');
test.after(()=>{const closed=closeCommonStore();assert.ok(closed.alreadyClosed||(closed.drained&&closed.ownedExit===0));assert.equal(native.existsSync(root),false);});
export function nativeTemporary(t,prefix){
 assert.match(prefix,/^[a-z0-9-]+$/i);
 // Retain synthetic native inputs for the gate's enumerated cleanup.
 return native.mkdtempSync(path.join(receipts,prefix));
}
export function caseRoot(input,name='case'){
 return path.join(root,path.basename(input),name);
}
export function walkStoredFiles(root){
 const result=[],pending=[root];
 while(pending.length){
  const parent=pending.pop();
  if(!stored.existsSync(parent))continue;
  for(const entry of stored.readdirSync(parent,{withFileTypes:true})){
   const target=path.join(parent,entry.name);
   if(entry.isDirectory())pending.push(target);else if(entry.isFile())result.push(target);
  }
 }
 return result.sort();
}

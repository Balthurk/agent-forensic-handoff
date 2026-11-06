// Qualification-only roots; never imported by a product entrypoint.
import {after} from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import fs from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
import {closeMemory} from './memory-provider.mjs';

const roots=new Set();
// Register at module scope. Calling commonFixture inside the first test must
// not attach the only teardown to that test and omit all later consumers.
after(async()=>{
 try{await closeMemory();}
 finally{
  const closed=closeCommonStore();assert.ok(closed.alreadyClosed||(closed.drained&&closed.ownedExit===0));
  for(const root of roots)assert.equal(native.existsSync(root),false);
 }
});
export function commonFixture(prefix){
 const root=process.env.ORBITA_POSTGRES_TEST_ROOT;
 assert.ok(root&&/^[a-z0-9-]+$/i.test(prefix),'EXPLICIT_COMMON_TEST_ROOT_REQUIRED');
 roots.add(root);fs.mkdirSync(root,{recursive:true});
 return fs.mkdtempSync(path.join(root,prefix));
}

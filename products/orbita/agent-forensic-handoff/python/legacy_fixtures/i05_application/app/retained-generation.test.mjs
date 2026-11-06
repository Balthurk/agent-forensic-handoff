import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {retainedGeneration,generationStatus} from './retained-generation.mjs';
const root=fs.mkdtempSync('C:/T/afh-retained-test-');let calls=0,commits=0,fail=true;
const base={root,id:'stable',request:{target:'one'},prepare:async()=>({input:'literal',cut:'a'}),verify:async()=>{},infer:async()=>{calls++;return {value:'proposal'};},admit:async()=>{commits++;if(fail)throw new Error('mechanical');return {records:[{id:'r',version:1}],errors:[]};}};
test('retained output is replayed without inference; binding and corruption fail closed',async()=>{
 await assert.rejects(retainedGeneration(base),/mechanical/);fail=false;const r=await retainedGeneration(base);assert.equal(calls,1);assert.equal(commits,2);assert.equal(r.records[0].version,1);assert.equal(generationStatus(root).jobs[0].status,'complete');
 await assert.rejects(retainedGeneration({...base,request:{target:'other'}}),/IDEMPOTENCY/);await assert.rejects(retainedGeneration({...base,verify:async()=>{throw new Error('SOURCE_CUT_CHANGED');}}),/SOURCE_CUT_CHANGED/);assert.equal(calls,1);
 const file=path.join(root,'stable','model-output.json'),e=JSON.parse(fs.readFileSync(file));e.value.value='changed';fs.writeFileSync(file,JSON.stringify(e));await assert.rejects(retainedGeneration(base),/CORRUPT/);
});
test('uncertain provider response never automatically invokes model twice',async()=>{const unknown={...base,id:'unknown',infer:async()=>{calls++;throw new Error('provider disconnected');}};await assert.rejects(retainedGeneration(unknown),/disconnected/);const before=calls;await assert.rejects(retainedGeneration(unknown),/UNKNOWN_NO_AUTORETRY/);assert.equal(calls,before);});

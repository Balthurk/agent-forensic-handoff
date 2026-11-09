import test from 'node:test';
import assert from 'node:assert/strict';
import {commonFixture} from './common-test-scope.mjs';
process.env.AFH_COSMOS_DATA=commonFixture('orbita-copilot-');
const {addSource,getLibrary,getEvidence}=await import('./corpus.mjs');
const {retrievePackage}=await import('./memory.mjs');

test('Copilot import preserves exact messages without dependencies on another interaction with the same turn counter',async()=>{
 const sessionId='c0f1a07e-5e55-4000-8000-000000000002';
 const values=[
  ['session.start',{sessionId,version:1}],
  ['user.message',{content:'',turnId:'0',interactionId:'previous-interaction'}],
  ['user.message',{content:'give me the literal path local',turnId:'0',interactionId:'current-interaction'}],
  ['assistant.message',{content:'The synthetic path is C:\\fixture\\page.html',messageId:'reply',turnId:'0',interactionId:'current-interaction'}],
 ];
 const records=values.map(([type,data],i)=>({id:`event-${i}`,parentId:i?`event-${i-1}`:null,timestamp:'2026-11-09T10:00:00Z',type,data}));
 const item=await addSource({filename:'copilot-interactions.jsonl',content:records.map(JSON.stringify).join('\n')+'\n'});
 const library=await getLibrary(),registered=library.find(x=>x.id===item.id);
 assert.equal(registered.verified,true);assert.ok(registered.messages>=2);
 const pkg=await retrievePackage('give me the literal path local',[item.id],{mode:'lexical',profile:'exact',maxBytes:20000});
 assert.equal(pkg.abstention,false);
 const request=pkg.evidence.find(e=>e.text==='give me the literal path local');
 assert.ok(request);assert.equal(request.role,'user');
 assert.equal(pkg.omissions.some(o=>o.reason==='missing_dependency'),false);
 const evidence=await getEvidence(item.id,request.id);
 assert.equal(evidence.verified,true);
 assert.equal(JSON.parse(evidence.raw).data.interactionId,'current-interaction');
 assert.equal(evidence.revision,request.revision);
});

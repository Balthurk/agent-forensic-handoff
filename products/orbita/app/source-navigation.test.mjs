import test from 'node:test';
import assert from 'node:assert/strict';
import {commonFixture} from './common-test-scope.mjs';
process.env.AFH_COSMOS_DATA=commonFixture('i06-original-');
const {importDocument}=await import('./documents.mjs');
const {getEvidence,loadCase,library}=await import('./corpus.mjs');
const {retrievePackage}=await import('./memory.mjs');

test('A13 omitted long source opens in full and navigates every original block at the same revision',async()=>{
 const text=('Condición íntegra 🪐: sólo con autorización.\r\n').repeat(1800);
 const item=await importDocument({filename:'long.txt',content:text});
 const packet=await retrievePackage('Condición íntegra',[item.id],{mode:'lexical',semanticKnowledge:false,maxBytes:4096});
 assert.equal(packet.evidence.length,0);assert.ok(packet.omissionSummary.budget>0);
 assert.ok(packet.bytes<=4096);assert.equal(packet.bytes,Buffer.byteLength(JSON.stringify(packet)));
 const source=packet.sources.find(s=>s.conversationId===item.id);
 const seed=packet.omissions[0].seed;assert.ok(seed.startsWith(item.id+':'));
 const first=await getEvidence(item.id,seed.slice(item.id.length+1),{revision:source.caseHash});
 assert.ok(Buffer.byteLength(first.text)>4096);assert.ok(first.navigation,'A13_ORIGINAL_NAVIGATION_MISSING');
 let value=await getEvidence(item.id,null,{revision:source.caseHash,position:1}),chunks=[],seen=new Set();
 for(;;){assert.equal(value.revision,source.caseHash);assert.ok(!seen.has(value.id));seen.add(value.id);chunks.push(value.text);
  assert.equal(value.navigation.position,chunks.length);
  if(!value.navigation.next)break;
  value=await getEvidence(item.id,value.navigation.next.id,{revision:source.caseHash});
 }
 assert.equal(chunks.join(''),text);assert.equal(chunks.length,first.navigation.total);
 assert.equal(value.navigation.next,null);assert.ok(value.navigation.previous);
});

test('A13 original navigation refuses a stale revision and invalid positions',async()=>{
 const item=await importDocument({filename:'short.txt',content:'Original completo, sin truncar.'});
 const c=await loadCase(library.find(x=>x.id===item.id)),id=c.messages[0].id;
 await assert.rejects(getEvidence(item.id,id,{revision:'0'.repeat(64)}),/SOURCE_REVISION_CHANGED/);
 for(const position of [0,-1,1.5,'1',2])await assert.rejects(getEvidence(item.id,null,{revision:c.manifest.caseHash,position}),/SOURCE_POSITION/);
 await assert.rejects(getEvidence(item.id,id,{revision:c.manifest.caseHash,position:1}),/SOURCE_POSITION/);
 assert.equal((await getEvidence(item.id,id,{revision:c.manifest.caseHash})).text,'Original completo, sin truncar.');
});

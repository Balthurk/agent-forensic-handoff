import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {conversation,original,draft} from './reevaluation-fixture.mjs';
import {unicodeText,lateText,lateQuote,codepointLastIndex,locatedDraft} from './quote-locators-fixture.mjs';

const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||os.tmpdir(),'orbita-a10-'));
process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {addSource,library}=await import('./corpus.mjs');
const {extractKnowledge,extractionSchema,verifiedSources,knowledgeOperation:op}=await import('./knowledge.mjs');
const {reevaluationSchema,registerWatch,reevaluationStatus,runReevaluation}=await import('./reevaluation.mjs');
const startSchema={type:['integer','null'],minimum:0};
const assertStart=node=>{assert.ok(node.required.includes('start'));assert.deepEqual(node.properties.start,startSchema);assert.equal(node.additionalProperties,false);};

test('A10 strict schemas expose start in clauses and every generated witness',()=>{
 const clause=extractionSchema.properties.acts.items.properties.clauses.items;
 assertStart(clause);
 for(const key of ['arguments','conditions','temporal','relations'])assertStart(clause.properties[key].items.properties.evidence.items);
 const revision=reevaluationSchema.properties.clauses.items;
 assertStart(revision.properties.evidence.items);
 assertStart(revision.properties.arguments.items.properties.evidence.items);
});

test('A10 extraction admits the second Unicode occurrence, retains output and rejects a changed original',async()=>{
 const item=await addSource(conversation('a10-unicode',unicodeText)),ids=[item.id];
 const source=(await verifiedSources(ids)).sources[0];let calls=0,seen;
 const inferDraft=async(prompt,schema)=>{calls++;seen={prompt,schema};return {value:locatedDraft(source.id),modelObserved:'synthetic-only',receipt:'no-provider-call'};};
 const request={conversationIds:ids,targets:[{conversationId:item.id,eventId:source.eventId}],requestId:'a10-explicit-second'};
 const first=await extractKnowledge(request,()=>{},{inferDraft});
 assert.equal(first.records.length,1);assert.deepEqual(first.errors,[]);
 const record=first.records[0],clause=record.payload.semantic_unit.clauses[0];
 assert.equal(record.payload.status,'proposed');
 assert.equal(clause.target_ref.revision,source.revision);
 assert.deepEqual(clause.target_ref.locator,{coordinate_system:'unicode_codepoints',source_encoding:'AFH-representation-text-v1',decoder_version:'afh-evidence-text-v1',start:9,end:12});
 assert.equal(Array.from(source.text).slice(9,12).join(''),clause.target_ref.quote);
 assert.equal(source.text.lastIndexOf('aaa'),10); // Distinct UTF-16 offset.
 assert.ok(Object.values(clause.evidence_by_field).flat().every(e=>e.judgment==='pending'));
 const again=await extractKnowledge(request,()=>{},{inferDraft});assert.equal(calls,1);assert.equal(again.records[0].version,1);
 assert.equal((await op('history',ids,{id:record.id})).length,1);
 const originalFile=path.join(library.find(x=>x.id===item.id).path,'acquisition/original.bin'),originalBytes=fs.readFileSync(originalFile);
 fs.appendFileSync(originalFile,'corruption');
 try{await assert.rejects(extractKnowledge(request,()=>{},{inferDraft}),/Integridad/);assert.equal(calls,1);}
 finally{fs.writeFileSync(originalFile,originalBytes);} // Keep this synthetic corruption out of later watch scans.
 assertStart(seen.schema.properties.acts.items.properties.clauses.items);
 assert.match(seen.prompt,/Unicode codepoints/);assert.match(seen.prompt,/UTF-16/);
});

test('A10 implicit overlapping quote fails admission; explicit offset and invalid UTF-16 range remain distinct',async()=>{
 const item=await addSource(conversation('a10-overlap','aaaa')),ids=[item.id],source=(await verifiedSources(ids)).sources[0];
 const request={conversationIds:ids,targets:[{conversationId:item.id,eventId:source.eventId}]};
 const inferDraft=async()=>({value:locatedDraft(source.id,{start:null}),modelObserved:'synthetic-only'});
 const result=await extractKnowledge({...request,requestId:'a10-overlap-implicit'},()=>{},{inferDraft});
 assert.equal(result.records.length,0);assert.equal(result.errors.length,1);assert.match(JSON.stringify(result.errors),/QUOTE_AMBIGUOUS_OR_MISSING/);
 const wrong=await extractKnowledge({...request,requestId:'a10-wrong-range'},()=>{},{inferDraft:async()=>({value:locatedDraft(source.id,{start:3})})});
 assert.equal(wrong.records.length,0);assert.match(JSON.stringify(wrong.errors),/QUOTE_MISMATCH/);
 await assert.rejects(extractKnowledge({...request,requestId:'a10-outside-selection'},()=>{},{inferDraft:async()=>({value:locatedDraft('outside',{start:0})})}),/EXTRACTION_TARGET_OUTSIDE_SELECTION/);
});

test('A10 reevaluation preserves a repeated context witness and replay uses no extra inference',async()=>{
 const old=await addSource(conversation('a10-old',original)),ids=[old.id];
 const ctx=await verifiedSources(ids),source=ctx.sources[0];
 const first=(await op('extract',ids,{draft:draft(source,'a10-antecedent'),producer:'synthetic',sourceCut:ctx.cut,requestId:'a10-old'})).records[0];
 await registerWatch({id:first.id,expectedVersion:1,conversationIds:ids,terms:['significa']});
 const late=await addSource(conversation('a10-late',lateText));ids.push(late.id);
 assert.deepEqual(late.reevaluation.errors,[]);
 const job=reevaluationStatus().jobs.find(j=>j.status==='pending');assert.ok(job);
 let calls=0,seen;const position=codepointLastIndex(lateText,lateQuote);
 const inferReview=async(prompt,schema)=>{
  calls++;seen={prompt,schema};const packet=JSON.parse(prompt.split('\nPACKET\n')[1]);
  const clause=packet.target.payload.semantic_unit.clauses[0],context=packet.originals.find(s=>packet.newSourceIds.includes(s.id));
  const evidence=[{sourceId:context.id,quote:lateQuote,start:position}];
  return {value:{disposition:'changed',reason:'Antecedente sintético',summary:'Ana llegó a la reunión.',clauses:[{clauseId:clause.semantic_clause_id,predicate:clause.predicate.value,resolution:'resolved',arguments:[{index:0,interpreted:'Ana',evidence}],evidence}]},modelObserved:'synthetic-only'};
 };
 const result=await runReevaluation({id:job.id},{inferReview});
 assert.equal(result.record.version,2);assert.equal(result.record.payload.status,'proposed');
 const clause=result.record.payload.semantic_unit.clauses[0];assert.equal(clause.arguments[0].interpreted,'Ana');
 const context=clause.evidence_by_field['/arguments/0/interpreted'];assert.ok(context.length);
 assert.ok(context.every(e=>e.quote===lateQuote&&e.locator.start===position&&e.locator.end===position+Array.from(lateQuote).length&&e.judgment==='pending'));
 assert.ok(clause.dependencies.some(d=>d.source_ref.locator.start===position));
 assert.deepEqual(clause.target_ref,first.payload.semantic_unit.clauses[0].target_ref);
 await runReevaluation({id:job.id},{inferReview});assert.equal(calls,1);
 assert.equal((await op('history',ids,{id:first.id})).length,2);
 assertStart(seen.schema.properties.clauses.items.properties.evidence.items);
 assert.match(seen.prompt,/Unicode codepoints/);assert.match(seen.prompt,/UTF-16/);
});

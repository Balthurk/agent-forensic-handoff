import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {draftForInput} from './corpus-plan-fixture.mjs';
const root=fs.mkdtempSync('C:/T/orbita-corpus-plan-test-');process.env.AFH_COSMOS_DATA=root;
const {importDocument}=await import('./documents.mjs');const {createCorpusPlan,corpusPlanStatus,runCorpusPlan}=await import('./corpus-plan.mjs');const {knowledgeOperation}=await import('./knowledge.mjs');const {coverage,closeMemory}=await import('./memory.mjs');
let first,firstItem,calls=0;
const inferDraft=async prompt=>{calls++;return {value:draftForInput(prompt),model:'gpt-6.1-sol',modelObserved:'controlled-fixture',elapsedMs:1,usage:null,receipt:'fixture-not-provider'};};
test('whole admitted corpus beyond legacy 20-case selection has exact counts and stable paginated membership',async()=>{
 for(let i=0;i<22;i++){const item=await importDocument({documentId:'case'+i,filename:'policy'+i+'.txt',content:`Regla ${i}: requiere revisión explícita antes de aplicar.`});if(i===0)firstItem=item;}
 first=await createCorpusPlan();assert.equal(first.totalTargets,22);assert.equal(first.inventory.selectedCases,22);assert.equal(first.inventory.sourceRecords,44);assert.equal(first.inventory.metadataOrNontextRecords,22);assert.equal(first.processingPercent,0);
 const a=corpusPlanStatus(first.id,{limit:7}),b=corpusPlanStatus(first.id,{limit:7,cursor:a.nextCursor});assert.equal(new Set([...a.page,...b.page].map(x=>x.id)).size,14);
 const selected=await createCorpusPlan({conversationIds:[firstItem.id]});assert.throws(()=>corpusPlanStatus(selected.id,{cursor:a.nextCursor}),/CURSOR_BINDING/);
 assert.equal((await createCorpusPlan()).reusedPlan,true);assert.equal((await coverage()).length,22);
});
test('explicit bounded processing retains provider receipts, source role, gaps and does not infer approval',async()=>{
 await assert.rejects(runCorpusPlan({id:first.id}),/EXPLICIT_ENABLE/);
 const run=await runCorpusPlan({id:first.id,maxTargets:2,enableProposals:true},{inferDraft});assert.equal(calls,2);assert.equal(run.processedTargets,2);assert.equal(run.counts.proposed_with_gaps,2);assert.equal(run.semanticCompleteness,'not_certified');assert.equal(run.approval,'none');assert.equal(run.usage.unknownUsageReceipts,2);
 const processed=run.page.find(p=>p.status==='proposed_with_gaps');const records=await knowledgeOperation('list',[processed.case_id]);assert.equal(records[0].payload.semantic_unit.issuer.role,'document');assert.equal(records[0].payload.status,'proposed');
});
test('new source invalidates all-corpus cut and a new plan reuses old work, queues only its delta',async()=>{
 await importDocument({documentId:'new-source',filename:'new.md',content:'La excepción exige una revisión adicional.'});assert.equal(corpusPlanStatus(first.id).current,false);await assert.rejects(runCorpusPlan({id:first.id,enableProposals:true},{inferDraft}),/STALE/);
 const next=await createCorpusPlan();assert.equal(next.inventory.newTargets,1);assert.equal(next.inventory.reusedTargets,22);assert.equal(next.processedTargets,2);assert.equal(calls,2);
});
test('unavailable source and nontext records remain explicit; they cannot produce a complete coverage claim',async()=>{
 fs.appendFileSync(path.join(root,'cases',firstItem.id,'acquisition/document/original.bin'),'changed');
 await assert.rejects(createCorpusPlan({conversationIds:[firstItem.id]}),/Integridad/);
 const fresh=await createCorpusPlan({conversationIds:[firstItem.id],model:'gpt-6-luna'});assert.equal(fresh.inventory.unavailableCases,1);assert.equal(fresh.processingPercent,null);assert.equal(fresh.mechanicalCoverage,'pending_or_blocked');
});
test.after(async()=>{await closeMemory();});

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {draftForInput} from './corpus-plan-fixture.mjs';
process.env.AFH_COSMOS_DATA=fs.mkdtempSync('C:/T/orbita-corpus-identity-');
const {addSource}=await import('./corpus.mjs'),{createCorpusPlan,runCorpusPlan}=await import('./corpus-plan.mjs'),{closeMemory}=await import('./memory.mjs');
const footer='\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[Prior context]\n</citation_entries>\n<rollout_ids>\n01a1543b-2410-7202-908a-c0f6ff70e59f\n</rollout_ids>\n</oai-mem-citation>';
async function add(name,text,session){const rows=[{timestamp:'2026-10-22T10:00:00Z',type:'session_meta',payload:{id:session,cwd:'C:/fixture'}},{timestamp:'2026-10-22T10:00:00Z',type:'response_item',payload:{type:'message',id:'native-1',role:'assistant',phase:'final',content:[{type:'output_text',text}]}}];return addSource({filename:name+'.jsonl',content:rows.map(JSON.stringify).join('\n')+'\n'});}
test('whole-corpus plan respects the inherited exact native footer equivalence without changing source bytes',async()=>{
 const a=await add('plain','El permiso sigue revocado.','01a154a3-e7d9-7990-9ebb-ac32839ca891'),b=await add('footer','El permiso sigue revocado.'+footer,'01a154a3-e7d9-7990-9ebb-ac32839ca891');
 const p=await createCorpusPlan({conversationIds:[a.id,b.id]});assert.equal(p.inventory.equivalentOccurrences,1);assert.equal(p.inventory.conflictingOccurrences,0);assert.equal(p.totalTargets,2);assert.equal(p.counts.blocked||0,0);assert.equal(p.counts.pending,2);
});
test('real conflicting versions block affected targets even when one was already processed in another cut',async()=>{
 const a=await add('old','Se permite publicar el informe.','01a154a3-e7d9-7990-9ebb-ac32839ca892');let calls=0;const inferDraft=async prompt=>{calls++;return {value:draftForInput(prompt),model:'gpt-6.1-sol',usage:null,elapsedMs:1,receipt:'controlled-only'};};
 const single=await createCorpusPlan({conversationIds:[a.id]});await runCorpusPlan({id:single.id,maxTargets:1,enableProposals:true},{inferDraft});assert.equal(calls,1);
 const b=await add('contradiction','No se permite publicar el informe.','01a154a3-e7d9-7990-9ebb-ac32839ca892');const conflict=await createCorpusPlan({conversationIds:[a.id,b.id]});assert.equal(conflict.inventory.conflictingOccurrences,1);assert.equal(conflict.counts.blocked,2);assert.equal(conflict.processedTargets,0);assert.equal(conflict.processingPercent,0);assert.ok(conflict.page.every(t=>t.error==='conflicting_occurrence_or_context'));
 const result=await runCorpusPlan({id:conflict.id,maxTargets:8,enableProposals:true},{inferDraft});assert.equal(result.attempted,0);assert.equal(calls,1);assert.equal((await createCorpusPlan({conversationIds:[a.id]})).processedTargets,1);
});
test.after(async()=>{await closeMemory();});

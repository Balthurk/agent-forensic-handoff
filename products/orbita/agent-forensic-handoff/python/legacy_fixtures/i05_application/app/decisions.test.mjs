import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {userText,resultText,exportConversation,decisionFixture,actionFixture} from './decision-fixture.mjs';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-decisions-'));process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {addSource,library}=await import('./corpus.mjs');const {decisionOperation:op,decisionSources}=await import('./decisions.mjs');const {learningOperation}=await import('./learning.mjs');const {knowledgeOperation,verifiedSources}=await import('./knowledge.mjs');const {retrievePackage,closeMemory}=await import('./memory.mjs');
const here=path.dirname(fileURLToPath(import.meta.url));
test('F26 concurrent CAS, retry, fresh process/full restore, F25 and semantic coexistence, abort and source drift',async t=>{
 t.after(()=>closeMemory());
 const a=await addSource(exportConversation('choice',userText)),b=await addSource(exportConversation('result',resultText,'tool'));const conversationIds=[a.id,b.id];const sources=await decisionSources(conversationIds);
 const caseData=decisionFixture(sources),input={conversationIds,id:'backup',case:caseData,actor:'test editor',statement:'Comparación explícita de dos opciones',requestId:'frame'};
 const first=await op('frame',input);assert.deepEqual(await op('frame',input),first);
 const claim={text:'Restauración verificada en muestra',evidence:[{sourceId:sources.find(s=>s.text===resultText).id,quote:'La prueba local restauró doce archivos con hashes idénticos'}]};
 await learningOperation('record',{conversationIds,requestId:'learning',episode:{id:'restore',title:'Restauración local',condition:claim,action:claim,observation:claim,outcome:{value:'success',evidence:claim.evidence},counterexamples:[]}});
 const context=await verifiedSources(conversationIds),source=context.sources[0];
 const semantic=await knowledgeOperation('extract',conversationIds,{draft:{acts:[{key:'goal',targetSourceId:source.id,type:'goal',summary:source.text,modality:'stated',clauses:[{key:'restore',quote:source.text,predicate:'conservar originales',polarity:'positive',resolution:'resolved',arguments:[],conditions:[],temporal:[],relations:[]}]}]},producer:'fixture',sourceCut:context.cut,requestId:'semantic'});assert.deepEqual(semantic.errors,[]);
 const oldLearning=await learningOperation('query',{conversationIds,question:'restauración'}),oldSemantic=await knowledgeOperation('list',conversationIds);
 const choose={conversationIds,id:'backup',action:'choose',detail:actionFixture(sources),expectedVersion:1,binding:first.reference};
 const writes=await Promise.allSettled(['x','y'].map(requestId=>op('act',{...choose,requestId})));assert.equal(writes.filter(r=>r.status==='fulfilled').length,1);assert.match(writes.find(r=>r.status==='rejected').reason.message,/VERSION_CONFLICT/);
 const chosen=writes.find(r=>r.status==='fulfilled').value,requestId=['x','y'][writes.findIndex(r=>r.status==='fulfilled')];assert.deepEqual(await op('act',{...choose,requestId}),chosen);
 const result=await op('act',{conversationIds,id:'backup',action:'result',detail:{...actionFixture(sources,'result'),choiceBinding:chosen.reference},expectedVersion:2,binding:chosen.reference,requestId:'result'});
 assert.equal(result.brief.outcome.alternativeId,'local');assert.deepEqual(result.brief.outcome.choiceBinding,chosen.reference);
 assert.deepEqual(await learningOperation('query',{conversationIds,question:'restauración'}),oldLearning);assert.deepEqual(await knowledgeOperation('list',conversationIds),oldSemantic);
 const retrieved=await retrievePackage('conservar originales',conversationIds,{mode:'lexical'});assert.ok(retrieved.evidence.length);assert.equal(retrieved.knowledge.items.length,1);
 function fresh(data,opName='list',params={}){const p=spawnSync(process.execPath,[path.join(here,'incremental-cli.mjs')],{env:{...process.env,AFH_COSMOS_DATA:data},input:JSON.stringify({op:'decision.'+opName,input:{conversationIds,...params}}),encoding:'utf8',timeout:30000,windowsHide:true});assert.equal(p.status,0,p.stdout+p.stderr);return JSON.parse(p.stdout).result;}
 const reopened=fresh(root);assert.equal(reopened.items[0].record.version,3);assert.equal(reopened.bytes,Buffer.byteLength(JSON.stringify(reopened)));
 const restored=root+'-restored';fs.cpSync(root,restored,{recursive:true});assert.deepEqual(fresh(restored),reopened);assert.deepEqual(fresh(restored,'history',{id:'backup'})[0],first);
 const control=new AbortController();control.abort(new Error('TEST_ABORT'));await assert.rejects(op('list',{conversationIds},{signal:control.signal}),/TEST_ABORT/);
 const item=library.find(i=>i.id===a.id);fs.appendFileSync(path.join(item.path,'acquisition/original.bin'),'drift');await assert.rejects(op('list',{conversationIds}),/Integridad/);
});

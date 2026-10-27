import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {conversation,original,late,draft,reviewOutput} from './reevaluation-fixture.mjs';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-reevaluation-'));process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {addSource,library}=await import('./corpus.mjs');const {knowledgeOperation:op,verifiedSources}=await import('./knowledge.mjs');const {registerWatch,scanReevaluations,reevaluationStatus,runReevaluation,drainReevaluations}=await import('./reevaluation.mjs');const {publishPending}=await import('./publication.mjs');
let calls=0;const inferReview=async prompt=>{calls++;const packet=JSON.parse(prompt.split('\nPACKET\n')[1]);return {value:reviewOutput(packet,packet.target.payload.semantic_unit.clauses[0].arguments[0].interpreted?'no_change':'changed'),modelObserved:'deterministic-test-fixture',receipt:'synthetic-only'};};
test('F29 late antecedent, irrelevant source, duplicate occurrence, cycles, replay, selective retrieval and full restore',async()=>{
 const a=await addSource(conversation('old',original));let ids=[a.id];const ctx=await verifiedSources(ids),s=ctx.sources[0];
 const first=(await op('extract',ids,{draft:draft(s),producer:'test',sourceCut:ctx.cut,requestId:'first'})).records[0];
 const second=(await op('extract',ids,{draft:draft(s,'dependent'),producer:'test',sourceCut:ctx.cut,requestId:'second'})).records[0];
 const untouched=(await op('extract',ids,{draft:draft(s,'unwatched'),producer:'test',sourceCut:ctx.cut,requestId:'third'})).records[0];
 await publishPending(ids);
 await registerWatch({id:first.id,expectedVersion:1,conversationIds:ids,terms:['refería'],dependsOn:[second.id]});
 await registerWatch({id:second.id,expectedVersion:1,conversationIds:ids,terms:[],dependsOn:[first.id]});
 const irrelevant=await addSource(conversation('weather','Mañana habrá lluvia.'));assert.deepEqual(irrelevant.reevaluation.errors,[]);assert.equal(reevaluationStatus().jobs.length,0);
 const b=await addSource(conversation('late',late));ids=[a.id,b.id];assert.deepEqual(b.reevaluation.errors,[]);let jobs=reevaluationStatus().jobs;assert.equal(jobs.length,2);assert.equal(jobs.filter(j=>j.selection.reason==='dependency').length,1);
 await scanReevaluations();assert.equal(reevaluationStatus().jobs.length,2);
 const concurrent=await Promise.allSettled([runReevaluation({id:jobs[0].id},{inferReview}),runReevaluation({id:jobs[0].id},{inferReview})]);assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);assert.match(concurrent.find(x=>x.status==='rejected').reason.message,/REEVALUATION_WATCH_BUSY/);
 for(const j of jobs.slice(1)){const result=await runReevaluation({id:j.id},{inferReview});assert.equal(result.record.version,2);assert.equal(result.record.payload.status,'proposed');}
 assert.equal(calls,2);await runReevaluation({id:jobs[0].id},{inferReview});assert.equal(calls,2);
 const unchanged=await op('get',ids,{id:untouched.id});delete unchanged.sourceBindings;assert.deepEqual(unchanged,untouched);
 assert.equal((await op('history',ids,{id:first.id})).length,2);
 const query=await op('publication_query',ids,{question:'Ana'});assert.equal(query.items.length,2);assert.ok(query.items.every(i=>i.record.version===2));
 const oldQuery=await op('query',ids,{question:'reunión',knownAt:first.recorded_at});assert.equal(oldQuery.items[0].recordVersion,1);
 await addSource(conversation('late',late));assert.equal(reevaluationStatus().jobs.length,2);
 const next=await addSource(conversation('more','Me refería a Ana; no añado ninguna interpretación distinta.'));ids.push(next.id);jobs=reevaluationStatus().jobs.filter(j=>j.status==='pending');assert.equal(jobs.length,2);
 const automatic=await drainReevaluations({}, {inferReview});assert.equal(automatic.results.length,0);assert.equal(calls,2);
 await assert.rejects(drainReevaluations({limit:9,automaticOnly:false},{inferReview}),/BATCH_BUDGET/);
 const batch=await drainReevaluations({limit:1,automaticOnly:false},{inferReview});assert.equal(batch.results.length,1);assert.equal(batch.remaining,1);assert.deepEqual(batch.errors,[]);
 const rest=await drainReevaluations({automaticOnly:false},{inferReview});assert.equal(rest.results.length,1);assert.equal(rest.remaining,0);for(const result of [...batch.results,...rest.results]){assert.equal(result.disposition,'no_change');assert.equal(result.record.version,2);}
 assert.equal(calls,4);assert.equal((await op('history',ids,{id:first.id})).length,2);
 const here=path.dirname(fileURLToPath(import.meta.url));function fresh(data){const p=spawnSync(process.execPath,[path.join(here,'incremental-cli.mjs')],{env:{...process.env,AFH_COSMOS_DATA:data},input:JSON.stringify({op:'reevaluation.status'}),encoding:'utf8',timeout:30000,windowsHide:true});assert.equal(p.status,0,p.stdout+p.stderr);return JSON.parse(p.stdout).result;}
 const status=fresh(root),restored=root+'-restored';fs.cpSync(root,restored,{recursive:true});assert.deepEqual(fresh(restored),status);assert.equal(status.jobs.filter(j=>j.status==='complete').length,4);
 const controller=new AbortController();controller.abort(new Error('TEST_CANCEL'));await assert.rejects(scanReevaluations({signal:controller.signal}),/TEST_CANCEL/);
 fs.appendFileSync(path.join(library.find(i=>i.id===a.id).path,'acquisition/original.bin'),'drift');await assert.rejects(runReevaluation({id:jobs[0].id},{inferReview}),/Integridad/);assert.equal(calls,4);
});

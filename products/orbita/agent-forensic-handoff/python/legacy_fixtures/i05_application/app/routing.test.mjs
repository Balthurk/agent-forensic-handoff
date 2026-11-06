import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-routing-'));process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {OPTIONS,localClassification,validateClassification,classifyNeed,routePlan,routingOperation,readRouting,routingForAnswer}=await import('./routing.mjs');
const {addSource}=await import('./corpus.mjs');const {retrievePackage,closeMemory}=await import('./memory.mjs');const {verifiedSources,knowledgeOperation}=await import('./knowledge.mjs');
const {createBackup,restoreBackup}=await import('./recovery.mjs');
let ids,request,receipt,reference;
const exported=(id,text)=>({filename:id+'.json',content:JSON.stringify({id,title:id,current_node:'u',mapping:{u:{id:'u',parent:null,children:[],message:{id:'u',author:{role:'user'},content:{content_type:'text',parts:[text]}}}}})});
const resolved=(q,...types)=>({resolution:'resolved',selections:types.map(id=>({id,quote:q})),pending:''});
before(async()=>{
 ids=[];for(const [i,text] of ['Permito staging de Alfa sólo si pasa QA.','Excepto durante el mantenimiento de Alfa.','Revoco esa autorización de Alfa.'].entries())ids.push((await addSource(exported('routing-'+i,text))).id);
 const sources=await verifiedSources(ids);for(const [i,s] of sources.sources.entries()){const out=await knowledgeOperation('extract',ids,{draft:{acts:[{key:'a',targetSourceId:s.id,type:'policy',summary:s.text,modality:'directive',clauses:[{key:'c',quote:s.text,predicate:'deployment',polarity:'positive',resolution:'resolved',arguments:[{role:'project',literal:'Alfa',interpreted:'',evidence:[{sourceId:s.id,quote:'Alfa'}]}],conditions:[],temporal:[],relations:[]}]}]},producer:'synthetic-routing-test',sourceCut:sources.cut,requestId:'routing-'+i});assert.deepEqual(out.errors,[]);}
 const cut=new Date().toISOString();request={question:'¿Qué regla permite staging de Alfa y cómo se realiza?',conversationIds:ids,retrieval:{mode:'lexical',knownAt:cut,validAt:cut}};reference=await retrievePackage(request.question,ids,request.retrieval);receipt=await routingOperation(request);
});after(()=>closeMemory());
test('F27 multi-membership follows actual TSM parents and never treats asking as its category',()=>{
 const c=localClassification(request.question);assert.deepEqual(c.selections.map(s=>s.id),['tsm:normative','tsm:procedural']);assert.ok(OPTIONS.every(o=>o.parent==='tsm:memory'));assert.ok(!OPTIONS.some(o=>o.id==='tsm:interrogative'));assert.deepEqual(validateClassification(request.question,c),c);
});
test('F27 material antecedents, ambiguity and uncovered needs are preserved without forced labels',()=>{
 assert.equal(localClassification('Hazlo como acordamos.').resolution,'insufficient_context');assert.equal(localClassification('Háblame de eso.').resolution,'insufficient_context');assert.equal(localClassification('No quiero normas; quiero fechas.').resolution,'ambiguous');assert.equal(localClassification('xyz 🧪').resolution,'unknown');
 for(const state of ['unknown','ambiguous','insufficient_context','unrepresented'])assert.equal(validateClassification('xyz',{resolution:state,selections:[],pending:'Falta interpretar'}).resolution,state);
});
test('F27 schema rejects invented categories, duplicate memberships, fabricated quotes and administrative authority',()=>{
 const q='¿Qué es el prisma?';for(const raw of [{...resolved(q,'tsm:descriptive'),approval:true},resolved(q,'invented'),resolved(q,'tsm:descriptive','tsm:descriptive'),{...resolved(q,'tsm:descriptive'),selections:[{id:'tsm:descriptive',quote:'inventado'}]},{resolution:'resolved',selections:[],pending:''},{resolution:'unknown',selections:[{id:'tsm:descriptive',quote:q}],pending:'duda'}])assert.throws(()=>validateClassification(q,raw),/ROUTING_RESULT/);
 assert.throws(()=>validateClassification('prisma prisma',{resolution:'resolved',selections:[{id:'tsm:descriptive',quote:'prisma'}],pending:''}),/QUOTE/);
});
test('F27 local classification has zero provider calls and cannot lower the selected answer model',async()=>{
 let calls=0;const r=await classifyNeed(request.question,{model:'gpt-6-astra',inferImpl:()=>{calls++;throw new Error('unexpected');}});assert.equal(calls,0);assert.equal(r.plan.answerModel,'gpt-6-astra');assert.equal(r.plan.answerModelChanged,false);assert.equal(r.plan.retrievalEffect,'none');assert.equal(r.metrics.providerCallsAttempted,0);assert.equal(r.executionAuthority,false);assert.equal(r.semanticSupport,'pending');assert.equal(r.calibrated,false);
});
test('F27 assisted and Luna routes are explicit, preserve model observation and validate only request literals',async()=>{
 for(const [policy,expected] of [['assisted','gpt-6-astra'],['luna','gpt-6-luna']]){let seen;const r=await classifyNeed(request.question,{policy,model:'gpt-6-astra',inferImpl:async(prompt,schema,opts)=>{seen=opts;assert.match(prompt,/NO el acto de preguntar/);return {value:resolved(request.question,'tsm:normative','tsm:procedural'),usage:{input_tokens:100},modelObserved:null};}});assert.equal(seen.model,expected);assert.equal(r.metrics.modelObserved,null);assert.equal(r.plan.answerModel,'gpt-6-astra');assert.equal(r.metrics.providerCallsCompleted,1);}
});
test('F27 invalid, missing and timed-out model results are visible local fallback, never a successful model classification',async()=>{
 for(const inferImpl of [async()=>({value:{approval:true}}),async()=>{throw new Error('timeout');},async()=>({value:resolved('otra pregunta','tsm:descriptive')})]){const r=await classifyNeed(request.question,{policy:'assisted',inferImpl});assert.equal(r.fallback.code,'CLASSIFIER_FAILED_OR_REJECTED');assert.equal(r.observed,'deterministic');assert.equal(r.metrics.providerCallsCompleted,0);assert.equal(r.metrics.providerCallsAttempted,1);assert.equal(r.reviewRequired,true);}
});
test('F27 cancellation is not swallowed as a successful fallback',async()=>{
 const c=new AbortController();await assert.rejects(classifyNeed(request.question,{policy:'luna',signal:c.signal,inferImpl:async()=>{c.abort(new Error('ROUTING_TEST_CANCEL'));throw new Error('transport');}}),/ROUTING_TEST_CANCEL/);
});
test('F27 Jev is explicitly blocked with no provider dispatch or imported authority',async()=>{
 let calls=0;await assert.rejects(classifyNeed(request.question,{policy:'jev',inferImpl:()=>{calls++;}}),/JEV_NOT_CONFIGURED/);assert.equal(calls,0);assert.equal(routePlan(localClassification(request.question),{policy:'jev'}).finiteRoute.dispatchAllowed,false);assert.throws(()=>routePlan(localClassification(request.question),{policy:'magic'}),/POLICY/);
});
test('F27 receipt binds exact original question, selected revisions, taxonomy and request budget',async()=>{
 assert.equal(receipt.binding.question,request.question);assert.equal(receipt.binding.questionSha256.length,64);assert.equal(receipt.binding.taxonomySha256.length,64);assert.equal(receipt.result.hierarchy.length,2);assert.equal(receipt.result.executionAuthority,false);assert.equal(receipt.freshness.current,true);
 await assert.rejects(routingOperation({...request,question:'x'.repeat(8001)}),/QUESTION/);await assert.rejects(readRouting(receipt.id,ids.slice(0,1)),/SELECTION_MISMATCH/);
});
test('F27 classification and deliberate misclassification cannot change evidence, exceptions, revocations or byte budget',async()=>{
 const correction=await routingOperation({op:'correct',id:receipt.id,conversationIds:ids,types:['tsm:descriptive'],reason:'Synthetic wrong classification to prove source invariance'});
 const after=await retrievePackage(request.question,ids,request.retrieval);assert.deepEqual(after.evidence,reference.evidence);assert.deepEqual(after.context.units,reference.context.units);assert.equal(after.bytes,reference.bytes);assert.equal(after.context.requiresAbstention,true);assert.equal(after.context.executionAuthority,false);for(const word of ['Permito','Excepto','Revoco'])assert.ok(after.evidence.some(e=>e.text.includes(word)));assert.equal(correction.result.plan.retrievalEffect,'none');
});
test('F27 correction creates an immutable linked receipt, original still reopens exactly',async()=>{
 const before=await readRouting(receipt.id,ids);const corrected=await routingOperation({op:'correct',id:receipt.id,conversationIds:ids,types:['tsm:normative','tsm:procedural'],reason:'Necesito regla y procedimiento'});assert.notEqual(corrected.id,receipt.id);assert.equal(corrected.parentReceipt,receipt.id);assert.equal(corrected.result.observed,'user_correction');assert.equal(corrected.result.reviewRequired,true);assert.deepEqual(await readRouting(receipt.id,ids),before);
 await assert.rejects(routingOperation({op:'correct',id:receipt.id,conversationIds:ids,types:['tsm:permission'],reason:'fuera del nivel'}),/OPTION/);
});
test('F27 a reusable classification cannot be attached to a different question, retrieval cut or answer model',async()=>{
 assert.equal((await routingForAnswer({...request,routing:{receiptId:receipt.id}})).id,receipt.id);
 for(const change of [{question:'otra'}, {retrieval:{...request.retrieval,maxBytes:9000}}, {model:'gpt-6-luna'}])await assert.rejects(routingForAnswer({...request,...change,routing:{receiptId:receipt.id}}),/QUERY_MISMATCH/);
});
test('F27 tampering with a retained receipt fails its content address',async()=>{
 const file=path.join(root,'query-routing',receipt.id+'.json'),raw=fs.readFileSync(file);fs.appendFileSync(file,' ');try{await assert.rejects(readRouting(receipt.id,ids),/INTEGRITY/);}finally{fs.writeFileSync(file,raw);}
});
test('F27 HTTP API, UI asset and CLI share the receipt without calling any model',async t=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.AFH_COSMOS_PORT=String(port);const {server}=await import('./server.mjs');await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const body={op:'get',id:receipt.id,conversationIds:ids},response=await fetch('http://127.0.0.1:'+port+'/api/routing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);assert.deepEqual(await response.json(),await readRouting(receipt.id,ids));assert.match(await(await fetch('http://127.0.0.1:'+port+'/routing-web.mjs')).text(),/Guardar corrección/);
 const f=path.join(root,'request.json');fs.writeFileSync(f,JSON.stringify(body));const result=spawnSync(process.execPath,[fileURLToPath(new URL('./memory-cli.mjs',import.meta.url)),'routing',f],{env:process.env,encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),await readRouting(receipt.id,ids));
});
test('F27 integral backup and fresh-process restore retain classification, correction lineage and original evidence',async()=>{
 const parent=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-routing-restore-')),archive=path.join(parent,'complete.orbita'),destination=path.join(parent,'restored');await createBackup({source:root,archive,password:'synthetic-routing-test-only',ownSession:true});await restoreBackup({archive,destination,password:'synthetic-routing-test-only'});
 const f=path.join(parent,'request.json');fs.writeFileSync(f,JSON.stringify({op:'get',id:receipt.id,conversationIds:ids}));const result=spawnSync(process.execPath,[fileURLToPath(new URL('./memory-cli.mjs',import.meta.url)),'routing',f],{env:{...process.env,AFH_COSMOS_DATA:destination},encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),await readRouting(receipt.id,ids));
});
test('F27 a changed semantic store marks old classification stale and blocks correction/reuse',async()=>{
 const sources=await verifiedSources(ids),s=sources.sources[0];await knowledgeOperation('extract',ids,{draft:{acts:[{key:'new',targetSourceId:s.id,type:'policy',summary:s.text,modality:'directive',clauses:[{key:'c',quote:s.text,predicate:'new-predicate',polarity:'positive',resolution:'resolved',arguments:[],conditions:[],temporal:[],relations:[]}]}]},producer:'synthetic-routing-test',sourceCut:sources.cut,requestId:'stale-cut'});
 assert.equal((await readRouting(receipt.id,ids)).freshness.current,false);await assert.rejects(routingOperation({op:'correct',id:receipt.id,conversationIds:ids,types:[],reason:'sin clasificar'}),/STALE_CUT/);await assert.rejects(routingForAnswer({...request,routing:{receiptId:receipt.id}}),/STALE_CUT/);
});
test('F27 a source-cut change during model interpretation cannot publish a current receipt',async()=>{
 const before=fs.readdirSync(path.join(root,'query-routing')).length;
 await assert.rejects(routingOperation({...request,policy:'assisted'},{inferImpl:async()=>{
  const sources=await verifiedSources(ids),s=sources.sources[0];const out=await knowledgeOperation('extract',ids,{draft:{acts:[{key:'concurrent',targetSourceId:s.id,type:'policy',summary:s.text,modality:'directive',clauses:[{key:'c',quote:s.text,predicate:'concurrent-change',polarity:'positive',resolution:'resolved',arguments:[],conditions:[],temporal:[],relations:[]}]}]},producer:'synthetic-routing-test',sourceCut:sources.cut,requestId:'concurrent-change'});assert.deepEqual(out.errors,[]);return {value:resolved(request.question,'tsm:normative')};
 }}),/CHANGED_DURING_CLASSIFICATION/);assert.equal(fs.readdirSync(path.join(root,'query-routing')).length,before);
});

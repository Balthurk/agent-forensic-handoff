import test,{after} from 'node:test';import assert from 'node:assert/strict';import native from 'node:fs';import fs from '../agent-forensic-handoff/src/common-files.js';import {closeCommonStore,acquireStoreLease} from '../agent-forensic-handoff/src/common-store.js';import {pythonExecutable} from '../agent-forensic-handoff/src/python-runtime.js';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
assert.ok(process.env.ORBITA_POSTGRES_TEST_ROOT&&process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'explicit common fixture and native receipt roots required');
fs.mkdirSync(process.env.ORBITA_POSTGRES_TEST_ROOT,{recursive:true});
const nativeRoot=native.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'jev-native-'));
const root=fs.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'orbita-jev-'));process.env.AFH_COSMOS_DATA=path.join(root,'data');fs.mkdirSync(process.env.AFH_COSMOS_DATA);delete process.env.AFH_JEV_CONFIG;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {prepareJev,validateJevResponse,interpretJev,invokeJev,classifyJev,initializeJev,jevStatus,reserveJev,settleJev,JEV_MODEL,digest}=await import('./jev.mjs');
const {OPTIONS,classifyNeed,routingOperation,readRouting}=await import('./routing.mjs');const {addSource}=await import('./corpus.mjs');const {createBackup:backup,restoreBackup:restore}=await import('./recovery.mjs');const createBackup=options=>backup({archiveStorage:'postgresql-common',...options}),restoreBackup=options=>restore({archiveStorage:'postgresql-common',...options});const {closeMemory}=await import('./memory.mjs');after(async()=>{delete process.env.AFH_JEV_CONFIG;try{await closeMemory();}finally{const closed=closeCommonStore();assert.equal(closed.drained,true);assert.equal(closed.ownedExit,0);assert.equal(native.existsSync(root),false);}});
const question='¿Qué regla permite consultar Beta y cómo se consulta?',body=prepareJev(question,OPTIONS);
function setup(changes={}){const dir=fs.mkdtempSync(path.join(root,'budget-')),file=path.join(native.mkdtempSync(path.join(nativeRoot,'config-')),'connection.json'),config={schema:'orbita.jev-connection.v2',budgetRoot:dir,id:'orbita-native-test',model:JEV_MODEL,credentialReference:'TYPESAFE_API_KEY',inputTokenNanoUSD:42,maxCalls:32,maxNanoUSD:100000000,createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),allowedDataRoots:[process.env.AFH_COSMOS_DATA],...changes};initializeJev(file,config);return {file,dir,config};}
function response(request=body,{resolution='resolved',types=['tsm:normative','tsm:procedural']}={}){return {model:JEV_MODEL,answers:Object.fromEntries(Object.entries(request.questions).map(([k,v])=>[k,v.type==='choice'?{type:'choice',choice:resolution,confidence:1,probabilities:Object.fromEntries(Object.keys(v.criteria).map(x=>[x,x===resolution?1:0]))}:{type:'noul',noul:types.includes(OPTIONS[Number(k.split('_').at(-1))]?.id)?0.99:0.01}])),usage:{input_tokens:1200,output_tokens:90}};}
test('F27 Jev request sends only the exact question and complete independent families',()=>{
 assert.deepEqual(body.state,{question});assert.equal(body.model,'jev-1.14.0');assert.equal(Object.keys(body.questions).length,8);assert.equal(Object.values(body.questions).filter(q=>q.type==='noul').length,7);assert.ok(Object.keys(body.questions.resolution.criteria).includes('insufficient_context'));assert.match(body.questions.option_1.instructions,/not the act of asking or the truth/);assert.ok(!JSON.stringify(body).includes('credential'));
});
test('F27 Jev rejects wrong model, extra authority, missing memberships and invalid probability/usage',()=>{
 const mutations=[v=>v.model='jev-latest',v=>v.approval=true,v=>delete v.answers.option_0,v=>v.answers.option_0.noul=NaN,v=>v.usage.input_tokens=-1,v=>v.usage.output_tokens=true,v=>v.answers.resolution.probabilities.unknown=0.2,v=>v.answers.resolution.choice='unknown',v=>v.answers.resolution.confidence=2,v=>v.answers.option_1.truth=true];
 for(const change of mutations){const v=response();change(v);assert.throws(()=>validateJevResponse(v,body),/JEV_/);}
});
test('F27 Jev preserves multiple needs, abstention controls and uncertain memberships',()=>{
 const multi=interpretJev(question,OPTIONS,validateJevResponse(response(),body));assert.deepEqual(multi.classification.selections.map(x=>x.id),['tsm:normative','tsm:procedural']);assert.ok(multi.classification.selections.every(x=>x.quote===question));assert.equal(multi.signals.thresholds.calibrated,false);
 for(const resolution of ['unknown','ambiguous','insufficient_context','unrepresented']){const r=interpretJev(question,OPTIONS,response(body,{resolution}));assert.equal(r.classification.resolution,resolution);assert.deepEqual(r.classification.selections,[]);assert.ok(r.classification.pending);}
 for(const mutate of [v=>v.answers.option_3.noul=.5,v=>v.answers.resolution.confidence=.4]){const v=response();mutate(v);const r=interpretJev(question,OPTIONS,v);assert.equal(r.classification.resolution,'ambiguous');assert.deepEqual(r.classification.selections,[]);}
});
test('F27 absent connection never invokes a sender or silently substitutes another route',async()=>{
 let calls=0;await assert.rejects(invokeJev(body,{sendImpl:async()=>{calls++;return response();}}),/NOT_CONFIGURED/);assert.equal(calls,0);assert.equal(jevStatus().status,'not_configured');
});
test('F27 reservation precedes dispatch and valid native usage settles a visible estimate',async()=>{
 const c=setup();let seen=false;const r=await invokeJev(body,{configPath:c.file,sendImpl:async req=>{const ledger=JSON.parse(fs.readFileSync(path.join(c.dir,'usage.json'),'utf8')).payload;assert.equal(ledger.attempts.length,1);assert.equal(ledger.attempts[0].status,'pending');assert.equal(ledger.attempts[0].requestSha256,digest(req));seen=true;return response(req);}});
 assert.equal(seen,true);assert.equal(r.money.estimatedUSD,0.0000504);assert.equal(r.value.model,JEV_MODEL);assert.equal(jevStatus({configPath:c.file}).actualCalls,1);assert.equal(jevStatus({configPath:c.file}).consumedOrReservedUSD,r.money.estimatedUSD);assert.ok(fs.existsSync(path.join(process.env.AFH_COSMOS_DATA,'jev-receipts',r.receipt.id+'.json')));
});
test('F27 uncertain errors are redacted and keep their reservation across reloads',async()=>{
 const c=setup({maxCalls:1});let calls=0;await assert.rejects(invokeJev(body,{configPath:c.file,sendImpl:async()=>{calls++;throw new Error('secret-do-not-leak');}}),e=>e.message==='JEV_TRANSPORT_UNCERTAIN');
 const ledger=fs.readFileSync(path.join(c.dir,'usage.json'),'utf8');assert.ok(!ledger.includes('secret-do-not-leak'));assert.equal(JSON.parse(ledger).payload.attempts[0].status,'uncertain');const status=jevStatus({configPath:c.file});assert.equal(status.status,'budget_exhausted');assert.equal(status.consumedOrReservedUSD,0.002752512);await assert.rejects(invokeJev(body,{configPath:c.file,sendImpl:async()=>{calls++;return response();}}),/BUDGET_EXHAUSTED/);assert.equal(calls,1);
});
test('F27 pre-cancel avoids reservation, in-flight cancel retains the conservative amount',async()=>{
 const c=setup(),controller=new AbortController();controller.abort(new Error('CANCEL_TEST'));await assert.rejects(invokeJev(body,{configPath:c.file,signal:controller.signal}),/CANCEL_TEST/);assert.equal(jevStatus({configPath:c.file}).actualCalls,0);
 const inflight=new AbortController();await assert.rejects(invokeJev(body,{configPath:c.file,signal:inflight.signal,sendImpl:async()=>{inflight.abort(new Error('CANCEL_TEST'));throw new Error('sensitive dependency');}}),/CANCEL_TEST/);assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir,'usage.json'),'utf8')).payload.attempts[0].status,'uncertain');
});
test('F27 rejected model result consumes a reservation without publishing a native receipt',async()=>{
 const c=setup(),dir=path.join(process.env.AFH_COSMOS_DATA,'jev-receipts'),before=fs.readdirSync(dir).length;await assert.rejects(invokeJev(body,{configPath:c.file,sendImpl:async()=>({...response(),model:'unqualified-model'})}),/MODEL_MISMATCH/);assert.equal(fs.readdirSync(dir).length,before);assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir,'usage.json'),'utf8')).payload.attempts[0].status,'uncertain');
});
test('F27 timeout cannot become a successful native classification',async()=>{
 const c=setup();await assert.rejects(invokeJev(body,{configPath:c.file,timeout:10,sendImpl:async()=>{await new Promise(r=>setTimeout(r,30));return response();}}),/DEADLINE_EXCEEDED/);assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir,'usage.json'),'utf8')).payload.attempts[0].status,'uncertain');
});
test('F27 native budget is shared across simultaneous fresh processes',async()=>{
 const c=setup({maxCalls:1}),script=path.join(path.dirname(c.file),'reserve.mjs');native.writeFileSync(script,`import {reserveJev} from ${JSON.stringify(new URL('./jev.mjs',import.meta.url).href)};import {closeCommonStore} from ${JSON.stringify(new URL('../agent-forensic-handoff/src/common-store.js',import.meta.url).href)};try{reserveJev(${JSON.stringify(body)},{configPath:${JSON.stringify(c.file)}});console.log('reserved');}catch(e){console.log(e.message);}finally{closeCommonStore();}`);
 const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script],{windowsHide:true,env:process.env,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(new Error('child failed')));});
 const results=await Promise.all([run(),run()]);assert.equal(results.filter(x=>x==='reserved').length,1);assert.ok(results.every(x=>['reserved','JEV_BUDGET_BUSY','JEV_BUDGET_EXHAUSTED'].includes(x)));assert.equal(jevStatus({configPath:c.file}).actualCalls,1);
});
test('F27 tampered, missing or changed budget cannot silently reset allowance',async()=>{
 for(const mode of ['hash','missing','config']){const c=setup();if(mode==='hash')fs.writeFileSync(path.join(c.dir,'usage.json'),'{}');if(mode==='missing')fs.renameSync(path.join(c.dir,'usage.json'),path.join(c.dir,'retained-usage.json'));if(mode==='config')native.writeFileSync(c.file,JSON.stringify({...c.config,id:'changed-configuration'}));let calls=0;await assert.rejects(invokeJev(body,{configPath:c.file,sendImpl:async()=>{calls++;return response();}}));assert.equal(calls,0);assert.equal(jevStatus({configPath:c.file}).dispatchAllowed,false);assert.equal(jevStatus({configPath:c.file}).actualCalls,null);}
});
test('F27 expired configuration and unregistered restored root cannot dispatch',async()=>{
 const c=setup({createdAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()});await assert.rejects(invokeJev(body,{configPath:c.file}),/EXPIRED/);const live=setup(),other=fs.mkdtempSync(path.join(root,'other-'));await assert.rejects(invokeJev(body,{configPath:live.file,dataRoot:other}),/ROOT_NOT_AUTHORIZED/);assert.equal(jevStatus({configPath:live.file}).actualCalls,0);
});
test('F27 native routing keeps answer model, literal binding and original evidence authority',async()=>{
 const c=setup();process.env.AFH_JEV_CONFIG=c.file;try{const r=await classifyNeed(question,{policy:'jev',model:'gpt-6-astra',jevImpl:(q,o,s)=>classifyJev(q,o,{...s,sendImpl:async b=>response(b)})});assert.equal(r.observed,'jev');assert.equal(r.plan.answerModel,'gpt-6-astra');assert.equal(r.plan.answerModelChanged,false);assert.equal(r.plan.retrievalEffect,'none');assert.equal(r.metrics.modelObserved,JEV_MODEL);assert.equal(r.metrics.money.estimatedUSD,.0000504);assert.equal(r.executionAuthority,false);assert.equal(r.calibrated,false);}finally{delete process.env.AFH_JEV_CONFIG;}
});
test('F27 native receipts survive integral restore; external budget and connections do not reset',async()=>{
 const c=setup();process.env.AFH_JEV_CONFIG=c.file;try{const id=(await addSource({filename:'native.json',content:JSON.stringify({id:'native',title:'native',current_node:'u',mapping:{u:{id:'u',parent:null,children:[],message:{id:'u',author:{role:'user'},content:{content_type:'text',parts:['La regla de Beta exige consultar el registro de revocaciones.']}}}}})})).id;
 const r=await routingOperation({question,conversationIds:[id],policy:'jev'},{jevImpl:(q,o,s)=>classifyJev(q,o,{...s,sendImpl:async b=>response(b)})});assert.equal(r.result.observed,'jev');const ledger=fs.readFileSync(path.join(c.dir,'usage.json'));const archive=path.join(root,'native.orbita'),destination=path.join(root,'restored');await createBackup({source:process.env.AFH_COSMOS_DATA,archive,password:'test-native-only',ownSession:true});await restoreBackup({archive,destination,password:'test-native-only'});
 assert.deepEqual(fs.readFileSync(path.join(destination,'jev-receipts',r.result.metrics.transportReceipt.id+'.json')),fs.readFileSync(path.join(process.env.AFH_COSMOS_DATA,'jev-receipts',r.result.metrics.transportReceipt.id+'.json')));assert.deepEqual(fs.readFileSync(path.join(c.dir,'usage.json')),ledger);assert.ok(!fs.existsSync(path.join(destination,'usage.json')));await assert.rejects(invokeJev(body,{configPath:c.file,dataRoot:destination}),/RECOVERY_EXTERNAL_ACCESS_PAUSED/);
 const f=path.join(nativeRoot,'read-routing.json');native.writeFileSync(f,JSON.stringify({op:'get',id:r.id,conversationIds:[id]}));const result=spawnSync(process.execPath,[fileURLToPath(new URL('./memory-cli.mjs',import.meta.url)),'routing',f],{env:{...process.env,AFH_COSMOS_DATA:destination},windowsHide:true,encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),await readRouting(r.id,[id]));}finally{delete process.env.AFH_JEV_CONFIG;}
});
test('F27 Python private boundary validates the wire and never emits credential/error contents',()=>{
 const result=spawnSync(pythonExecutable(['AFH_JEV_PYTHON']),['-X','utf8','-B',fileURLToPath(new URL('./test_jev_http.py',import.meta.url))],{windowsHide:true,encoding:'utf8',timeout:60000});native.writeFileSync(path.join(nativeRoot,'http-boundary.log'),result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stderr,/Ran 6 tests/);assert.match(result.stderr,/OK/);
});

test('PG01 a legacy Jev configuration cannot promote or reset an existing allowance',async()=>{
 const c=setup(),before=fs.readFileSync(path.join(c.dir,'usage.json')),legacy={...c.config,schema:'orbita.jev-connection.v1'};delete legacy.budgetRoot;
 native.writeFileSync(c.file,JSON.stringify(legacy));const oldLedger=path.join(path.dirname(c.file),'usage.json');native.writeFileSync(oldLedger,'legacy pending spend must remain');
 let calls=0;await assert.rejects(invokeJev(body,{configPath:c.file,sendImpl:async()=>{calls++;return response();}}),/CONFIG_INVALID/);
 assert.equal(calls,0);assert.deepEqual(fs.readFileSync(path.join(c.dir,'usage.json')),before);assert.equal(native.readFileSync(oldLedger,'utf8'),'legacy pending spend must remain');
});
test('PG01 the budget cannot overlap any authorized content tree',()=>{
 const c=setup(),other=fs.mkdtempSync(path.join(root,'other-content-')),file=path.join(path.dirname(c.file),'rejected.json');
 for(const budgetRoot of [path.join(other,'budget'),root])assert.throws(()=>initializeJev(file,{...c.config,allowedDataRoots:[process.env.AFH_COSMOS_DATA,other],budgetRoot}),/BUDGET_MUST_BE_EXTERNAL/);
 assert.equal(native.existsSync(file),false);
});
test('PG01 an unregistered native budget directory cannot become an operational fallback',()=>{
 const c=setup(),budgetRoot=native.mkdtempSync(path.join(nativeRoot,'unbound-')),file=path.join(path.dirname(c.file),'unbound.json');
 assert.throws(()=>initializeJev(file,{...c.config,budgetRoot}),/ORBITA_PG/);assert.equal(native.existsSync(file),false);assert.deepEqual(native.readdirSync(budgetRoot),[]);
});
test('PG01 a live exclusive budget owner blocks reservation until actual release',()=>{
 const c=setup(),lease=acquireStoreLease(c.dir,{mode:'exclusive'});
 try{assert.equal(jevStatus({configPath:c.file}).status,'budget_busy');assert.throws(()=>reserveJev(body,{configPath:c.file}),/BUDGET_BUSY/);assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir,'usage.json'),'utf8')).payload.attempts.length,0);}finally{lease.release();}
 reserveJev(body,{configPath:c.file});assert.equal(jevStatus({configPath:c.file}).actualCalls,1);assert.equal(native.existsSync(path.join(path.dirname(c.file),'usage.lock')),false);
});

import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import net from 'node:net';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-context-'));process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {addSource,library}=await import('./corpus.mjs');const {verifiedSources,knowledgeOperation}=await import('./knowledge.mjs');const {retrievePackage,closeMemory}=await import('./memory.mjs');const {contextPage,verifyContextSnapshot}=await import('./context.mjs');
const {collectiveOperation}=await import('./collectives.mjs');const {collectiveFixture}=await import('./collective-fixture.mjs');
let ids,record,baseline,allSources;
async function add(id,text){return addSource({filename:id+'.json',content:JSON.stringify({id,title:id,current_node:'u',mapping:{u:{id:'u',parent:null,children:[],message:{id:'u',author:{role:'user'},content:{content_type:'text',parts:[text]}}}}})});}
before(async()=>{
 ids=[];for(const [i,text] of ['Permito staging de Alfa sólo si pasa QA.','Excepto durante el mantenimiento de Alfa.','Revoco esa autorización de Alfa.','El informe técnico contiene un contexto independiente.'].entries())ids.push((await add('f22-'+i,text)).id);
 const context=await verifiedSources(ids);allSources=context.sources;
 for(const [i,s] of context.sources.slice(0,3).entries()){
  const ev=[{sourceId:s.id,quote:s.text}],clause={key:'c',quote:s.text,predicate:'deployment',polarity:'positive',resolution:'resolved',arguments:[{role:'project',literal:'Alfa',interpreted:'',evidence:ev}],conditions:[],temporal:[],relations:[]};
  if(i===0)clause.conditions=[{literal:'sólo si pasa QA',scope:'Alfa',resolution:'resolved',evidence:[{sourceId:s.id,quote:'sólo si pasa QA'}]}];
  const out=await knowledgeOperation('extract',ids,{draft:{acts:[{key:'a'+i,targetSourceId:s.id,type:'policy',summary:s.text,modality:'directive',clauses:[clause]}]},producer:'synthetic-f22-test',sourceCut:context.cut,requestId:'extract-'+i});assert.deepEqual(out.errors,[]);if(i===0)record=out.records[0];
 }
 baseline=await retrievePackage('¿Puedo usar staging de Alfa y qué excepciones o revocaciones tiene?',ids,{mode:'lexical'});
});
after(()=>closeMemory());
test('F22 finds unlinked cross-source complements, exact literals and unknown validity without invented edges',()=>{
 assert.equal(baseline.knowledge.items.length,3);assert.equal(baseline.knowledge.edges.length,0);assert.equal(baseline.knowledge.candidateComplements.length,0); // all three also match the question
 for(const text of ['Permito','Excepto','Revoco'])assert.ok(baseline.evidence.some(e=>e.text.includes(text)));
 assert.ok(baseline.context.needs.some(n=>n.id==='revocation'&&n.status==='candidate_evidence'));assert.equal(baseline.context.requiresAbstention,true);assert.equal(baseline.context.executionAuthority,false);
 assert.ok(baseline.knowledge.items.every(i=>i.validity==='unknown'));assert.equal(baseline.bytes,Buffer.byteLength(JSON.stringify(baseline)));
});
test('F22 removes the whole semantic component when the budget is too small, never only its adverse evidence',async()=>{
 const small=await retrievePackage('staging Alfa',ids,{mode:'lexical',maxBytes:9000});assert.ok(small.bytes<=9000);
 const members=small.evidence.filter(e=>/Permito|Excepto|Revoco/.test(e.text));assert.ok(members.length===0||members.length===3);assert.equal(members.length,0);assert.ok(small.context.omissions>0);assert.equal(small.knowledge.items.length,0);
});
test('F22 pages reopen the exact snapshot with UTF8 budget and atomic context',async()=>{
 const page=await contextPage({id:baseline.context.snapshot.id,conversationIds:ids,limit:1});assert.equal(page.freshness.current,true);assert.equal(page.items.length,1);assert.equal(page.items[0].kind,'semantic');assert.equal(page.evidence.length,3);assert.equal(page.bytes,Buffer.byteLength(JSON.stringify(page)));
 const again=await contextPage({id:baseline.context.snapshot.id,conversationIds:ids,limit:1});assert.deepEqual(again,page);
 const small=await contextPage({id:baseline.context.snapshot.id,conversationIds:ids,maxBytes:4096,limit:1});assert.equal(small.items.length,0);assert.equal(small.evidence.length,0);assert.equal(small.omissions[0].reason,'whole_context_exceeds_page_budget');assert.ok(small.bytes<=4096);
});
test('F22 cursor binds selection, budget and query snapshot and cannot be forged by changing its offset',async()=>{
 await assert.rejects(contextPage({id:baseline.context.snapshot.id,conversationIds:ids.slice(0,1)}),/SELECTION_MISMATCH/);
 const snapshotDir=path.join(root,'context-queries',baseline.context.snapshot.id);const raw=fs.readFileSync(path.join(snapshotDir,'snapshot.json'),'utf8');
 const pages=await retrievePackage('informe técnico staging Alfa',ids,{mode:'lexical'});const first=await contextPage({id:pages.context.snapshot.id,conversationIds:ids,limit:1});assert.ok(first.nextCursor);
 await assert.rejects(contextPage({id:pages.context.snapshot.id,conversationIds:ids,cursor:first.nextCursor,limit:2}),/CURSOR_BINDING/);
 const [data,signature]=first.nextCursor.split('.');const changed=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(data,'base64url').toString()),offset:20})).toString('base64url')+'.'+signature;
 await assert.rejects(contextPage({id:pages.context.snapshot.id,conversationIds:ids,cursor:changed,limit:1}),/CURSOR_INTEGRITY/);
 const next=await contextPage({id:pages.context.snapshot.id,conversationIds:ids,cursor:first.nextCursor,limit:1});assert.equal(next.items[0].kind,'original');assert.equal(next.nextCursor,null);
 assert.equal(fs.readFileSync(path.join(snapshotDir,'snapshot.json'),'utf8'),raw);
});
test('F22 CLI in a fresh process reconstructs the same query page',async()=>{
 const request=path.join(root,'page-request.json'),input={id:baseline.context.snapshot.id,conversationIds:ids,limit:1};fs.writeFileSync(request,JSON.stringify(input));const cli=fileURLToPath(new URL('./memory-cli.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[cli,'context-page',request],{env:process.env,encoding:'utf8',timeout:60000,windowsHide:true});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),await contextPage(input));
});
test('F22 snapshot tampering is rejected before serving a page',async()=>{
 const file=path.join(root,'context-queries',baseline.context.snapshot.id,'snapshot.json'),raw=fs.readFileSync(file);fs.appendFileSync(file,' ');
 try{await assert.rejects(contextPage({id:baseline.context.snapshot.id,conversationIds:ids}),/SNAPSHOT_INTEGRITY/);}finally{fs.writeFileSync(file,raw);}
});
test('F22 new collective changes the cut; old pages remain explicitly stale and cannot validate an answer as current',async()=>{
 await collectiveOperation('put',{conversationIds:ids,id:'scope-review',detail:collectiveFixture(allSources),requestId:'collective'});
 const old=await contextPage({id:baseline.context.snapshot.id,conversationIds:ids});assert.equal(old.status,'stale_cut');assert.equal(old.freshness.current,false);assert.equal(old.items[0].kind,'semantic');
 await assert.rejects(verifyContextSnapshot(baseline.context.snapshot,ids),/CHANGED_SINCE_RETRIEVAL/);
 const fresh=await retrievePackage('Revisión staging Alfa',ids,{mode:'lexical'});assert.ok(fresh.context.units.some(u=>u.kind==='collective'));assert.equal((await contextPage({id:fresh.context.snapshot.id,conversationIds:ids})).freshness.current,true);
});
test('F22 changed original cannot be served from a retained query cache',async()=>{
 const source=library.find(x=>x.id===ids[0]),file=path.join(source.path,'acquisition/original.bin'),raw=fs.readFileSync(file);fs.appendFileSync(file,' changed');
 try{await assert.rejects(contextPage({id:baseline.context.snapshot.id,conversationIds:ids}),/Integridad/);}finally{fs.writeFileSync(file,raw);}
});
test('F22 explicit needs are recorded and unknown needs are rejected',async()=>{
 const packet=await retrievePackage('Alfa',ids,{mode:'lexical',needs:['decision_support','exception']});assert.ok(packet.context.needs.some(n=>n.id==='decision_support'));assert.ok(packet.context.needs.some(n=>n.id==='exception'));
 await assert.rejects(retrievePackage('Alfa',ids,{mode:'lexical',needs:['invented']}),/CONTEXT_NEEDS/);
});
test('F22 HTTP retrieval, continuation and UI module expose the same packet',async t=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.AFH_COSMOS_PORT=String(port);
 const {server}=await import('./server.mjs');await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+port;
 const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;};
 const packet=await post('/api/retrieve',{question:'staging Alfa',conversationIds:ids,retrieval:{mode:'lexical',needs:['exception']}});assert.equal(packet.bytes,Buffer.byteLength(JSON.stringify(packet)));
 const request={id:packet.context.snapshot.id,conversationIds:ids,limit:1};assert.deepEqual(await post('/api/context/page',request),await contextPage(request));
 assert.match(await(await fetch(base+'/context-web.mjs')).text(),/Contexto y vigencia/);assert.match(await(await fetch(base)).text(),/id="contextNeed"/);
});
test('F22 integral restore retains the snapshot, cursor key and exact evidence for a new process',async()=>{
 const {createBackup,restoreBackup}=await import('./recovery.mjs');const destination=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-context-restore-parent-'));const archive=path.join(destination,'memory.orbita'),restored=path.join(destination,'restored');
 const input={id:baseline.context.snapshot.id,conversationIds:ids,limit:1},before=await contextPage(input);await createBackup({source:root,archive,password:'f22-synthetic-test-only',ownSession:true});await restoreBackup({archive,destination:restored,password:'f22-synthetic-test-only'});
 const request=path.join(destination,'request.json');fs.writeFileSync(request,JSON.stringify(input));const cli=fileURLToPath(new URL('./memory-cli.mjs',import.meta.url));const result=spawnSync(process.execPath,[cli,'context-page',request],{env:{...process.env,AFH_COSMOS_DATA:restored},encoding:'utf8',timeout:60000,windowsHide:true});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),before);
});

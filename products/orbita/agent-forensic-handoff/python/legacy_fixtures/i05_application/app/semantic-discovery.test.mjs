import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {createHash,randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {contextDiscovery,semanticSeeds,validateDiscovery} from './semantic-discovery.mjs';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-discovery-'));
process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {addSource,library,loadCase,importCapturedRevision}=await import('./corpus.mjs');
const {verifiedSources,knowledgeOperation:op}=await import('./knowledge.mjs');
const {retrievePackage,closeMemory}=await import('./memory.mjs');
const {contextPage,readSnapshot}=await import('./context.mjs');
const {buildSemanticIndex}=await import('../agent-forensic-handoff/src/semantic.js');
const {conversation}=await import('./reevaluation-fixture.mjs');
const hash=value=>createHash('sha256').update(value).digest('hex');
let embeddingCalls=0;
const provider={identity:{provider:'fixture-local',runtime:'deterministic-test-provider',runtimeVersion:'1',modelId:'fixture/a12-discovery',revision:'v1',modelDigest:'c'.repeat(64),dimensions:4,dtype:'f32',pooling:'fixture',normalization:'l2-v1',license:'test-only',snapshotPath:null},maxInputTokens:384,countTokens:s=>[...s].length+2,
 async embed(texts){embeddingCalls++;return texts.map(s=>/Permito|arrancar/.test(s)?[1,0,0,0]:/Revoco/.test(s)?[0,1,0,0]:/Neptuno/.test(s)?[0,0,1,0]:[0,0,0,1]);}};
const deps={embeddingProvider:async()=>provider};
const question='¿Podemos arrancar la aplicación?';
let ids,bindings,knownAt,packet,lexical,projection;
async function extract(selection,source,key,{project='Alfa'}={}){
 const evidence=[{sourceId:source.id,quote:source.text,start:0}];
 const clause={key,quote:source.text,start:0,predicate:'declaración',polarity:'positive',resolution:'resolved',arguments:[{role:project?'project':'literal_content',literal:project||source.text,interpreted:'',evidence}],conditions:[],temporal:[],relations:[]};
 const result=await op('extract',selection,{draft:{acts:[{key,targetSourceId:source.id,type:'policy',summary:source.text,modality:'stated',clauses:[clause]}]},producer:'synthetic-a12',sourceCut:'synthetic-cut',requestId:'extract-'+key});
 assert.deepEqual(result.errors,[]);return result.records[0];
}
before(async()=>{
 ids=[];for(const [i,text] of ['Permito activar Alfa sólo si pasa QA.','Revoco el permiso de Alfa durante mantenimiento.','Neptuno tiene una atmósfera fría.'].entries())ids.push((await addSource(conversation('a12-'+i,text))).id);
 bindings=(await verifiedSources(ids)).sources;
 for(const [i,s] of bindings.entries()){const r=await extract(ids,s,'rule-'+i,{project:i<2?'Alfa':null});knownAt=r.recorded_at;}
 for(const id of ids){const built=await buildSemanticIndex(library.find(i=>i.id===id).path,{provider,representation:'full_source_text'});if(id===ids[0])projection=built;}
 lexical=await retrievePackage(question,ids,{mode:'lexical',knownAt},deps);
 packet=await retrievePackage(question,ids,{mode:'semantic',knownAt},deps);
});
after(()=>closeMemory());

test('verified full-text hits discover clauses and whole adverse closure without inferred edges or support',()=>{
 assert.equal(lexical.knowledge.items.length,0);assert.equal(packet.knowledge.items.length,2);
 assert.equal(packet.knowledge.edges.length,0);assert.equal(packet.knowledge.candidateComplements.length,1);
 assert.deepEqual(packet.evidence.map(e=>e.text).sort(),bindings.slice(0,2).map(s=>s.text).sort());
 assert.ok(packet.knowledge.items.every(i=>i.support!=='supported'&&i.validity==='unknown'));
 assert.equal(packet.context.requiresAbstention,true);assert.equal(packet.context.executionAuthority,false);
 assert.equal(packet.context.coverage.discovery.acceptedSeeds,1);assert.equal(packet.bytes,Buffer.byteLength(JSON.stringify(packet)));
 assert.ok(embeddingCalls>=6);assert.ok(packet.backends.filter(b=>b.channel==='semantic_full_text').every(b=>['ok','no_match'].includes(b.status)));
});

test('discovery provenance is snapshot-bound and page budget never splits its adverse component',async()=>{
 const {snapshot}=readSnapshot(packet.context.snapshot.id);
 assert.equal(snapshot.discovery.seeds[0].sourceId,bindings[0].id);assert.equal(snapshot.discovery.seeds[0].revision,bindings[0].revision);
 assert.equal(snapshot.discovery.seeds[0].caseHash,bindings[0].caseHash);assert.equal(snapshot.discovery.seeds[0].projectionId,projection.projectionId);
 assert.equal(Object.hasOwn(packet.knowledge,'contextDiscovery'),false);
 const input={id:packet.context.snapshot.id,conversationIds:ids,limit:1};const page=await contextPage(input);
 assert.equal(page.items.length,1);assert.equal(page.items[0].kind,'semantic');assert.equal(page.evidence.length,2);
 assert.deepEqual(page,await contextPage(input));assert.equal(page.bytes,Buffer.byteLength(JSON.stringify(page)));
 const small=await contextPage({...input,maxBytes:4096});assert.equal(small.items.length,0);assert.equal(small.evidence.length,0);assert.equal(small.omissions[0].reason,'whole_context_exceeds_page_budget');
 await assert.rejects(retrievePackage(question,ids,{mode:'semantic',knownAt,maxBytes:9000},deps),/PACKAGE_METADATA_EXCEEDS_BUDGET/);
 const budget=12000,limited=await retrievePackage(question,ids,{mode:'semantic',knownAt,maxBytes:budget},deps);
 assert.ok(limited.bytes<=budget);assert.equal(limited.knowledge.items.length,0);assert.equal(limited.evidence.length,0);assert.ok(limited.context.omissions>0);
 assert.deepEqual(limited.context.coverage.discovery,packet.context.coverage.discovery);
 const boundary=await retrievePackage(question,ids,{mode:'semantic',knownAt,maxBytes:16000},deps);
 assert.ok(boundary.bytes<=16000);assert.equal(boundary.knowledge.items.length,2);assert.equal(boundary.evidence.length,2);
});

test('global seed order, duplicates, omissions, budgets and exact identity checks are deterministic',()=>{
 const seeds=Array.from({length:70},(_,i)=>({sourceId:'rep-'+String(i).padStart(3,'0'),revision:hash('payload'+i),caseHash:hash('case'+i),conversationId:'conversation-'+i,projectionId:'sem-fixture',similarity:1-i/200}));
 const first=contextDiscovery([...seeds,seeds[0]],['deadline','plazo']);assert.deepEqual(contextDiscovery([...seeds].reverse(),['deadline','plazo']),first);
 assert.equal(first.candidateCount,70);assert.equal(first.seeds.length,60);assert.equal(first.omittedSeeds,10);assert.equal(contextDiscovery([],['deadline']),null);
 assert.throws(()=>contextDiscovery(Array(1201).fill(seeds[0])),/CANDIDATE_BUDGET/);
 const source={id:seeds[0].sourceId,revision:seeds[0].revision,conversationId:seeds[0].conversationId,caseHash:seeds[0].caseHash};
 const one=contextDiscovery([seeds[0]]);assert.equal(validateDiscovery(one,[source]),one);
 for(const field of ['sourceId','revision','caseHash','conversationId'])assert.throws(()=>validateDiscovery({...one,seeds:[{...seeds[0],[field]:field==='sourceId'?'unknown':'0'.repeat(64)}]},[source]),/CONTEXT_DISCOVERY/);
 const message={id:'event',representationId:source.id,payloadSha256:source.revision,text:'😀abc'};
 const hit={id:'event',semanticText:'abc',semanticRange:{start:1,end:4,rangeUnit:'unicode_codepoints',representationId:source.id},explanation:{projectionId:'sem-fixture',cosineSimilarity:.9}};
 const result={projectionId:'sem-fixture',results:[hit]};assert.equal(semanticSeeds(result,[message],source)[0].sourceId,source.id);
 for(const range of [{...hit.semanticRange,start:2},{...hit.semanticRange,representationId:'wrong'},{...hit.semanticRange,end:5}])assert.throws(()=>semanticSeeds({...result,results:[{...hit,semanticRange:range}]},[message],source),/CONTEXT_DISCOVERY/);
});

test('selection recheck rejects forged seed bindings before crossing the semantic bridge',async()=>{
 const {snapshot}=readSnapshot(packet.context.snapshot.id),seed=snapshot.discovery.seeds[0],d=contextDiscovery([seed]);
 for(const field of ['caseHash','revision','conversationId','sourceId']){
  const forged={...d,seeds:[{...seed,[field]:'0'.repeat(64)}]};
  await assert.rejects(op('context_query',ids,{question,knownAt,discovery:forged}),/CONTEXT_DISCOVERY/);
 }
});

test('wrong model identity and changed projection cannot become semantic clause seeds',async()=>{
 const before=embeddingCalls,wrong={...provider,identity:{...provider.identity,revision:'different'}};
 const mismatch=await retrievePackage(question,ids,{mode:'semantic',knownAt},{embeddingProvider:async()=>wrong});
 assert.equal(embeddingCalls,before);assert.equal(mismatch.knowledge.items.length,0);assert.equal(mismatch.context.coverage.discovery,undefined);
 assert.ok(mismatch.backends.filter(b=>b.channel==='semantic_full_text').every(b=>b.status==='unavailable'));
 const file=path.join(projection.projectionDir,'semantic.sqlite'),raw=fs.readFileSync(file);fs.appendFileSync(file,'tampered');
 try{const changed=await retrievePackage(question,ids,{mode:'semantic',knownAt},deps);assert.equal(changed.knowledge.items.length,0);assert.equal(changed.context.coverage.discovery,undefined);assert.equal(changed.backends.find(b=>b.conversationId===ids[0]&&b.channel==='semantic_full_text').status,'unavailable');}
 finally{fs.writeFileSync(file,raw);}
});

test('original changed during embedding fails final evidence verification',async()=>{
 const file=path.join(library.find(i=>i.id===ids[0]).path,'acquisition/original.bin'),raw=fs.readFileSync(file);let changed=false;
 const drifting={...provider,async embed(texts){if(!changed){changed=true;fs.appendFileSync(file,' changed');}return provider.embed(texts);}};
 try{await assert.rejects(retrievePackage(question,ids,{mode:'semantic',knownAt},{embeddingProvider:async()=>drifting}),/Integridad|SOURCE_CHANGED|EVIDENCE_CHANGED/);assert.equal(changed,true);}
 finally{fs.writeFileSync(file,raw);}
});

test('public HTTP options cannot inject discovery and internal context operation is not exposed',async t=>{
 const {snapshot}=readSnapshot(packet.context.snapshot.id),injected=contextDiscovery(snapshot.discovery.seeds);
 assert.deepEqual(await retrievePackage(question,ids,{mode:'lexical',knownAt,discovery:injected,_discovery_hints:['Alfa'],_discovery_refs:[bindings[0]]},deps),lexical);
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.AFH_COSMOS_PORT=String(port);
 const {server}=await import('./server.mjs');await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+port;
 const post=async(route,body)=>{const response=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 const response=await post('/api/retrieve',{question,conversationIds:ids,retrieval:{mode:'lexical',knownAt,discovery:injected,embeddingProvider:{},_discovery_hints:['Alfa']}});
 assert.equal(response.status,200,JSON.stringify(response.body));assert.deepEqual(response.body,lexical);
 const denied=await post('/api/semantic',{op:'context_query',question,conversationIds:ids,discovery:injected});assert.equal(denied.status,400);
});

test('verified growing-capture alias discovers the old clause with current original and exact witness',async()=>{
 const job='a12-'+randomUUID(),head=JSON.stringify({timestamp:'2026-10-22T10:00:00Z',type:'session_meta',payload:{id:randomUUID(),cwd:'C:/synthetic-a12'}})+'\n';
 const line=(id,text)=>JSON.stringify({timestamp:'2026-10-22T10:00:01Z',type:'response_item',payload:{type:'message',id,role:'user',content:[{type:'input_text',text}]}})+'\n';
 const bytes=Buffer.from(head+line('first','Permito activar Zeta tras revisar los controles.'));
 const old=await importCapturedRevision({id:'capture-'+randomUUID(),bytes,title:'A12 old',captureJob:job,revisionHash:hash(bytes)});
 const source=(await verifiedSources([old.id])).sources.find(s=>s.text.startsWith('Permito'));const record=await extract([old.id],source,'capture-rule',{project:'Zeta'});
 const later=Buffer.concat([bytes,Buffer.from(line('second','Neptuno continúa distante.'))]);
 const current=await importCapturedRevision({id:'capture-'+randomUUID(),bytes:later,title:'A12 current',captureJob:job,revisionHash:hash(later)});
 const context=await verifiedSources([current.id]);assert.ok(context.aliases.some(a=>a.sourceId===source.id));
 await buildSemanticIndex(library.find(i=>i.id===current.id).path,{provider,representation:'full_source_text'});
 const result=await retrievePackage(question,[current.id],{mode:'semantic',knownAt:record.recorded_at},deps);
 assert.equal(result.knowledge.items.length,1);assert.equal(result.knowledge.items[0].clauseVersionId,record.payload.semantic_unit.clauses[0].clause_version_id);
 assert.ok(result.evidence.every(e=>e.conversationId===current.id));
 const retained=readSnapshot(result.context.snapshot.id).snapshot;
 assert.equal(retained.discovery.aliases[0].sourceId,source.id);assert.equal(retained.discovery.aliases[0].witness.conversationId,old.id);
});

test('two real full-text projections share one global seed budget with explicit omitted count',async()=>{
 const selected=[];
 for(let n=0;n<2;n++){
  const mapping=Object.fromEntries(Array.from({length:40},(_,i)=>{const id='m'+i;return [id,{id,parent:i?'m'+(i-1):null,children:i<39?['m'+(i+1)]:[],message:{id,author:{role:'user'},content:{content_type:'text',parts:['Permito activar un elemento '+n+' '+i+'.']}}}];}));
  const item=await addSource({filename:'many-'+n+'.json',content:JSON.stringify({id:'many-'+n,title:'Many '+n,current_node:'m39',mapping})});selected.push(item.id);
  await buildSemanticIndex(library.find(i=>i.id===item.id).path,{provider,representation:'full_source_text'});
 }
 const result=await retrievePackage(question,selected,{mode:'semantic'},deps);
 assert.deepEqual(result.backends.filter(b=>b.channel==='semantic_full_text').map(b=>b.candidates),[40,40]);
 assert.equal(result.context.coverage.discovery.candidateCount,80);assert.equal(result.context.coverage.discovery.acceptedSeeds,60);assert.equal(result.context.coverage.discovery.omittedSeeds,20);
 assert.equal(readSnapshot(result.context.snapshot.id).snapshot.discovery.seeds.length,60);assert.equal(result.bytes,Buffer.byteLength(JSON.stringify(result)));
});

test('restore and new process preserve discovery receipt, cursor and exact evidence',async()=>{
 const input={id:packet.context.snapshot.id,conversationIds:ids,limit:1},before=await contextPage(input);
 const {createBackup,restoreBackup}=await import('./recovery.mjs');
 const parent=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-discovery-restore-')),archive=path.join(parent,'fixture.orbita'),destination=path.join(parent,'restored');
 await createBackup({source:root,archive,password:'a12-synthetic-test-only',ownSession:true});await restoreBackup({archive,destination,password:'a12-synthetic-test-only'});
 const request=path.join(parent,'request.json');fs.writeFileSync(request,JSON.stringify(input));
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./memory-cli.mjs',import.meta.url)),'context-page',request],{env:{...process.env,AFH_COSMOS_DATA:destination},encoding:'utf8',windowsHide:true,timeout:60000});
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),before);
 const relative=path.join('context-queries',packet.context.snapshot.id,'snapshot.json');assert.deepEqual(fs.readFileSync(path.join(destination,relative)),fs.readFileSync(path.join(root,relative)));
});

import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {exportConversation,userText,resultText,decisionFixture} from './decision-fixture.mjs';
import {supportFixture} from './support-fixture.mjs';import {collectiveFixture} from './collective-fixture.mjs';
import {projectContext,publicGraph,nodeIdentity,neighborhood} from './web/explorer-model.mjs';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-explorer-'));process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {addSource,library}=await import('./corpus.mjs');const {retrievePackage,closeMemory}=await import('./memory.mjs');const {explorer}=await import('./explorer.mjs');const {supportOperation,supportSources}=await import('./justifications.mjs');const {decisionOperation}=await import('./decisions.mjs');const {collectiveOperation}=await import('./collectives.mjs');
let ids=[],sources,packet,page,group,support,historyNode,groupPage;
const call=(op,extra={})=>explorer({op,id:packet.context.snapshot.id,conversationIds:ids,...extra});
before(async()=>{
 for(const [id,text,role] of [['u',userText,'user'],['r',resultText,'tool'],['r2','Segunda comprobación: doce archivos con hashes idénticos.','tool']])ids.push((await addSource(exportConversation('f45-'+id,text,role))).id);
 sources=await supportSources(ids);const u=sources.find(s=>s.text===userText),r=sources.find(s=>s.text===resultText);
 const decision=(await decisionOperation('frame',{conversationIds:ids,id:'copy',case:decisionFixture(sources),actor:'test',statement:'Encuadre sintético',requestId:'frame'})).reference;
 support=await supportOperation('put',{conversationIds:ids,id:'first',detail:supportFixture(decision,r,u),requestId:'first'});
 support=await supportOperation('put',{conversationIds:ids,id:'first',expectedVersion:1,binding:support.reference,detail:{...supportFixture(decision,r,u),state:'withdrawn',reason:'Retirada declarada de prueba'},requestId:'withdraw-version'});
 await supportOperation('put',{conversationIds:ids,id:'second',detail:supportFixture(decision,r,u),requestId:'second'});
 group=await collectiveOperation('put',{conversationIds:ids,id:'copies',detail:collectiveFixture(sources),requestId:'group'});
 group=await collectiveOperation('put',{conversationIds:ids,id:'copies',expectedVersion:1,binding:group.reference,detail:{...collectiveFixture(sources),title:'Contexto de copia actualizado',reason:'Revisar título'},requestId:'group2'});
 packet=await retrievePackage('¿Qué decisión y contexto de copia conserva los originales y qué sustento tiene?',ids,{mode:'lexical'});
 page=await call('page');historyNode=page.graph.nodes.find(n=>n.kind==='justification'&&n.reference.id==='first');
 let p=page;while(p){if(p.unit?.kind==='collective')groupPage=p;p=p.nextCursor?await call('page',{cursor:p.nextCursor}):null;}
});
after(()=>closeMemory());
test('F45 projects all alternatives and withdrawn support without claiming truth or doubling source identity',()=>{
 assert.equal(page.unit.kind,'decision');assert.equal(page.graph.nodes.filter(n=>n.kind==='alternative').length,2);assert.equal(page.graph.nodes.filter(n=>n.kind==='justification').length,2);
 assert.ok(historyNode);assert.equal(historyNode.recordState,'withdrawn');assert.equal(page.executionAuthority,false);assert.equal(page.completeness,'not_certified');assert.equal(page.freshness.current,true);
 const originals=page.graph.nodes.filter(n=>n.kind==='source');assert.equal(new Set(originals.map(n=>n.id)).size,originals.length);assert.ok(!JSON.stringify(page).includes(userText));assert.equal(page.bytes,Buffer.byteLength(JSON.stringify(page)));
});
test('F45 collective membership has named roles and no participant-to-participant edges or implied AND',()=>{
 const g=groupPage.graph;assert.equal(g.groups.length,1);assert.equal(g.groups[0].logic,'none');assert.equal(g.edges.filter(e=>e.kind==='membership').length,2);
 const members=new Set(g.groups[0].members);assert.ok(g.edges.every(e=>!(members.has(e.from)&&members.has(e.to))));assert.deepEqual(g.edges.filter(e=>e.kind==='membership').map(e=>e.label),['request','observation']);
});
test('F45 exact identity includes version and digest; lexical complement hints never become graph edges',()=>{
 assert.notEqual(nodeIdentity('collective',{id:'x',version:1,digest:'a'}),nodeIdentity('collective',{id:'x',version:2,digest:'a'}));assert.notEqual(nodeIdentity('collective',{id:'x',version:1,digest:'a'}),nodeIdentity('collective',{id:'x',version:1,digest:'b'}));
 const unit={kind:'semantic',data:{items:['a','b','c'].map((id,i)=>({clauseVersionId:id,recordId:'r'+i,recordVersion:1,text:id,support:'pending',validity:'unknown',sourceRefs:[]})),edges:[{from:'b',to:'a',kind:'exception'},{from:'c',to:'a',kind:'retracts'}],candidateComplements:[{version:'b',relationEstablished:false}]}};
 const g=projectContext(unit);assert.equal(g.edges.length,2);assert.equal(g.edges[1].kind,'retracts');assert.equal(g.nodes[0].validity,'unknown');assert.equal(publicGraph(g,{maxNodes:2}).nodes.length,0);assert.equal(publicGraph(g,{maxNodes:2}).limited,true);
});
test('F45 neighborhoods and list projections expose hidden counts and remain bounded',()=>{
 const focus=page.graph.rootId,view=neighborhood(page.graph,focus,0,1);assert.equal(view.nodes.length,2);assert.ok(view.total>=2);assert.equal(view.remaining,view.total-1);assert.equal(neighborhood(page.graph,'absent').nodes.length,0);
});
test('F45 cursor resumes same cut and budget; another selection, tamper or unknown operation is rejected',async()=>{
 assert.deepEqual(await call('page'),page);assert.ok(page.nextCursor);
 const next=await call('page',{cursor:page.nextCursor});assert.deepEqual(await call('page',{cursor:next.previousCursor}),page);
 await assert.rejects(call('page',{cursor:page.nextCursor,maxBytes:4096}),/CURSOR_BINDING/);
 await assert.rejects(call('page',{cursor:page.nextCursor.slice(0,-1)+'z'}),/CURSOR/);
 await assert.rejects(call('page',{conversationIds:ids.slice(1)}),/SELECTION_MISMATCH/);
 await assert.rejects(call('invented'),/EXPLORER_OPERATION/);
});
test('F45 budget discloses an oversized graph as a whole and does not discard adverse edges selectively',async()=>{
 const small=await call('page',{maxBytes:4096});assert.ok(small.bytes<=4096);assert.equal(small.graph.limited,true);assert.equal(small.graph.nodes.length,0);assert.ok(small.graph.counts.nodes>0);assert.ok(small.warnings.length);
});
test('F45 inspector and complete original are restricted to exact members of the frozen unit',async()=>{
 const node=page.graph.nodes.find(n=>n.originalKey),data=await call('inspect',{unitId:page.unit.id,nodeId:historyNode.id});assert.equal(data.node.reference.version,2);
 const original=await call('original',{unitId:page.unit.id,originalKey:node.originalKey});assert.ok([userText,resultText,sources[2].text].includes(original.original.text));assert.equal(original.original.verified,true);
 await assert.rejects(call('inspect',{unitId:page.unit.id,nodeId:'other'}),/NODE_NOT_IN_UNIT/);await assert.rejects(call('original',{unitId:page.unit.id,originalKey:'other'}),/ORIGINAL_NOT_IN_UNIT/);
});
test('F45 evolution preserves earlier support versions and source-bound withdrawal reasons',async()=>{
 const input={unitId:page.unit.id,nodeId:historyNode.id},h=await call('history',input);assert.deepEqual(h.items.map(i=>i.reference.version),[1,2]);assert.equal(h.items[1].state,'withdrawn');assert.equal(h.items[1].reason,'Retirada declarada de prueba');
 const version=await call('version',{...input,version:1});assert.equal(version.record.payload.support.detail.state,'active');assert.ok(version.sourceBindings.length);
 const original=await call('original',{...input,version:1,sourceId:version.sourceBindings[0].id});assert.equal(original.original.verified,true);
 await assert.rejects(call('version',{...input,version:3}),/VERSION_NOT_AT_CUT/);await assert.rejects(call('original',{...input,version:1,sourceId:'unknown'}),/ORIGINAL_NOT_IN_VERSION/);
});
test('F45 decision and collective histories preserve exact version identity at the query cut',async()=>{
 const h=await call('history',{unitId:page.unit.id,nodeId:page.graph.rootId});assert.equal(h.items[0].reference.caseId,'copy');assert.equal(h.items.length,1);
 const c=await call('history',{unitId:groupPage.unit.id,nodeId:groupPage.graph.rootId});assert.deepEqual(c.items.map(x=>x.reference.version),[1,2]);
});
test('F45 later revisions mark a retained map stale without leaking version 3 into its evolution',async()=>{
 group=await collectiveOperation('put',{conversationIds:ids,id:'copies',expectedVersion:2,binding:group.reference,detail:{...collectiveFixture(sources),title:'Cambio posterior al corte'},requestId:'group3'});
 const stale=await call('page');assert.equal(stale.status,'stale_cut');assert.deepEqual(stale.graph,page.graph);
 const history=await call('history',{unitId:groupPage.unit.id,nodeId:groupPage.graph.rootId});assert.deepEqual(history.items.map(x=>x.reference.version),[1,2]);assert.equal(history.freshness.current,false);
 const fresh=await retrievePackage(packet.query,ids,{mode:'lexical'});assert.notEqual(fresh.context.snapshot.id,packet.context.snapshot.id);
 const historical=await retrievePackage(packet.query,ids,{mode:'lexical',knownAt:packet.context.cut.knownAt,validAt:packet.context.cut.validAt});let p=await explorer({id:historical.context.snapshot.id,conversationIds:ids});while(p.unit?.kind!=='collective'&&p.nextCursor)p=await explorer({id:historical.context.snapshot.id,conversationIds:ids,cursor:p.nextCursor});assert.equal(p.graph.nodes.find(n=>n.kind==='collective'&&n.hasHistory).reference.version,2);assert.equal(p.cut.mode,'historical');
});
test('F45 tampered originals fail closed even when the map snapshot itself is intact',async()=>{
 const item=library.find(i=>i.id===ids[0]),file=path.join(item.path,'acquisition/original.bin'),raw=fs.readFileSync(file);fs.appendFileSync(file,' changed');try{await assert.rejects(call('page'),/Integridad/);}finally{fs.writeFileSync(file,raw);}
});
test('F45 HTTP, CLI and browser module use the same bounded explorer service',async t=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.AFH_COSMOS_PORT=String(port);const {server}=await import('./server.mjs');await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const input={id:packet.context.snapshot.id,conversationIds:ids},r=await fetch('http://127.0.0.1:'+port+'/api/explorer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});assert.equal(r.status,200);assert.deepEqual(await r.json(),await explorer(input));
 for(const asset of ['explorer-web.mjs','explorer-model.mjs','explorer.css']){const response=await fetch('http://127.0.0.1:'+port+'/'+asset);assert.equal(response.status,200,asset);assert.match(response.headers.get('content-type'),asset.endsWith('css')?/text\/css/:/text\/javascript/);assert.doesNotMatch(response.headers.get('content-security-policy'),/unsafe-inline|unsafe-eval/);}
 const request=path.join(root,'explorer-request.json');fs.writeFileSync(request,JSON.stringify(input));const cli=fileURLToPath(new URL('./memory-cli.mjs',import.meta.url));const run=spawnSync(process.execPath,[cli,'explorer',request],{env:process.env,encoding:'utf8',timeout:60000,windowsHide:true});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),await explorer(input));
});
test('F45 integral restore reproduces map, exact evolution and cursors in a new process',async()=>{
 const {createBackup,restoreBackup}=await import('./recovery.mjs');const lab=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-explorer-restore-'));const archive=path.join(lab,'archive.orbita'),destination=path.join(lab,'restored');
 const requests=[{id:packet.context.snapshot.id,conversationIds:ids},{id:packet.context.snapshot.id,conversationIds:ids,op:'history',unitId:page.unit.id,nodeId:historyNode.id}];const before=await Promise.all(requests.map(explorer));
 await createBackup({source:root,archive,password:'f45-synthetic-test-only',ownSession:true});await restoreBackup({archive,destination,password:'f45-synthetic-test-only'});
 const script=path.join(lab,'read.mjs');fs.writeFileSync(script,`import {explorer} from ${JSON.stringify(new URL('./explorer.mjs',import.meta.url).href)};console.log(JSON.stringify(await Promise.all(${JSON.stringify(requests)}.map(explorer))));`);
 const result=spawnSync(process.execPath,[script],{env:{...process.env,AFH_COSMOS_DATA:destination},encoding:'utf8',timeout:60000,windowsHide:true});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),before);
});

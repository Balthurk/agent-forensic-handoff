import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {exportConversation} from './decision-fixture.mjs';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-identities-'));process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {addSource,library}=await import('./corpus.mjs');const {identityOperation}=await import('./identities.mjs');const {retrievePackage,closeMemory}=await import('./memory.mjs');const {explorer}=await import('./explorer.mjs');
let ids=[],source,a,b,link,page,packet,map;
const text='Fixture sintético: Órbita y Orbita son nombres del mismo proyecto en el directorio local. Beta es otro proyecto. Desde 2026-01-01 hasta 2027-01-01. No es una identidad autenticada.';
const call=(op,input={})=>identityOperation(op,{conversationIds:ids,...input});
before(async()=>{
 ids.push((await addSource(exportConversation('f28-a',text))).id);ids.push((await addSource(exportConversation('f28-b','Otra fuente seleccionada, independiente de la comparación.'))).id);
 source=(await call('sources',{question:'Fixture'})).items[0];const evidence=[{sourceId:source.id,quote:text}];
 const entity=label=>({label,aliases:[],entityType:'project',namespace:'local',origin:null,state:'active',actor:'test',reason:'Registro sintético',evidence});
 a=await call('put',{kind:'entity',id:'a',detail:entity('Órbita'),requestId:'a'});b=await call('put',{kind:'entity',id:'b',detail:entity('Orbita'),requestId:'b'});
 page=await call('query',{view:'entities',limit:1});
 link=await call('put',{kind:'link',detail:{left:a.reference,right:b.reference,judgment:'same',temporal:{eventAt:null,validFrom:'2026-01-01T00:00:00Z',validTo:'2027-01-01T00:00:00Z',endOpen:false,evidence},state:'active',actor:'test',reason:'Comparación sintética',evidence},requestId:'link'});
 packet=await retrievePackage('¿Qué identidad y alias tiene Órbita?',ids,{mode:'lexical',validAt:'2026-06-01T00:00:00Z',maxBytes:150000});map=await explorer({id:packet.context.snapshot.id,conversationIds:ids});
});
after(()=>closeMemory());
test('F28 whole snapshots bind selection, cut, cursor and budget and expose staleness',async()=>{
 assert.ok(page.nextCursor);assert.equal(page.bytes,Buffer.byteLength(JSON.stringify(page)));const next=await call('page',{snapshotId:page.snapshotId,cursor:page.nextCursor,limit:1});assert.notEqual(next.items[0].reference.id,page.items[0].reference.id);assert.equal(next.freshness.current,false);assert.equal(next.knownAt,page.knownAt);
 await assert.rejects(call('page',{snapshotId:page.snapshotId,cursor:page.nextCursor,limit:2}),/CURSOR_BINDING/);await assert.rejects(call('page',{snapshotId:page.snapshotId,conversationIds:ids.slice(1)}),/SELECTION_MISMATCH/);await assert.rejects(call('page',{snapshotId:page.snapshotId,cursor:page.nextCursor+'x',limit:1}),/CURSOR/);
});
test('F28 context and explorer recover exact identities, explicit review and originals',async()=>{
 assert.equal(map.unit.kind,'identity');assert.equal(map.graph.nodes.filter(n=>n.kind==='identity').length,2);assert.equal(map.graph.nodes.filter(n=>n.kind==='identity_review').length,1);assert.ok(map.graph.edges.every(e=>e.kind!=='name_match'));assert.equal(map.graph.groups.length,1);assert.equal(map.executionAuthority,false);assert.ok(packet.context.requiresAbstention);
 const review=map.graph.nodes.find(n=>n.kind==='identity_review'),h=await explorer({op:'history',id:packet.context.snapshot.id,conversationIds:ids,unitId:map.unit.id,nodeId:review.id});assert.equal(h.items.length,1);assert.equal(h.items[0].reference.digest,link.reference.digest);
});
test('F28 originals cannot be substituted or requested outside a snapshot item',async()=>{
 const q=await call('query',{view:'entities'}),v=await call('original',{snapshotId:q.snapshotId,index:0,sourceId:source.id});assert.equal(v.original.text,text);
 await assert.rejects(call('original',{snapshotId:q.snapshotId,index:0,sourceId:'other'}),/ORIGINAL_NOT_IN_ITEM/);
 const small=await call('query',{view:'links',maxBytes:4096});assert.ok(small.bytes<=4096);assert.equal(small.items.length,0);assert.ok(small.omissions.length);
});
test('F28 undo is append-only and old snapshots never silently become current',async()=>{
 const old=await call('query',{view:'groups',validAt:'2026-06-01T00:00:00Z'});assert.equal(old.items.length,1);
 link=await call('put',{kind:'link',expectedVersion:1,binding:link.reference,detail:{...link.record.payload.identity.detail,state:'withdrawn',reason:'Deshacer comparación de prueba'},requestId:'undo'});
 const fresh=await call('query',{view:'groups',validAt:'2026-06-01T00:00:00Z'});assert.equal(fresh.total,0);const retained=await call('page',{snapshotId:old.snapshotId});assert.equal(retained.items.length,1);assert.equal(retained.status,'stale_cut');assert.equal((await call('history',{kind:'link',id:link.reference.id})).length,2);
 const p=await explorer({id:packet.context.snapshot.id,conversationIds:ids});assert.equal(p.freshness.current,false);assert.deepEqual(p.graph,map.graph);
});
test('F28 HTTP assets and CLI use the same service and enforce origin',async t=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.AFH_COSMOS_PORT=String(port);const {server}=await import('./server.mjs');await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const request={op:'page',conversationIds:ids,snapshotId:page.snapshotId,limit:1},url='http://127.0.0.1:'+port;
 const http=await fetch(url+'/api/identities',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});assert.equal(http.status,200);assert.deepEqual(await http.json(),await call('page',request));
 const denied=await fetch(url+'/api/identities',{method:'POST',headers:{origin:'https://other.invalid','content-type':'application/json'},body:JSON.stringify(request)});assert.equal(denied.status,403);
 for(const asset of ['identities-web.mjs','identities.css']){const response=await fetch(url+'/'+asset);assert.equal(response.status,200);assert.doesNotMatch(response.headers.get('content-security-policy'),/unsafe-inline|unsafe-eval/);}
 const file=path.join(root,'identity-request.json');fs.writeFileSync(file,JSON.stringify(request));const run=spawnSync(process.execPath,[fileURLToPath(new URL('./memory-cli.mjs',import.meta.url)),'identities',file],{env:process.env,encoding:'utf8',timeout:60000,windowsHide:true});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),await call('page',request));
});
test('F28 integral restore reproduces cursor, history and context projection in a fresh process',async()=>{
 const {createBackup,restoreBackup}=await import('./recovery.mjs');const lab=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-identity-restore-')),archive=path.join(lab,'all.orbita'),destination=path.join(lab,'restored');
 const requests=[{op:'page',snapshotId:page.snapshotId,cursor:page.nextCursor,limit:1,conversationIds:ids},{op:'history',kind:'link',id:link.reference.id,conversationIds:ids}],before=await Promise.all(requests.map(r=>identityOperation(r.op,r)));
 await createBackup({source:root,archive,password:'synthetic-f28-only',ownSession:true});await restoreBackup({archive,destination,password:'synthetic-f28-only'});
 const script=path.join(lab,'fresh.mjs');fs.writeFileSync(script,`import {identityOperation} from ${JSON.stringify(new URL('./identities.mjs',import.meta.url).href)};console.log(JSON.stringify(await Promise.all(${JSON.stringify(requests)}.map(r=>identityOperation(r.op,r)))));`);
 const result=spawnSync(process.execPath,[script],{env:{...process.env,AFH_COSMOS_DATA:destination},encoding:'utf8',timeout:60000,windowsHide:true});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),before);
});
test('F28 tampered source and tampered retained projection fail closed',async()=>{
 const file=path.join(library.find(i=>i.id===ids[0]).path,'acquisition/original.bin'),raw=fs.readFileSync(file);fs.appendFileSync(file,'bad');try{await assert.rejects(call('page',{snapshotId:page.snapshotId}),/Integridad/);}finally{fs.writeFileSync(file,raw);}
 const snap=path.join(root,'identity-queries',page.snapshotId,'snapshot.json'),bytes=fs.readFileSync(snap);fs.appendFileSync(snap,' ');try{await assert.rejects(call('page',{snapshotId:page.snapshotId}),/SNAPSHOT_INTEGRITY/);}finally{fs.writeFileSync(snap,bytes);}
});

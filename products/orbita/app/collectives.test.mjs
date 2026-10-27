import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {exportConversation} from './decision-fixture.mjs';import {collectiveFixture} from './collective-fixture.mjs';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','collective-'));process.env.AFH_COSMOS_DATA=path.join(root,'data');process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.AFH_COSMOS_PORT=String(port);
const {addSource}=await import('./corpus.mjs');const {collectiveOperation,collectiveSources}=await import('./collectives.mjs');
const ids=[(await addSource(exportConversation('u','Conservar originales.'))).id,(await addSource(exportConversation('t','Copia revisada.','tool'))).id];const sources=await collectiveSources(ids),detail=collectiveFixture(sources);
const call=(op,input={})=>collectiveOperation(op,{conversationIds:ids,...input});
test('F43 exact source revisions, distinct identities, concurrent CAS and preserved history',async()=>{
 const a=await call('put',{id:'a',detail,requestId:'a'});await call('put',{id:'b',detail,requestId:'b'});
 const results=await Promise.allSettled(['c1','c2'].map(requestId=>call('put',{id:'a',detail:{...detail,reason:requestId},expectedVersion:1,binding:a.reference,requestId})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/VERSION_CONFLICT/);
 const h=await call('history',{id:'a'});assert.equal(h.length,2);assert.deepEqual(h[0].record,a.record);
 const p=await call('query');assert.equal(p.items.length,2);assert.deepEqual(p.binaryEdges,[]);assert.equal(p.bytes,Buffer.byteLength(JSON.stringify(p)));
});
test('F43 REST route, origin guard and UI modules',async t=>{
 const {server}=await import('./server.mjs');await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+port;const post=(body,headers={})=>fetch(url+'/api/collectives',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const r=await post({op:'query',conversationIds:ids});assert.equal(r.status,200);assert.equal((await r.json()).items.length,2);
 assert.equal((await post({op:'query',conversationIds:ids},{origin:'https://invalid.example'})).status,403);
 assert.match(await(await fetch(url)).text(),/collectives-web.mjs/);assert.equal((await fetch(url+'/collectives-web.mjs')).status,200);
});
test('F43 full restore retains relations and a fresh process resolves originals',async()=>{
 const {createBackup,restoreBackup}=await import('./recovery.mjs');const archive=path.join(root,'backup.orbita'),destination=path.join(root,'restored');
 const before=await call('get',{id:'a'});await createBackup({source:process.env.AFH_COSMOS_DATA,archive,password:'collective-regression-only',ownSession:true});await restoreBackup({archive,destination,password:'collective-regression-only'});
 const code=`import {collectiveOperation} from ${JSON.stringify(pathToFileURL(path.resolve('app/collectives.mjs')).href)};console.log(JSON.stringify(await collectiveOperation('get',{conversationIds:${JSON.stringify(ids)},id:'a'})));`;
 const restored=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,AFH_COSMOS_DATA:destination},encoding:'utf8'}));assert.deepEqual(restored.reference,before.reference);assert.deepEqual(restored.record,before.record);
});

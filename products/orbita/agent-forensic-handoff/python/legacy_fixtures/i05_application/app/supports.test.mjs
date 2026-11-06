import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {exportConversation,userText,resultText,decisionFixture} from './decision-fixture.mjs';import {supportFixture} from './support-fixture.mjs';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','support-'));process.env.AFH_COSMOS_DATA=path.join(root,'data');process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.AFH_COSMOS_PORT=String(port);
const {addSource}=await import('./corpus.mjs');const {decisionOperation}=await import('./decisions.mjs');const {supportOperation,supportSources}=await import('./justifications.mjs');
const ids=[];for(const [id,text,role] of [['u',userText,'user'],['e1',resultText,'tool'],['e2','Segunda comprobación: doce archivos con hashes idénticos.','tool']])ids.push((await addSource(exportConversation(id,text,role))).id);
const sources=await supportSources(ids),u=sources.find(s=>s.text===userText),e1=sources.find(s=>s.text===resultText),e2=sources.find(s=>s.text.startsWith('Segunda'));
const decision=(await decisionOperation('frame',{conversationIds:ids,id:'copy',case:decisionFixture(sources),actor:'test',statement:'Encuadre de regresión',requestId:'case'})).reference;
const call=(op,input={})=>supportOperation(op,{conversationIds:ids,...input});
test('F44 withdrawal leaves alternative intact, exact decision unchanged and durable replay fixed to its cut',async()=>{
 await call('put',{id:'one',detail:supportFixture(decision,e1,u),requestId:'one'});await call('put',{id:'two',detail:supportFixture(decision,e2,u),requestId:'two'});
 const before=await call('review',{decision,alternativeId:'local',requestId:'review-before'});assert.equal(before.result.state,'supported');
 await call('impact',{detail:{target:{kind:'source',id:e1.id,revision:e1.revision},judgment:'withdrawn',actor:'test',reason:'Retirar prueba uno',evidence:[{sourceId:u.id,quote:userText}]},requestId:'withdraw'});
 const after=await call('evaluate',{decision,alternativeId:'local'});assert.equal(after.state,'supported');assert.deepEqual(after.items.map(x=>x.state).sort(),['pending','supported']);assert.equal(after.bytes,Buffer.byteLength(JSON.stringify(after)));
 const replay=await call('review',{decision,alternativeId:'local',requestId:'review-before'});assert.deepEqual(replay.record,before.record);
 assert.deepEqual((await decisionOperation('get',{conversationIds:ids,id:'copy'})).reference,decision);
});
test('F44 HTTP and visible app entry use the same support service',async t=>{
 const {server}=await import('./server.mjs');await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+port;const r=await fetch(url+'/api/supports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'evaluate',conversationIds:ids,decision,alternativeId:'local'})});assert.equal(r.status,200);assert.equal((await r.json()).state,'supported');assert.equal((await fetch(url+'/supports-web.mjs')).status,200);assert.match(await(await fetch(url)).text(),/supports-web.mjs/);
});
test('F44 full restore reopens exact decisions, justifications, impacts and review receipts in a fresh process',async()=>{
 const {createBackup,restoreBackup}=await import('./recovery.mjs');const archive=path.join(root,'backup.orbita'),destination=path.join(root,'restored');
 const before=await call('evaluate',{decision,alternativeId:'local',knownAt:'2030-01-01T00:00:00Z',validAt:'2026-10-23T00:00:00Z'});await createBackup({source:process.env.AFH_COSMOS_DATA,archive,password:'support-test-only',ownSession:true});await restoreBackup({archive,destination,password:'support-test-only'});
 const code=`import {supportOperation} from ${JSON.stringify(pathToFileURL(path.resolve('app/justifications.mjs')).href)};console.log(JSON.stringify(await supportOperation('evaluate',{conversationIds:${JSON.stringify(ids)},decision:${JSON.stringify(decision)},alternativeId:'local',knownAt:'2030-01-01T00:00:00Z',validAt:'2026-10-23T00:00:00Z'})));`;
 const restored=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,AFH_COSMOS_DATA:destination},encoding:'utf8'}));assert.deepEqual(restored,before);
});

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {conversation,original,late,draft} from './reevaluation-fixture.mjs';
process.env.AFH_COSMOS_DATA=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-reeval-http-'));process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.AFH_COSMOS_PORT=String(port);
const {server}=await import('./server.mjs');const {addSource}=await import('./corpus.mjs');const {knowledgeOperation,verifiedSources}=await import('./knowledge.mjs');
test('F29 HTTP watch, automatic source discovery, bounds, origin rejection, UI and prior panels',async t=>{
 await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+port;
 const api=async(op,input={})=>{const r=await fetch(base+'/api/reevaluation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op,...input})});return {status:r.status,data:await r.json()};};
 const a=await addSource(conversation('first',original)),ids=[a.id],c=await verifiedSources(ids);const record=(await knowledgeOperation('extract',ids,{draft:draft(c.sources[0]),producer:'fixture',sourceCut:c.cut,requestId:'first'})).records[0];
 const input={id:record.id,expectedVersion:1,conversationIds:ids,terms:['refería']};assert.equal((await api('watch',{...input,expectedVersion:99})).status,400);assert.equal((await api('watch',input)).status,200);assert.equal((await api('watch',input)).status,200);
 const arrival=await fetch(base+'/api/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(conversation('new',late))});assert.equal(arrival.status,200);assert.equal((await arrival.json()).result.reevaluation.enqueued.length,1);assert.equal((await api('scan')).data.errors.length,0);assert.equal((await api('status')).data.jobs.length,1);
 assert.equal((await api('invalid')).status,400);const denied=await fetch(base+'/api/reevaluation',{method:'POST',headers:{origin:'https://unrelated.invalid','content-type':'application/json'},body:'{"op":"status"}'});assert.equal(denied.status,403);
 const html=await (await fetch(base)).text();for(const asset of ['reevaluation','decisions','learning','incremental']){assert.ok(html.includes(asset+'-web.mjs'));assert.equal((await fetch(base+'/'+asset+'-web.mjs')).status,200);}
});

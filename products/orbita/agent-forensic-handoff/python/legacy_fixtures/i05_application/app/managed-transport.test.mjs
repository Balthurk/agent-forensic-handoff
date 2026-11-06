import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {AccessStore} from './access-store.mjs';
import {createAccessServer} from './access-server.mjs';

async function fixture(t){
 const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','i05-transport-'));
 const store=new AccessStore(root,{create:true}),owner=store.createAccount('owner','synthetic-transport-test',{admin:true});
 const space=store.createWorkspace(owner.id,{name:'Synthetic transport',policy:{basis:'Synthetic transport regression',purpose:'Exact request and socket checks',rightsUntil:new Date(Date.now()+86400000).toISOString(),retainUntil:new Date(Date.now()+172800000).toISOString()}});
 const token=store.issue(owner.id,{workspace:space.id}).token;store.close();
 const prior=process.env.NODE_OPTIONS,priorDir=process.env.ORBITA_TRANSPORT_FIXTURE_DIR;
 const dir=path.join(root,'observed-transport');fs.mkdirSync(dir);
 process.env.NODE_OPTIONS=(prior?prior+' ':'')+'--import='+new URL('./managed-transport-fixture.mjs',import.meta.url).href;
 process.env.ORBITA_TRANSPORT_FIXTURE_DIR=dir;
 const app=createAccessServer({root,port:0});
 t.after(async()=>{try{await app.close();assert.equal(app.workers.slots.size,0);assert.equal(app.server.listening,false);}finally{if(prior===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=prior;if(priorDir===undefined)delete process.env.ORBITA_TRANSPORT_FIXTURE_DIR;else process.env.ORBITA_TRANSPORT_FIXTURE_DIR=priorDir;}});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 const call=async(route='/api/bootstrap',body)=>{const response=await fetch('http://127.0.0.1:'+app.server.address().port+route,{method:body?'POST':'GET',headers:{connection:'close',authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,value:await response.json()};};
 const workspace=path.join(dir,space.id),records=()=>fs.readFileSync(path.join(workspace,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 return {app,call,workspace,records};
}

test('I05 managed gateway closes each real upstream connection without socket reuse',async t=>{
 const f=await fixture(t);
 for(let i=0;i<4;i++){const r=await f.call();assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.value.library.length,0);}
 const rows=f.records().filter(r=>r.event==='request');
 assert.equal(rows.length,4,'each browser request reaches the real worker exactly once');
 assert.ok(rows.every(r=>r.method==='GET'&&r.url==='/api/bootstrap'));
 assert.ok(rows.every(r=>r.connection==='close'),'upstream requests must explicitly close their transport');
 assert.equal(new Set(rows.map(r=>r.socket)).size,4,'no potentially stale keep-alive socket is reused');
});

test('I05 managed gateway never replays a real mutation after its completed response is lost',async t=>{
 const f=await fixture(t);assert.equal((await f.call()).status,200);
 fs.writeFileSync(path.join(f.workspace,'drop-document-response'),'drop only the next real completed document response');
 const result=await f.call('/api/documents',{filename:'once.md',content:'# Exact mutation\nThis document was created once.',metadata:{title:'Transport once'}});
 assert.equal(result.status,503);assert.equal(result.value.error,'ACCESS_OPERATION_INCOMPLETE');
 const current=await f.call();assert.equal(current.status,200);assert.equal(current.value.library.length,1);assert.equal(current.value.library[0].title,'Transport once');
 const rows=f.records();assert.equal(rows.filter(r=>r.event==='request'&&r.method==='POST'&&r.url==='/api/documents').length,1);
 const dropped=rows.filter(r=>r.event==='completed-response-dropped');assert.equal(dropped.length,1);assert.equal(dropped[0].status,200);
});

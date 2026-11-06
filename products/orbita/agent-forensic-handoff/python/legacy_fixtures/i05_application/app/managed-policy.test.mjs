import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {managedFixture} from './managed-fixture.mjs';
import {createAccessServer} from './access-server.mjs';
import {requestRole} from './access-policy.mjs';
import {sameManagedSession} from './web/managed-permissions.mjs';

let f,app,base;
async function call(route,{token=f.tokens.owner,body,cookie,headers={}}={}){
 const r=await fetch(base+route,{method:body?'POST':'GET',headers:{connection:'close',...(cookie?{cookie}:{authorization:'Bearer '+token}),...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual'});
 const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:r.status,value,headers:r.headers};
}
before(async()=>{f=managedFixture(fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','o4-policy-')));app=createAccessServer({root:f.root,port:0});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;});
after(async()=>{await app?.close();});

test('I04 managed session capabilities match current roles and exclude unavailable inference/backends',async()=>{
 for(const name of ['owner','editor','reader']){
  const {value:s,status}=await call('/access/api/session',{token:f.tokens[name]});assert.equal(status,200);assert.equal(s.capabilities?.version,1);
  const actions=new Set(s.capabilities.actions);assert.ok(actions.has('POST /api/retrospectives#query'));assert.ok(actions.has('POST /api/graph-publication#query'));
  for(const route of ['retrospectives','decision-intelligence','causal'])assert.equal(actions.has('POST /api/'+route+'#put'),name!=='reader');
  assert.equal(actions.has('POST /api/graph-publication#publish'),name!=='reader');assert.equal(actions.has('POST /api/supports#impact'),name!=='reader');
  for(const key of ['POST /api/ask','POST /api/semantic/extract','POST /api/semantic/review','GET /api/corpus-plan','POST /api/corpus-plan','POST /api/volume#postgres'])assert.ok(!actions.has(key),key);
  for(const key of actions){const [method,target]=key.split(' '),[route,op]=target.split('#'),role=requestRole(method,route,{...(op?{op}:{})});assert.ok(name!=='reader'||role==='reader',key);}
 }
});

test('I04 managed bootstrap includes the four preserved feature modules',async()=>{
 const {value:entry,status}=await call('/managed-app.mjs');assert.equal(status,200);
 for(const name of ['retrospectives','decision-intelligence','causal','graph-publication'])assert.ok(entry.includes('/'+name+'-web.mjs'),name);
});

test('I04 real workers execute permitted writes and readers see all four original-backed modules',async()=>{
 const c=f.causal,ids=c.ids,reader=f.tokens.reader;
 const writes=[['/api/retrospectives',{op:'put',conversationIds:ids,id:'managed-context',detail:c.context.record.payload.retrospective.detail,requestId:'managed-context'}],['/api/decision-intelligence',{op:'put',conversationIds:ids,id:'managed-review',kind:'review',detail:c.review,requestId:'managed-review'}],['/api/causal',{op:'put',conversationIds:ids,id:'managed-causal',detail:c.detail,requestId:'managed-causal'}],['/api/graph-publication',{op:'publish',conversationIds:f.graph.ids,outboxId:f.graph.entry.outboxId,backend:'sqlite'}]];
 for(const [route,body] of writes){assert.equal((await call(route,{token:reader,body})).status,403,route);const r=await call(route,{token:f.tokens.editor,body});assert.equal(r.status,200,JSON.stringify(r.value));}
 for(const route of ['retrospectives','decision-intelligence','causal']){const r=await call('/api/'+route,{token:reader,body:{op:'query',conversationIds:ids}});assert.equal(r.status,200,JSON.stringify(r.value));assert.ok(r.value.items.length>0,route);}
 const s=await call('/api/graph-publication',{token:reader,body:{op:'status',conversationIds:f.graph.ids}}),entry=s.value.entries.find(e=>e.state==='selected');assert.ok(entry);
 const page=await call('/api/graph-publication',{token:reader,body:{op:'query',conversationIds:f.graph.ids,generation:entry.generation,sourceCut:entry.sourceCut,mode:'current',backend:'sqlite'}});assert.equal(page.status,200,JSON.stringify(page.value));assert.ok(page.value.items.length>0);
 const item=page.value.items[0],original=await call('/api/graph-publication',{token:reader,body:{op:'original',conversationIds:f.graph.ids,generation:entry.generation,sourceCut:entry.sourceCut,mode:'current',backend:'sqlite',recordId:item.record.id,sourceId:item.record.payload.source_refs[0].id}});assert.equal(original.status,200);assert.ok(original.value.source.text.includes('sintética'));
});

test('I04 evidence impact is a write and a reader cannot persist a valid review',async()=>{
 const c=f.causal,body={op:'impact',conversationIds:c.ids,requestId:'reader-impact',detail:{target:{kind:'source',id:c.source.id,revision:c.source.revision},judgment:'withdrawn',actor:'synthetic reader',reason:'Synthetic attempted mutation must be refused',evidence:c.evidence}};
 const r=await call('/api/supports',{token:f.tokens.reader,body});assert.equal(r.status,403,JSON.stringify(r.value));assert.equal(requestRole('POST','/api/supports',body),'editor');
 const allowed=await call('/api/supports',{token:f.tokens.editor,body:{...body,requestId:'editor-impact'}});assert.equal(allowed.status,200,JSON.stringify(allowed.value));
});

test('I04 managed entry does not activate host inference, remote graphs or PostgreSQL',async()=>{
 for(const [route,body] of [['/api/ask',{}],['/api/semantic/extract',{}],['/api/semantic/review',{}],['/api/corpus-plan',null],['/api/volume',{op:'page',backend:'postgres'}],['/api/routing',{op:'classify',policy:'jev'}]])assert.equal((await call(route,{body})).status,403,route);
 const r=await call('/api/graph-publication',{body:{op:'capabilities',conversationIds:f.graph.ids}});assert.equal(r.status,200);assert.equal(r.value.configured,false);
 const remote=await call('/api/graph-publication',{body:{op:'publish',conversationIds:f.graph.ids,outboxId:f.graph.entry.outboxId,backend:'janusgraph'}});assert.ok(remote.status>=400);assert.ok(!JSON.stringify((await call('/access/api/session')).value).includes(app.workers.items.get(f.a.id).secret));
});

test('I04 a second actual login invalidates the old tab even with identical role and workspace',async()=>{
 async function selectedSession(){
  const login=await call('/access/api/login',{body:{username:'owner',password:f.password},headers:{origin:base,'x-orbita-login':'1'}});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0],first=(await call('/access/api/session',{cookie})).value;
  assert.equal((await call('/access/api/select',{cookie,headers:{origin:base,'x-orbita-csrf':first.csrf},body:{id:f.a.id}})).status,200);
  return (await call('/access/api/session',{cookie})).value;
 }
 const a=await selectedSession(),b=await selectedSession();assert.equal(a.user.id,b.user.id);assert.deepEqual(a.capabilities,b.capabilities);assert.notEqual(a.csrf,b.csrf);
 assert.equal(sameManagedSession(a,a),true);assert.equal(sameManagedSession(a,b),false,'the browser cookie can change before the next poll');
 assert.equal(sameManagedSession(a,{...a,user:{...a.user,id:'different-principal'}}),false);
 assert.equal(sameManagedSession(a,null),false);assert.equal(sameManagedSession(a,{...a,spaces:[]}),false);
});

test('I04 browser capability revision changes on downgrade, selection and revocation',async()=>{
 const login=await call('/access/api/login',{body:{username:'editor',password:f.password},headers:{origin:base,'x-orbita-login':'1'},cookie:''});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const first=(await call('/access/api/session',{cookie})).value,headers={origin:base,'x-orbita-csrf':first.csrf};
 assert.equal((await call('/access/api/select',{cookie,headers,body:{id:f.a.id}})).status,200);const a=(await call('/access/api/session',{cookie})).value;
 app.store.grant(f.owner.id,f.a.id,'editor','reader');const downgraded=(await call('/access/api/session',{cookie})).value;assert.notDeepEqual(downgraded.capabilities,a.capabilities);assert.ok(!downgraded.capabilities.actions.includes('POST /api/causal#put'));
 assert.equal((await call('/access/api/select',{cookie,headers,body:{id:f.b.id}})).status,200);const b=(await call('/access/api/session',{cookie})).value;assert.equal(b.selected,f.b.id);assert.equal((await call('/api/bootstrap',{cookie,headers:{'x-orbita-workspace':f.a.id}})).status,409);
 assert.equal((await call('/api/bootstrap',{cookie,headers:{'x-orbita-workspace':f.b.id}})).value.library.length,0);app.store.revoke(f.owner.id,f.b.id,f.editor.id);assert.equal((await call('/access/api/session',{cookie})).status,401);
});

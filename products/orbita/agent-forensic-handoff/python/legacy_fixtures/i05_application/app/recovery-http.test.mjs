import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import net from 'node:net';
import {conversation,original} from './reevaluation-fixture.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),lab=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-recovery-http-'));
async function start(data){const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const child=spawn(process.execPath,[path.join(here,'server.mjs')],{env:{...process.env,AFH_COSMOS_DATA:data,AFH_COSMOS_PORT:String(port),AFH_COSMOS_EMPTY_LIBRARY:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(errors||'server timeout')),10000);child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});child.once('exit',()=>{clearTimeout(timeout);reject(new Error(errors));});});return {url:'http://127.0.0.1:'+port,child};}
async function stop(server){server.child.kill();await new Promise(r=>server.child.once('exit',r));}
async function request(server,route,body){const r=await fetch(server.url+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const value=await r.json();return {status:r.status,value};}
async function complete(server,id){for(let i=0;i<300;i++){const r=(await request(server,'/api/jobs/'+id)).value;if(r.status!=='running'){assert.equal(r.status,'complete',JSON.stringify(r));return r.result;}await new Promise(r=>setTimeout(r,50));}throw new Error('job timeout');}
test('F31 real HTTP import → quiescent encrypted backup → isolated restore → source retrieval with no external auto-start',async()=>{
 const live=await start(path.join(lab,'live'));let recovered;
 try{
  const denied=await fetch(live.url+'/api/recovery',{method:'POST',headers:{origin:'https://example.org','content-type':'application/json'},body:'{}'});assert.equal(denied.status,403);
  const imported=await request(live,'/api/import',conversation('memory',original));assert.equal(imported.status,200,JSON.stringify(imported));const id=imported.value.result.id;
  const before=await request(live,'/api/retrieve',{question:'reunión',conversationIds:[id],retrieval:{mode:'lexical'}});assert.equal(before.status,200);assert.ok(before.value.evidence.length);
  const archive=path.join(lab,'http.orbita'),password='test-only-long-password';let job=await request(live,'/api/recovery',{op:'backup',archive,password});assert.equal(job.status,202,JSON.stringify(job));const saved=await complete(live,job.value.id);assert.equal(saved.validation.conversations,1);
  const destination=path.join(lab,'restored');job=await request(live,'/api/recovery',{op:'restore',archive,password,destination});assert.equal(job.status,202);await complete(live,job.value.id);
  recovered=await start(destination);const status=await request(recovered,'/api/recovery/status');assert.equal(status.value.restored.automaticWork,false);assert.equal(status.value.restored.externalAccess,false);
  const after=await request(recovered,'/api/retrieve',{question:'reunión',conversationIds:[id],retrieval:{mode:'lexical'}});assert.equal(after.status,200,JSON.stringify(after));assert.deepEqual(after.value.evidence,before.value.evidence);
  const external=await request(recovered,'/api/capture',{op:'capture',id:'unknown',allowPaths:[]});assert.match(external.value.error,/EXTERNAL_ACCESS_PAUSED/);
  const activated=await request(recovered,'/api/recovery/activate',{restoreId:status.value.restored.id,automaticWork:false,externalAccess:true});assert.equal(activated.status,200);
  const stillLive=await request(live,'/api/bootstrap');assert.equal(stillLive.value.build,'v8-recovery-agent-1');assert.equal(stillLive.value.library[0].verified,true);
 }finally{if(recovered)await stop(recovered);await stop(live);}
});

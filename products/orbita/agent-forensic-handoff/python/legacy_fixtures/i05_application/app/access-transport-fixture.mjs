import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {channel} from 'node:diagnostics_channel';
import {AccessStore} from './access-store.mjs';
import {createAccessServer} from './access-server.mjs';
const [mode,waitRaw='6500']=process.argv.slice(2),waitMs=Number(waitRaw);
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||os.tmpdir(),'orbita-i02-access-transport-')),events=[],now=Date.now(),password='synthetic-I02-diagnostic-only';
const mark=(event,values={})=>events.push({at:new Date().toISOString(),event,...values});
const failure=e=>({name:e.name,message:e.message,code:e.code,...(e.cause?{cause:failure(e.cause)}:{})});
channel('undici:request:error').subscribe(({request,error})=>mark('client-error',{method:request.method,path:request.path,error:failure(error)}));
const store=new AccessStore(root,{create:true,clock:()=>now}),owner=store.createAccount('owner',password,{admin:true});
const workspace=store.createWorkspace(owner.id,{name:'Diagnostic-only',policy:{basis:'Synthetic fixture only',purpose:'Local transport diagnosis',rightsUntil:new Date(now+86400000).toISOString(),retainUntil:new Date(now+172800000).toISOString()}});store.close();
const app=createAccessServer({root,port:0,clock:()=>now});let serial=0;
app.server.on('connection',socket=>{const id=++serial;mark('connection',{id});socket.on('timeout',()=>mark('server-timeout',{id}));socket.on('close',hadError=>mark('socket-close',{id,hadError}));});
app.server.on('request',(req,res)=>{mark('server-request',{method:req.method,path:req.url});res.on('finish',()=>mark('server-response',{path:req.url,status:res.statusCode}));});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+app.server.address().port;
async function call(route,{cookie,body,headers={}}={}){
 if(mode==='blocked-fresh')headers={connection:'close',...headers};
 const response=await fetch(base+route,{method:body?'POST':'GET',headers:{...headers,...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const value=await response.json();return {status:response.status,value,headers:response.headers};
}
const login=await call('/access/api/login',{body:{username:'owner',password},headers:{origin:base,'x-orbita-login':'1'}});
assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
const csrf=(await call('/access/api/session',{cookie})).value.csrf;
await call('/access/api/login',{body:{username:'owner',password},headers:{origin:base,'x-orbita-login':'1'}});
mark('before-idle',{mode,waitMs});
if(mode==='blocked-loop'||mode==='blocked-fresh')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,waitMs);
if(mode==='async-idle')await new Promise(resolve=>setTimeout(resolve,waitMs));
mark('after-idle');
const calls=[];
const selected=()=>app.store.session(cookie.slice(cookie.indexOf('=')+1)).workspace===workspace.id;
try {
 for(const [name,headers] of [['csrf-missing',{origin:base}],['csrf-valid',{origin:base,'x-orbita-csrf':csrf}]]){
  mark('client-call',{name});
  try{const r=await call('/access/api/select',{cookie,body:{id:workspace.id},headers});calls.push({name,status:r.status,code:r.value?.error,selected:selected()});}
  catch(error){calls.push({name,error:failure(error),selected:selected()});break;}
 }
} finally {await app.close();}
const result={at:new Date().toISOString(),mode,waitMs,root,calls,events};
fs.writeFileSync(path.join(root,'RESULT.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));

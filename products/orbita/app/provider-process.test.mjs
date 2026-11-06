import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {providerEnvironment,runOwnedProcess} from './owned-process.mjs';

assert.ok(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'explicit native fixture receipt root required');
const root=fs.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'provider-process-'));
async function observed(fn){
 const original=cp.spawn,children=[];
 cp.spawn=function(...args){const child=original.apply(this,args),record={child,closed:false};children.push(record);child.once('close',()=>{record.closed=true;});return child;};syncBuiltinESMExports();
 try{return await fn(children);}finally{cp.spawn=original;syncBuiltinESMExports();assert.ok(children.every(x=>x.closed),'every spawned provider child must actually close');}
}
const run=(code,options={})=>runOwnedProcess(process.execPath,['-e',code],{env:providerEnvironment(),timeout:5000,...options});

test('PG01 actual provider children never inherit database capabilities, API credentials or preloads',async()=>{
 const names=['ORBITA_POSTGRES_BINDING','ORBITA_POSTGRES_CONFIG','ORBITA_POSTGRES_TEST_OPERATOR_CONFIG','AFH_JEV_CONFIG','OPENAI_API_KEY','CODEX_API_KEY','TYPESAFE_API_KEY','JEV_Vercel','NODE_OPTIONS','PYTHONPATH','PYTHONHOME'];
 const previous=Object.fromEntries(names.map(key=>[key,process.env[key]]));
 try{
  for(const key of names)process.env[key]='synthetic sentinel must not reach a child';
  await observed(async children=>{
   for(const codex of [false,true]){
    const result=await run(`console.log(JSON.stringify(${JSON.stringify(names)}.filter(key=>Object.hasOwn(process.env,key))));`,{env:providerEnvironment({codex})});
    assert.equal(result.code,0);assert.deepEqual(JSON.parse(result.stdout),[]);assert.equal(result.closed,true);
   }
   assert.equal(children.length,2);
  });
 }finally{for(const key of names)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
});

test('PG01 stdin and arbitrary UTF8 pipe boundaries preserve the complete provider response',async()=>{
 await observed(async children=>{
  const input='Texto exacto: café 漢字 😀 e\u0301.\nSegunda línea.';
  const result=await run("process.stdin.setEncoding('utf8');let value='';process.stdin.on('data',x=>value+=x);process.stdin.on('end',()=>{for(const byte of Buffer.from(JSON.stringify({value,pid:process.pid})))process.stdout.write(Buffer.from([byte]));});",{input});
  assert.equal(result.code,0);assert.deepEqual(JSON.parse(result.stdout),{value:input,pid:children[0].child.pid});assert.equal(result.closed,true);assert.equal(children[0].closed,true);
 });
});

test('PG01 cancellation waits for the close of a demonstrably running provider process',async()=>{
 await observed(async children=>{
  const marker=path.join(root,'cancel-ready'),controller=new AbortController();
  const promise=run(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);`,{signal:controller.signal});
  promise.catch(()=>{});
  const deadline=Date.now()+5000;
  while(!fs.existsSync(marker)){assert.ok(Date.now()<deadline,'provider readiness deadline');await delay(5);}
  assert.equal(children[0].closed,false);controller.abort(new Error('SYNTHETIC_CANCEL'));
  await assert.rejects(promise,error=>error.message==='SYNTHETIC_CANCEL'&&error.capture.closed&&children[0].closed);
 });
});

test('PG01 a provider timeout rejects only after actual owned process closure',async()=>{
 await observed(async children=>{
  await assert.rejects(run('setInterval(()=>{},1000);',{timeout:400}),error=>error.message==='OWNED_PROCESS_TIMEOUT'&&error.capture.closed&&children[0].closed);
 });
});

test('PG01 excessive output and truncated UTF8 close real provider processes and retain failure',async()=>{
 await observed(async children=>{
  for(const [channel,options] of [['stdout',{stdoutLimit:1024}],['stderr',{stderrLimit:1024}]]){
   await assert.rejects(run(`process.${channel}.write(Buffer.alloc(1025,120));setInterval(()=>{},1000);`,options),error=>error.message==='UTF8_STREAM_BUDGET'&&error.capture.closed);
  }
  await assert.rejects(run('process.stdout.write(Buffer.from([0xe2,0x82]));'),error=>error.capture.closed&&error.capture.code===0);
  assert.equal(children.length,3);
 });
});

test('PG01 a cancelled provider request cannot create a child process',async()=>{
 await observed(async children=>{
  const controller=new AbortController();controller.abort(new Error('CANCEL_BEFORE_SPAWN'));
  assert.throws(()=>run('throw new Error("must not execute")',{signal:controller.signal}),/CANCEL_BEFORE_SPAWN/);assert.equal(children.length,0);
 });
});

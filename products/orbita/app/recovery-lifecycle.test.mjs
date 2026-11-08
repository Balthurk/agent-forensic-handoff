import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {commonFixture} from './common-test-scope.mjs';
import {runtimeEnv} from './common-test-fixtures.mjs';
import {exclusiveStore} from './store-access.mjs';

const root=commonFixture('i08-eof-'),pythonRoot=fileURLToPath(new URL('../agent-forensic-handoff/python/',import.meta.url));
for(const malformed of [false,true])test('I08 C01 '+(malformed?'truncated request':'clean EOF')+' closes a real Python bridge and releases its live store lock',async()=>{
 const source=path.join(root,malformed?'truncated':'clean');
 const child=spawn(process.env.ORBITA_POSTGRES_PYTHON,['-X','utf8','-B','-u','-m','orbita_store.bridge'],{cwd:pythonRoot,env:runtimeEnv(),windowsHide:true,stdio:['pipe','pipe','pipe']});
 let errors='',timer;child.stderr.on('data',value=>errors+=value);
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 const lines=createInterface({input:child.stdout}),queue=[],receivers=[];lines.on('line',line=>{const receive=receivers.shift();receive?receive(line):queue.push(line);});
 const next=()=>new Promise((resolve,reject)=>{
  if(queue.length)return resolve(queue.shift());
  const receive=line=>{clearTimeout(timer);resolve(line);};receivers.push(receive);
  timer=setTimeout(()=>{receivers.splice(receivers.indexOf(receive),1);reject(Error('REAL_BRIDGE_RESPONSE_DEADLINE'));},30000);
 });
 try{
  const response=next();child.stdin.write(JSON.stringify({id:1,op:'lease.acquire',path:source,mode:'shared'})+'\n');
  const held=JSON.parse(await response);assert.equal(held.ok,true,held.code);assert.ok(Number.isInteger(held.leaseId));
  assert.throws(()=>exclusiveStore(source),/RECOVERY_STORE_BUSY/);
  child.stdin.end(malformed?'{"id":2':undefined);
  const deadline=new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('REAL_BRIDGE_EOF_CLOSE_DEADLINE')),30000));
  const ended=await Promise.race([closed,deadline]);clearTimeout(timer);
  assert.equal(ended.signal,null);assert.equal(ended.code,malformed?1:0,errors);
  if(malformed)assert.match(errors,/ORBITA_PG_REQUEST_LIMIT/);else assert.equal(errors,'');
  const release=exclusiveStore(source);release();
 }finally{
  clearTimeout(timer);child.stdin.destroy();
  if(child.exitCode===null&&child.signalCode===null)child.kill();
  await closed;lines.close();
 }
});

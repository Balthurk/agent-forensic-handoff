import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import files from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
import {publishSnapshot} from './common-snapshots.mjs';
import {AccessStore} from './access-store.mjs';
import {nativeFixture,runtimeEnv} from './common-test-fixtures.mjs';
const root=path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'snapshots-'+randomUUID());
const sha=value=>createHash('sha256').update(value).digest('hex');
const raw=JSON.stringify({text:'Fuente literal ñ😀',items:[1,2,3]}),id=sha(raw);
const filesUrl=new URL('../agent-forensic-handoff/src/common-files.js',import.meta.url).href,storeUrl=new URL('../agent-forensic-handoff/src/common-store.js',import.meta.url).href,snapshotUrl=new URL('./common-snapshots.mjs',import.meta.url).href;
const childSource=(dir,prefix='')=>`import files from ${JSON.stringify(filesUrl)};import {closeCommonStore} from ${JSON.stringify(storeUrl)};import {publishSnapshot} from ${JSON.stringify(snapshotUrl)};import {createHash} from 'node:crypto';try{${prefix}const published=publishSnapshot(${JSON.stringify(dir)},${JSON.stringify(id)},${JSON.stringify(raw)});const key=files.readFileSync(${JSON.stringify(path.join(dir,id,'cursor.key'))});console.log(JSON.stringify({published,keyHash:createHash('sha256').update(key).digest('hex')}));}finally{closeCommonStore();}`;
test.after(()=>{const closed=closeCommonStore();assert.equal(closed.drained,true);assert.equal(native.existsSync(root),false);});

test('common snapshot publishes literal bytes and a stable signing key together',()=>{
 const dir=path.join(root,'stable');assert.equal(publishSnapshot(dir,id,raw),true);
 assert.equal(files.readFileSync(path.join(dir,id,'snapshot.json'),'utf8'),raw);
 const key=files.readFileSync(path.join(dir,id,'cursor.key'));assert.equal(key.length,32);
 const cursor=createHmac('sha256',key).update('synthetic cursor').digest('hex');
 assert.equal(publishSnapshot(dir,id,raw),false);assert.equal(createHmac('sha256',files.readFileSync(path.join(dir,id,'cursor.key'))).update('synthetic cursor').digest('hex'),cursor);
 assert.deepEqual(files.readdirSync(dir),[id]);assert.throws(()=>publishSnapshot(dir,'0'.repeat(64),raw),/SNAPSHOT_PUBLICATION_IDENTITY/);
});

test('two actual publishers overlap before key publication and converge on one stable pair',async()=>{
 const dir=path.join(root,'concurrent'),barriers=nativeFixture('snapshot-concurrency'),release=path.join(barriers,'release');
 const children=[];
 try{
  for(const label of ['a','b']){
   const ready=path.join(barriers,'ready-'+label);
   const prefix=`const native=await import('node:fs');const original=files.writeFileSync;files.writeFileSync=(file,...args)=>{const result=original(file,...args);if(String(file).endsWith('snapshot.json')){native.writeFileSync(${JSON.stringify(ready)},'actual PostgreSQL body committed');const until=Date.now()+15000;while(!native.existsSync(${JSON.stringify(release)})){if(Date.now()>=until)throw Error('SNAPSHOT_TEST_BARRIER_TIMEOUT');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}return result;};`;
   const child=spawn(process.execPath,['--input-type=module','-e',childSource(dir,prefix)],{env:runtimeEnv(),windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
   child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
   const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});children.push({child,done});
  }
  const deadline=Date.now()+15000;
  while(!['a','b'].every(label=>native.existsSync(path.join(barriers,'ready-'+label)))){assert.ok(Date.now()<deadline,'both actual publishers reached the real storage barrier');await delay(20);}
  assert.equal(files.existsSync(path.join(dir,id)),false,'neither partial pair is published');
  assert.equal(files.readdirSync(dir).filter(name=>name.startsWith('.snapshot-')).length,2);
  native.writeFileSync(release,'publish both actual transactions');
  const results=await Promise.all(children.map(c=>c.done));for(const r of results)assert.equal(r.code,0,r.stderr);
  const values=results.map(r=>JSON.parse(r.stdout));assert.deepEqual(values.map(v=>v.published).sort(),[false,true]);assert.equal(values[0].keyHash,values[1].keyHash);
  assert.equal(sha(files.readFileSync(path.join(dir,id,'cursor.key'))),values[0].keyHash);assert.equal(files.readFileSync(path.join(dir,id,'snapshot.json'),'utf8'),raw);assert.deepEqual(files.readdirSync(dir),[id]);
 }finally{if(!native.existsSync(release))native.writeFileSync(release,'release on test failure');await Promise.allSettled(children.map(c=>c.done));}
});

for(const checkpoint of ['snapshot-after-body','snapshot-after-key','snapshot-after-publish'])test('real process crash at '+checkpoint+' exposes only a complete pair on retry',()=>{
 const dir=path.join(root,checkpoint);
 const crashed=spawnSync(process.execPath,['--input-type=module','-e',childSource(dir)],{env:runtimeEnv({crashAt:checkpoint}),encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(crashed.status,86,crashed.stderr);
 const published=checkpoint==='snapshot-after-publish';assert.equal(files.existsSync(path.join(dir,id)),published);
 const prior=published?files.readFileSync(path.join(dir,id,'cursor.key')):null;
 if(!published){const stages=files.readdirSync(dir).filter(name=>name.startsWith('.snapshot-'));assert.equal(stages.length,1);assert.equal(files.existsSync(path.join(dir,stages[0],'cursor.key')),checkpoint==='snapshot-after-key');}
 const retry=spawnSync(process.execPath,['--input-type=module','-e',childSource(dir)],{env:runtimeEnv(),encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(retry.status,0,retry.stderr);
 assert.equal(files.readFileSync(path.join(dir,id,'snapshot.json'),'utf8'),raw);const key=files.readFileSync(path.join(dir,id,'cursor.key'));assert.equal(key.length,32);if(prior)assert.deepEqual(key,prior);
});

test('identical snapshots in actual managed children keep separate keys and scoped capabilities',()=>{
 const control=new AccessStore(path.join(root,'control'),{create:true});
 try{
  const owner=control.createAccount('owner','synthetic-snapshot-scope-password',{admin:true});
  const policy={basis:'Synthetic publication isolation',purpose:'Separate keys and literal bytes',rightsUntil:new Date(Date.now()+86400000).toISOString(),retainUntil:new Date(Date.now()+172800000).toISOString()};
  const a=control.createWorkspace(owner.id,{name:'A',policy}),b=control.createWorkspace(owner.id,{name:'B',policy}),aroot=path.join(control.workspaceRoot(a.id),'data/views'),broot=path.join(control.workspaceRoot(b.id),'data/views');
  publishSnapshot(aroot,id,raw);publishSnapshot(broot,id,raw);assert.notEqual(sha(files.readFileSync(path.join(aroot,id,'cursor.key'))),sha(files.readFileSync(path.join(broot,id,'cursor.key'))));
  const code=`import assert from 'node:assert/strict';import files from ${JSON.stringify(filesUrl)};import {closeCommonStore} from ${JSON.stringify(storeUrl)};try{assert.equal(files.readFileSync(${JSON.stringify(path.join(aroot,id,'snapshot.json'))},'utf8'),${JSON.stringify(raw)});assert.throws(()=>files.readFileSync(${JSON.stringify(path.join(broot,id,'cursor.key'))}),/ORBITA_PG_/);}finally{closeCommonStore();}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:runtimeEnv({configuration:control.workerConfiguration(a.id).configuration}),encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(child.status,0,child.stderr);
 }finally{control.close();}
});

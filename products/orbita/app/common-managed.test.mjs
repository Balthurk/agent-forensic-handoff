import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import files from '../agent-forensic-handoff/src/common-files.js';
import {DatabaseSync,closeCommonStore,acquireStoreLease,exportCommonStore} from '../agent-forensic-handoff/src/common-store.js';
import {AccessStore} from './access-store.mjs';

assert.ok(process.env.ORBITA_POSTGRES_TEST_ROOT,'explicit common test root required');
const root=path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'managed-'+randomUUID());
const password='Synthetic managed fixture password only';
const policy=()=>({basis:'Synthetic source permission only',purpose:'Isolated PostgreSQL qualification',rightsUntil:new Date(Date.now()+86400000).toISOString(),retainUntil:new Date(Date.now()+172800000).toISOString()});
const filesUrl=new URL('../agent-forensic-handoff/src/common-files.js',import.meta.url).href;
const storeUrl=new URL('../agent-forensic-handoff/src/common-store.js',import.meta.url).href;
let control,owner,reader,a,b;
const childEnv=configuration=>Object.fromEntries(Object.entries({PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',ORBITA_POSTGRES_PYTHON:process.env.ORBITA_POSTGRES_PYTHON,ORBITA_POSTGRES_BINDING:JSON.stringify(configuration)}).filter(([,value])=>value!==undefined));
const run=(configuration,code)=>execFileSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import files from ${JSON.stringify(filesUrl)};import {closeCommonStore} from ${JSON.stringify(storeUrl)};try{${code}}finally{closeCommonStore();}`],{env:childEnv(configuration),encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1024*1024});

test.before(()=>{control=new AccessStore(root,{create:true});owner=control.createAccount('owner',password,{admin:true});reader=control.createAccount('reader',password);a=control.createWorkspace(owner.id,{name:'Alpha',policy:policy()});b=control.createWorkspace(owner.id,{name:'Beta',policy:policy()});});
test.after(()=>{try{control?.close();}finally{const closed=closeCommonStore();assert.equal(closed.ownedExit,0);assert.equal(closed.drained,true);assert.equal(native.existsSync(root),false);}});

test('common access creates accounts and separate child namespaces without native state',()=>{
 assert.equal(files.statSync(path.join(root,'access.pgstore')).isStore(),true);
 assert.equal(files.readFileSync(path.join(control.workspaceRoot(a.id),'data/library.json'),'utf8'),'[]');
 files.writeFileSync(path.join(control.workspaceRoot(a.id),'data/literal.txt'),'Alpha literal ñ😀');
 files.writeFileSync(path.join(control.workspaceRoot(b.id),'data/literal.txt'),'Beta literal');
 assert.notEqual(control.managedState(a.id).workspaceId,control.managedState(b.id).workspaceId);
 assert.equal(native.existsSync(root),false);
});

test('atomic create rolls back membership audit mapping and child bytes on a real outer failure',()=>{
 const before=control.db.prepare('SELECT count(*) n FROM workspaces').get().n,audit=control.db.prepare('SELECT count(*) n FROM audit').get().n;
 const original=control.db.provisionManaged;let rejected;
 control.db.provisionManaged=function(id){rejected=id;original.call(this,id);throw new Error('SYNTHETIC_AFTER_REAL_PROVISION');};
 try{assert.throws(()=>control.createWorkspace(owner.id,{name:'Rollback',policy:policy()}),/SYNTHETIC_AFTER_REAL_PROVISION/);}finally{control.db.provisionManaged=original;}
 assert.equal(control.db.prepare('SELECT count(*) n FROM workspaces').get().n,before);
 assert.equal(control.db.prepare('SELECT count(*) n FROM audit').get().n,audit);
 assert.equal(control.db.prepare('SELECT count(*) n FROM members WHERE workspace=?').get(rejected).n,0);
 assert.throws(()=>control.managedState(rejected),/MANAGED_UNKNOWN/);
 assert.throws(()=>files.existsSync(control.workspaceRoot(rejected)),/MANAGED_UNKNOWN/);
});

test('a real fresh worker gets only its original child root and cannot read parent or sibling',()=>{
 const {configuration,epoch}=control.workerConfiguration(a.id);
 assert.deepEqual(Object.keys(configuration).sort(),['schema','host','port','dbname','user','password','instanceId','bindings'].sort());
 assert.equal(configuration.bindings.length,1);assert.equal(configuration.bindings[0].root,control.workspaceRoot(a.id));assert.equal(epoch,control.managedState(a.id).epoch);
 const output=run(configuration,`assert.equal(files.readFileSync(${JSON.stringify(path.join(control.workspaceRoot(a.id),'data/literal.txt'))},'utf8'),'Alpha literal ñ😀');for(const p of ${JSON.stringify([path.join(root,'access.pgstore'),path.join(control.workspaceRoot(b.id),'data/literal.txt')])})assert.throws(()=>files.readFileSync(p),/PATH_NOT_BOUND/);assert.equal(process.env.ORBITA_POSTGRES_TEST_OPERATOR_CONFIG,undefined);assert.equal(process.env.ORBITA_POSTGRES_CONFIG,undefined);console.log('PASS_SCOPED_CHILD');`);
 assert.match(output,/PASS_SCOPED_CHILD/);assert.ok(!output.includes(configuration.password));assert.ok(!output.includes(configuration.bindings[0].capability));
});

test('membership epoch fences pending responses and rejects an old worker in a fresh process',()=>{
 const old=control.workerConfiguration(a.id),secret=control.login('owner',password).token,access=control.authorize(secret,a.id);
 control.grant(owner.id,a.id,'reader','reader');
 assert.throws(()=>control.fence(secret,access),/ACCESS_CHANGED_DURING_REQUEST/);
 assert.match(run(old.configuration,`assert.throws(()=>files.existsSync(${JSON.stringify(control.workspaceRoot(a.id))}),/CONNECT_OR_AUTHORIZE_FAILED/);console.log('PASS_OLD_DENIED');`),/PASS_OLD_DENIED/);
 const current=control.workerConfiguration(a.id);assert.ok(current.epoch>old.epoch);
 assert.match(run(current.configuration,`assert.ok(files.existsSync(${JSON.stringify(control.workspaceRoot(a.id))}));console.log('PASS_CURRENT');`),/PASS_CURRENT/);
 control.revoke(owner.id,a.id,reader.id);
});

test('unknown and retired child prefixes cannot create objects in the parent namespace',()=>{
 const unknown=path.join(root,'spaces','ws-'+randomUUID());
 assert.throws(()=>files.mkdirSync(unknown,{recursive:true}),/MANAGED_UNKNOWN/);
 assert.throws(()=>files.copyFileSync(path.join(control.workspaceRoot(b.id),'data/literal.txt'),path.join(unknown,'copy')),/MANAGED_UNKNOWN/);
 assert.equal(native.existsSync(root),false);
});

test('control close and bridge restart reconstruct child bindings from the actual control',()=>{
 const alpha=path.join(control.workspaceRoot(a.id),'data/literal.txt');control.close();
 assert.equal(files.readFileSync(alpha,'utf8'),'Alpha literal ñ😀');
 closeCommonStore();control=new AccessStore(root);
 assert.equal(files.readFileSync(alpha,'utf8'),'Alpha literal ñ😀');
 assert.equal(control.list(owner.id).length,2);
});

test('purge rejects owned handles databases transfers and leases before closing idle objects',()=>{
 const w=control.createWorkspace(owner.id,{name:'Owned resources',policy:policy()}),workspace=control.workspaceRoot(w.id);
 control.save({...w,status:'purge_failed'},'synthetic_purge_prepared',owner.id);
 const fd=files.openSync(path.join(workspace,'data/library.json'),'r');
 assert.throws(()=>control.purgeContent(w.id),/MANAGED_OWNED_CONSUMER_BUSY/);files.closeSync(fd);
 const db=new DatabaseSync(path.join(workspace,'data/cache.pgstore'),{family:'embedding',create:true});
 assert.throws(()=>control.purgeContent(w.id),/MANAGED_OWNED_CONSUMER_BUSY/);db.close();
 const transfer=exportCommonStore(path.join(workspace,'data/cache.pgstore'));
 assert.throws(()=>control.purgeContent(w.id),/MANAGED_OWNED_CONSUMER_BUSY/);transfer.close();
 const lease=acquireStoreLease(path.join(workspace,'data'));
 assert.throws(()=>control.purgeContent(w.id),/MANAGED_OWNED_CONSUMER_BUSY/);lease.release();
 assert.equal(control.purgeContent(w.id).purged,true);assert.equal(files.existsSync(workspace),false);
 assert.throws(()=>files.writeFileSync(path.join(workspace,'recreated'),'forbidden'),/MANAGED_PURGED/);
 assert.equal(files.readFileSync(path.join(control.workspaceRoot(b.id),'data/literal.txt'),'utf8'),'Beta literal');
});

test('another real process holding a PostgreSQL reader blocks purge until observed close',async()=>{
 const w=control.createWorkspace(owner.id,{name:'External reader',policy:policy()}),workspace=control.workspaceRoot(w.id),cfg=control.workerConfiguration(w.id).configuration;
 const code=`import files from ${JSON.stringify(filesUrl)};import {closeCommonStore} from ${JSON.stringify(storeUrl)};const fd=files.openSync(${JSON.stringify(path.join(workspace,'data/library.json'))},'r');console.log('READY');process.stdin.once('data',()=>{files.closeSync(fd);closeCommonStore();process.stdin.pause();});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:childEnv(cfg),windowsHide:true,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);const closed=once(child,'close');
 try{
  const ready=await Promise.race([once(child.stdout,'data'),closed.then(()=>{throw new Error('CHILD_CLOSED_BEFORE_READY');}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('CHILD_READY_TIMEOUT')),20000);t.unref();})]);
  assert.match(String(ready[0]),/READY/);
  control.save({...w,status:'purge_prepared'},'synthetic_purge_prepared',owner.id);
  assert.throws(()=>control.purgeContent(w.id),/MANAGED_LIVE_CONSUMER/);
 }finally{child.stdin.end('close owned reader');const [code]=await closed;assert.equal(code,0,stderr);}
 assert.equal(control.purgeContent(w.id).purged,true);assert.equal(files.existsSync(workspace),false);
});

test('a rejected capability produces an authorization error rather than false absence',()=>{
 const value=control.workerConfiguration(b.id).configuration;value.bindings[0].capability='x'.repeat(64);
 assert.match(run(value,`assert.throws(()=>files.existsSync(${JSON.stringify(control.workspaceRoot(b.id))}),/CONNECT_OR_AUTHORIZE_FAILED/);console.log('PASS_DENIED_NOT_ABSENT');`),/PASS_DENIED_NOT_ABSENT/);
});

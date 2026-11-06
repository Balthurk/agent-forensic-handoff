import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {DatabaseSync} from 'node:sqlite';import {randomBytes,scryptSync,createCipheriv} from 'node:crypto';
import {createBackup,restoreBackup,inventory,restoreState,activateRestore,requireExternalAccess,safeMember} from './recovery.mjs';
import {exclusiveStore} from './store-access.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),password='test-only-password-not-a-secret',lab=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-recovery-'));
function base(name){const root=path.join(lab,name);fs.mkdirSync(root);fs.writeFileSync(path.join(root,'library.json'),'[]');fs.mkdirSync(path.join(root,'future-relations'));fs.writeFileSync(path.join(root,'future-relations/unknown-version.json'),'{"opaque":["preserve me"]}');return root;}
function cli(input,env={}){return spawnSync(process.execPath,[path.join(here,'recovery-cli.mjs')],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,...env},windowsHide:true,timeout:60000});}
function framed(v){const raw=Buffer.from(JSON.stringify(v)),n=Buffer.alloc(4);n.writeUInt32BE(raw.length);return Buffer.concat([n,raw]);}
function malicious(name,entries){const salt=randomBytes(16),nonce=randomBytes(12),header=Buffer.concat([Buffer.from('ORBITA-BACKUP-01\0'),salt,nonce]),key=scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024**2}),c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(header);const file=path.join(lab,name);fs.writeFileSync(file,Buffer.concat([header,c.update(Buffer.concat(entries.map(framed))),c.final(),c.getAuthTag()]));return file;}
test('F31 complete exact bytes, opaque future data, fresh-process restore and explicit reactivation',async()=>{
 const source=base('exact'),archive=path.join(lab,'exact.orbita'),destination=path.join(lab,'exact-restored');
 const db=new DatabaseSync(path.join(source,'records.sqlite3'));db.exec("CREATE TABLE history(version INTEGER,payload TEXT); INSERT INTO history VALUES(1,'old'),(2,'current'); CREATE TABLE jobs(id TEXT,status TEXT); INSERT INTO jobs VALUES('work','pending');");db.close();
 fs.writeFileSync(path.join(source,'large.bin'),Buffer.alloc(4*1024**2,37));const expected=await inventory(source);
 const a=await createBackup({source,archive,password});assert.equal(a.treeHash,expected.treeHash);
 const restored=cli({op:'restore',archive,destination,password});assert.equal(restored.status,0,restored.stdout+restored.stderr);assert.deepEqual(await inventory(destination),expected);
 const state=restoreState(destination);assert.equal(state.automaticWork,false);assert.throws(()=>requireExternalAccess(destination),/EXTERNAL_ACCESS_PAUSED/);assert.throws(()=>activateRestore(destination,{restoreId:'wrong'}),/RESTORE_ID/);
 activateRestore(destination,{restoreId:state.id,automaticWork:true,externalAccess:true});requireExternalAccess(destination);
 const r=new DatabaseSync(path.join(destination,'records.sqlite3'));assert.equal(r.prepare('SELECT COUNT(*) n FROM history').get().n,2);assert.equal(r.prepare('SELECT status FROM jobs').get().status,'pending');r.close();
});
test('F31 wrong key, modified ciphertext/header/tag and truncation never publish',async()=>{
 const source=base('auth'),archive=path.join(lab,'auth.orbita');await createBackup({source,archive,password});const original=fs.readFileSync(archive);
 const cases=[['wrong',original,'another-test-password'],['cipher',Buffer.from(original),password],['header',Buffer.from(original),password],['tag',Buffer.from(original),password],['truncated',original.subarray(0,original.length-1),password]];
 cases[1][1][65]^=1;cases[2][1][20]^=1;cases[3][1][original.length-1]^=1;
 for(const [name,bytes,key] of cases){const file=path.join(lab,name+'.orbita'),destination=path.join(lab,name+'-restored');fs.writeFileSync(file,bytes);await assert.rejects(restoreBackup({archive:file,destination,password:key}),/AUTHENTICATION/);assert.equal(fs.existsSync(destination),false);}
 assert.deepEqual(fs.readFileSync(archive),original);
});
test('F31 authenticated malicious paths, aliases, reserved names and quotas fail closed',async()=>{
 for(const name of ['../outside','C:/escape','x\\y','NUL.txt','a/..','x.','a//b','/absolute'])assert.throws(()=>safeMember(name),/MEMBER_PATH/);
 const entries=[{type:'dir',path:'A'},{type:'dir',path:'a'}],file=malicious('alias.orbita',entries);await assert.rejects(restoreBackup({archive:file,destination:path.join(lab,'alias-target'),password}),/ALIASED_MEMBER/);
 const traversal=malicious('traversal.orbita',[{type:'dir',path:'../outside'}]);await assert.rejects(restoreBackup({archive:traversal,destination:path.join(lab,'traversal-target'),password}),/MEMBER_PATH/);assert.equal(fs.existsSync(path.join(lab,'outside')),false);
 const source=base('quota'),archive=path.join(lab,'quota.orbita');fs.writeFileSync(path.join(source,'payload'),Buffer.alloc(100));await assert.rejects(createBackup({source,archive,password,maxBytes:20}),/QUOTA/);assert.equal(fs.existsSync(archive),false);
 await createBackup({source,archive,password});await assert.rejects(restoreBackup({archive,destination:path.join(lab,'quota-target'),password,maxBytes:20}),/QUOTA/);
});
test('F31 refuses overwrite, overlap, external case, aliases and corrupt canonical databases',async()=>{
 const source=base('safe'),archive=path.join(lab,'safe.orbita');await createBackup({source,archive,password});
 await assert.rejects(createBackup({source,archive,password}),/DESTINATION_EXISTS/);await assert.rejects(createBackup({source,archive:path.join(source,'nested.orbita'),password}),/OVERLAP/);
 await assert.rejects(restoreBackup({archive,destination:source,password}),/DESTINATION_EXISTS/);
 const external=base('external');fs.writeFileSync(path.join(external,'library.json'),JSON.stringify([{id:'outside',path:source}]));await assert.rejects(createBackup({source:external,archive:path.join(lab,'external.orbita'),password}),/EXTERNAL_CASE/);
 const broken=base('broken');fs.writeFileSync(path.join(broken,'canonical.sqlite3'),'not sqlite');await assert.rejects(createBackup({source:broken,archive:path.join(lab,'broken.orbita'),password}));
 const links=base('links');fs.linkSync(path.join(links,'library.json'),path.join(links,'alias.json'));await assert.rejects(createBackup({source:links,archive:path.join(lab,'links.orbita'),password}),/NON_REGULAR/);
 const junction=base('junction');fs.symlinkSync(source,path.join(junction,'external'),process.platform==='win32'?'junction':'dir');await assert.rejects(createBackup({source:junction,archive:path.join(lab,'junction.orbita'),password}),/LINK/);
 await assert.rejects(restoreBackup({archive,destination:path.join(junction,'external','new'),password}),/LINK/);
});
test('F31 live Node and independent Python processes exclude backup; dead owners recover',async()=>{
 const source=base('busy'),archive=path.join(lab,'busy.orbita');
 const code=`import {useStore} from ${JSON.stringify(new URL('./store-access.mjs',import.meta.url).href)};useStore(${JSON.stringify(source)});process.stdout.write('READY');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise(resolve=>child.stdout.once('data',resolve));
 try{await assert.rejects(createBackup({source,archive,password}),/STORE_BUSY/);}finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));}
 const pcode=`import sys,time;sys.path.insert(0,${JSON.stringify(path.resolve(here,'../agent-forensic-handoff/python'))});from store_access import use_store;use_store(${JSON.stringify(source)});print('READY',flush=True);time.sleep(120)`;
 const python=spawn('python',['-B','-c',pcode],{windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise(resolve=>python.stdout.once('data',resolve));
 try{await assert.rejects(createBackup({source,archive,password}),/STORE_BUSY/);}finally{python.kill();await new Promise(resolve=>python.once('exit',resolve));}
 await createBackup({source,archive,password});
 const unlock=exclusiveStore(source);try{const r=cli({op:'backup',source,archive:path.join(lab,'other.orbita'),password});assert.equal(r.status,1);assert.match(r.stdout,/STORE_BUSY/);}finally{unlock();}
});
test('F31 terminated backup/restore never publishes partial data; a fresh retry is safe',async()=>{
 const source=base('crash'),archive=path.join(lab,'crash.orbita');
 let r=cli({op:'backup',source,archive,password},{AFH_RECOVERY_CRASH_AT:'backup-before-publish'});assert.equal(r.status,86,r.stdout+r.stderr);assert.equal(fs.existsSync(archive),false);
 r=cli({op:'backup',source,archive,password});assert.equal(r.status,0,r.stdout+r.stderr);
 const destination=path.join(lab,'crash-target');r=cli({op:'restore',archive,destination,password},{AFH_RECOVERY_CRASH_AT:'restore-before-publish'});assert.equal(r.status,86,r.stdout+r.stderr);assert.equal(fs.existsSync(destination),false);
 r=cli({op:'restore',archive,destination,password});assert.equal(r.status,0,r.stdout+r.stderr);assert.deepEqual(await inventory(destination),await inventory(source));
 const after=path.join(lab,'crash-after');r=cli({op:'restore',archive,destination:after,password},{AFH_RECOVERY_CRASH_AT:'restore-after-publish'});assert.equal(r.status,86,r.stdout+r.stderr);assert.deepEqual(await inventory(after),await inventory(source));assert.equal(restoreState(after).automaticWork,false);
 const published=path.join(lab,'published.orbita');r=cli({op:'backup',source,archive:published,password},{AFH_RECOVERY_CRASH_AT:'backup-after-publish'});assert.equal(r.status,86,r.stdout+r.stderr);
 r=cli({op:'restore',archive:published,destination:path.join(lab,'published-restored'),password});assert.equal(r.status,0,r.stdout+r.stderr);
});

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {requestRole} from './access-policy.mjs';
const app=path.dirname(fileURLToPath(import.meta.url));
const root=fs.mkdtempSync('C:/T/orbita-volume-api-');process.env.AFH_COSMOS_DATA=root;
const {volumeOperation}=await import('./volume.mjs');const {importDocument}=await import('./documents.mjs');
let sourceA,sourceB;
test.before(async()=>{sourceA=await importDocument({documentId:'volume-alpha',filename:'alpha.md',content:'Regla declarada: publicar sólo con revisión. Café y 漢字.',metadata:{title:'Regla Alfa'}});sourceB=await importDocument({documentId:'volume-beta',filename:'beta.md',content:'Retirada posterior: no hay permiso vigente demostrado.',metadata:{title:'Retirada Beta'}});});
async function sync(){for(let i=0;i<50;i++){const r=await volumeOperation({op:'sync'});if(r.ready)return r;}throw new Error('sync did not finish');}
test('F36 operational delta, signed pages, restore, real Parquet and PostgreSQL contract suite',()=>{
 const output=execFileSync(process.env.AFH_VOLUME_PYTHON||'python',['-X','utf8','-B',path.join(app,'test_volume_store.py')],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:180000});
 const receipt=JSON.parse(output);assert.equal(receipt.status,'PASS');assert.equal(receipt.tests,21);assert.equal(receipt.skipped,0);console.log('F36 Python contract checks: '+JSON.stringify(receipt));
});
test('F36 managed allowlist classifies local operations and rejects external projection',()=>{
 for(const op of ['status','page','verify'])assert.equal(requestRole('POST','/api/volume',{op}),'reader');
 for(const op of ['sync','lake'])assert.equal(requestRole('POST','/api/volume',{op}),'editor');
 for(const body of [{op:'postgres'},{op:'page',backend:'postgres'},{op:'unknown'}])assert.throws(()=>requestRole('POST','/api/volume',body),/ACCESS_/);
});

test('F36 missing worker dependency fails explicitly and releases the operation lock',async()=>{
 const previous=process.env.AFH_VOLUME_PYTHON;process.env.AFH_VOLUME_PYTHON=path.join(root,'missing-python.exe');
 try{await assert.rejects(volumeOperation({op:'status'}),/VOLUME_PYTHON_UNAVAILABLE/);}finally{if(previous===undefined)delete process.env.AFH_VOLUME_PYTHON;else process.env.AFH_VOLUME_PYTHON=previous;}
 assert.equal((await volumeOperation({op:'status'})).sources,2);
});
test('F36 indexes actual originals without losing a withdrawal or Unicode and resumes exact pages',async()=>{
 await assert.rejects(volumeOperation({op:'page'}),/PROJECTION_PENDING/);const ready=await sync();assert.equal(ready.records,4);
 let cursor=null,rows=[];do{const p=await volumeOperation({op:'page',limit:1,cursor});assert.equal(p.originalsVerified,true);assert.equal(p.executionAuthority,false);rows.push(...p.rows);cursor=p.cursor;}while(cursor);
 assert.equal(new Set(rows.map(x=>x.uri)).size,4);assert.ok(rows.some(x=>x.raw.includes('漢字')));assert.ok(rows.some(x=>x.raw.includes('no hay permiso vigente')));
 const only=await volumeOperation({op:'page',sourceIds:[sourceB.id],query:'Retirada posterior'});assert.equal(only.rows.length,1);assert.equal(only.rows[0].sourceId,sourceB.id);
 assert.equal((await volumeOperation({op:'sync'})).added,0);
});
test('F36 rejects forged selection and cursors and suspends paging across a new document revision',async()=>{
 const first=await volumeOperation({op:'page',limit:1});await assert.rejects(volumeOperation({op:'page',cursor:first.cursor+'x'}),/CURSOR/);await assert.rejects(volumeOperation({op:'page',sourceIds:['foreign']}),/SELECTION/);
 await importDocument({documentId:'volume-alpha',expectedRevision:1,filename:'alpha.md',content:'Versión posterior: la regla queda suspendida; requiere nueva revisión.'});
 await assert.rejects(volumeOperation({op:'page',cursor:first.cursor}),/PROJECTION_PENDING/);await sync();await assert.rejects(volumeOperation({op:'page',cursor:first.cursor}),/CURSOR_STALE/);
 const now=await volumeOperation({op:'page'});assert.equal(now.rows.length,6);assert.ok(now.rows.some(x=>x.raw.includes('queda suspendida')));assert.ok(now.rows.some(x=>x.raw.includes('publicar sólo')));
});
test('F36 rechecks canonical source bytes after projection and rejects tampered originals',async()=>{
 const file=path.join(root,'cases',sourceB.id,'acquisition/document/original.bin'),before=fs.readFileSync(file);fs.appendFileSync(file,'changed');
 try{for(const op of ['page','lake','verify'])await assert.rejects(volumeOperation({op}),/SOURCE_INTEGRITY/);}finally{fs.writeFileSync(file,before);}
 assert.equal((await volumeOperation({op:'page'})).rows.length,6);
});
test('F36 managed process and restore fence prohibit PostgreSQL even with a host config',async()=>{
 const prior=process.env.AFH_MANAGED;process.env.AFH_MANAGED='1';try{await assert.rejects(volumeOperation({op:'postgres'}),/MANAGED_POSTGRES_NOT_ADMITTED/);}finally{if(prior===undefined)delete process.env.AFH_MANAGED;else process.env.AFH_MANAGED=prior;}
 const signal=AbortSignal.abort();await assert.rejects(volumeOperation({op:'status'},{signal}),/CANCELLED/);assert.equal((await volumeOperation({op:'status'})).ready,true);
});
test('F36 complete encrypted restore recovers new operational rows, page cursors and real lake',async()=>{
 await volumeOperation({op:'lake'});assert.equal((await volumeOperation({op:'verify'})).records,6);const page=await volumeOperation({op:'page',limit:1});
 const {createBackup,restoreBackup}=await import('./recovery.mjs');const parent=fs.mkdtempSync('C:/T/orbita-volume-restore-'),archive=path.join(parent,'snapshot.orbita'),destination=path.join(parent,'restored'),password='fixture-volume-restore-password';
 await createBackup({source:root,archive,password,ownSession:true});await restoreBackup({archive,destination,password});
 const result=JSON.parse(execFileSync(process.execPath,[path.join(app,'volume-cli.mjs')],{input:JSON.stringify({op:'page',limit:200,cursor:page.cursor}),encoding:'utf8',env:{...process.env,AFH_COSMOS_DATA:destination},windowsHide:true,timeout:120000}));
 assert.equal(result.rows.length,5);assert.equal(result.originalsVerified,true);
 const lake=JSON.parse(execFileSync(process.execPath,[path.join(app,'volume-cli.mjs')],{input:'{"op":"verify"}',encoding:'utf8',env:{...process.env,AFH_COSMOS_DATA:destination},windowsHide:true,timeout:120000}));assert.equal(lake.records,6);
 assert.throws(()=>execFileSync(process.execPath,[path.join(app,'volume-cli.mjs')],{input:'{"op":"postgres"}',encoding:'utf8',env:{...process.env,AFH_COSMOS_DATA:destination},windowsHide:true,timeout:30000,stdio:['pipe','pipe','pipe']}),/RECOVERY_EXTERNAL_ACCESS_PAUSED/);
});

test('F36 real managed workers isolate volume, enforce current roles and restore lake without restoring access',async()=>{
 const {AccessStore}=await import('./access-store.mjs'),{createAccessServer}=await import('./access-server.mjs');
 const managedRoot=fs.mkdtempSync('C:/T/orbita-volume-managed-'),store=new AccessStore(managedRoot,{create:true});
 const password='synthetic-volume-managed-password',owner=store.createAccount('owner',password,{admin:true}),reader=store.createAccount('reader',password),other=store.createAccount('other',password);
 const policy={basis:'Synthetic F36 fixtures',purpose:'Verify local projection isolation and restore',rightsUntil:new Date(Date.now()+86400000).toISOString(),retainUntil:new Date(Date.now()+86400000).toISOString()};
 const a=store.createWorkspace(owner.id,{name:'Volume Alpha',policy}),b=store.createWorkspace(other.id,{name:'Volume Beta',policy});store.grant(owner.id,a.id,'reader','reader');
 const ownerToken=store.issue(owner.id,{workspace:a.id}).token,readerToken=store.issue(reader.id,{workspace:a.id}).token,otherToken=store.issue(other.id,{workspace:b.id}).token;store.close();
 const server=createAccessServer({root:managedRoot,port:0});await new Promise(r=>server.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.server.address().port;
 const call=async(token,route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 const volume=(token,body)=>call(token,'/api/volume',body);
 try{
  for(const [token,text] of [[ownerToken,'VOLUME-ALPHA-ONLY'],[otherToken,'VOLUME-BETA-ONLY']]){assert.equal((await call(token,'/api/documents',{filename:'source.md',content:text})).status,200);for(let i=0;i<10;i++){const r=await volume(token,{op:'sync'});assert.equal(r.status,200,JSON.stringify(r.value));if(r.value.ready)break;}assert.equal((await volume(token,{op:'lake'})).status,200);}
  const page=await volume(readerToken,{op:'page'});assert.equal(page.status,200);assert.ok(JSON.stringify(page.value).includes('VOLUME-ALPHA-ONLY'));assert.ok(!JSON.stringify(page.value).includes('VOLUME-BETA-ONLY'));
  for(const body of [{op:'sync'},{op:'lake'},{op:'postgres'},{op:'page',backend:'postgres'}])assert.equal((await volume(readerToken,body)).status,403);
  assert.equal((await volume(ownerToken,{op:'postgres'})).status,403);assert.equal((await volume(ownerToken,{op:'status'})).value.postgresConfigured,false);
  const foreign=(await volume(otherToken,{op:'page'})).value.rows[0].sourceId;assert.ok((await volume(readerToken,{op:'page',sourceIds:[foreign]})).status>=400);
  const backup=await call(ownerToken,'/access/api/backup',{id:a.id,password});assert.equal(backup.status,200,JSON.stringify(backup.value));
  server.store.revoke(owner.id,a.id,reader.id);assert.equal((await volume(readerToken,{op:'page'})).status,401);
  const restored=await call(ownerToken,'/access/api/restore',{id:a.id,backupId:backup.value.id,password});assert.equal(restored.status,200,JSON.stringify(restored.value));assert.equal(restored.value.revocationsPreserved,true);
  assert.deepEqual((await volume(ownerToken,{op:'page'})).value.rows,page.value.rows);assert.equal((await volume(ownerToken,{op:'verify'})).value.records,page.value.rows.length);assert.equal((await volume(readerToken,{op:'page'})).status,401);
  assert.ok(JSON.stringify((await volume(otherToken,{op:'page'})).value).includes('VOLUME-BETA-ONLY'));
 }finally{await server.close();}
});

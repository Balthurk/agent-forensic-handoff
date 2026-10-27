import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const app=path.dirname(fileURLToPath(import.meta.url)),root=fs.mkdtempSync('C:/T/orbita-retro-test-');process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {retrospectiveOperation:op}=await import('./retrospectives.mjs'),{importDocument}=await import('./documents.mjs'),{requestRole}=await import('./access-policy.mjs');let ids,source,first,page;
const body=()=>({title:'Política y memoria retrospectiva',subjectAt:'2020-01-01T00:00:00Z',sourceCut:new Date(Date.now()+60000).toISOString(),actor:'tester',reason:'Interpretación local explícita',state:'active',claims:[{key:'rule',text:'La política requiere revisión.',position:'supports',evidence:[{sourceId:source.id,quote:'La política exige revisión.'}]}],gaps:['No se demuestra vigencia actual.'],personalReports:[]});
test.before(async()=>{const doc=await importDocument({documentId:'retro-fixture',filename:'regla.md',content:'La política exige revisión. Alice recibió el aviso el 2020-01-01.',metadata:{title:'Documento retrospectivo'}});ids=[doc.id];source=(await op('sources',{conversationIds:ids,question:'La política'})).items[0];});
test('F33 durable composition, source clocks and exact historical exclusion through facade',async()=>{
 const detail=body();first=await op('put',{conversationIds:ids,id:'one',detail,requestId:'one'});assert.equal(first.personalKnowledge,'not_established');assert.equal(first.lateSources.length,1);
 assert.equal((await op('query',{conversationIds:ids,view:'system_history',knownAt:'2020-02-01T00:00:00Z'})).total,0);
 const retry=await op('put',{conversationIds:ids,id:'one',detail,requestId:'one'});assert.deepEqual(retry,first);
 for(let i=2;i<=3;i++)await op('put',{conversationIds:ids,id:'entry'+i,detail:body(),requestId:'entry'+i});
 page=await op('query',{conversationIds:ids,limit:1});assert.equal(page.total,3);assert.ok(page.nextCursor);assert.equal(page.items.length,1);
});
test('F33 signed whole-item pages reject forged cursors, selection and sources',async()=>{
 const next=await op('page',{conversationIds:ids,snapshotId:page.snapshotId,cursor:page.nextCursor,limit:1});assert.equal(next.items.length,1);
 await assert.rejects(op('page',{conversationIds:ids,snapshotId:page.snapshotId,cursor:page.nextCursor+'x',limit:1}),/CURSOR/);
 await assert.rejects(op('page',{conversationIds:['foreign'],snapshotId:page.snapshotId}),/SELECTION_MISMATCH/);
 await assert.rejects(op('original',{conversationIds:ids,snapshotId:page.snapshotId,index:0,sourceId:'wrong'}),/ORIGINAL_NOT_IN_ITEM/);
 const r=await op('original',{conversationIds:ids,snapshotId:page.snapshotId,index:0,sourceId:source.id});assert.ok(r.original.text.includes('Alice'));
 const small=await op('query',{conversationIds:ids,maxBytes:4096});assert.equal(small.items.length,0);assert.ok(small.omissions.length);assert.ok(small.bytes<=4096);
});
test('F33 changes preserve old snapshot and label its freshness without silently rewriting it',async()=>{
 const detail=body();detail.state='withdrawn';await op('put',{conversationIds:ids,id:'one',detail,expectedVersion:1,binding:first.reference,requestId:'withdraw'});
 const old=await op('page',{conversationIds:ids,snapshotId:page.snapshotId,limit:1});assert.equal(old.freshness.current,false);assert.equal(old.status,'stale_cut');
 assert.deepEqual((await op('get',{conversationIds:ids,id:'one',version:1})).reference,first.reference);
});
test('F33 complete encrypted restore resumes snapshot and original in a separate process',async()=>{
 const {createBackup,restoreBackup}=await import('./recovery.mjs');const lab=fs.mkdtempSync('C:/T/orbita-retro-restore-'),archive=path.join(lab,'snapshot.orbita'),destination=path.join(lab,'restored'),password='fixture-retro-restore-password';
 await createBackup({source:root,archive,password,ownSession:true});await restoreBackup({archive,destination,password});const request=path.join(lab,'request.json');fs.writeFileSync(request,JSON.stringify({op:'page',conversationIds:ids,snapshotId:page.snapshotId,cursor:page.nextCursor,limit:1}));
 const restored=JSON.parse(execFileSync(process.execPath,[path.join(app,'memory-cli.mjs'),'retrospectives',request],{env:{...process.env,AFH_COSMOS_DATA:destination},encoding:'utf8',windowsHide:true,timeout:60000}));
 assert.deepEqual(restored,await op('page',JSON.parse(fs.readFileSync(request))));
});
test('F33 authenticated operation allowlist separates writes and defaults closed',()=>{
 assert.equal(requestRole('POST','/api/retrospectives',{op:'query'}),'reader');assert.equal(requestRole('POST','/api/retrospectives',{op:'put'}),'editor');assert.throws(()=>requestRole('POST','/api/retrospectives',{op:'purge'}),/ACCESS_/);
});
test('F33 unrelated compositions do not invalidate a selected source context fingerprint',async()=>{
 const {contextState}=await import('./context.mjs');const doc=await importDocument({documentId:'unrelated',filename:'other.md',content:'Original independiente.'});const unrelated=[doc.id],before=await contextState(unrelated);
 await op('put',{conversationIds:ids,id:'extra',detail:body(),requestId:'extra'});
 assert.deepEqual(await contextState(unrelated),before);
});
test('F33 two real managed workers keep scope and revocation outside restored content',async()=>{
 const {AccessStore}=await import('./access-store.mjs'),{createAccessServer}=await import('./access-server.mjs');const managed=fs.mkdtempSync('C:/T/orbita-retro-managed-'),store=new AccessStore(managed,{create:true});
 const password='synthetic-retro-managed-password',owner=store.createAccount('owner',password,{admin:true}),reader=store.createAccount('reader',password),other=store.createAccount('other',password);
 const policy={basis:'Synthetic F33 tests',purpose:'Verify retrospective scope',rightsUntil:new Date(Date.now()+86400000).toISOString(),retainUntil:new Date(Date.now()+86400000).toISOString()};
 const a=store.createWorkspace(owner.id,{name:'Retro Alpha',policy}),b=store.createWorkspace(other.id,{name:'Retro Beta',policy});store.grant(owner.id,a.id,'reader','reader');const at=store.issue(owner.id,{workspace:a.id}).token,rt=store.issue(reader.id,{workspace:a.id}).token,bt=store.issue(other.id,{workspace:b.id}).token;store.close();
 const server=createAccessServer({root:managed,port:0});await new Promise(r=>server.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.server.address().port;
 const call=async(token,route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 try{
  const doc=await call(at,'/api/documents',{filename:'evidence.md',content:'La política exige revisión. Fuentes exclusivas de Alpha.'});assert.equal(doc.status,200);const selection=[doc.value.result.id];const sources=await call(at,'/api/retrospectives',{op:'sources',conversationIds:selection,question:'La política'});assert.equal(sources.status,200,JSON.stringify(sources));const detail=body();detail.claims[0].evidence[0].sourceId=sources.value.items[0].id;
  const write={op:'put',conversationIds:selection,id:'managed',detail,requestId:'managed'};assert.equal((await call(rt,'/api/retrospectives',write)).status,403);assert.equal((await call(at,'/api/retrospectives',write)).status,200);
  const query={op:'query',conversationIds:selection};const q=await call(rt,'/api/retrospectives',query);assert.equal(q.value.total,1);assert.ok((await call(bt,'/api/retrospectives',query)).status>=400);
  const backup=await call(at,'/access/api/backup',{id:a.id,password});assert.equal(backup.status,200);server.store.revoke(owner.id,a.id,reader.id);assert.equal((await call(rt,'/api/retrospectives',query)).status,401);
  const restored=await call(at,'/access/api/restore',{id:a.id,backupId:backup.value.id,password});assert.equal(restored.status,200);assert.equal(restored.value.revocationsPreserved,true);assert.equal((await call(at,'/api/retrospectives',query)).value.total,1);assert.equal((await call(rt,'/api/retrospectives',query)).status,401);
 }finally{await server.close();}
});

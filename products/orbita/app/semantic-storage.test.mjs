import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';import fs from 'node:fs';import path from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
test('F36 real semantic PostgreSQL migration, F22 evidence, current permissions, CAS and fresh-process SQLite restore',()=>{
 const result=JSON.parse(execFileSync(process.env.AFH_VOLUME_PYTHON||'python',['-X','utf8','-B',fileURLToPath(new URL('./test_semantic_postgres.py',import.meta.url))],{env:process.env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:180000}));
 assert.equal(result.status,'PASS');assert.equal(result.tests,21);assert.equal(result.skipped,0);console.log('F36 semantic PostgreSQL included checks: '+JSON.stringify(result));
});
test('F36 whole application retrieval and encrypted restore preserve a PostgreSQL context page in a new process',async()=>{
 const config=JSON.parse(fs.readFileSync(process.env.AFH_SEMANTIC_PG_TEST_CONFIG,'utf8')),lab=fs.mkdtempSync(path.join(config.testRoot,'application-')),root=path.join(lab,'data');process.env.AFH_COSMOS_DATA=root;
 const {graphFixture}=await import('./graph-fixture.mjs'),{ids}=await graphFixture();
 const {discoverContext,contextPage}=await import('./context.mjs'),{retrievePackage,closeMemory}=await import('./memory.mjs');
 const options={mode:'lexical',knownAt:'2099-01-01T00:00:00Z',validAt:'2026-10-25T00:00:00Z'};
 const before=await discoverContext('revisar contexto',ids,options);
 const cfg=path.join(lab,'connection.json');config.roots={[root]:{namespace:randomUUID().replaceAll('-',''),active:false}};fs.writeFileSync(cfg,JSON.stringify(config));process.env.AFH_SEMANTIC_PG_CONFIG=cfg;
 const python=process.env.AFH_VOLUME_PYTHON,cli=fileURLToPath(new URL('../agent-forensic-handoff/python/semantic-storage-cli.py',import.meta.url));
 const {useStore}=await import('./store-access.mjs');useStore(root).release();
 const migration=JSON.parse(execFileSync(python,['-I','-B',cli],{input:JSON.stringify({op:'migrate',root})+'\n',encoding:'utf8',windowsHide:true}));assert.equal(migration.ok,true);useStore(root);
 const after=await discoverContext('revisar contexto',ids,options);assert.deepEqual(after,before);
 const result=await retrievePackage('revisar contexto',ids,options);assert.ok(result.context.snapshot);const request={id:result.context.snapshot.id,conversationIds:ids,limit:1};const page=await contextPage(request);assert.equal(page.freshness.current,true);assert.ok(page.items.length);
 const {createBackup,restoreBackup}=await import('./recovery.mjs'),archive=path.join(lab,'verified.orbita'),destination=path.join(lab,'restored'),password=randomBytes(24).toString('hex');
 await createBackup({source:root,archive,password,ownSession:true});await restoreBackup({archive,destination,password});
 const reader=path.join(lab,'read-restored.mjs');fs.writeFileSync(reader,`import {contextPage} from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./context.mjs',import.meta.url))).href)};console.log(JSON.stringify(await contextPage(${JSON.stringify(request)})));`);
 const restored=JSON.parse(execFileSync(process.execPath,[reader],{env:{...process.env,AFH_COSMOS_DATA:destination},encoding:'utf8',windowsHide:true,timeout:60000}));assert.deepEqual(restored,page);
 await closeMemory();delete process.env.AFH_SEMANTIC_PG_CONFIG;
});

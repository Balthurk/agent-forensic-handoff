import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import native from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import fs from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore,commonWorkerConfiguration,DatabaseSync} from '../agent-forensic-handoff/src/common-store.js';
import {commonWorkerEnv} from './common-worker-env.mjs';
import {runOwnedProcess,providerEnvironment} from './owned-process.mjs';

const PYROOT=fileURLToPath(new URL('../agent-forensic-handoff/python/',import.meta.url));
test.after(()=>{const closed=closeCommonStore();assert.ok(closed.alreadyClosed||(closed.drained&&closed.ownedExit===0));});

test('F36 original21 semantic guarantees, evidence, current permissions, CAS and fresh-process common restore',()=>{
 const result=JSON.parse(execFileSync(process.env.ORBITA_POSTGRES_PYTHON,['-X','utf8','-B',fileURLToPath(new URL('./test_semantic_postgres.py',import.meta.url))],{env:process.env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:180000}));
 assert.equal(result.status,'PASS');assert.equal(result.tests,21);assert.equal(result.skipped,0);console.log('F36 semantic PostgreSQL included checks: '+JSON.stringify(result));
});

test('F36 whole application retrieval and encrypted restore preserve a PostgreSQL context page in a new process',async()=>{
 fs.mkdirSync(process.env.ORBITA_POSTGRES_TEST_ROOT,{recursive:true});
 const lab=fs.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'application-')),root=path.join(lab,'data');
 const nativeLab=native.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'legacy-application-')),originalRoot=path.join(nativeLab,'data');native.mkdirSync(originalRoot);
 const generator=path.join(PYROOT,'legacy_fixtures/i05_application/generate.mjs');
 const oracle=await runOwnedProcess(process.execPath,[generator,originalRoot],{env:{...providerEnvironment(),AFH_COSMOS_DATA:originalRoot,AFH_COSMOS_EMPTY_LIBRARY:'1',AFH_PYTHON:process.env.ORBITA_POSTGRES_PYTHON,AFH_VOLUME_PYTHON:process.env.ORBITA_POSTGRES_PYTHON,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'},timeout:60000,stdoutLimit:16*1024**2,stderrLimit:1024**2});
 assert.equal(oracle.code,0,oracle.stderr);assert.equal(oracle.closed,true);const original=JSON.parse(oracle.stdout);
 assert.equal(original.originalSourcesUnchanged,true);assert.match(original.sqliteVersion,/^3\./);assert.equal(original.schema,'orbita-i05-application-result-1');
 native.writeFileSync(path.join(nativeLab,'ORACLE.json'),JSON.stringify(original,null,2));
 const configuration=commonWorkerConfiguration(lab),workerEnv=commonWorkerEnv(configuration,{data:root});
 const imported=await runOwnedProcess(process.env.ORBITA_POSTGRES_PYTHON,['-I','-X','utf8','-B',path.join(PYROOT,'legacy_import_fixture.py')],{env:workerEnv,input:JSON.stringify({plan:original.plan,destination:root,stage:path.join(lab,'staging'),vectorExtension:process.env.ORBITA_LEGACY_VEC_EXTENSION})+'\n',timeout:180000,stdoutLimit:16*1024**2,stderrLimit:1024**2});
 assert.equal(imported.code,0,imported.stderr);assert.equal(imported.closed,true);const receipt=JSON.parse(imported.stdout);assert.equal(receipt.status,'PASS_EXPLICIT_IMPORT');assert.ok(receipt.derivations.length>=5);
 native.writeFileSync(path.join(nativeLab,'IMPORT.json'),JSON.stringify(receipt,null,2));
 process.env.AFH_COSMOS_DATA=root;
 const {verifyCaseIntegrity}=await import('../agent-forensic-handoff/src/integrity.js');
 const {verifySemanticProjection}=await import('../agent-forensic-handoff/src/semantic.js');
 for(const item of JSON.parse(fs.readFileSync(path.join(root,'library.json'),'utf8'))){
  const check=await verifyCaseIntegrity(item.path);assert.equal(check.passed,true,JSON.stringify(check.findings.filter(f=>!f.ok)));
 }
 const projectionRoot=path.join(root,original.projectionRelative),caseRoot=path.dirname(path.dirname(projectionRoot));
 const projectionFile=path.join(projectionRoot,'projection.json'),projectionBytes=fs.readFileSync(projectionFile),projection=JSON.parse(projectionBytes);
 // I05 creates the five nullable columns even for previews. Claiming they
 // were absent must not make the independent original hash pass.
 assert.equal(projection.storage.legacyProjectionHash,undefined);
 const legacyClaim={...projection,storage:{...projection.storage,legacyProjectionHash:{schema:'sqlite-preview-without-fulltext-columns-1',absentColumns:['start_cp','end_cp','token_count','representation_id','source_text_sha256']}}};
 fs.writeFileSync(projectionFile,JSON.stringify(legacyClaim));
 const wrongFormat=await verifySemanticProjection(caseRoot,projectionRoot);assert.equal(wrongFormat.passed,false);assert.ok(wrongFormat.findings.some(f=>f.check==='semantic.projection_hash'&&!f.ok));
 fs.writeFileSync(projectionFile,JSON.stringify({...legacyClaim,config:{...projection.config,representation:'full_source_text'}}));
 assert.equal((await verifySemanticProjection(caseRoot,projectionRoot)).passed,false);fs.writeFileSync(projectionFile,JSON.stringify(legacyClaim));
 const vectors=new DatabaseSync(path.join(projectionRoot,'semantic.pgstore'),{family:'vector'});
 try{vectors.prepare('UPDATE semantic_chunk SET start_cp=1').run();const invalid=await verifySemanticProjection(caseRoot,projectionRoot);assert.equal(invalid.passed,false);assert.ok(invalid.findings.some(f=>f.detail.includes('LEGACY_PROJECTION_COORDINATES_PRESENT')));vectors.prepare('UPDATE semantic_chunk SET start_cp=NULL').run();}finally{vectors.close();}
 fs.writeFileSync(projectionFile,projectionBytes);assert.equal((await verifySemanticProjection(caseRoot,projectionRoot)).passed,true);
 const {discoverContext,contextPage}=await import('./context.mjs');
 const {retrievePackage,closeMemory}=await import('./memory.mjs');
 const {ids,options,request}=original;
 assert.deepEqual(await discoverContext('revisar contexto',ids,options),original.before);
 assert.deepEqual(await contextPage(request),original.page);
 if(original.nextPage)assert.deepEqual(await contextPage({...request,cursor:original.page.nextCursor}),original.nextPage);
 const result=await retrievePackage('revisar contexto',ids,options);assert.ok(result.context.snapshot);
 const page=await contextPage({id:result.context.snapshot.id,conversationIds:ids,limit:1});assert.equal(page.freshness.current,true);assert.ok(page.items.length);assert.deepEqual(page,original.page);
 const {volumeCatalog,volumeOperation}=await import('./volume.mjs');
 assert.deepEqual(volumeCatalog(),original.volume.catalog);
 const volumeRequest={...original.volume.request,backend:'postgresql-common'};
 assert.deepEqual(await volumeOperation(volumeRequest),{...original.volume.page,backend:'postgresql-common'});
 assert.deepEqual(await volumeOperation({...volumeRequest,cursor:original.volume.page.cursor}),{...original.volume.nextPage,backend:'postgresql-common'});
 const analytical=await volumeOperation({...volumeRequest,backend:'postgresql-analytics'});assert.deepEqual(analytical.rows,original.volume.page.rows);
 assert.deepEqual((await volumeOperation({...volumeRequest,backend:'postgresql-analytics',cursor:analytical.cursor})).rows,original.volume.nextPage.rows);
 await assert.rejects(volumeOperation({...volumeRequest,backend:'postgresql-analytics',cursor:original.volume.page.cursor}),/CURSOR_STALE/);
 assert.equal((await volumeOperation({op:'verify'})).status,'VERIFIED');
 const library=JSON.parse(fs.readFileSync(path.join(root,'library.json'),'utf8')),caseFile=path.join(library[0].path,'case.json'),caseBytes=fs.readFileSync(caseFile),caseValue=JSON.parse(caseBytes);
 fs.writeFileSync(caseFile,JSON.stringify({...caseValue,storage:{...caseValue.storage,originalManifest:{...caseValue.storage.originalManifest,sha256:'0'.repeat(64)}}}));
 assert.throws(()=>volumeCatalog(),/LEGACY_MANIFEST_HASH/);fs.writeFileSync(caseFile,caseBytes);assert.deepEqual(volumeCatalog(),original.volume.catalog);
 const {createBackup,restoreBackup}=await import('./recovery.mjs');
 const archive=path.join(lab,'verified.orbita'),destination=path.join(lab,'restored'),password=randomBytes(24).toString('hex');
 await createBackup({source:root,archive,password,ownSession:true,archiveStorage:'postgresql-common'});await restoreBackup({archive,destination,password,archiveStorage:'postgresql-common'});
 const reader=path.join(nativeLab,'read-restored.mjs');
 native.writeFileSync(reader,`import {contextPage} from ${JSON.stringify(new URL('./context.mjs',import.meta.url).href)};import {volumeOperation} from ${JSON.stringify(new URL('./volume.mjs',import.meta.url).href)};import {closeCommonStore} from ${JSON.stringify(new URL('../agent-forensic-handoff/src/common-store.js',import.meta.url).href)};import {useStore} from ${JSON.stringify(new URL('./store-access.mjs',import.meta.url).href)};try{console.log(JSON.stringify({context:await contextPage(${JSON.stringify(request)}),volume:await volumeOperation(${JSON.stringify(volumeRequest)}),volumeNext:await volumeOperation(${JSON.stringify({...volumeRequest,cursor:original.volume.page.cursor})})}));}finally{useStore(process.env.AFH_COSMOS_DATA).release();const closed=closeCommonStore();if(!closed.drained||closed.ownedExit!==0)throw new Error('READER_CLOSE_UNVERIFIED');}`);
 const restored=await runOwnedProcess(process.execPath,[reader],{env:commonWorkerEnv(configuration,{data:destination}),timeout:60000,stdoutLimit:16*1024**2,stderrLimit:1024**2});
 assert.equal(restored.code,0,restored.stderr);assert.equal(restored.closed,true);const restoredResult=JSON.parse(restored.stdout);assert.deepEqual(restoredResult.context,original.page);assert.deepEqual(restoredResult.volume,{...original.volume.page,backend:'postgresql-common'});assert.deepEqual(restoredResult.volumeNext,{...original.volume.nextPage,backend:'postgresql-common'});
 for(const entry of original.plan.entries)assert.equal(createHash('sha256').update(native.readFileSync(path.join(originalRoot,entry.source))).digest('hex'),entry.sha256);
 await closeMemory();const {useStore}=await import('./store-access.mjs');useStore(root).release();assert.equal(native.existsSync(lab),false);
});

import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import fs from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openDB,writeDurable} from './durable.mjs';
import {hasSemanticStorage,semanticStorageState,semanticExportGuard} from './semantic-storage.mjs';
import {semanticModelStatus,createTransformersProvider} from '../agent-forensic-handoff/src/semantic-model.js';

assert.ok(process.env.ORBITA_POSTGRES_TEST_ROOT&&process.env.ORBITA_POSTGRES_TEST_RECEIPTS);
const APP=path.dirname(fileURLToPath(import.meta.url)),PYROOT=path.resolve(APP,'../agent-forensic-handoff/python');
const nativeRoot=native.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'entrypoints-native-'));
fs.mkdirSync(process.env.ORBITA_POSTGRES_TEST_ROOT,{recursive:true});
const root=fs.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'entrypoints-'));
after(()=>{const closed=closeCommonStore();assert.equal(closed.drained,true);assert.equal(closed.ownedExit,0);assert.equal(native.existsSync(root),false);});
const python=(script,args=[])=>spawnSync(process.env.ORBITA_POSTGRES_PYTHON,['-I','-X','utf8','-B','-c',script,...args],{env:process.env,encoding:'utf8',windowsHide:true,timeout:15000});

test('PG01 compatibility durable writers persist objects and relational rows only in common storage',()=>{
 writeDurable(path.join(root,'complete.bin'),Buffer.from([0,255,12]));assert.deepEqual(fs.readFileSync(path.join(root,'complete.bin')),Buffer.from([0,255,12]));
 fs.mkdirSync(path.join(root,'semantic'));const db=openDB(path.join(root,'semantic','records.pgstore'),'semantic');
 try{assert.equal(db.prepare('SELECT count(*) AS n FROM record_versions').get().n,0);}finally{db.close();}
 const unregistered=path.join(nativeRoot,'not admitted','store.sqlite');assert.throws(()=>openDB(unregistered,'semantic'),/ORBITA_PG_/);assert.equal(native.existsSync(path.dirname(unregistered)),false);
});
test('PG01 semantic inspection reports verified common identity and bounded headers in a read snapshot',async()=>{
 assert.equal(hasSemanticStorage(root),true);const state=await semanticStorageState(root);
 assert.equal(state.backend,'postgresql-common');assert.equal(state.readOnly,true);assert.equal(state.storeHeadersOnly,true);assert.ok(state.instanceId&&state.workspaceId&&state.snapshot);
 assert.equal(state.stores.length,1);assert.equal(state.stores[0].path,'records.pgstore');assert.equal(state.stores[0].kind,'store');assert.ok(state.stores[0].storeId);assert.equal(native.existsSync(root),false);
});
test('PG01 a copied native storage marker cannot authorize a root or trigger a local fallback',async()=>{
 const copied=path.join(nativeRoot,'copied');native.mkdirSync(path.join(copied,'semantic'),{recursive:true});const marker=path.join(copied,'semantic','postgres-storage.json');native.writeFileSync(marker,'{"namespace":"synthetic"}');const before=native.readFileSync(marker);
 assert.throws(()=>hasSemanticStorage(copied),/ORBITA_PG_/);await assert.rejects(semanticStorageState(copied),/ORBITA_PG_/);assert.deepEqual(native.readFileSync(marker),before);assert.deepEqual(native.readdirSync(path.join(copied,'semantic')),['postgres-storage.json']);
});
test('PG01 old implicit migration and shadow export entrypoints require an explicit import or backup',async()=>{
 await assert.rejects(semanticExportGuard(root),/EXPLICIT_BACKUP_REQUIRED/);
 for(const op of ['migrate','export']){
  const result=spawnSync(process.env.ORBITA_POSTGRES_PYTHON,['-I','-X','utf8','-B',path.join(PYROOT,'semantic-storage-cli.py')],{input:JSON.stringify({root,op})+'\n',env:process.env,encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).error,'ORBITA_PG_EXPLICIT_LEGACY_IMPORT_OR_BACKUP_REQUIRED');
 }
 const destination=path.join(nativeRoot,'retired-backend','records.sqlite3');
 const script="import sys;sys.path.insert(0,sys.argv[1]);from afh_semantic import postgres_backend as b,postgres_migration as m;p=sys.argv[2]\nfor call in (lambda:b.connect(p),lambda:b.Connection(p,{}),lambda:b.binding(p),lambda:b.read_config(),lambda:b.raw_connect({}),lambda:b.atomic_json(p,{}),lambda:b.state(p),lambda:m.exclusive(p),lambda:m.migrate(p),lambda:m.export_held(p)):\n try:call()\n except RuntimeError as e:assert str(e) in ('ORBITA_PG_LEGACY_SEMANTIC_BACKEND_DISABLED','ORBITA_PG_EXPLICIT_LEGACY_IMPORT_OR_BACKUP_REQUIRED')\n else:raise AssertionError('retired entrypoint remained operational')\nprint('closed')";
 const direct=python(script,[PYROOT,destination]);assert.equal(direct.status,0,direct.stderr);assert.equal(direct.stdout.trim(),'closed');assert.equal(native.existsSync(path.dirname(destination)),false);
});
test('PG01 legacy SQLite deadline connector cannot create a file',()=>{
 const destination=path.join(nativeRoot,'must-not-create.sqlite');
 const script="import sys;sys.path.insert(0,sys.argv[1]);from afh_semantic.sqlite_runtime import _deadline_connect;\ntry:_deadline_connect(sys.argv[2])\nexcept RuntimeError as e:assert str(e)=='ORBITA_PG_LEGACY_SQLITE_RUNTIME_DISABLED';print('closed')\nelse:raise AssertionError('legacy writer remained active')";
 const result=python(script,[PYROOT,destination]);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'closed');assert.equal(native.existsSync(destination),false);
});
test('PG01 model status requires an explicit absolute runtime without inspecting a user cache',()=>{
 const previous=process.env.AFH_MODEL_HOME;delete process.env.AFH_MODEL_HOME;
 try{assert.throws(()=>semanticModelStatus(),/explicit absolute local model runtime/);assert.throws(()=>semanticModelStatus({modelHome:'relative-cache'}),/explicit absolute local model runtime/);const empty=path.join(nativeRoot,'empty runtime');assert.equal(semanticModelStatus({modelHome:empty}).available,false);assert.equal(native.existsSync(empty),false);}
 finally{if(previous===undefined)delete process.env.AFH_MODEL_HOME;else process.env.AFH_MODEL_HOME=previous;}
});
test('PG01 the qualified local model still produces finite vectors from its exact installed snapshot',async()=>{
 const provider=await createTransformersProvider({modelHome:process.env.AFH_MODEL_HOME});
 try{const vectors=await provider.embed(['Canario local sintético: café 漢字 😀.']);assert.equal(vectors.length,1);assert.equal(vectors[0].length,384);assert.ok(Array.from(vectors[0]).every(Number.isFinite));assert.equal(provider.identity.revision,'2c4055b12046f11709e9df2c122e59ffbdc2f900');assert.match(provider.identity.modelDigest,/^[a-f0-9]{64}$/);}
 finally{await provider.dispose?.();}
});
test('PG01 native Windows startup verifies the explicit common runtime and fails closed on invalid configuration',()=>{
 const shell=path.join(process.env.SystemRoot??process.env.SYSTEMROOT,'System32','WindowsPowerShell','v1.0','powershell.exe');assert.equal(native.existsSync(shell),true);
 const probe=(config,pythonPath=process.env.ORBITA_POSTGRES_PYTHON)=>spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(APP,'START.ps1'),'-Data',root,'-PostgresConfig',config,'-Python',pythonPath,'-Node',process.execPath,'-ModelHome',process.env.AFH_MODEL_HOME,'-CheckOnly'],{env:process.env,encoding:'utf8',windowsHide:true,timeout:30000});
 const result=probe(process.env.ORBITA_POSTGRES_CONFIG);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'READY');
 const bad=path.join(nativeRoot,'invalid-config.json');native.writeFileSync(bad,'{}');const failed=probe(bad);assert.notEqual(failed.status,0);assert.match(failed.stderr,/START_COMMON_RUNTIME_NOT_READY|ORBITA_PG_/);
 const missing=probe(process.env.ORBITA_POSTGRES_CONFIG,path.join(nativeRoot,'missing-python.exe'));assert.notEqual(missing.status,0);assert.match(missing.stderr,/START_EXPLICIT_PYTHON_REQUIRED/);assert.equal(native.existsSync(root),false);
});

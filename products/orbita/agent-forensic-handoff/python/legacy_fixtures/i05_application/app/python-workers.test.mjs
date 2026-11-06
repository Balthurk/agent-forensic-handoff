import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {pythonExecutable} from '../agent-forensic-handoff/src/python-runtime.js';

const app=pathToFileURL(path.dirname(fileURLToPath(import.meta.url))+path.sep).href;
function run(t,script){
 const parent=fs.realpathSync(process.env.AFH_TEST_ROOT||os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'orbita-i03-workers-'));
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),parent);assert.ok(path.basename(root).startsWith('orbita-i03-workers-'));fs.rmSync(root,{recursive:true,force:true});});
 const found=spawnSync(pythonExecutable(['AFH_VOLUME_PYTHON']),['-I','-c','import sys;print(sys.executable)'],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(found.status,0,found.stderr);
 const env={...process.env,AFH_PYTHON:found.stdout.trim(),AFH_COSMOS_DATA:path.join(root,'data with spaces'),AFH_COSMOS_EMPTY_LIBRARY:'1',PATH:path.join(root,'empty PATH')};
 for(const key of ['LOCALAPPDATA','NODE_OPTIONS','AFH_VOLUME_PYTHON','AFH_SEMANTIC_PYTHON','AFH_SQLITE_PYTHON','AFH_JEV_PYTHON','AFH_JEV_CONFIG','AFH_MANAGED','AFH_SEMANTIC_PG_CONFIG','AFH_G1_JANUS_CONFIG','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
 const prefix="import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';const app=process.argv[1],root=process.argv[2];";
 const result=spawnSync(process.execPath,['--input-type=module','-e',prefix+script,app,root],{env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2000000});
 assert.equal(result.status,0,JSON.stringify({error:result.error?.message,stdout:result.stdout,stderr:result.stderr}));return JSON.parse(result.stdout);
}
test('I03 common Python runs volume, semantic bridge and storage without Python on PATH or Codex',t=>{
 const result=run(t,`const {importDocument}=await import(app+'documents.mjs');const source=await importDocument({documentId:'i03-common',filename:'source.md',content:'Documento completo: café 漢字 😀 é.'});
 const {knowledgeOperation}=await import(app+'knowledge.mjs');assert.deepEqual(await knowledgeOperation('list',[source.id]),[]);
 const {volumeWorker}=await import(app+'volume.mjs');const volume=await volumeWorker({op:'status'});assert.equal(volume.storedRecords,0);
 const markerRoot=path.join(root,'storage selection fixture'),marker=path.join(markerRoot,'semantic');fs.mkdirSync(marker,{recursive:true});fs.writeFileSync(path.join(marker,'postgres-storage.json'),JSON.stringify({namespace:'a'.repeat(32)}));
 const {semanticStorageState}=await import(app+'semantic-storage.mjs');const state=await semanticStorageState(markerRoot);assert.equal(state.namespace,'a'.repeat(32));assert.deepEqual(state.stores,[]);
 process.env.AFH_VOLUME_PYTHON=path.join(root,'missing volume python.exe');await assert.rejects(volumeWorker({op:'status'}),/VOLUME_PYTHON_UNAVAILABLE/);
 process.env.AFH_SEMANTIC_PYTHON=path.join(root,'missing semantic python.exe');await assert.rejects(semanticStorageState(markerRoot),/SEMANTIC_STORAGE_PYTHON_UNAVAILABLE/);
 const {closeMemory}=await import(app+'memory.mjs');await closeMemory();console.log(JSON.stringify({volume:true,knowledge:true,storage:true,overridesPreserved:true,providerCalls:0}));`);
 assert.equal(result.volume&&result.knowledge&&result.storage&&result.overridesPreserved,true);assert.equal(result.providerCalls,0);
});
test('I03 Jev worker selects common Python through an isolated synthetic transport with no credentials',t=>{
 const result=run(t,`const {default:cp}=await import('node:child_process');const {syncBuiltinESMExports}=await import('node:module');let calls=0;
 const original=cp.spawn;const synthetic=\`import sys,json
r=json.load(sys.stdin);b=r['body'];answers={}
for key,value in b['questions'].items():
 answers[key]={'type':'choice','choice':'unknown','confidence':1,'probabilities':{k:1 if k=='unknown' else 0 for k in value['criteria']}} if value['type']=='choice' else {'type':'noul','noul':0.1}
print(json.dumps({'ok':True,'value':{'model':b['model'],'answers':answers,'usage':{'input_tokens':1,'output_tokens':1}}}))\`;
 cp.spawn=function(executable,args,options){if(args.some(x=>typeof x==='string'&&x.endsWith('jev-http.py'))){calls++;assert.equal(executable,process.env.AFH_PYTHON);assert.equal(options.shell,undefined);return original.call(this,executable,['-I','-B','-c',synthetic],options);}return original.call(this,executable,args,options);};syncBuiltinESMExports();
 const {initializeJev,prepareJev,invokeJev,JEV_MODEL}=await import(app+'jev.mjs');const {OPTIONS}=await import(app+'routing.mjs');const configPath=path.join(root,'synthetic budget','connection.json');fs.mkdirSync(path.dirname(configPath));fs.mkdirSync(process.env.AFH_COSMOS_DATA,{recursive:true});
 initializeJev(configPath,{schema:'orbita.jev-connection.v1',id:'synthetic-i03-common-python',model:JEV_MODEL,credentialReference:'TYPESAFE_API_KEY',inputTokenNanoUSD:42,maxCalls:1,maxNanoUSD:100000000,createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),allowedDataRoots:[process.env.AFH_COSMOS_DATA]});
 const received=await invokeJev(prepareJev('Pregunta sintética, sin proveedor',OPTIONS),{configPath});assert.equal(received.value.model,JEV_MODEL);assert.equal(calls,1);console.log(JSON.stringify({syntheticWorkerCalls:calls,realProviderCalls:0,credentialsRead:false}));`);
 assert.equal(result.syntheticWorkerCalls,1);assert.equal(result.realProviderCalls,0);assert.equal(result.credentialsRead,false);
});

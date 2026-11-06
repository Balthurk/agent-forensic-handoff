// Synthetic qualification helpers: explicit native request/backup artifacts,
// common operational objects, and process crashes in the actual Python bridge.
import native from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync,spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';
import fs from '../agent-forensic-handoff/src/common-files.js';
import {commonWorkerConfiguration} from '../agent-forensic-handoff/src/common-store.js';
import {commonWorkerEnv} from './common-worker-env.mjs';
import {terminateOwned} from './owned-process.mjs';
const app=path.dirname(fileURLToPath(import.meta.url));
const moduleURL=name=>new URL(name,import.meta.url).href;
export function lab(prefix){fs.mkdirSync(process.env.ORBITA_POSTGRES_TEST_ROOT,{recursive:true});return fs.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,prefix));}
export const environment=data=>commonWorkerEnv(commonWorkerConfiguration(data),{data});
export function artifact(prefix){return native.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,prefix));}
export function requestFile(input){const file=path.join(artifact('graph-request-'),'request.json');native.writeFileSync(file,JSON.stringify(input));return file;}
export function seed(data){
 const code=`import {graphFixture} from ${JSON.stringify(moduleURL('./graph-fixture.mjs'))};import {closeMemory} from ${JSON.stringify(moduleURL('./memory.mjs'))};import {closeCommonStore} from ${JSON.stringify(moduleURL('../agent-forensic-handoff/src/common-store.js'))};try{console.log(JSON.stringify(await graphFixture()));}finally{await closeMemory();closeCommonStore();}`;
 return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{env:environment(data),encoding:'utf8',windowsHide:true,timeout:60000}));
}
export function cli(input,data,timeout=60000){return JSON.parse(execFileSync(process.execPath,[path.join(app,'memory-cli.mjs'),'graph-publication',requestFile(input)],{env:environment(data),encoding:'utf8',windowsHide:true,timeout}));}
export function crash(input,data,point,timeout=60000){
 const code=`import {verifiedSources} from ${JSON.stringify(moduleURL('./knowledge.mjs'))};import {closeMemory} from ${JSON.stringify(moduleURL('./memory.mjs'))};import {commonWorkerConfiguration,observeCommonWorker,closeCommonStore} from ${JSON.stringify(moduleURL('../agent-forensic-handoff/src/common-store.js'))};import {commonWorkerEnv} from ${JSON.stringify(moduleURL('./common-worker-env.mjs'))};import {spawnSync} from 'node:child_process';import path from 'node:path';
 const input=${JSON.stringify(input)},data=${JSON.stringify(data)},ownerId=${JSON.stringify(randomUUID())};try{const context=await verifiedSources(input.conversationIds),env={...commonWorkerEnv(commonWorkerConfiguration(data),{data,ownerId}),AFH_CRASH_AT:${JSON.stringify(point)}};
 const result=spawnSync(process.env.ORBITA_POSTGRES_PYTHON,['-I','-B',${JSON.stringify(fileURLToPath(new URL('../agent-forensic-handoff/python/bridge.py',import.meta.url)))}],{env,encoding:'utf8',windowsHide:true,timeout:${timeout-3000},input:JSON.stringify({...input,op:'graph_'+input.op,sources:context.sources,root:path.join(data,'semantic'),scope:'afh-corpus'})});
 if(result.error)throw result.error;if(observeCommonWorker(ownerId).backends!==0)throw new Error('CRASH_BACKENDS_NOT_DRAINED');process.stderr.write('Actual Python exit '+result.status+' '+result.stderr);process.stdout.write(result.stdout);process.exitCode=result.status??1;
 }finally{await closeMemory();closeCommonStore();}`;
 return spawnSync(process.execPath,['--input-type=module','-e',code],{env:environment(data),encoding:'utf8',windowsHide:true,timeout});
}
export function publisher(input,data){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(app,'memory-cli.mjs'),'graph-publication',requestFile(input)],{env:environment(data),windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='',failure;
  const timer=setTimeout(()=>{failure=new Error('PUBLISHER_TIMEOUT');terminateOwned(child);},65000);
  child.stdout.on('data',b=>{out+=b;if(out.length>32000000){failure=new Error('PUBLISHER_OUTPUT_LIMIT');terminateOwned(child);}});child.stderr.on('data',b=>{err+=b;if(err.length>1000000){failure=new Error('PUBLISHER_STDERR_LIMIT');terminateOwned(child);}});
  child.on('error',e=>{failure=e;});child.once('close',code=>{clearTimeout(timer);if(failure)return reject(failure);if(code!==0)return reject(new Error(err));try{resolve(JSON.parse(out));}catch(e){reject(e);}});
 });
}

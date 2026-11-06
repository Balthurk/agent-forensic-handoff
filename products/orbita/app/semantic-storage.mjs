import {pythonExecutable} from '../agent-forensic-handoff/src/python-runtime.js';
import fs from '../agent-forensic-handoff/src/common-files.js';
import {commonWorkerConfiguration,observeCommonWorker} from '../agent-forensic-handoff/src/common-store.js';
import {commonWorkerEnv} from './common-worker-env.mjs';
import {runOwnedProcess} from './owned-process.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
const CLI=fileURLToPath(new URL('../agent-forensic-handoff/python/semantic-storage-cli.py',import.meta.url));
export const hasSemanticStorage=root=>fs.existsSync(root);
export async function semanticStorageState(root,{signal}={}){
 signal?.throwIfAborted();root=path.resolve(root);
 const configuration=commonWorkerConfiguration(root),ownerId=randomUUID();
 let capture,failure;
 try{
  capture=await runOwnedProcess(pythonExecutable(['AFH_SEMANTIC_PYTHON','AFH_VOLUME_PYTHON']),['-I','-X','utf8','-B',CLI],{env:commonWorkerEnv(configuration,{data:root,ownerId}),input:JSON.stringify({root,op:'state'})+'\n',signal,timeout:180000,stdoutLimit:1000000,stderrLimit:100000});
 }catch(error){failure=error;}
 const deadline=performance.now()+15000;
 let observed;
 do{observed=observeCommonWorker(ownerId);if(observed.backends===0)break;await delay(25);}while(performance.now()<deadline);
 if(observed.backends!==0)throw new Error('SEMANTIC_STORAGE_POSTGRES_DRAIN_UNVERIFIED');
 if(failure){
  if(failure.code==='ENOENT')throw new Error('SEMANTIC_STORAGE_PYTHON_UNAVAILABLE',{cause:failure});
  throw failure;
 }
 if(JSON.stringify(commonWorkerConfiguration(root))!==JSON.stringify(configuration))throw new Error('SEMANTIC_STORAGE_AUTHORITY_CHANGED');
 let response;try{response=JSON.parse(capture.stdout);}catch{throw new Error('SEMANTIC_STORAGE_PROTOCOL');}
 if(capture.code!==0||response?.ok!==true)throw new Error(response?.error??'SEMANTIC_STORAGE_FAILED');
 return response.result;
}
// Native exports are explicit encrypted recovery operations with a destination.
// The former implicit SQLite shadow/export lock is never an operational path.
export async function semanticExportGuard(){throw new Error('SEMANTIC_STORAGE_EXPLICIT_BACKUP_REQUIRED');}

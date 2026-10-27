import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {Utf8Stream} from './utf8-stream.mjs';import {terminateOwned} from './owned-process.mjs';
const CLI=fileURLToPath(new URL('../agent-forensic-handoff/python/semantic-storage-cli.py',import.meta.url));
export const hasSemanticStorage=root=>fs.existsSync(path.join(root,'semantic','postgres-storage.json'));
function worker(root,op){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.env.AFH_SEMANTIC_PYTHON||process.env.AFH_VOLUME_PYTHON||'python',['-I','-B',CLI],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const out=new Utf8Stream(1000000),err=new Utf8Stream(100000);let ready=false,settled=false,offset=0,response=null;
  const closed=new Promise(done=>child.once('close',code=>done(code)));
  const fail=e=>{if(settled)return;settled=true;clearTimeout(timer);terminateOwned(child);reject(e);};
  const timer=setTimeout(()=>fail(new Error('SEMANTIC_STORAGE_TIMEOUT')),180000);
  child.on('error',()=>fail(new Error('SEMANTIC_STORAGE_PYTHON_UNAVAILABLE')));child.stdin.on('error',()=>{});
  child.stderr.on('data',b=>{try{err.push(b);}catch(e){fail(e);}});
  // Progress lines keep long exports observable; final readiness retains the lock.
  child.stdout.on('data',b=>{try{out.push(b);let end;while((end=out.text.indexOf('\n',offset))>=0){
   const value=JSON.parse(out.text.slice(offset,end));offset=end+1;
   if(value.progress){timer.refresh();continue;}if(ready)throw new Error('SEMANTIC_STORAGE_PROTOCOL');ready=true;response=value;if(!value.ok)throw new Error(value.error);
   if(op==='export'&&value.result?.backend==='postgres'){
    clearTimeout(timer);settled=true;
    let released=false;resolve({result:value.result,assertHeld:()=>{if(child.exitCode!==null||child.signalCode!==null)throw new Error('SEMANTIC_STORAGE_EXPORT_LOST');},release:async()=>{if(released)return;released=true;child.stdin.end('release\n');if(await closed!==0)throw new Error('SEMANTIC_STORAGE_EXPORT_LOST');}});
   }
  }}catch(e){fail(e);}});
  child.on('close',code=>{if(settled)return;try{clearTimeout(timer);out.end();if(code!==0||!response?.ok)throw new Error(response?.error||'SEMANTIC_STORAGE_FAILED '+err.end().slice(-1000));settled=true;resolve({result:response.result,release:async()=>{}});}catch(e){fail(e);}});
  child.stdin.write(JSON.stringify({root:path.resolve(root),op})+'\n');if(op!=='export')child.stdin.end();
 });
}
export async function semanticStorageState(root){return hasSemanticStorage(root)?(await worker(root,'state')).result:null;}
export async function semanticExportGuard(root){return hasSemanticStorage(root)?worker(root,'export'):{result:null,release:async()=>{}};}

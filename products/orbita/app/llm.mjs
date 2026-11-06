import native from 'node:fs';
import fs from '../agent-forensic-handoff/src/common-files.js';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {providerEnvironment,runOwnedProcess} from './owned-process.mjs';
import {inferenceSchemaAsset,parseInferenceEvents} from './inference-protocol.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
function codexExecutable(){
 const local=process.env.LOCALAPPDATA;if(typeof local!=='string'||!local.trim())return null;
 const runtime=path.join(local,'OpenAI','Codex','bin');
 try{return native.readdirSync(runtime).flatMap(name=>{const executable=path.join(runtime,name,'codex.exe');try{const info=native.statSync(executable);return info.isFile()?[{executable,mtime:info.mtimeMs}]:[];}catch{return [];}}).sort((a,b)=>b.mtime-a.mtime||a.executable.localeCompare(b.executable))[0]?.executable??null;}catch{return null;}
}
const unavailable=()=>({connected:false,code:'CODEX_UNAVAILABLE',method:'ChatGPT · Codex no está disponible; puedes importar y consultar fuentes locales.'});
export const MODELS=[{id:'gpt-6.1-sol',name:'GPT-6.1 Sol',description:'Equilibrio y precisión'},{id:'gpt-6-astra',name:'GPT-6 Astra',description:'Análisis profundo'},{id:'gpt-6-luna',name:'GPT-6 Luna',description:'Respuestas ágiles'}];
export function authStatus(){
 if(process.env.AFH_MANAGED==='1')return {connected:false,method:'Espacio autenticado: conexión de inferencia propia pendiente'};
 const executable=codexExecutable();if(!executable)return unavailable();
 const result=spawnSync(executable,['login','status'],{encoding:'utf8',env:providerEnvironment({codex:true}),windowsHide:true,timeout:15000,maxBuffer:100000});
 if(result.error)return unavailable();
 return {connected:result.status===0&&/using ChatGPT/i.test((result.stdout||'')+(result.stderr||'')),method:'ChatGPT · sesión local de Codex'};
}
async function authStatusAsync(signal,executable){
 signal?.throwIfAborted();
 try{
  const result=await runOwnedProcess(executable,['login','status'],{env:providerEnvironment({codex:true}),signal,timeout:15000,stdoutLimit:100000,stderrLimit:100000,totalLimit:100000});
  return {connected:result.code===0&&/using ChatGPT/i.test(result.stdout+result.stderr)};
 }catch(error){
  if(signal?.aborted)throw signal.reason??error;
  if(error.message==='OWNED_PROCESS_TIMEOUT')throw new Error('AUTH_TIMEOUT',{cause:error});
  return unavailable();
 }
}
export async function infer(prompt,schema,{model='gpt-6.1-sol',effort='low',timeout=120000,signal}={}){
 signal?.throwIfAborted();
 if(process.env.AFH_MANAGED==='1')throw new Error('ACCESS_MANAGED_INFERENCE_NOT_CONNECTED');
 if(!MODELS.some(item=>item.id===model))throw new Error('Modelo no permitido');
 const executable=codexExecutable();if(!executable)throw new Error('CODEX_UNAVAILABLE: instala Codex e inicia sesión con ChatGPT para usar inferencia. La consulta local sigue disponible.');
 const asset=inferenceSchemaAsset(schema);
 if(!(await authStatusAsync(signal,executable)).connected)throw new Error('Inicia sesión con ChatGPT en Codex para consultar. No se usa facturación API.');
 signal?.throwIfAborted();
 const job=path.join(process.env.AFH_COSMOS_DATA||path.join(ROOT,'data'),'inference',randomUUID());
 fs.mkdirSync(job,{recursive:true});
 fs.writeFileSync(path.join(job,'schema.json'),asset.bytes,{flag:'wx'});
 fs.writeFileSync(path.join(job,'prompt.txt'),prompt,{flag:'wx'});
 const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','-s','read-only','-C',ROOT,'-m',model,'-c',`model_reasoning_effort="${effort}"`,'-c','project_doc_max_bytes=0','--output-schema',asset.path,'--json'];
 for(const feature of ['shell_tool','plugins','hooks','memories','multi_agent','image_generation','view_image','skill_search'])args.push('--disable',feature);
 args.push('-');
 const started=Date.now();let capture;
 function persist(error,parsed){
  fs.writeFileSync(path.join(job,'events.jsonl'),capture?.stdout??'',{flag:'wx'});
  fs.writeFileSync(path.join(job,'stderr.txt'),capture?.stderr??'',{flag:'wx'});
  if(error)fs.writeFileSync(path.join(job,'failure.json'),JSON.stringify({reason:signal?.aborted?'cancelled':error.message,error:error.message,modelRequested:model,elapsedMs:Date.now()-started},null,2),{flag:'wx'});
  else fs.writeFileSync(path.join(job,'answer.json'),parsed.answer,{flag:'wx'});
  fs.writeFileSync(path.join(job,'receipt.json'),JSON.stringify({status:error?'failed':'completed',startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started,model,modelObserved:parsed?.modelObserved??null,code:capture?.code??null,auth:'chatgpt',promptChars:prompt.length,schema:asset.name,schemaSha256:asset.sha256,processClosed:capture?.closed??null,pid:capture?.pid??null},null,2),{flag:'wx'});
 }
 let parsed;
 try{
  capture=await runOwnedProcess(executable,args,{env:providerEnvironment({codex:true}),cwd:ROOT,input:prompt,signal,timeout,stdoutLimit:64000000,stderrLimit:2000000});
  if(capture.code!==0)throw new Error('Codex no pudo responder: '+(capture.stderr+capture.stdout).slice(-1200));
  parsed=parseInferenceEvents(capture.stdout,asset.schema);
 }catch(error){
  capture=error.capture??capture;persist(error);
  if(Object.isExtensible(error))error.receipt=job;
  throw error;
 }
 persist(null,parsed);
 return {value:parsed.value,model,modelObserved:parsed.modelObserved,elapsedMs:Date.now()-started,usage:parsed.usage,receipt:job};
}
export const GAP_TEXT='Los fragmentos recuperados no aportan evidencia suficiente para resolver con certeza esta parte de la consulta.';
const citationSchema={type:'object',additionalProperties:false,required:['id','quote'],properties:{id:{type:'string'},quote:{type:'string'}}};
export const answerSchema={type:'object',additionalProperties:false,required:['title','claims','followups'],properties:{title:{type:'string'},claims:{type:'array',minItems:1,items:{anyOf:[{type:'object',additionalProperties:false,required:['text','kind','evidence'],properties:{text:{type:'string'},kind:{type:'string',enum:['fact','inference']},evidence:{type:'array',minItems:1,items:citationSchema}}},{type:'object',additionalProperties:false,required:['text','kind','evidence'],properties:{text:{type:'string',enum:[GAP_TEXT]},kind:{type:'string',enum:['gap']},evidence:{type:'array',maxItems:0,items:citationSchema}}}]}},followups:{type:'array',items:{type:'string'}}}};

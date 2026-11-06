import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {terminateOwned} from './owned-process.mjs';
import { Utf8Stream } from './utf8-stream.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
function codexExecutable(){
 const local=process.env.LOCALAPPDATA;if(typeof local!=='string'||!local.trim())return null;
 const runtime=path.join(local,'OpenAI','Codex','bin');
 try{return fs.readdirSync(runtime).flatMap(name=>{const executable=path.join(runtime,name,'codex.exe');try{const info=fs.statSync(executable);return info.isFile()?[{executable,mtime:info.mtimeMs}]:[];}catch{return [];}}).sort((a,b)=>b.mtime-a.mtime||a.executable.localeCompare(b.executable))[0]?.executable??null;}catch{return null;}
}
const unavailable=()=>({connected:false,code:'CODEX_UNAVAILABLE',method:'ChatGPT · Codex no está disponible; puedes importar y consultar fuentes locales.'});
export const MODELS=[{id:'gpt-6.1-sol',name:'GPT-6.1 Sol',description:'Equilibrio y precisión'},{id:'gpt-6-astra',name:'GPT-6 Astra',description:'Análisis profundo'},{id:'gpt-6-luna',name:'GPT-6 Luna',description:'Respuestas ágiles'}];
const env={...process.env};delete env.OPENAI_API_KEY;delete env.CODEX_API_KEY;
export function authStatus(){
 if(process.env.AFH_MANAGED==='1')return {connected:false,method:'Espacio autenticado: conexión de inferencia propia pendiente'};
 const executable=codexExecutable();if(!executable)return unavailable();
 const r=spawnSync(executable,['login','status'],{encoding:'utf8',env,windowsHide:true,timeout:15000});
 if(r.error)return unavailable();
 return {connected:r.status===0&&/using ChatGPT/i.test((r.stdout||'')+(r.stderr||'')),method:'ChatGPT · sesión local de Codex'};
}
async function authStatusAsync(signal,executable){
 signal?.throwIfAborted();return new Promise((resolve,reject)=>{let out='',done=false;const child=spawn(executable,['login','status'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};const cancel=()=>{if(done)return;done=true;cleanup();terminateOwned(child);reject(signal?.reason??new Error('AUTH_TIMEOUT'));};const timer=setTimeout(cancel,15000);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{out+=b.toString();if(out.length>100000)cancel();});child.on('error',()=>{cleanup();if(!done){done=true;resolve(unavailable());}});child.on('close',code=>{cleanup();if(!done){done=true;resolve({connected:code===0&&/using ChatGPT/i.test(out)});}});});
}
export async function infer(prompt,schema,{model='gpt-6.1-sol',effort='low',timeout=120000,signal}={}){
  signal?.throwIfAborted();
  if(process.env.AFH_MANAGED==='1')throw new Error('ACCESS_MANAGED_INFERENCE_NOT_CONNECTED');
  if(!MODELS.some(x=>x.id===model))throw new Error('Modelo no permitido');
  const executable=codexExecutable();if(!executable)throw new Error('CODEX_UNAVAILABLE: instala Codex e inicia sesión con ChatGPT para usar inferencia. La consulta local sigue disponible.');
  if(!(await authStatusAsync(signal,executable)).connected)throw new Error('Inicia sesión con ChatGPT en Codex para consultar. No se usa facturación API.');
  const job=path.join(process.env.AFH_COSMOS_DATA||path.join(ROOT,'data'),'inference',randomUUID());fs.mkdirSync(job,{recursive:true});
  const schemaPath=path.join(job,'schema.json'),outputPath=path.join(job,'answer.json');fs.writeFileSync(schemaPath,JSON.stringify(schema));fs.writeFileSync(path.join(job,'prompt.txt'),prompt);
  const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','-s','read-only','-C',job,'-m',model,'-c',`model_reasoning_effort="${effort}"`,'-c','project_doc_max_bytes=0','--output-schema',schemaPath,'-o',outputPath,'--json'];
  for(const f of ['shell_tool','plugins','hooks','memories','multi_agent','image_generation','view_image','skill_search'])args.push('--disable',f);
  args.push('-');
  const started=Date.now();
  return await new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{env,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='',settled=false;
    const stdout=new Utf8Stream(64000000),stderr=new Utf8Stream(2000000);
    const saveRaw=()=>{out=stdout.text;err=stderr.text;fs.writeFileSync(path.join(job,'events.jsonl'),out);fs.writeFileSync(path.join(job,'stderr.txt'),err);};
    const timer=setTimeout(()=>{saveRaw();fs.writeFileSync(path.join(job,'failure.json'),JSON.stringify({reason:'timeout',modelRequested:model,elapsedMs:Date.now()-started}));terminateOwned(child);if(!settled){settled=true;reject(new Error('El modelo ha agotado el tiempo de respuesta. Puedes reintentar.'));}},timeout);
    const streamFailure=e=>{if(settled)return;settled=true;clearTimeout(timer);saveRaw();fs.writeFileSync(path.join(job,'failure.json'),JSON.stringify({reason:'invalid_or_excessive_output',error:e.message,modelRequested:model,elapsedMs:Date.now()-started}));terminateOwned(child);reject(e);};
    const cancel=()=>{if(settled)return;settled=true;clearTimeout(timer);saveRaw();fs.writeFileSync(path.join(job,'failure.json'),JSON.stringify({reason:'cancelled',modelRequested:model,error:signal?.reason?.message||'CALLER_CANCELLED',elapsedMs:Date.now()-started}));terminateOwned(child);reject(signal?.reason??new Error('CALLER_CANCELLED'));};signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    child.stdout.on('data',d=>{try{stdout.push(d);}catch(e){streamFailure(e);}});child.stderr.on('data',d=>{try{stderr.push(d);}catch(e){streamFailure(e);}});
    child.on('error',e=>{clearTimeout(timer);if(!settled){settled=true;reject(e);}});
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(settled){saveRaw();return;}if(signal?.aborted){cancel();return;}try{stdout.end();stderr.end();}catch(e){streamFailure(e);return;}saveRaw();settled=true;
      fs.writeFileSync(path.join(job,'receipt.json'),JSON.stringify({startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started,model,code,auth:'chatgpt',promptChars:prompt.length},null,2));
      if(code!==0||!fs.existsSync(outputPath))return reject(new Error('Codex no pudo responder: '+(err+out).slice(-1200)));
      try{const events=out.split('\n').filter(Boolean).flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}});const tools=events.filter(x=>['command_execution','mcp_tool_call','web_search','file_change'].includes(x.item?.type));if(tools.length)throw new Error('La inferencia intentó usar herramientas fuera del contexto cerrado');
      resolve({value:JSON.parse(fs.readFileSync(outputPath,'utf8')),model,modelObserved:events.findLast(x=>typeof x.model==='string')?.model??null,elapsedMs:Date.now()-started,usage:events.findLast(x=>x.type==='turn.completed')?.usage??null,receipt:job});}catch(e){reject(e);}
    });child.stdin.end(prompt);
  });
}
export const GAP_TEXT='Los fragmentos recuperados no aportan evidencia suficiente para resolver con certeza esta parte de la consulta.';
const citationSchema={type:'object',additionalProperties:false,required:['id','quote'],properties:{id:{type:'string'},quote:{type:'string'}}};
export const answerSchema={type:'object',additionalProperties:false,required:['title','claims','followups'],properties:{title:{type:'string'},claims:{type:'array',minItems:1,items:{anyOf:[{type:'object',additionalProperties:false,required:['text','kind','evidence'],properties:{text:{type:'string'},kind:{type:'string',enum:['fact','inference']},evidence:{type:'array',minItems:1,items:citationSchema}}},{type:'object',additionalProperties:false,required:['text','kind','evidence'],properties:{text:{type:'string',enum:[GAP_TEXT]},kind:{type:'string',enum:['gap']},evidence:{type:'array',maxItems:0,items:citationSchema}}}]}},followups:{type:'array',items:{type:'string'}}}};

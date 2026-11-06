import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import fs from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
import path from 'node:path';
import cp from 'node:child_process';
import vm from 'node:vm';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {infer,answerSchema,MODELS} from './llm.mjs';
import {inferenceSchemaAsset} from './inference-protocol.mjs';

assert.ok(process.env.ORBITA_POSTGRES_TEST_ROOT&&process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'explicit fixture roots required');
const APP=path.dirname(fileURLToPath(import.meta.url));
const nativeRoot=native.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'inference-native-'));
const local=path.join(nativeRoot,'local appdata'),fake=path.join(local,'OpenAI','Codex','bin','synthetic','codex.exe');
native.mkdirSync(path.dirname(fake),{recursive:true});native.writeFileSync(fake,'Synthetic resolution fixture. This file is never executed.');
fs.mkdirSync(process.env.ORBITA_POSTGRES_TEST_ROOT,{recursive:true});
const root=fs.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'inference-'));
const planSchema={type:'object',additionalProperties:false,required:['terms'],properties:{terms:{type:'array',items:{type:'string'}}}};
const excluded=['ORBITA_POSTGRES_BINDING','ORBITA_POSTGRES_CONFIG','ORBITA_POSTGRES_TEST_OPERATOR_CONFIG','AFH_JEV_CONFIG','OPENAI_API_KEY','CODEX_API_KEY','NODE_OPTIONS','PYTHONPATH','PYTHONHOME'];
let sequence=0;
const helper=String.raw`
const fs=require('node:fs'),c=JSON.parse(process.argv[1]);
if(c.excluded.some(key=>Object.hasOwn(process.env,key)))throw new Error('Provider inherited forbidden environment names');
if(c.phase==='auth'){
 if(c.mode==='auth-wait'){fs.writeFileSync(c.marker,'ready');setInterval(()=>{},1000);}
 else if(c.mode==='auth-overflow'){process.stdout.write('x'.repeat(100001));setInterval(()=>{},1000);}
 else if(c.mode==='auth-denied'){console.log('Logged in using an API key');process.exitCode=1;}
 else{process.stdout.write('Logged in using ChatGPT');}
}else{
 process.stdin.setEncoding('utf8');let prompt='';process.stdin.on('data',value=>prompt+=value);
 process.stdin.on('end',()=>{
  const value=c.echo?{terms:[prompt]}:c.value;
  const events=c.events??[{type:'thread.started',thread_id:'synthetic-thread'},{type:'turn.started',model:c.model},{type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:2}}];
  let output=events.map(value=>JSON.stringify(value)).join('\n')+'\n';
  if(c.mode==='bad-jsonl')output='malformed event\n'+output;
  if(c.mode==='wait'){process.stdout.write(output.split('\n')[0]+'\n');fs.writeFileSync(c.marker,'ready');setInterval(()=>{},1000);return;}
  if(c.mode==='large-stdout'||c.mode==='large-stderr'){
   const stream=c.mode==='large-stdout'?process.stdout:process.stderr,limit=c.mode==='large-stdout'?64000000:2000000;
   stream.write(Buffer.alloc(limit+1,120));setInterval(()=>{},1000);return;
  }
  if(c.mode==='invalid-utf8'){process.stdout.write(Buffer.from([0xe2,0x82]));return;}
  if(c.bytewise)for(const byte of Buffer.from(output))process.stdout.write(Buffer.from([byte]));else process.stdout.write(output);
  process.stderr.write('synthetic diagnostics\n');if(c.mode==='nonzero')process.exitCode=7;
 });
}
`;
async function scenario(mode,fn,config={}){
 const previous={LOCALAPPDATA:process.env.LOCALAPPDATA,AFH_COSMOS_DATA:process.env.AFH_COSMOS_DATA,AFH_MANAGED:process.env.AFH_MANAGED};
 const data=path.join(root,'scenario-'+(++sequence)),marker=path.join(nativeRoot,'ready-'+sequence),children=[];
 fs.mkdirSync(data);process.env.LOCALAPPDATA=local;process.env.AFH_COSMOS_DATA=data;delete process.env.AFH_MANAGED;
 const original=cp.spawn;
 cp.spawn=function(executable,args,options){
  if(executable!==fake)return original.call(this,executable,args,options);
  const phase=args[0]==='login'?'auth':'exec';
  for(const key of excluded)assert.equal(options.env[key],undefined);
  if(phase==='exec'){
   assert.equal(options.cwd,APP);assert.equal(args[args.indexOf('-C')+1],APP);assert.equal(args.includes('-o'),false);assert.equal(args.at(-1),'-');
   assert.equal(path.dirname(args[args.indexOf('--output-schema')+1]),path.join(APP,'inference-schemas'));
   for(const flag of ['--ignore-user-config','--ephemeral','--skip-git-repo-check','--json'])assert.ok(args.includes(flag));
  }
  const value={terms:['synthetic response']},model=phase==='exec'?args[args.indexOf('-m')+1]:null;
  const child=original.call(this,process.execPath,['-e',helper,JSON.stringify({mode,phase,marker,excluded,value,model,...config})],options);
  const record={child,phase,closed:false};children.push(record);child.once('close',()=>{record.closed=true;});return child;
 };syncBuiltinESMExports();
 try{return await fn({data,marker,children});}
 finally{cp.spawn=original;syncBuiltinESMExports();for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;assert.ok(children.every(value=>value.closed),'all actual auth and execution children closed before return');assert.equal(native.existsSync(data),false);}
}
const read=(job,file)=>fs.readFileSync(path.join(job,file),'utf8');
const jobs=data=>fs.existsSync(path.join(data,'inference'))?fs.readdirSync(path.join(data,'inference')):[];
async function rejected(mode,pattern,config={},options={}){
 await scenario(mode,async({data,children})=>{
  await assert.rejects(infer('Synthetic request',options.schema??planSchema,options),error=>{
   assert.match(error.message,pattern);assert.equal(children.every(value=>value.closed),true);
   assert.equal(jobs(data).length,1);const job=path.join(data,'inference',jobs(data)[0]);
   assert.equal(JSON.parse(read(job,'receipt.json')).status,'failed');assert.equal(JSON.parse(read(job,'receipt.json')).processClosed,true);
   assert.ok(read(job,'failure.json'));assert.equal(fs.existsSync(path.join(job,'answer.json')),false);return true;
  });
 },config);
}
async function ready(marker){const until=Date.now()+5000;while(!native.existsSync(marker)){assert.ok(Date.now()<until,'actual child readiness deadline');await delay(5);}}
after(()=>{const closed=closeCommonStore();assert.equal(closed.drained,true);assert.equal(closed.ownedExit,0);assert.equal(native.existsSync(root),false);});

test('PG01 installed inference schemas equal all six current application contracts',()=>{
 const source=name=>native.readFileSync(path.join(APP,name),'utf8'),line=(text,name)=>text.split('\n').find(value=>new RegExp('^(export )?const '+name+'=').test(value));
 const evaluate=(code,expression,context={})=>JSON.parse(JSON.stringify(vm.runInNewContext(code.replace(/export /g,'')+'\n;'+expression,context)));
 const knowledge=source('knowledge.mjs'),base=knowledge.slice(knowledge.indexOf('const str='),knowledge.indexOf('export function extractionInput'));
 const [extraction,review]=evaluate(base+'\n'+line(knowledge,'reviewSchema'),'[extractionSchema,reviewSchema]');
 const re=source('reevaluation.mjs'),reevaluation=evaluate(re.slice(re.indexOf('const str='),re.indexOf('export async function runReevaluation')),'reevaluationSchema');
 const routing=source('routing.mjs'),catalog=JSON.parse(native.readFileSync(path.join(APP,'../agent-forensic-handoff/schemas/tsm-catalog.v1.json'),'utf8'));
 const classification=evaluate(['families','OPTIONS','RESOLUTIONS','classificationSchema'].map(name=>line(routing,name)).join('\n'),'classificationSchema',{catalog});
 const plan=evaluate(line(source('server.mjs'),'planSchema'),'planSchema');
 for(const [name,schema] of Object.entries({answer:answerSchema,extraction,review,reevaluation,classification,plan})){const asset=inferenceSchemaAsset(schema);assert.equal(asset.name,name+'.json');assert.deepEqual(asset.schema,schema);assert.equal(asset.sha256.length,64);}
});

test('PG01 actual synthetic CLI preserves all models, Unicode stdin, receipts and fresh-process reads',async()=>{
 const prompt='Café 漢字 😀 e\u0301.\nTexto íntegro.';
 for(const {id:model} of MODELS)await scenario('success',async({children})=>{
  const result=await infer(prompt,planSchema,{model,effort:'medium'});assert.deepEqual(result.value,{terms:[prompt]});assert.equal(result.model,model);assert.equal(result.modelObserved,model);assert.deepEqual(result.usage,{input_tokens:1,output_tokens:2});assert.equal(children.length,2);
  assert.equal(read(result.receipt,'prompt.txt'),prompt);assert.deepEqual(JSON.parse(read(result.receipt,'schema.json')),planSchema);assert.equal(JSON.parse(read(result.receipt,'receipt.json')).processClosed,true);assert.match(read(result.receipt,'stderr.txt'),/synthetic diagnostics/);
  const script="import fs from "+JSON.stringify(new URL('../agent-forensic-handoff/src/common-files.js',import.meta.url).href)+";import {closeCommonStore} from "+JSON.stringify(new URL('../agent-forensic-handoff/src/common-store.js',import.meta.url).href)+";try{console.log(fs.readFileSync(process.argv[1],'utf8'))}finally{const closed=closeCommonStore();if(!closed.drained||closed.ownedExit!==0)process.exitCode=1}";
  const reopened=cp.spawnSync(process.execPath,['--input-type=module','-e',script,path.join(result.receipt,'answer.json')],{env:process.env,encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(reopened.status,0,reopened.stderr);assert.deepEqual(JSON.parse(reopened.stdout),result.value);
 },{echo:true,bytewise:true});
});

test('PG01 all six registered output contracts retain their complete structured answers',async()=>{
 const minimum=s=>s.anyOf?minimum(s.anyOf[0]):s.enum?s.enum[0]:(Array.isArray(s.type)?s.type[0]:s.type)==='object'?Object.fromEntries(s.required.map(key=>[key,minimum(s.properties[key])])):s.type==='array'?Array.from({length:s.minItems??0},()=>minimum(s.items)):s.type==='string'?'synthetic':s.type==='boolean'?false:0;
 for(const file of native.readdirSync(path.join(APP,'inference-schemas'))){const schema=JSON.parse(native.readFileSync(path.join(APP,'inference-schemas',file),'utf8')),value=minimum(schema);await scenario('success',async()=>{const result=await infer('Synthetic six-contract qualification',schema);assert.deepEqual(result.value,value);assert.deepEqual(JSON.parse(read(result.receipt,'answer.json')),value);},{value});}
});

test('PG01 malformed JSONL cannot be silently discarded before accepting a later answer',async()=>{await rejected('bad-jsonl',/INVALID_JSONL/);});
test('PG01 incomplete, duplicate and out-of-order inference events cannot publish an answer',async()=>{
 const thread={type:'thread.started',thread_id:'synthetic'},start={type:'turn.started'},answer={type:'item.completed',item:{id:'answer',type:'agent_message',text:'{"terms":[]}' }},done={type:'turn.completed'};
 for(const events of [[thread,start,answer],[thread,answer,done],[thread,start,{type:'item.started',item:{id:'pending',type:'reasoning'}},answer,done],[thread,start,answer,done,done]])await rejected('success',/EVENTS_(INCOMPLETE|INVALID_SEQUENCE)/,{events});
});
test('PG01 every external tool and unknown item is rejected in the closed inference protocol',async()=>{
 for(const type of ['command_execution','mcp_tool_call','web_search','file_change','unknown_tool'])await rejected('success',/TOOL_EVENT_REJECTED/,{events:[{type:'thread.started',thread_id:'synthetic'},{type:'turn.started'},{type:'item.completed',item:{id:'tool',type}}]});
});
test('PG01 failed turns, error events and nonzero child exits retain failed receipts',async()=>{
 for(const type of ['error','turn.failed'])await rejected('success',/EXECUTION_FAILED/,{events:[{type:'thread.started',thread_id:'synthetic'},{type:'turn.started'},{type}]});
 await rejected('nonzero',/Codex no pudo responder/);
});
test('PG01 output validation rejects missing fields, extra authority, invalid evidence and wrong types',async()=>{
 for(const value of [{},{terms:[1]},{terms:[],approval:true}])await rejected('success',/ANSWER_SCHEMA_INVALID/,{value});
 for(const value of [{title:'x',claims:[],followups:[]},{title:'x',claims:[{text:'x',kind:'fact',evidence:[]}],followups:[]},{title:'x',claims:[{text:'invented gap',kind:'gap',evidence:[]}],followups:[]}])await rejected('success',/ANSWER_SCHEMA_INVALID/,{value},{schema:answerSchema});
});
test('PG01 unregistered and hash-corrupted schema assets cannot start a provider process',async()=>{
 await scenario('success',async({children})=>{
  await assert.rejects(infer('Synthetic',{}),/SCHEMA_NOT_REGISTERED/);assert.equal(children.length,0);
  const original=native.readFileSync;native.readFileSync=function(file,...args){const value=original.call(this,file,...args);return String(file).endsWith('answer.json')&&String(file).includes('inference-schemas')?Buffer.concat([value,Buffer.from(' ')]):value;};
  try{await assert.rejects(infer('Synthetic',answerSchema),/ASSET_INTEGRITY/);}finally{native.readFileSync=original;}
  assert.equal(children.length,0);
 });
});
test('PG01 denied or excessive authentication output closes its child without creating a job',async()=>{
 for(const mode of ['auth-denied','auth-overflow'])await scenario(mode,async({data,children})=>{await assert.rejects(infer('Synthetic',planSchema),/Inicia sesión/);assert.equal(children.length,1);assert.deepEqual(jobs(data),[]);});
});
test('PG01 cancelling active authentication waits for real closure and dispatches no inference',async()=>{
 await scenario('auth-wait',async({marker,data,children})=>{const controller=new AbortController(),promise=infer('Synthetic',planSchema,{signal:controller.signal});promise.catch(()=>{});await ready(marker);assert.equal(children[0].closed,false);controller.abort(new Error('AUTH_TEST_CANCEL'));await assert.rejects(promise,/AUTH_TEST_CANCEL/);assert.equal(children[0].closed,true);assert.equal(children.length,1);assert.deepEqual(jobs(data),[]);});
});
test('PG01 cancelling active inference preserves partial events after the real child closes',async()=>{
 await scenario('wait',async({marker,data,children})=>{const controller=new AbortController(),promise=infer('Synthetic',planSchema,{signal:controller.signal});promise.catch(()=>{});await ready(marker);assert.equal(children[1].closed,false);controller.abort(new Error('INFER_TEST_CANCEL'));await assert.rejects(promise,/INFER_TEST_CANCEL/);assert.equal(children[1].closed,true);const job=path.join(data,'inference',jobs(data)[0]);assert.equal(JSON.parse(read(job,'failure.json')).reason,'cancelled');assert.match(read(job,'events.jsonl'),/thread.started/);assert.equal(JSON.parse(read(job,'receipt.json')).processClosed,true);});
});
test('PG01 inference timeout preserves failure only after owned process closure',async()=>{await rejected('wait',/OWNED_PROCESS_TIMEOUT/,{},{timeout:400});});
test('PG01 real 64MB and 2MB output ceilings and invalid UTF8 retain closed failures',async()=>{
 for(const mode of ['large-stdout','large-stderr'])await rejected(mode,/UTF8_STREAM_BUDGET/);
 await rejected('invalid-utf8',/encoded data|encoding/i);
});

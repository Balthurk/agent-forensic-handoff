// Qualification-only barriers around real work and real transport completion.
// No endpoint, provider, permission or result is replaced.
import http from 'node:http';
import {registerHooks} from 'node:module';
if(process.env.ORBITA_RECOVERY_ADMISSION_FIXTURE==='1'){
 let armed=null,release=null,stopping=false;
 globalThis.orbitaRecoveryBarrier=kind=>{
  if(armed!==kind)return Promise.resolve();
  process.send?.({type:'fixture-held',kind});
  return new Promise(resolve=>release=resolve);
 };
 const end=http.ServerResponse.prototype.end;
 http.ServerResponse.prototype.end=function(...args){
  if(armed!=='get'||this.req.url!=='/api/bootstrap?recovery-fixture=hold')return end.apply(this,args);
  process.send?.({type:'fixture-held',kind:'get'});
  release=()=>end.apply(this,args);return this;
 };
 registerHooks({load(url,context,next){
  const result=next(url,context);
  const anchors={
   'corpus.mjs':[['export async function addSource({url,filename,content,contentBase64}){','import']],
   'recovery.mjs':[["export async function createBackup({source,archive,password,ownSession=false,archiveStorage='native',...options}) {",'backup']],
   'memory.mjs':[["try{const p=await provider(),result=[];for(const id of [...new Set(ids)])",'index'],[' contextNeeds(question,needs);await cancellationPoint(signal);','query']],
   'reevaluation.mjs':[['try{const result=await drainReevaluations();','automatic'],['automaticResuming++;try{const result=await scanReevaluations();','resume']]
  };
  const key=Object.keys(anchors).find(name=>url===new URL('./'+name,import.meta.url).href);if(!key)return result;
  let source=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');
  for(const [anchor,kind] of anchors[key]){
   if(source.split(anchor).length!==2)throw Error('RECOVERY_FIXTURE_ANCHOR_CHANGED:'+kind);
   const barrier="await globalThis.orbitaRecoveryBarrier('"+kind+"');";
   const replacement=['import','backup'].includes(kind)?anchor+barrier:kind==='index'?anchor.replace('try{','try{'+barrier):kind==='query'?barrier+anchor:anchor.replace('try{','try{'+barrier);
   source=source.replace(anchor,replacement);
  }
  return {...result,source};
 }});
 const stop=async()=>{if(stopping)return;stopping=true;release?.();release=null;armed=null;try{await (await import('./server.mjs')).closeServer();}catch(e){console.error(e);process.exitCode=1;}finally{if(process.connected)process.disconnect();}};
 process.on('message',message=>{
  if(message?.type==='fixture-arm'){armed=message.kind;process.send?.({type:'fixture-armed',kind:armed});}
  if(message?.type==='fixture-release'){armed=null;release?.();release=null;}
  if(message?.type==='fixture-stop')void stop();
  if(message?.type==='fixture-automatic')void (async()=>{
   const module=await import('./reevaluation.mjs');
   if(message.kind==='resume'){module.reevaluationStatus();await module.resumeAutomaticReevaluations();}
   else module.scheduleAutomaticReevaluations();
  })().catch(error=>{console.error(error);process.exitCode=1;});
 });
 process.once('disconnect',()=>void stop());
}

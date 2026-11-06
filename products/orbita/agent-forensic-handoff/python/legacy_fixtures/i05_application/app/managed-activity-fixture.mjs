// Test-only preload. Hold actual HTTP completion or actual indexing before the
// real provider runs; never replace an endpoint, provider, result or permission.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {registerHooks} from 'node:module';
if(process.env.AFH_MANAGED==='1'&&process.env.ORBITA_ACTIVITY_FIXTURE_DIR){
 const dir=path.join(process.env.ORBITA_ACTIVITY_FIXTURE_DIR,path.basename(path.dirname(process.env.AFH_COSMOS_DATA)));
 fs.mkdirSync(dir,{recursive:true});
 const end=http.ServerResponse.prototype.end;
 http.ServerResponse.prototype.end=function(...args){
  if(this.req.url!=='/api/bootstrap?activity-fixture=hold')return end.apply(this,args);
  fs.writeFileSync(path.join(dir,'response-entered'),'actual bootstrap handler reached end');
  const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'response-release'))){clearInterval(timer);end.apply(this,args);}else if(this.destroyed)clearInterval(timer);},10);
  return this;
 };
 registerHooks({load(url,context,next){
  const result=next(url,context);
  if(url!==new URL('./memory.mjs',import.meta.url).href)return result;
  const source=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');
  const needle='try{const p=await provider(),result=[];for(const id of [...new Set(ids)])';
  if(source.split(needle).length!==2)throw new Error('ACTIVITY_FIXTURE_INDEX_ANCHOR_CHANGED');
  const barrier=`fs.writeFileSync(${JSON.stringify(path.join(dir,'index-entered'))},'real indexConversations promise entered');await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(dir,'index-release'))})){clearInterval(timer);resolve();}},10);});`;
  return {...result,source:source.replace(needle,'try{'+barrier+'const p=await provider(),result=[];for(const id of [...new Set(ids)])')};
 }});
}

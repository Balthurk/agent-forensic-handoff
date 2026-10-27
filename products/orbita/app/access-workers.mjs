import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {terminateOwned} from './owned-process.mjs';
import {demand} from './access-store.mjs';

export class Workers{
 constructor(store){this.store=store;this.items=new Map();this.pending=new Map();this.stopping=new Map();this.closed=false;
  this.timer=setInterval(()=>{for(const id of this.items.keys()){try{store.active(store.workspace(id));}catch{void this.stop(id).catch(()=>{});}}},500);this.timer.unref();
 }
 async get(id){
  demand(!this.closed&&!this.stopping.has(id),'ACCESS_WORKER_STOPPING',503);this.store.active(this.store.workspace(id));
  if(this.items.has(id))return this.items.get(id);if(this.pending.has(id))return this.pending.get(id);
  demand(this.items.size+this.pending.size<4,'ACCESS_WORKER_LIMIT',429);
  const task=this.start(id);this.pending.set(id,task);try{return await task;}finally{this.pending.delete(id);}
 }
 async start(id){
  const temporary=path.join(this.store.workspaceRoot(id),'temporary');fs.mkdirSync(temporary,{recursive:true});
  const secret=randomBytes(32).toString('base64url'),env={...process.env,TEMP:temporary,TMP:temporary,AFH_COSMOS_DATA:path.join(this.store.workspaceRoot(id),'data'),AFH_COSMOS_PORT:'0',AFH_PRIVATE_TOKEN:secret,AFH_MANAGED:'1'};
  delete env.AFH_VOLUME_PG_CONFIG;delete env.AFH_JEV_CONFIG;delete env.OPENAI_API_KEY;delete env.CODEX_API_KEY;
  const child=fork(fileURLToPath(new URL('./server.mjs',import.meta.url)),[],{env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  const worker={child,secret,port:null,closed:new Promise(resolve=>child.once('close',resolve))};
  try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('ACCESS_WORKER_START_TIMEOUT')),20000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('ACCESS_WORKER_EXIT'));});child.on('message',m=>{if(m?.type==='orbita-ready'&&Number.isInteger(m.port)){clearTimeout(timer);worker.port=m.port;resolve();}});});
   this.store.active(this.store.workspace(id));demand(!this.closed&&!this.stopping.has(id),'ACCESS_WORKER_STOPPING',503);this.items.set(id,worker);child.once('exit',()=>{if(this.items.get(id)===worker)this.items.delete(id);});return worker;
  }catch(e){terminateOwned(child);await worker.closed;throw e;}
 }
 async stop(id){
  if(this.stopping.has(id))return this.stopping.get(id);
  const task=(async()=>{const pending=this.pending.get(id);if(pending)try{await pending;}catch{}const w=this.items.get(id);if(!w)return;terminateOwned(w.child);await Promise.race([w.closed,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('ACCESS_WORKER_STOP_TIMEOUT')),15000);t.unref();})]);if(this.items.get(id)===w)this.items.delete(id);})();
  this.stopping.set(id,task);try{await task;}finally{this.stopping.delete(id);}
 }
 async close(){this.closed=true;clearInterval(this.timer);for(const id of new Set([...this.items.keys(),...this.pending.keys()]))await this.stop(id);}
}

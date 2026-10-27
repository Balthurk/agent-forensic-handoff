import fs from 'node:fs';import path from 'node:path';import {sha} from './durable.mjs';import {RequestDeadline} from './deadline.mjs';
const controller=new AbortController();let running=false;
process.on('message',async message=>{
 if(message.type==='cancel'){controller.abort(new Error(message.reason||'CALLER_CANCELLED'));return;}
 if(message.type!=='query'||running)return;running=true;let deadline,closeMemory;
 try{
  const {route,question,options,remainingMs}=message;deadline=new RequestDeadline(Math.max(1,remainingMs),controller.signal);await deadline.yield();
  const root=fs.realpathSync.native(process.env.AFH_COSMOS_DATA);if(root.toLowerCase()!==route.root.toLowerCase())throw new Error('FEDERATION_ROOT_REBOUND');const identityBytes=fs.readFileSync(path.join(root,'federation-store.json'));if(sha(identityBytes)!==route.identityHash)throw new Error('FEDERATION_IDENTITY_CHANGED');const identity=JSON.parse(identityBytes);if(identity.id!==route.id||identity.scope!==route.scope)throw new Error('FEDERATION_SCOPE_MISMATCH');
  const disk=JSON.parse(fs.readFileSync(path.join(root,'library.json'),'utf8'));for(const id of route.conversationIds)if(!disk.some(i=>i.id===id))throw new Error('FEDERATION_CONVERSATION_UNKNOWN');for(const item of disk){const id=item.id;if(typeof id!=='string'||!/^[-a-zA-Z0-9_]{1,180}$/.test(id))throw new Error('FEDERATION_CASE_ID_INVALID');const local=fs.realpathSync.native(path.join(root,'cases',id)),relative=path.relative(path.join(root,'cases'),local);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('FEDERATION_CASE_OUTSIDE_STORE');}
  await deadline.yield();const memory=await import('./memory.mjs');closeMemory=memory.closeMemory;const pkg=await memory.retrievePackage(question,route.conversationIds,{...options,signal:deadline.signal});deadline.check();process.send({ok:true,package:pkg});
 }catch(e){process.send({ok:false,error:e.message,cancelled:controller.signal.aborted||deadline?.signal.aborted||false});}
 finally{deadline?.close();await closeMemory?.();process.disconnect();}
});

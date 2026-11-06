import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {inventory,createBackup,restoreBackup,hashFile,validateStore} from './recovery.mjs';
import {plainPath} from './store-access.mjs';
import {demand} from './access-store.mjs';

// The entire workspace is the lifecycle unit. No table-specific deletion list:
// future stores, sidecars and abandoned staging files belong to the same root.
export class Lifecycle{
 constructor(store,stop){this.store=store;this.stop=stop;this.busy=new Set();}
 async exclusive(id,fn){demand(!this.busy.has(id),'ACCESS_LIFECYCLE_BUSY',409);this.busy.add(id);try{return await fn();}finally{this.busy.delete(id);}}
 async preview(user,id){this.store.authorizeUser(user,id,'owner',{maintenance:true});const w=this.store.workspace(id),root=this.store.workspaceRoot(id);return {workspace:w,inventory:fs.existsSync(root)?await inventory(root):null,scope:'All files in this managed workspace, including backups and sidecars',externalDeletion:'Not independently verifiable',physicalErasure:false};}
 async backup(user,id,password){return this.exclusive(id,async()=>{
  let w=this.store.authorizeUser(user,id,'owner').workspace;w=this.store.save({...w,status:'maintenance'},'backup_started',user);await this.stop(id);
  try{const backupId=randomUUID(),archive=path.join(this.store.workspaceRoot(id),'backups',backupId+'.orbita');
   const receipt=await createBackup({source:path.join(this.store.workspaceRoot(id),'data'),archive,password,scratchRoot:path.join(this.store.workspaceRoot(id),'scratch')});
   const value={id:backupId,workspace:id,archive,sha256:receipt.archiveSha256,files:receipt.files,bytes:receipt.bytes,createdAt:receipt.createdAt};
   this.store.db.prepare('INSERT INTO archives VALUES(?,?,?)').run(backupId,id,JSON.stringify(value));this.store.audit(user,'backup_completed',id,{id:backupId,sha256:value.sha256});return {...value,archive:undefined};
  }finally{const current=this.store.workspace(id);if(current.status==='maintenance')this.store.save({...current,status:'active'},'maintenance_finished',user);}
 });}
 archives(user,id){this.store.authorizeUser(user,id,'owner',{maintenance:true});return this.store.db.prepare('SELECT payload FROM archives WHERE workspace=?').all(id).map(r=>({...JSON.parse(r.payload),archive:undefined}));}
 async archive(user,id,backupId){this.store.authorizeUser(user,id,'owner');const row=this.store.db.prepare('SELECT payload FROM archives WHERE id=? AND workspace=?').get(backupId,id);demand(row,'ACCESS_BACKUP_NOT_FOUND',404);const b=JSON.parse(row.payload),expected=path.join(this.store.workspaceRoot(id),'backups',backupId+'.orbita');demand(b.archive===expected,'ACCESS_BACKUP_BINDING');plainPath(expected);demand(await hashFile(expected)===b.sha256,'ACCESS_BACKUP_CHANGED',409);return b;}
 async restore(user,id,backupId,password){return this.exclusive(id,async()=>{
  const b=await this.archive(user,id,backupId);let w=this.store.authorizeUser(user,id,'owner').workspace;
  w=this.store.save({...w,status:'maintenance'},'restore_started',user);await this.stop(id);
  const root=this.store.workspaceRoot(id),stage=path.join(root,'restore-'+randomUUID()),data=path.join(root,'data'),prior=path.join(root,'retired-'+randomUUID());let swapped=false;
  w=this.store.save({...w,restoreTransition:{stage:path.basename(stage),prior:path.basename(prior),backupId}},'restore_transition_prepared',user);
  try{
   const receipt=await restoreBackup({archive:b.archive,destination:stage,password,scratchRoot:path.join(root,'scratch')});
   demand((await hashFile(b.archive))===b.sha256,'ACCESS_BACKUP_CHANGED',409);
   fs.renameSync(data,prior);fs.renameSync(stage,data);swapped=true;
   // These markers are part of the same workspace inventory/purge scope.
   const marker=path.join(root,'.'+path.basename(stage)+'.orbita-restore.json');
   if(fs.existsSync(marker))fs.renameSync(marker,path.join(root,'.data.orbita-restore.json'));
   this.store.audit(user,'restore_completed',id,{backupId,files:receipt.files,revocationsPreserved:true});
   return {files:receipt.files,validation:receipt.validation,revocationsPreserved:true,automaticWork:false,externalAccess:false,retiredDataRetained:true};
  }catch(e){if(!fs.existsSync(data)&&fs.existsSync(prior))fs.renameSync(prior,data);throw e;}
  finally{const current=this.store.workspace(id);if(current.status==='maintenance'&&fs.existsSync(data))this.store.save({...current,status:'active',restoreTransition:null},'maintenance_finished',user,{swapped});}
 });}
 async recoverMaintenance(user,id){return this.exclusive(id,async()=>{
  const w=this.store.authorizeUser(user,id,'owner',{maintenance:true}).workspace;demand(w.status==='maintenance','ACCESS_NOT_IN_MAINTENANCE',409);await this.stop(id);
  const root=this.store.workspaceRoot(id),data=path.join(root,'data');
  if(!fs.existsSync(data)){demand(/^retired-[a-f0-9-]{36}$/.test(w.restoreTransition?.prior||''),'ACCESS_RECOVERY_PRIOR_MISSING',409);const prior=plainPath(path.join(root,w.restoreTransition.prior));demand(fs.existsSync(prior),'ACCESS_RECOVERY_PRIOR_MISSING',409);fs.renameSync(prior,data);}
  const validation=await validateStore(data,{scratchRoot:path.join(root,'scratch')});
  this.store.save({...w,status:'suspended',restoreTransition:null},'maintenance_recovered_suspended',user);return {validation,status:'suspended',requiresExplicitResume:true};
 });}
 async plan(user,id){return this.exclusive(id,async()=>{
  let w=this.store.authorizeUser(user,id,'owner',{maintenance:true}).workspace;
  demand(['active','suspended','purge_prepared','purge_failed','maintenance'].includes(w.status),'ACCESS_PURGE_STATE',409);
  demand(!w.legalHold,'ACCESS_LEGAL_HOLD',409);demand(!w.externalCopies.some(c=>c.state==='outstanding'),'ACCESS_EXTERNAL_COPIES_OUTSTANDING',409);
  w=this.store.save({...w,status:'purge_prepared'},'purge_prepared',user);await this.stop(id);
  const root=this.store.workspaceRoot(id),rootAbsent=!fs.existsSync(root);demand(!rootAbsent||w.purgeAttempt,'ACCESS_PURGE_ROOT_MISSING',409);
  const snapshot=rootAbsent?{files:0,bytes:0,entries:0,treeHash:null}:await inventory(root),idPlan=randomUUID(),plan={id:idPlan,workspace:id,revision:w.revision,createdAt:this.store.now(),expiresAt:new Date(this.store.clock()+600000).toISOString(),snapshot,rootAbsent,externalCopies:w.externalCopies.map(c=>({id:c.id,state:c.state})),confirmation:'BORRAR '+id};
  this.store.db.prepare('INSERT INTO plans VALUES(?,?,?)').run(idPlan,id,JSON.stringify(plan));return plan;
 });}
 async cancel(user,id){return this.exclusive(id,async()=>{const w=this.store.authorizeUser(user,id,'owner',{maintenance:true}).workspace;demand(w.status==='purge_prepared','ACCESS_PURGE_NOT_CANCELLABLE',409);return this.store.save({...w,status:'suspended'},'purge_cancelled_suspended',user);});}
 async purge(user,id,planId,confirmation){return this.exclusive(id,async()=>{
  let w=this.store.authorizeUser(user,id,'owner',{maintenance:true}).workspace;demand(w.status==='purge_prepared'&&!w.legalHold,'ACCESS_PURGE_NOT_PREPARED',409);
  const row=this.store.db.prepare('SELECT payload FROM plans WHERE id=? AND workspace=?').get(planId,id);demand(row,'ACCESS_PURGE_PLAN',409);const plan=JSON.parse(row.payload);
  demand(confirmation===plan.confirmation&&w.revision===plan.revision&&Date.parse(plan.expiresAt)>this.store.clock(),'ACCESS_PURGE_CONFIRMATION_OR_STALE_PLAN',409);
  demand(!w.externalCopies.some(c=>c.state==='outstanding'),'ACCESS_EXTERNAL_COPIES_OUTSTANDING',409);await this.stop(id);
  const root=this.store.workspaceRoot(id),current=plan.rootAbsent&&!fs.existsSync(root)?{files:0,bytes:0,entries:0,treeHash:null}:await inventory(root);
  demand(JSON.stringify(current)===JSON.stringify(plan.snapshot),'ACCESS_PURGE_INVENTORY_CHANGED',409);
  // Absolute path and non-alias inventory are verified before any deletion.
  demand(path.dirname(root)===path.join(this.store.root,'spaces')&&path.basename(root)===id,'ACCESS_PURGE_PATH');
  w=this.store.save({...w,status:'purge_failed',purgeAttempt:w.purgeAttempt||{planId,snapshot:current}},'purge_started',user,{planId,files:current.files,treeHash:current.treeHash});
  try{
   if(fs.existsSync(root))fs.rmSync(root,{recursive:true,force:false,maxRetries:0});demand(!fs.existsSync(root),'ACCESS_PURGE_RESIDUAL',409);
   const receipt={id:randomUUID(),workspace:id,at:this.store.now(),files:w.purgeAttempt.snapshot.files,bytes:w.purgeAttempt.snapshot.bytes,treeHash:w.purgeAttempt.snapshot.treeHash,managedFilesAbsent:true,physicalErasure:false,externalCopies:plan.externalCopies,scope:'managed_workspace_only'};
   this.store.tx(()=>{this.store.db.prepare('DELETE FROM sessions WHERE workspace=?').run(id);this.store.db.prepare('DELETE FROM archives WHERE workspace=?').run(id);this.store.db.prepare('DELETE FROM plans WHERE workspace=?').run(id);});
   this.store.save({...w,status:'purged',name:'Espacio eliminado',policy:{},externalCopies:[],purge:receipt},'purge_verified',user,{receiptId:receipt.id});return receipt;
  }catch(e){this.store.audit(user,'purge_incomplete',id,{code:e.code||e.message});throw e;}
 });}
}

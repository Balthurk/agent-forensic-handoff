import fs from 'node:fs';
import path from 'node:path';
import {commonStoreHealth,DatabaseSync,closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
import {semanticModelStatus} from '../agent-forensic-handoff/src/semantic-model.js';
import {plainPath} from './store-access.mjs';

// A launcher receives one root's runtime credential, never an operator bundle.
const [mode,requestedRoot]=process.argv.slice(2);
let control;
try{
 if(!['Personal','Managed'].includes(mode))throw new Error('START_MODE');
 const root=plainPath(requestedRoot),file=process.env.ORBITA_POSTGRES_CONFIG;
 if(!file||process.env.ORBITA_POSTGRES_BINDING)throw new Error('START_REQUIRES_FILE_CONFIGURATION');
 const fd=fs.openSync(plainPath(file),'r');let config;
 try{
  if(fs.fstatSync(fd).size>1024**2)throw new Error('START_PROFILE_SIZE');
  try{config=JSON.parse(fs.readFileSync(fd,'utf8').replace(/^\uFEFF/,''));}catch{throw new Error('START_PROFILE_INVALID');}
 }finally{fs.closeSync(fd);}
 const canonical=value=>path.resolve(plainPath(value)).toLowerCase();
 if(config.user!=='orbita_runtime'||config.bindings?.length!==1)throw new Error('START_SINGLE_ROOT_PROFILE_REQUIRED');
 const relative=path.relative(canonical(config.bindings[0].root),canonical(root));
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('START_SINGLE_ROOT_PROFILE_REQUIRED');
 const health=commonStoreHealth(root);
 if(!(mode==='Managed'?['control','test']:['personal','test']).includes(health.workspaceKind))throw new Error('START_WORKSPACE_KIND');
 if(mode==='Managed'){
  control=new DatabaseSync(path.join(root,'access.pgstore'),{family:'access'});
  if(control.registerManagedControl().workspaceId!==health.workspaceId)throw new Error('START_CONTROL_IDENTITY');
 }
 const model=semanticModelStatus();
 if(!model.available)throw new Error('START_EXACT_MODEL_SNAPSHOT_REQUIRED');
 console.log(JSON.stringify({status:'READY',mode,health,model:{modelId:model.modelId,revision:model.revision,available:model.available}}));
}finally{
 try{control?.close();}finally{
  const closed=closeCommonStore();
  if(!closed.alreadyClosed&&(!closed.drained||closed.ownedExit!==0))throw new Error('START_COMMON_CONSUMER_CLOSE_UNVERIFIED');
 }
}

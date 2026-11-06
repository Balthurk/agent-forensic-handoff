// Isolated synthetic managed workspace, shared by executable and native UI checks.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {AccessStore} from './access-store.mjs';

export function managedFixture(root){
 const password='synthetic-managed-parity-only',store=new AccessStore(root,{create:true});
 try{
  const owner=store.createAccount('owner',password,{admin:true}),editor=store.createAccount('editor',password),reader=store.createAccount('reader',password);
  const policy={basis:'Synthetic permission for regression',purpose:'Managed UI and role acceptance only',rightsUntil:new Date(Date.now()+86400000).toISOString(),retainUntil:new Date(Date.now()+172800000).toISOString()};
  const a=store.createWorkspace(owner.id,{name:'Alpha · pruebas sintéticas',policy}),b=store.createWorkspace(owner.id,{name:'Beta · espacio vacío',policy});
  for(const w of [a,b]){store.grant(owner.id,w.id,'reader','reader');store.grant(owner.id,w.id,'editor',w===a?'editor':'reader');}
  const tokens=Object.fromEntries([owner,editor,reader].map(u=>[u.name,store.issue(u.id,{workspace:a.id}).token]));
  const seed=path.join(root,'seed.mjs');
  fs.writeFileSync(seed,`const {graphFixture}=await import(${JSON.stringify(new URL('./graph-fixture.mjs',import.meta.url).href)});const {causalFixture}=await import(${JSON.stringify(new URL('./causal-fixture.mjs',import.meta.url).href)});console.log(JSON.stringify({graph:await graphFixture(),causal:await causalFixture()}));`);
  const f=JSON.parse(execFileSync(process.execPath,[seed],{env:{...process.env,AFH_COSMOS_DATA:path.join(store.workspaceRoot(a.id),'data'),AFH_COSMOS_EMPTY_LIBRARY:'1'},encoding:'utf8',windowsHide:true,timeout:60000}));
  return {root,password,owner,editor,reader,a,b,tokens,...f};
 }finally{store.close();}
}

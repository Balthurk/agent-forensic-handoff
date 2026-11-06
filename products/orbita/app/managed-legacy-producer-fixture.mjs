// Qualification only: the sealed I05 writer produces this disposable history.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [oracle,root]=process.argv.slice(2),temporary=path.resolve(process.env.TEMP);
assert.ok(path.resolve(root).startsWith(temporary+path.sep));assert.match(path.basename(root),/^legacy-managed-[a-f0-9-]{36}$/);
assert.equal(fs.existsSync(root),false);
const {AccessStore}=await import(pathToFileURL(path.join(oracle,'app/access-store.mjs')));
const {Lifecycle}=await import(pathToFileURL(path.join(oracle,'app/access-lifecycle.mjs')));
const now=Date.now(),clock=()=>now-2*86400000;
const store=new AccessStore(root,{create:true,clock}),life=new Lifecycle(store,async()=>{});
const password='synthetic-managed-legacy-password-only';
const policy={basis:'Synthetic fixture permission only',purpose:'Local migration qualification only',rightsUntil:new Date(now+2*86400000).toISOString(),retainUntil:new Date(now+3*86400000).toISOString()};
let result;
try{
 const owner=store.createAccount('original-owner',password,{admin:true}),erased=store.createAccount('erased-owner',password);
 const active=store.createWorkspace(owner.id,{name:'Original active fixture',policy}),gone=store.createWorkspace(erased.id,{name:'Original purged fixture',policy});
 const expired=store.issue(owner.id,{kind:'browser'});
 const backup=await life.backup(owner.id,active.id,'synthetic-v1-archive-password-only');
 const archive=JSON.parse(store.db.prepare('SELECT payload FROM archives WHERE id=?').get(backup.id).payload);
 const plan=await life.plan(erased.id,gone.id);await life.purge(erased.id,gone.id,plan.id,plan.confirmation);
 store.deleteAccount(owner.id,erased.id);
 assert.equal(fs.existsSync(store.workspaceRoot(gone.id)),false);
 result={local:active.id,purged:gone.id,owner:owner.id,erased:erased.id,expiredToken:expired.token,archive};
}finally{store.close();}
fs.writeFileSync(path.join(root,'producer.json'),JSON.stringify(result),{flag:'wx'});
process.stdout.write(JSON.stringify(result));

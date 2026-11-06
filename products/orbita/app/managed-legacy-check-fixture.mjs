// Qualification only: fresh candidate application against a published domain.
import native from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
import {AccessStore} from './access-store.mjs';
import {Lifecycle} from './access-lifecycle.mjs';
const [metadata,root]=process.argv.slice(2),legacy=JSON.parse(native.readFileSync(metadata,'utf8'));
const store=new AccessStore(root),life=new Lifecycle(store,async()=>{});
try{
 assert.throws(()=>store.session(legacy.expiredToken),/ACCESS_SESSION_REQUIRED/);
 assert.throws(()=>store.user(legacy.erased),/ACCESS_SESSION_REQUIRED/);
 assert.equal(store.managedState(legacy.purged).purged,true);
 assert.throws(()=>store.db.provisionManaged(legacy.purged),/MANAGED_CREATE_TRANSACTION_REQUIRED/);
 const session=store.login('original-owner','synthetic-managed-legacy-password-only');assert.equal(store.session(session.token).user,legacy.owner);
 const row=store.db.prepare('SELECT payload FROM archives WHERE id=?').get(legacy.archive.id);
 const archive=await life.archive(legacy.owner,legacy.local,legacy.archive.id);
 assert.equal(archive.archive,path.join(root,'spaces',legacy.local,'backups',legacy.archive.id+'.orbita'));
 assert.equal(store.db.prepare('SELECT payload FROM archives WHERE id=?').get(legacy.archive.id).payload,row.payload);
 store.db.prepare('UPDATE archives SET payload=? WHERE id=?').run(row.payload+' ',legacy.archive.id);
 await assert.rejects(life.archive(legacy.owner,legacy.local,legacy.archive.id),/MANAGED_ARCHIVE_BINDING/);
 store.db.prepare('UPDATE archives SET payload=? WHERE id=?').run(row.payload,legacy.archive.id);
 const original=fs.readFileSync(archive.archive);assert.ok(original.subarray(0,17).toString().startsWith('ORBITA-BACKUP-01'));
 fs.writeFileSync(archive.archive,'altered synthetic ciphertext');
 await assert.rejects(life.archive(legacy.owner,legacy.local,legacy.archive.id),/ACCESS_BACKUP_CHANGED/);
 fs.writeFileSync(archive.archive,original);
 await assert.rejects(life.archive(legacy.owner,legacy.purged,legacy.archive.id),/ACCESS_DENIED/);
 assert.equal(native.existsSync(root),false);
}finally{store.close();assert.equal(closeCommonStore().drained,true);}
process.stdout.write(JSON.stringify({status:'PASS_ORIGINAL_ACCESS_AND_ARCHIVE_MAPPING',v1RestoreTested:false}));

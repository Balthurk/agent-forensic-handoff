import test from 'node:test';import assert from 'node:assert/strict';import fs from '../agent-forensic-handoff/src/common-files.js';import native from 'node:fs';import path from 'node:path';import {DatabaseSync,closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';import {keepCaptureLease} from './capture-lease.mjs';
const schema=native.readFileSync(new URL('../agent-forensic-handoff/python/orbita_store/schemas/capture.sql',import.meta.url),'utf8');
fs.mkdirSync(process.env.ORBITA_POSTGRES_TEST_ROOT,{recursive:true});
test.after(()=>{assert.equal(native.existsSync(process.env.ORBITA_POSTGRES_TEST_ROOT),false);closeCommonStore();});

test('capture lease survives a blocked main event loop and cannot revive an expired owner',async()=>{
 const root=fs.mkdtempSync(process.env.ORBITA_POSTGRES_TEST_ROOT+'/capture-lease-'),file=path.join(root,'jobs.pgstore'),db=new DatabaseSync(file,{family:'capture',create:true});db.exec(schema);
 db.prepare("INSERT INTO jobs(id,owner,lease_until,source,prefix,status) VALUES(?,?,?,'explicit-fixture','empty','capturing')").run('job','owner',Date.now()+5000);const keeper=await keepCaptureLease(file,'job','owner',5000);
 try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6000);keeper.assert();assert.ok(db.prepare('SELECT lease_until FROM jobs').get().lease_until>Date.now());}finally{const receipt=await keeper.stop();assert.equal(receipt.drained,true);assert.equal(receipt.ownedExit,0);}
 db.prepare('UPDATE jobs SET lease_until=?').run(Date.now()-1);await assert.rejects(keepCaptureLease(file,'job','owner',5000),/STALE_OWNER/);assert.ok(db.prepare('SELECT lease_until FROM jobs').get().lease_until<Date.now());db.close();
});
test('capture lease never overwrites a replacement writer token',async()=>{
 const root=fs.mkdtempSync(process.env.ORBITA_POSTGRES_TEST_ROOT+'/capture-fence-'),file=path.join(root,'jobs.pgstore'),db=new DatabaseSync(file,{family:'capture',create:true});db.exec(schema);db.prepare("INSERT INTO jobs(id,owner,lease_until,source,prefix,status) VALUES(?,?,?,'explicit-fixture','empty','capturing')").run('job','new-owner',Date.now()+10000);
 const before=db.prepare('SELECT * FROM jobs').get();await assert.rejects(keepCaptureLease(file,'job','old-owner',5000),/STALE_OWNER/);assert.deepEqual(db.prepare('SELECT * FROM jobs').get(),before);db.close();
});

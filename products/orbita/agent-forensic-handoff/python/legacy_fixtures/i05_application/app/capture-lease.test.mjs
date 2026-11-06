import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {keepCaptureLease} from './capture-lease.mjs';
test('capture lease survives a blocked main event loop and cannot revive an expired owner',async()=>{
 const root=fs.mkdtempSync('C:/T/orbita-capture-lease-'),file=path.join(root,'jobs.sqlite'),db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL;CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT,lease_until INTEGER)');
 db.prepare('INSERT INTO jobs VALUES(?,?,?)').run('job','owner',Date.now()+5000);const keeper=await keepCaptureLease(file,'job','owner',5000);
 try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6000);keeper.assert();assert.ok(db.prepare('SELECT lease_until FROM jobs').get().lease_until>Date.now());}finally{await keeper.stop();}
 db.prepare('UPDATE jobs SET lease_until=?').run(Date.now()-1);await assert.rejects(keepCaptureLease(file,'job','owner',5000),/STALE_OWNER/);assert.ok(db.prepare('SELECT lease_until FROM jobs').get().lease_until<Date.now());db.close();
});
test('capture lease never overwrites a replacement writer token',async()=>{
 const root=fs.mkdtempSync('C:/T/orbita-capture-fence-'),file=path.join(root,'jobs.sqlite'),db=new DatabaseSync(file);db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT,lease_until INTEGER)');db.prepare('INSERT INTO jobs VALUES(?,?,?)').run('job','new-owner',Date.now()+10000);
 const before=db.prepare('SELECT * FROM jobs').get();await assert.rejects(keepCaptureLease(file,'job','old-owner',5000),/STALE_OWNER/);assert.deepEqual(db.prepare('SELECT * FROM jobs').get(),before);db.close();
});

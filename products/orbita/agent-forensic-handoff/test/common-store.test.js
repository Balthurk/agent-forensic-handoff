import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync,commonStoreIdentity,closeCommonStore,openObject,objectOperation} from '../src/common-store.js';

const root=process.env.ORBITA_POSTGRES_TEST_ROOT;
assert.ok(root,'A real isolated PostgreSQL test binding is required');
const databases=[];
function database(name,options={}){
  const value=new DatabaseSync(path.join(root,name+'.pgstore'),{family:'access',create:true,...options});
  databases.push(value);return value;
}
test.after(()=>{for(const db of databases)db.close();closeCommonStore();});

test('Node runs against one PostgreSQL instance and never creates SQLite files',()=>{
  const identity=commonStoreIdentity();
  assert.equal(identity.database,'orbita');assert.match(identity.instanceId,/^[a-f0-9-]{36}$/);
  const a=database('same-a'),b=database('same-b');
  a.prepare('INSERT INTO attempts VALUES(?,?,?)').run('a',1,10);
  assert.deepEqual(a.prepare('SELECT * FROM attempts').all(),[{name:'a',count:1,until_at:10}]);
  assert.equal(b.prepare('SELECT count(*) n FROM attempts').get().n,0);
  assert.equal(fs.existsSync(root),false);
});

test('named parameters, literal bytes and split Unicode responses are exact',()=>{
  const db=database('unicode');
  const text='😀ñá\\ ? :named 100% '.repeat(12000);
  assert.equal(db.prepare('SELECT $text payload').get({$text:text}).payload,text);
  assert.deepEqual(db.prepare("SELECT CAST($text AS BLOB) payload").get({text:'literal\\x41 á'}).payload,Buffer.from('literal\\x41 á'));
});

test('BigInt parameters are not rounded and unsafe integer reads are explicit',()=>{
  const db=database('integers'),value=9007199254740993n;
  const statement=db.prepare('SELECT ? value');
  assert.throws(()=>statement.get(value),{code:'ORBITA_PG_INTEGER_OUT_OF_RANGE'});
  assert.equal(statement.setReadBigInts(true).get(value).value,value);
});

test('an ESM eval caller retains compatible worker flags and closes the owned child',()=>{
  const module=new URL('../src/common-store.js',import.meta.url).href;
  const source=`import {commonStoreIdentity,closeCommonStore} from ${JSON.stringify(module)}; if(commonStoreIdentity().database!=='orbita')throw Error('database'); const r=closeCommonStore(); if(r.ownedExit!==0||!r.drained)throw Error('close'); process.stdout.write('closed');`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',source],{env:process.env,windowsHide:true,timeout:15000,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'closed');
});

test('RETURNING is drained and run reports the actual inserted ordinal',()=>{
  const db=database('returning');
  const inserted=db.prepare("INSERT INTO audit(action) VALUES('one') RETURNING seq").run();
  assert.equal(inserted.changes,1);assert.equal(inserted.lastInsertRowid,1);
  assert.equal(db.prepare('SELECT seq FROM audit').get().seq,1);
});

test('failed SQL preserves a caller transaction and closing rolls it back',()=>{
  const db=database('transactions');
  db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO attempts VALUES(?,?,?)').run('a',1,10);
  assert.throws(()=>db.prepare('INSERT INTO attempts VALUES(?,?,?)').run('a',2,20),{code:'23505'});
  assert.equal(db.prepare('SELECT count(*) n FROM attempts').get().n,1);db.close();
  assert.equal(database('transactions').prepare('SELECT count(*) n FROM attempts').get().n,0);
});

test('Node object handles stream bytes and retain the exact opened version',()=>{
  objectOperation('mkdir',root,{recursive:true,existOk:true});
  const file=path.join(root,'bytes'),data=Buffer.from('😀 bytes\r\n'.repeat(140000));
  const writer=openObject(file,{mode:'x'});
  for(let start=0;start<data.length;start+=65536)assert.equal(writer.write(data.subarray(start,start+65536)),Math.min(65536,data.length-start));
  const result=writer.close();assert.equal(result.sha256,createHash('sha256').update(data).digest('hex'));
  const reader=openObject(file);
  const replacement=openObject(file,{mode:'w'});replacement.write(Buffer.from('new'));replacement.close();
  const blocks=[];
  for(;;){const block=reader.read(65536);if(!block.length)break;blocks.push(block);}
  assert.deepEqual(Buffer.concat(blocks),data);reader.close();
  const fresh=openObject(file);assert.equal(fresh.read(10).toString(),'new');fresh.close();
  objectOperation('unlink',file);
  assert.equal(fs.existsSync(root),false);
});

test('transport timeout invalidates old handles and does not replay a mutation',()=>{
  for(const db of databases)db.close();closeCommonStore();
  const db=database('timeout');db.exec('BEGIN IMMEDIATE');
  db.prepare("INSERT INTO attempts VALUES('uncommitted',1,10)").run();
  const prior=process.env.ORBITA_POSTGRES_BRIDGE_TIMEOUT_MS;
  process.env.ORBITA_POSTGRES_BRIDGE_TIMEOUT_MS='200';
  try{assert.throws(()=>db.prepare('SELECT pg_sleep(3)').get(),{code:'ORBITA_PG_BRIDGE_TIMEOUT_OUTCOME_UNKNOWN'});}
  finally{if(prior===undefined)delete process.env.ORBITA_POSTGRES_BRIDGE_TIMEOUT_MS;else process.env.ORBITA_POSTGRES_BRIDGE_TIMEOUT_MS=prior;}
  assert.throws(()=>db.prepare('SELECT 1').get(),{code:'ORBITA_PG_BRIDGE_LOST'});
  assert.equal(database('timeout').prepare('SELECT count(*) n FROM attempts').get().n,0);
});

test('graceful close drains the owned Python child and discards unpublished bytes',()=>{
  const file=path.join(root,'abandoned');openObject(file,{mode:'w'}).write(Buffer.from('unpublished'));
  const result=closeCommonStore();assert.equal(result.ownedExit,0);assert.equal(result.drained,true);
  assert.equal(objectOperation('exists',file).exists,false);
  assert.equal(closeCommonStore().ownedExit,0);
});

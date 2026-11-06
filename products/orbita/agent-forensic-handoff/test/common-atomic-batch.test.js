import {CaseDatabase} from '../src/database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync,closeCommonStore} from '../src/common-store.js';

const root=process.env.ORBITA_POSTGRES_TEST_ROOT;
assert.ok(root);
const virtual=path.join(root,'atomic-batch-'+randomUUID());
const open=(key,options={})=>new DatabaseSync(path.join(virtual,key),{family:'access',...options});
test.after(()=>{closeCommonStore();assert.equal(fs.existsSync(virtual),false);});

test('atomic batch publishes all rows together and can begin again',()=>{
  const db=open('visibility',{create:true}),reader=open('visibility',{readOnly:true});
  try{
    db.beginAtomicBatch();db.prepare("INSERT INTO attempts VALUES('a',1,10),('b',2,20)").run();
    assert.equal(reader.prepare('SELECT count(*) AS n FROM attempts').get().n,0);
    db.exec('COMMIT');assert.equal(reader.prepare('SELECT count(*) AS n FROM attempts').get().n,2);
    db.beginAtomicBatch();db.prepare("INSERT INTO attempts VALUES('c',3,30)").run();db.exec('COMMIT');
    assert.equal(reader.prepare('SELECT count(*) AS n FROM attempts').get().n,3);
  }finally{db.close();reader.close();}
});

test('atomic batch rejects commit after SQL failure while ordinary statements recover',()=>{
  const db=open('failure',{create:true}),reader=open('failure',{readOnly:true});
  try{
    db.prepare("INSERT INTO attempts VALUES('seed',1,10)").run();
    db.beginAtomicBatch();db.prepare("INSERT INTO attempts VALUES('discard',2,20)").run();
    assert.throws(()=>db.prepare("INSERT INTO attempts VALUES('seed',3,30)").run(),{code:'23505'});
    assert.throws(()=>db.exec('COMMIT'),{code:'ORBITA_PG_ATOMIC_BATCH_FAILED'});db.exec('ROLLBACK');
    assert.deepEqual(reader.prepare('SELECT name FROM attempts').all(),[{name:'seed'}]);
    db.exec('BEGIN IMMEDIATE');db.prepare("INSERT INTO attempts VALUES('ordinary',4,40)").run();
    assert.throws(()=>db.prepare("INSERT INTO attempts VALUES('seed',5,50)").run(),{code:'23505'});db.exec('COMMIT');
    assert.deepEqual(reader.prepare('SELECT name FROM attempts ORDER BY name').all(),[{name:'ordinary'},{name:'seed'}]);
  }finally{db.close();reader.close();}
});

test('client integer decoding failure after INSERT poisons the batch before commit',()=>{
  const db=open('decode',{create:true}),reader=open('decode',{readOnly:true});
  const large=9007199254740992n;
  try{
    db.beginAtomicBatch();
    assert.throws(()=>db.prepare('INSERT INTO audit(seq,action) VALUES(?,?)').run(large,'decode-failure'),{code:'ORBITA_PG_INTEGER_OUT_OF_RANGE'});
    assert.throws(()=>db.exec('COMMIT'),{code:'ORBITA_PG_ATOMIC_BATCH_FAILED'});db.exec('ROLLBACK');
    assert.equal(reader.prepare('SELECT count(*) AS n FROM audit').get().n,0);
    db.beginAtomicBatch();const result=db.prepare('INSERT INTO audit(seq,action) VALUES(?,?)').setReadBigInts(true).run(large,'exact');
    assert.equal(result.lastInsertRowid,large);db.exec('COMMIT');
    assert.deepEqual(reader.prepare('SELECT seq,action FROM audit').setReadBigInts(true).all(),[{seq:large,action:'exact'}]);
  }finally{db.close();reader.close();}
});

test('void writes retain exact large integers and publish only on commit',()=>{
  const db=open('void-visibility',{create:true}),reader=open('void-visibility',{readOnly:true});
  try{
    db.beginAtomicBatch();
    assert.equal(db.runAtomicWrites([{sql:'INSERT INTO attempts VALUES(?,?,?)',params:['first',1,10]},{sql:'INSERT INTO audit(seq,action) VALUES(?,?)',params:[9007199254740992n,'exact']}]),2);
    assert.equal(reader.prepare('SELECT count(*) AS n FROM attempts').get().n,0);
    db.exec('COMMIT');
    assert.deepEqual(reader.prepare('SELECT seq,action FROM audit').setReadBigInts(true).all(),[{seq:9007199254740992n,action:'exact'}]);
  }finally{db.close();reader.close();}
});

test('a failed void segment forbids committing previously flushed writes',()=>{
  const db=open('void-failure',{create:true}),reader=open('void-failure',{readOnly:true});
  try{
    db.beginAtomicBatch();db.runAtomicWrites([{sql:"INSERT INTO attempts VALUES('prior',1,10)"}]);
    assert.throws(()=>db.runAtomicWrites([{sql:"INSERT INTO attempts VALUES('next',2,20)"},{sql:"INSERT INTO attempts VALUES('prior',3,30)"}]),{code:'23505'});
    assert.throws(()=>db.exec('COMMIT'),{code:'ORBITA_PG_ATOMIC_BATCH_FAILED'});db.exec('ROLLBACK');
    assert.equal(reader.prepare('SELECT count(*) AS n FROM attempts').get().n,0);
  }finally{db.close();reader.close();}
});

test('case writes snapshot buffers and flush before retained statements and commit',()=>{
  const target=path.join(virtual,'case-queue'),db=new CaseDatabase(target),reader=new DatabaseSync(target,{family:'case',readOnly:true});
  try{
    const retained=db.statement('SELECT count(*) AS n FROM parse_warning');
    const bytes=Buffer.from('original');let calls=0;const send=db.db.runAtomicWrites.bind(db.db);
    db.db.runAtomicWrites=(writes)=>{calls++;return send(writes);};
    db.beginAtomicBatch();
    db.insertContentBlob({sha256:'test-buffer',byteLength:8,extension:'bin',storage:'SQLITE',inlineData:bytes});bytes.fill(120);
    db.insertWarning({id:'first',code:'test',message:'first'});
    assert.equal(retained.get().n,1);assert.equal(calls,1);
    assert.deepEqual(db.get("SELECT inline_data FROM content_blob WHERE sha256='test-buffer'").inline_data,Buffer.from('original'));
    assert.equal(reader.prepare('SELECT count(*) AS n FROM parse_warning').get().n,0);
    db.insertWarning({id:'second',code:'test',message:'second'});db.commit();
    assert.equal(reader.prepare('SELECT count(*) AS n FROM parse_warning').get().n,2);
  }finally{db.close();reader.close();}
});

test('case queue discards rollback and close and preserves failed flush outcome',()=>{
  const target=path.join(virtual,'case-discard'),db=new CaseDatabase(target),reader=new DatabaseSync(target,{family:'case',readOnly:true});
  try{
    db.beginAtomicBatch();db.insertWarning({id:'discard',code:'test',message:'rollback'});db.rollback();
    assert.equal(reader.prepare('SELECT count(*) AS n FROM parse_warning').get().n,0);
    db.beginAtomicBatch();db.insertWarning({id:'duplicate',code:'test',message:'first'});db.get('SELECT count(*) AS n FROM parse_warning');
    db.insertWarning({id:'duplicate',code:'test',message:'second'});
    assert.throws(()=>db.commit(),{code:'23505'});
    assert.throws(()=>db.commit(),{code:'ORBITA_PG_ATOMIC_BATCH_FAILED'});db.rollback();
    assert.equal(reader.prepare('SELECT count(*) AS n FROM parse_warning').get().n,0);
    db.beginAtomicBatch();db.insertWarning({id:'close',code:'test',message:'close'});db.close();
    assert.equal(reader.prepare('SELECT count(*) AS n FROM parse_warning').get().n,0);
  }finally{db.close();reader.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync,closeCommonStore} from '../src/common-store.js';
import {transactionIO} from '../src/common-transaction.js';
import fs from '../src/common-files.js';

const root=process.env.ORBITA_POSTGRES_TEST_ROOT;
const opened=[];
function build(name){
  const dir=path.join(root,'atomic-node',name),file=path.join(dir,'case.json');
  const db=new DatabaseSync(path.join(dir,'access.pgstore'),{family:'access',create:true});opened.push(db);
  db.prepare("INSERT INTO attempts VALUES('row',1,0)").run();fs.writeFileSync(file,'old');
  return {dir,file,db,io:transactionIO(db)};
}
test.after(()=>{for(const db of opened)db.close();assert.equal(native.existsSync(root),false);closeCommonStore();});

test('explicit transactional I/O commits exact large Unicode bytes and rows for a fresh reader',()=>{
  const {dir,file,db,io}=build('commit');const text='aá😀\r\n'.repeat(900000);
  db.beginConsistentWrite();db.prepare('UPDATE attempts SET count=2').run();io.atomicWrite(file,text);
  assert.equal(io.readFile(file,'utf8'),text);assert.equal(fs.readFileSync(file,'utf8'),'old');
  db.exec('COMMIT');db.close();
  const source=`import {DatabaseSync,closeCommonStore} from ${JSON.stringify(new URL('../src/common-store.js',import.meta.url).href)};import fs from ${JSON.stringify(new URL('../src/common-files.js',import.meta.url).href)};import path from 'node:path';import {createHash} from 'node:crypto';const d=new DatabaseSync(path.join(process.argv[1],'access.pgstore'),{family:'access',readOnly:true});const b=fs.readFileSync(path.join(process.argv[1],'case.json'));console.log(JSON.stringify({n:d.prepare('SELECT count FROM attempts').get().count,size:b.length,sha:createHash('sha256').update(b).digest('hex')}));d.close();closeCommonStore();`;
  const actual=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source,dir],{encoding:'utf8',timeout:15000,windowsHide:true}));
  assert.equal(actual.n,2);assert.equal(actual.size,Buffer.byteLength(text));
  assert.equal(actual.sha,fs.statSync(file).sha256);assert.equal(fs.readFileSync(file,'utf8'),text);
});

test('rollback and database close discard operational views without native output',()=>{
  for(const close of [false,true]){
    const {file,db,io}=build('discard-'+close);db.beginConsistentWrite();
    db.prepare('UPDATE attempts SET count=3').run();io.atomicWrite(file,'new');
    if(close)db.close();else db.exec('ROLLBACK');
    assert.equal(fs.readFileSync(file,'utf8'),'old');
    assert.throws(()=>io.readFile(file),{code:close?'ORBITA_PG_DATABASE_CLOSED':'ORBITA_PG_OBJECT_TRANSACTION_REQUIRED'});
  }
});

test('no transaction, outside parent and open handles are rejected and fully drained',()=>{
  const {dir,file,db,io}=build('scope');
  assert.throws(()=>io.atomicWrite(file,'bad'),{code:'ORBITA_PG_OBJECT_TRANSACTION_REQUIRED'});
  db.beginConsistentWrite();assert.throws(()=>io.atomicWrite(path.join(root,'outside'),'bad'),{code:'ORBITA_PG_OBJECT_TRANSACTION_PATH_ESCAPE'});
  const reader=db.transactionOpen(file);assert.throws(()=>db.exec('COMMIT'),{code:'ORBITA_PG_OBJECT_TRANSACTION_OPEN_HANDLES'});
  reader.close();const writer=db.transactionOpen(path.join(dir,'open'),{mode:'w'});writer.write(Buffer.from('unpublished'));
  assert.throws(()=>db.exec('COMMIT'),{code:'ORBITA_PG_OBJECT_TRANSACTION_OPEN_HANDLES'});db.exec('ROLLBACK');
  assert.equal(fs.existsSync(path.join(dir,'open')),false);
  assert.throws(()=>writer.write(Buffer.from('later')));db.close();
});

test('exclusive immutable receipt conflicts preserve the original and caller transaction',()=>{
  const {dir,db,io}=build('immutable');const receipt=path.join(dir,'seals','one.json');
  db.beginConsistentWrite();io.atomicWrite(receipt,'original',{exclusive:true});
  assert.throws(()=>io.atomicWrite(receipt,'replacement',{exclusive:true}),{code:'EEXIST'});
  assert.equal(io.readFile(receipt,'utf8'),'original');db.exec('COMMIT');
  assert.equal(fs.readFileSync(receipt,'utf8'),'original');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from '../agent-forensic-handoff/src/common-files.js';
import native from 'node:fs';
import {commonFixture} from './common-test-scope.mjs';
import {nativeFixture} from './common-test-fixtures.mjs';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';

const corpus=process.env.ORBITA_CORPUS_UNDER_TEST||new URL('./corpus.mjs',import.meta.url).href;
const python=process.env.ORBITA_POSTGRES_PYTHON,pythonRoot=fileURLToPath(new URL('../agent-forensic-handoff/python',import.meta.url));
function fixture(t){
 const root=commonFixture('orbita-library-noop-');
 const data=path.join(root,'data');fs.mkdirSync(data);
 const items=[{id:'existing',title:'Texto sintético café 漢字',path:path.join(data,'cases','existing')}];
 const file=path.join(data,'library.json');fs.writeFileSync(file,JSON.stringify(items,null,2));
 const worker=path.join(nativeFixture('library-noop-worker'),'writer.mjs');
 native.writeFileSync(worker,`import {closeCommonStore} from ${JSON.stringify(new URL('../agent-forensic-handoff/src/common-store.js',import.meta.url).href)};import {registerLibraryItems} from ${JSON.stringify(corpus)};
const items=JSON.parse(process.argv[2]);
try{registerLibraryItems(items);console.log(JSON.stringify({status:'PASS'}));}catch(e){console.error(e.code||e.message);process.exitCode=1;}finally{closeCommonStore();}`);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,data,items,file,worker,env:{...process.env,AFH_COSMOS_DATA:data,AFH_COSMOS_EMPTY_LIBRARY:'1'}};
}
function run(f,items){return spawnSync(process.execPath,[f.worker,JSON.stringify(items)],{env:f.env,encoding:'utf8',windowsHide:true,timeout:15000});}
async function holdCommonReader(f,{blockReplacement=false}={}){
 const code=`import sys
sys.path.insert(0,sys.argv[1])
from orbita_store.config import read_config,binding_for
from orbita_store.objects import ObjectStore
from orbita_store.pool import close_idle
config=read_config();binding,key=binding_for(sys.argv[2],config)
store=ObjectStore(config,binding);reader=None
try:
 if sys.argv[3]=='lock':
  store.raw.execute('BEGIN')
  assert store.raw.execute('SELECT path FROM orbita_common.entries WHERE path=%s FOR UPDATE',(key,)).fetchone()[0]==key
 else:
  reader=store.open_read(key);original=reader.read()
 print('READY',flush=True);sys.stdin.read(1)
 if reader is not None:
  reader.seek(0);assert reader.read()==original
finally:
 if reader is not None:reader.close()
 else:store.raw.execute('ROLLBACK')
 store.close();close_idle()
`;
 const child=spawn(python,['-I','-X','utf8','-B','-c',code,pythonRoot,f.file,blockReplacement?'lock':'pin'],{env:f.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',d=>stderr+=d);
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('READER_NOT_READY: '+stderr)),10000);
   child.once('error',e=>{clearTimeout(timer);reject(e);});
   child.stdout.once('data',data=>{clearTimeout(timer);String(data).trim()==='READY'?resolve():reject(new Error('INVALID_READER_HANDSHAKE'));});
   child.once('exit',()=>{clearTimeout(timer);reject(new Error('READER_EXITED: '+stderr));});
  });
 }catch(e){child.stdin.end('x');await exited;throw e;}
 return async()=>{child.stdin.end('x');const end=await exited;assert.equal(end.code,0,stderr);};
}

test('library identical reconciliation preserves the exact object under a real PostgreSQL pinned reader',{timeout:25000},async t=>{
 const f=fixture(t),before=fs.readFileSync(f.file),stat=fs.statSync(f.file,{bigint:true});
 const release=await holdCommonReader(f);
 try{const result=run(f,f.items);assert.equal(result.status,0,result.stderr);}finally{await release();}
 assert.deepEqual(fs.readFileSync(f.file),before);
 const after=fs.statSync(f.file);assert.equal(after.revision,stat.revision);assert.equal(after.objectId,stat.objectId);assert.equal(after.sha256,stat.sha256);assert.equal(after.mtimeMs,stat.mtimeMs);
 assert.deepEqual(fs.readdirSync(f.data).filter(n=>n.endsWith('.tmp')),[]);
});

test('library real changes preserve other entries and persist the complete new value',{timeout:25000},t=>{
 const f=fixture(t),addition={id:'new',title:'Otro original',metadata:{quote:'a;b',unicode:'é😀'}};
 const result=run(f,[addition]);assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),[...f.items,addition]);
 const updated={...f.items[0],title:'Corrección explícita'};
 const correction=run(f,[updated]);assert.equal(correction.status,0,correction.stderr);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),[updated,addition]);
});

test('library concurrent distinct writers preserve both committed entries',{timeout:25000},async t=>{
 const f=fixture(t);
 const worker=items=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[f.worker,JSON.stringify(items)],{env:f.env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='';
  child.stderr.on('data',d=>stderr+=d);child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(stderr)));
 });
 const a={id:'writer-a',title:'A'},b={id:'writer-b',title:'B'};
 await Promise.all([worker([a]),worker([b])]);
 const result=JSON.parse(fs.readFileSync(f.file));assert.equal(result.length,3);
 assert.deepEqual(new Map(result.map(item=>[item.id,item])),new Map([...f.items,a,b].map(item=>[item.id,item])));
});

test('library a real PostgreSQL row lock rejects replacement and preserves the committed object',{timeout:25000},async t=>{
 const f=fixture(t),before=fs.readFileSync(f.file),release=await holdCommonReader(f,{blockReplacement:true});
 try{const result=run(f,[{id:'new',title:'Must not silently disappear'}]);assert.notEqual(result.status,0);assert.match(result.stderr,/55P03/);}finally{await release();}
 assert.deepEqual(fs.readFileSync(f.file),before);
 const retried=run(f,[{id:'new',title:'Must not silently disappear'}]);assert.equal(retried.status,0,retried.stderr);
 assert.equal(JSON.parse(fs.readFileSync(f.file)).length,2);
});

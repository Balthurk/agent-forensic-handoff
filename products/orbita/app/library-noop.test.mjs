import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';

const corpus=process.env.ORBITA_CORPUS_UNDER_TEST||new URL('./corpus.mjs',import.meta.url).href;
const python=process.env.AFH_VOLUME_PYTHON||process.env.AFH_SQLITE_PYTHON||'python';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbita-library-noop-'));
 const data=path.join(root,'data');fs.mkdirSync(data);
 const items=[{id:'existing',title:'Texto sintético café 漢字',path:path.join(data,'cases','existing')}];
 const file=path.join(data,'library.json');fs.writeFileSync(file,JSON.stringify(items,null,2));
 const worker=path.join(root,'writer.mjs');
 fs.writeFileSync(worker,`import fs from 'node:fs';import {registerLibraryItems} from ${JSON.stringify(corpus)};
const items=JSON.parse(process.argv[2]);
try{registerLibraryItems(items);console.log(JSON.stringify({status:'PASS'}));}catch(e){console.error(e.code||e.message);process.exitCode=1;}`);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,data,items,file,worker,env:{...process.env,AFH_COSMOS_DATA:data,AFH_COSMOS_EMPTY_LIBRARY:'1'}};
}
function run(f,items){return spawnSync(process.execPath,[f.worker,JSON.stringify(items)],{env:f.env,encoding:'utf8',windowsHide:true,timeout:15000});}
async function holdWindowsReader(f){
 const code=`import ctypes as c,ctypes.wintypes as w,sys
k=c.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,c.c_void_p,w.DWORD,w.DWORD,w.HANDLE];k.CreateFileW.restype=w.HANDLE
k.CloseHandle.argtypes=[w.HANDLE]
h=k.CreateFileW(sys.argv[1],0x80000000,3,None,3,0x80,None)
assert h not in (None,c.c_void_p(-1).value),c.get_last_error()
try:
 print('READY',flush=True);sys.stdin.read(1)
finally:k.CloseHandle(h)
`;
 const child=spawn(python,['-X','utf8','-B','-c',code,f.file],{windowsHide:true,stdio:['pipe','pipe','pipe']});
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

test('library identical reconciliation performs no replacement under a real Windows reader',{timeout:25000},async t=>{
 const f=fixture(t),before=fs.readFileSync(f.file),stat=fs.statSync(f.file,{bigint:true});
 const release=process.platform==='win32'?await holdWindowsReader(f):async()=>{};
 try{const result=run(f,f.items);assert.equal(result.status,0,result.stderr);}finally{await release();}
 assert.deepEqual(fs.readFileSync(f.file),before);
 assert.equal(fs.statSync(f.file,{bigint:true}).mtimeNs,stat.mtimeNs);
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

if(process.platform==='win32')test('library blocked real replacement reports failure and preserves the committed file',{timeout:25000},async t=>{
 const f=fixture(t),before=fs.readFileSync(f.file),release=await holdWindowsReader(f);
 try{const result=run(f,[{id:'new',title:'Must not silently disappear'}]);assert.notEqual(result.status,0);assert.match(result.stderr,/EPERM|EACCES|EBUSY/);}finally{await release();}
 assert.deepEqual(fs.readFileSync(f.file),before);
 const retried=run(f,[{id:'new',title:'Must not silently disappear'}]);assert.equal(retried.status,0,retried.stderr);
 assert.equal(JSON.parse(fs.readFileSync(f.file)).length,2);
});

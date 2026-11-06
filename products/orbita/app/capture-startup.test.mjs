import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import files from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
const commonRoot=process.env.ORBITA_POSTGRES_TEST_ROOT;
assert.ok(commonRoot);
const inputs=path.join(path.dirname(commonRoot),'inputs');native.mkdirSync(inputs,{recursive:true});
const own=native.mkdtempSync(path.join(inputs,'capture-startup-'));
process.env.AFH_COSMOS_DATA=path.join(commonRoot,path.basename(own),'data');
process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {registerCapture,captureOnce,captureStatus}=await import('./capture.mjs');
const {library}=await import('./corpus.mjs');
const {closeMemory}=await import('./memory.mjs');
test.after(async()=>{await closeMemory();assert.equal(native.existsSync(commonRoot),false);closeCommonStore();});

test('capture renewal covers a stalled source read before the first checkpoint without extending its lease',async()=>{
 const header={timestamp:'2026-10-22T10:00:00Z',type:'session_meta',payload:{id:'00000000-0000-4000-8000-000000000071',cwd:'C:/synthetic-capture-startup'}};
 const message={timestamp:'2026-10-22T10:00:01Z',type:'response_item',payload:{type:'message',id:'source-message',role:'user',content:[{type:'input_text',text:'Conservar íntegra esta entrada sintética: pingüino.'}]}};
 const source=path.join(own,'source.jsonl'),bytes=Buffer.from(JSON.stringify(header)+'\n'+JSON.stringify(message)+'\n');native.writeFileSync(source,bytes);
 const job=registerCapture(source,[source]);
 const open=native.openSync,read=native.readSync;let sourceFd=null,delays=0,blockedMs=0;
 native.openSync=function(file,...args){const fd=open.call(this,file,...args);if(typeof file==='string'&&path.resolve(file).toLowerCase()===source.toLowerCase())sourceFd=fd;return fd;};
 native.readSync=function(fd,...args){
  if(fd===sourceFd&&delays===0){delays++;const began=performance.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6000);blockedMs=performance.now()-began;}
  return read.call(this,fd,...args);
 };
 let result;
 try{result=await captureOnce(job.id,[source],{leaseMs:5000});}
 finally{native.openSync=open;native.readSync=read;assert.deepEqual(native.readFileSync(source),bytes);}
 assert.equal(delays,1);assert.ok(blockedMs>=5900);assert.equal(result.offset,bytes.length);assert.equal(result.validOffset,bytes.length);
 const current=captureStatus().jobs.find(x=>x.id===job.id);assert.equal(current.status,'idle');assert.equal(current.owner,null);assert.equal(current.lease_until,0);
 const item=library.find(x=>x.id===result.caseId);assert.ok(item);const acquired=JSON.parse(files.readFileSync(path.join(item.path,'acquisition/native.json'),'utf8'));assert.equal(acquired.entries.length,1);assert.equal(acquired.entries[0].byteLength,bytes.length);assert.deepEqual(files.readFileSync(path.join(item.path,acquired.entries[0].path)),bytes);
});

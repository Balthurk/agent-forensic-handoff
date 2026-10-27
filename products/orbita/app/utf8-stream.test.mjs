import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Utf8Stream } from './utf8-stream.mjs';
const text=JSON.stringify({quote:'No cambiaría la decisión: canción, revisión, 日本語, 🧠.'});
test('every possible pipe split preserves the exact JSON evidence',()=>{
 const bytes=Buffer.from(text);let oldFailures=0;
 for(let split=1;split<bytes.length;split++){
  const parts=[bytes.subarray(0,split),bytes.subarray(split)],s=new Utf8Stream();
  for(const p of parts)s.push(p);
  assert.equal(s.end(),text);assert.deepEqual(JSON.parse(s.text),JSON.parse(text));
  if(parts.map(p=>p.toString()).join('')!==text)oldFailures++;
 }
 assert.ok(oldFailures>0,'test must detect the original decoding defect');
});
test('real child process with delayed one-byte writes preserves non-ASCII',async()=>{
 const s=new Utf8Stream();const c=spawn(process.execPath,['-e',`const b=Buffer.from(${JSON.stringify(text)});let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t);},2);`],{windowsHide:true});
 c.stdout.on('data',b=>s.push(b));
 await new Promise((resolve,reject)=>{c.on('error',reject);c.on('close',code=>code===0?resolve():reject(new Error(String(code))));});
 assert.equal(s.end(),text);
});
test('budget counts UTF-8 bytes and rejects overflow',()=>{const s=new Utf8Stream(3);s.push(Buffer.from('í'));assert.throws(()=>s.push(Buffer.from('í')),/BUDGET/);});
test('malformed or truncated Unicode cannot become a valid-looking quote',()=>{const s=new Utf8Stream();assert.throws(()=>s.push(Buffer.from([0xff])));const t=new Utf8Stream();t.push(Buffer.from([0xf0,0x9f]));assert.throws(()=>t.end());});

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import zlib from 'node:zlib';
import {decodedLines} from '../src/evidence.js';

async function tracked(t,extension,bytes,consume){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'afh-stream-close-'));const file=path.join(root,'source'+extension);fs.writeFileSync(file,bytes);
 const original=fs.createReadStream,streams=[];t.after(()=>{fs.createReadStream=original;});
 fs.createReadStream=(...args)=>{const s=original(...args);streams.push(s);const destroy=s._destroy;s._destroy=function(error,callback){setTimeout(()=>destroy.call(this,error,callback),60);};return s;};
 await consume(file);assert.ok(streams.length);assert.ok(streams.every(s=>s.closed&&s.fd===null),'decodedLines must release the source handle before the caller can publish/move its case');
 // This is a real rename after consumption; the delayed handle closure above
 // makes the precondition deterministic even where open-file renames succeed.
 const moved=root+'-published';fs.renameSync(root,moved);assert.deepEqual(fs.readFileSync(path.join(moved,'source'+extension)),bytes);
}
for(const [label,ext,encode] of [['plain','.jsonl',x=>Buffer.from(x)],['gzip','.jsonl.gz',x=>zlib.gzipSync(x)],['zstd','.jsonl.zst',x=>zlib.zstdCompressSync(x)]]){
 test('reader closes '+label+' source before returning a complete verified snapshot',{timeout:10000},async t=>{
  await tracked(t,ext,encode('uno\nniño 🧠\n'),async file=>{const rows=[];for await(const row of decodedLines(file))rows.push(row);assert.deepEqual(rows.map(r=>r.line),['uno','niño 🧠']);assert.equal(rows[1].byteOffset,4);});
 });
}
test('early consumer return releases its source descriptor',{timeout:10000},async t=>{
 await tracked(t,'.jsonl',Buffer.from(('x'.repeat(100)+'\n').repeat(3000)),async file=>{for await(const row of decodedLines(file)){assert.ok(row.line);break;}});
});
test('decoder failure releases the source descriptor before rejecting',{timeout:10000},async t=>{
 await tracked(t,'.gz',Buffer.from('invalid gzip'),async file=>{await assert.rejects(async()=>{for await(const row of decodedLines(file))void row;});});
});

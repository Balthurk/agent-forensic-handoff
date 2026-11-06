import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import {Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from '../src/common-files.js';
import {closeCommonStore} from '../src/common-store.js';
import {hashFile} from '../src/common-util.js';

const root=path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'file-api');
fs.mkdirSync(root,{recursive:true});
const file=name=>path.join(root,name);
test.after(()=>{assert.equal(native.existsSync(root),false);closeCommonStore();});

test('hashing checks fresh literal bytes and exact prefixes across the small-object boundary',async()=>{
  const target=file('fresh-hash'),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  for(const bytes of [Buffer.alloc(0),Buffer.from('\0á😀\r\n'),Buffer.alloc(1024*1024,0xee),Buffer.alloc(1024*1024+3,0xff)]){
    fs.writeFileSync(target,bytes);assert.equal(await hashFile(target),digest(bytes));
    for(const count of [0,Math.min(3,bytes.length),bytes.length])assert.equal(await hashFile(target,count),digest(bytes.subarray(0,count)));
    await assert.rejects(hashFile(target,bytes.length+1),/SHORT_READ/);
  }
  fs.writeFileSync(target,'replacement');assert.equal(await hashFile(target),digest(Buffer.from('replacement')));
  fs.unlinkSync(target);await assert.rejects(hashFile(target),{code:'ENOENT'});await assert.rejects(hashFile(root),{code:'EISDIR'});
  await assert.rejects(hashFile(target,-1),{code:'EINVAL'});
});

test('whole-file reads preserve empty and binary objects, block boundaries and fresh replacements',()=>{
  const value=Buffer.from('\0á😀\r\n'),target=file('whole-file');
  for(const bytes of [Buffer.alloc(0),value,Buffer.alloc(1024*1024,0xff),Buffer.concat([Buffer.alloc(1024*1024,0xee),value])]){
    fs.writeFileSync(target,bytes);assert.deepEqual(fs.readFileSync(target),bytes);
  }
  fs.writeFileSync(target,'changed ñ');assert.equal(fs.readFileSync(target,'utf8'),'changed ñ');
  fs.unlinkSync(target);assert.throws(()=>fs.readFileSync(target),{code:'ENOENT'});
  assert.throws(()=>fs.readFileSync(root),{code:'EISDIR'});
});

test('complete small writes preserve exclusive creation, append and errors without native outputs',()=>{
  const target=file("small ' exclusive"),original=Buffer.from('\0á😀\r\n');
  fs.writeFileSync(target,original,{flag:'wx'});
  const first=fs.statSync(target),pinned=fs.openSync(target,'r');
  for(const flag of ['wx','x'])assert.throws(()=>fs.writeFileSync(target,'forbidden',{flag}),{code:'EEXIST'});
  assert.deepEqual(fs.readFileSync(target),original);assert.equal(fs.statSync(target).revision,first.revision);
  fs.writeFileSync(target,'new');assert.equal(fs.statSync(target).revision,first.revision+1);
  assert.deepEqual(fs.readFileSync(pinned),original);fs.closeSync(pinned);
  fs.appendFileSync(target,' tail');assert.equal(fs.readFileSync(target,'utf8'),'new tail');
  assert.throws(()=>fs.writeFileSync(root,'invalid'),{code:'EISDIR'});
  assert.throws(()=>fs.writeFileSync(file('absent-parent/child'),'invalid'),{code:'ENOENT'});
  assert.throws(()=>fs.writeFileSync(path.join(target,'child'),'invalid'),{code:'ENOTDIR'});
  assert.throws(()=>fs.writeFileSync('C:/orbita-unregistered-small-write/child','invalid'),/PATH_NOT_BOUND/);
  assert.equal(native.existsSync('C:/orbita-unregistered-small-write'),false);
  assert.equal(fs.readFileSync(target,'utf8'),'new tail');
});

test('contained paths check all ancestors and reject escapes without native outputs',()=>{
  const base=file('contained');fs.mkdirSync(path.join(base,'nested'),{recursive:true});
  fs.writeFileSync(path.join(base,'nested','original'),'Ámbito exacto 😀');
  const found=fs.containedPathSync(base,'nested/original');
  assert.equal(found,path.join(base,'nested','original'));assert.equal(fs.readFileSync(found,'utf8'),'Ámbito exacto 😀');
  for(const bad of ['','../other','nested/../original','nested//original','nested\\original','C:/other','/other'])assert.throws(()=>fs.containedPathSync(base,bad),/OBJECT_PATH_ESCAPE/);
  assert.throws(()=>fs.containedPathSync(base,'missing/original'),{code:'ENOENT'});
  assert.throws(()=>fs.containedPathSync(path.join(base,'nested','original'),'child'),{code:'ENOTDIR'});
  assert.throws(()=>fs.containedPathSync('C:/orbita-unregistered-contained-root','child'),/PATH_NOT_BOUND/);
});

test('contained path resolution observes rename and deletion on every call',()=>{
  const base=file('fresh-path');fs.mkdirSync(path.join(base,'before'),{recursive:true});
  fs.writeFileSync(path.join(base,'before','original'),'immutable source');
  fs.containedPathSync(base,'before/original');fs.renameSync(path.join(base,'before'),path.join(base,'after'));
  assert.throws(()=>fs.containedPathSync(base,'before/original'),{code:'ENOENT'});
  assert.equal(fs.readFileSync(fs.containedPathSync(base,'after/original'),'utf8'),'immutable source');
  fs.unlinkSync(path.join(base,'after','original'));
  assert.throws(()=>fs.containedPathSync(base,'after/original'),{code:'ENOENT'});
});

test('positional reads preserve the sequential offset and an opened immutable version',()=>{
  const p=file('positions');fs.writeFileSync(p,'0123456789😀');
  const fd=fs.openSync(p,'r'),bytes=Buffer.alloc(3);
  assert.equal(fs.readSync(fd,bytes,0,3,null),3);assert.equal(bytes.toString(),'012');
  assert.equal(fs.readSync(fd,bytes,0,3,6),3);assert.equal(bytes.toString(),'678');
  assert.equal(fs.readSync(fd,bytes,0,3,null),3);assert.equal(bytes.toString(),'345');
  fs.writeFileSync(p,'new');assert.equal(fs.fstatSync(fd).size,14);
  assert.equal(fs.readSync(fd,bytes,0,3,null),3);assert.equal(bytes.toString(),'678');
  fs.closeSync(fd);assert.throws(()=>fs.readSync(fd,bytes),{code:'EBADF'});
  assert.equal(fs.readFileSync(p,'utf8'),'new');
});

test('fsync publishes a durable prefix and subsequent writes preserve exact bytes',()=>{
  const p=file('checkpoint'),fd=fs.openSync(p,'wx');
  const prefix=Buffer.from('😀line\r\n'.repeat(170000));
  assert.equal(fs.writeSync(fd,prefix),prefix.length);
  const first=fs.fsyncSync(fd);assert.equal(first.sha256,createHash('sha256').update(prefix).digest('hex'));
  const pinned=fs.openSync(p,'r');
  fs.writeSync(fd,'tail');const second=fs.fsyncSync(fd);
  assert.equal(second.revision,first.revision+1);assert.deepEqual(fs.readFileSync(p),Buffer.concat([prefix,Buffer.from('tail')]));
  assert.equal(fs.fstatSync(pinned).size,prefix.length);fs.closeSync(pinned);
  const rev=fs.statSync(p).revision;fs.closeSync(fd);assert.equal(fs.statSync(p).revision,rev);
});

test('aborting after fsync retains only the published prefix',()=>{
  const p=file('abort'),fd=fs.openSync(p,'w');fs.writeSync(fd,'published');fs.fsyncSync(fd);
  fs.writeSync(fd,'unpublished');fs.abortSync(fd);assert.equal(fs.readFileSync(p,'utf8'),'published');
  const missing=file('never-published'),other=fs.openSync(missing,'w');fs.writeSync(other,'no');fs.abortSync(other);
  assert.equal(fs.existsSync(missing),false);
  const descriptor=fs.openSync(file('descriptor'),'w');fs.writeFileSync(descriptor,'á😀',{encoding:'utf8'});fs.fsyncSync(descriptor);fs.closeSync(descriptor);
  const reader=fs.openSync(file('descriptor'),'r');assert.equal(fs.readFileSync(reader,'utf8'),'á😀');assert.equal(fs.fstatSync(reader).position,6);fs.closeSync(reader);
});

test('process failure after fsync keeps the prefix and discards unpublished data',()=>{
  const p=file('crash'),url=new URL('../src/common-files.js',import.meta.url).href;
  const source=`import fs from ${JSON.stringify(url)};const fd=fs.openSync(${JSON.stringify(p)},'wx');fs.writeSync(fd,'durable');fs.fsyncSync(fd);fs.writeSync(fd,'pending');process.exit(86);`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',source],{env:process.env,windowsHide:true,timeout:15000,encoding:'utf8'});
  assert.equal(child.status,86,child.stderr);assert.equal(fs.readFileSync(p,'utf8'),'durable');
});

test('streams preserve bytes, bounded chunks, Unicode decoding and inclusive ranges',async()=>{
  const p=file('streams'),source=Buffer.from('á😀literal\r\n'.repeat(140000));
  const writer=fs.createWriteStream(p,{highWaterMark:32768});
  await pipeline(Readable.from((function*(){for(let i=0;i<source.length;i+=23000)yield source.subarray(i,i+23000);})()),writer);
  assert.equal(writer.bytesWritten,source.length);
  const hash=createHash('sha256');let max=0;
  await pipeline(fs.createReadStream(p,{highWaterMark:65536}),new Writable({write(b,e,cb){hash.update(b);max=Math.max(max,b.length);cb();}}));
  assert.equal(hash.digest('hex'),createHash('sha256').update(source).digest('hex'));assert.ok(max<=65536);
  const chunks=[];for await(const b of fs.createReadStream(p,{start:17,end:124,highWaterMark:7}))chunks.push(b);
  assert.deepEqual(Buffer.concat(chunks),source.subarray(17,125));
  let text='';for await(const b of fs.createReadStream(p,{encoding:'utf8',highWaterMark:13}))text+=b;
  assert.equal(text,source.toString('utf8'));
});

test('stream failure aborts the replacement and preserves the previous file',async()=>{
  const p=file('failed-stream');fs.writeFileSync(p,'previous');
  async function* source(){yield Buffer.from('incomplete');throw new Error('source failed');}
  await assert.rejects(pipeline(Readable.from(source()),fs.createWriteStream(p)),/source failed/);
  assert.equal(fs.readFileSync(p,'utf8'),'previous');
  await assert.rejects(pipeline(fs.createReadStream(file('absent')),new Writable({write(b,e,cb){cb();}})),{code:'ENOENT'});
});

test('stream read-ahead and direct reads of its FD share one exact cursor',async()=>{
  const p=file('shared-read-ahead'),source=Buffer.from('0123456789'.repeat(1000));fs.writeFileSync(p,source);
  const stream=fs.createReadStream(p,{highWaterMark:13});let fd,first=true,at;const chunks=[],events=[];
  stream.once('open',value=>{fd=value;events.push('open');});
  stream.once('ready',()=>events.push('ready'));
  await new Promise((resolve,reject)=>{
    stream.on('error',reject);stream.on('end',resolve);
    stream.on('data',chunk=>{
      try{
        chunks.push(chunk);
        if(first){
          first=false;assert.ok(fd);assert.deepEqual(events,['open','ready']);at=fs.fstatSync(fd).position;
          const stolen=Buffer.alloc(7);assert.equal(fs.readSync(fd,stolen),7);
          assert.deepEqual(stolen,source.subarray(at,at+7));assert.equal(fs.fstatSync(fd).position,at+7);
          const positional=Buffer.alloc(3);assert.equal(fs.readSync(fd,positional,0,3,0),3);assert.equal(positional.toString(),'012');
          assert.equal(fs.fstatSync(fd).position,at+7);
        }
      }catch(error){stream.destroy(error);}
    });
  });
  assert.deepEqual(Buffer.concat(chunks),Buffer.concat([source.subarray(0,at),source.subarray(at+7)]));
  assert.equal(stream.bytesRead,source.length-7);
});

test('copy creates an independent immutable name without aliasing later writes',()=>{
  const a=file('copy-a'),b=file('copy-b');fs.writeFileSync(a,'first');fs.copyFileSync(a,b,fs.constants.COPYFILE_EXCL);
  assert.equal(fs.statSync(a).objectId,fs.statSync(b).objectId);
  assert.throws(()=>fs.copyFileSync(a,b,fs.constants.COPYFILE_EXCL),{code:'EEXIST'});
  fs.writeFileSync(a,'second');assert.equal(fs.readFileSync(b,'utf8'),'first');
  fs.unlinkSync(a);assert.equal(fs.readFileSync(b,'utf8'),'first');
  fs.unlinkSync(b);assert.throws(()=>fs.statSync(b),{code:'ENOENT'});
});

test('directory operations and unsupported random writes fail explicitly',()=>{
  const dir=file('directory');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'child'),'value');
  assert.equal(fs.lstatSync(dir).isDirectory(),true);
  assert.equal(fs.readdirSync(dir,{withFileTypes:true})[0].isFile(),true);
  assert.throws(()=>fs.rmdirSync(dir),{code:'ENOTEMPTY'});
  const fd=fs.openSync(path.join(dir,'child'),'a');fs.writeSync(fd,'tail');fs.closeSync(fd);
  assert.equal(fs.readFileSync(path.join(dir,'child'),'utf8'),'valuetail');
  const writer=fs.openSync(file('random'),'w');
  assert.throws(()=>fs.writeSync(writer,Buffer.from('x'),0,1,7),{code:'ORBITA_PG_RANDOM_WRITE_UNSUPPORTED'});fs.abortSync(writer);
  fs.unlinkSync(path.join(dir,'child'));fs.rmdirSync(dir);assert.equal(fs.existsSync(dir),false);
});

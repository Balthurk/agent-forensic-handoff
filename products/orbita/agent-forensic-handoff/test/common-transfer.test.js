import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import native from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import files from '../src/common-files.js';
import {DatabaseSync,exportCommonStore,importCommonStore,restoreControl,closeCommonStore} from '../src/common-store.js';

const root=process.env.ORBITA_POSTGRES_TEST_ROOT;
assert.ok(root);files.mkdirSync(root,{recursive:true});
test.after(()=>{assert.equal(native.existsSync(root),false);closeCommonStore();});

test('typed row stream crosses fresh processes with exact BigInts and no local store',()=>{
  const file=path.join(root,'transfer/source.pgstore'),db=new DatabaseSync(file,{family:'access',create:true});
  db.prepare('INSERT INTO attempts VALUES(?,?,?)').run('ñ😀',9007199254740993n,12);
  const expected=db.logicalManifest();db.close();
  assert.equal(files.statSync(file).isStore(),true);assert.equal(files.statSync(file).kind,'store');
  assert.equal(files.readdirSync(path.dirname(file),{withFileTypes:true})[0].isStore(),true);
  const stream=exportCommonStore(file),info=stream.info,payload=path.join(root,'typed-stream'),fd=files.openSync(payload,'wx');let length=0;
  try{for(;;){const part=stream.read(4093);if(!part.length)break;files.writeSync(fd,part);length+=part.length;}}finally{stream.close();files.closeSync(fd);}
  assert.equal(length,info.size);const target=path.join(root,'transfer/target.pgstore');
  const module=new URL('../src/common-store.js',import.meta.url).href;
  const code=`import {importCommonStore,DatabaseSync,closeCommonStore} from ${JSON.stringify(module)};const result=importCommonStore(${JSON.stringify(payload)},0,${length},${JSON.stringify(target)});const db=new DatabaseSync(${JSON.stringify(target)},{family:'access',readOnly:true});if(db.prepare('SELECT count FROM attempts').setReadBigInts(true).get().count!==9007199254740993n)throw Error('integer');db.close();const closed=closeCommonStore();if(!closed.drained||closed.ownedExit!==0)throw Error('close');process.stdout.write(JSON.stringify(result));`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',code],{encoding:'utf8',windowsHide:true,timeout:15000,env:process.env});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout).manifest,expected);
  assert.throws(()=>importCommonStore(payload,0,length,target),{code:'23505'});
  const restored=new DatabaseSync(target,{family:'access',readOnly:true});try{assert.deepEqual(restored.logicalManifest(),expected);}finally{restored.close();}
});

test('restore activation is private state and content snapshots cannot replace it',()=>{
  const source=path.join(root,'restore-data');files.mkdirSync(source);files.writeFileSync(path.join(source,'library.json'),'[]');
  const id=randomUUID(),state=restoreControl('prepare',source,{state:{schema:'orbita-restore-2',id,automaticWork:true,externalAccess:true}});
  assert.equal(state.automaticWork,false);assert.equal(state.externalAccess,false);
  files.cloneTreeSync(source,path.join(root,'restore-copy'));files.rmSync(source,{recursive:true});files.mkdirSync(source);
  assert.deepEqual(restoreControl('state',source),state);
  assert.equal(restoreControl('state',path.join(root,'restore-copy')),null);
  assert.throws(()=>restoreControl('activate',source,{restoreId:'wrong',automaticWork:true,externalAccess:true}));
  const active=restoreControl('activate',source,{restoreId:id,automaticWork:true,externalAccess:false});assert.equal(active.automaticWork,true);assert.equal(active.externalAccess,false);
  assert.deepEqual(files.readdirSync(source),[]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import native from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {useStore,exclusiveStore} from './store-access.mjs';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';

const root=path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'access-leases');
const accessURL=new URL('./store-access.mjs',import.meta.url).href;
const commonURL=new URL('../agent-forensic-handoff/src/common-store.js',import.meta.url).href;
const imports=`import {useStore,exclusiveStore} from ${JSON.stringify(accessURL)};import {closeCommonStore,commonStoreIdentity} from ${JSON.stringify(commonURL)};`;
const child=code=>spawnSync(process.execPath,['--input-type=module','--eval',imports+code],{env:process.env,windowsHide:true,timeout:15000,encoding:'utf8'});
test.after(()=>{closeCommonStore();assert.equal(native.existsSync(root),false);assert.equal(native.existsSync(path.join(path.dirname(root),'.access-leases.orbita-access.sqlite')),false);});

test('shared reuse and exclusive upgrade preserve ownership until exact release',()=>{
  const store=useStore(root);assert.equal(useStore(root),store);
  if(process.platform==='win32')assert.equal(useStore(root.toUpperCase()),store);
  assert.throws(()=>exclusiveStore(root),{code:'RECOVERY_STORE_BUSY'});
  const unlock=exclusiveStore(root,{ownSession:true});
  const blocked=child(`try{useStore(${JSON.stringify(root)});process.exitCode=2;}catch(e){if(e.code!=='RECOVERY_STORE_LOCKED')throw e;}finally{closeCommonStore();}`);
  assert.equal(blocked.status,0,blocked.stderr);unlock();unlock();
  assert.throws(()=>exclusiveStore(root),{code:'RECOVERY_STORE_BUSY'});store.release();store.release();
  exclusiveStore(root)();
});

test('exclusive subtree excludes ancestor and descendants but permits another tree',()=>{
  const part=path.join(root,'a'),unlock=exclusiveStore(part);
  try{
    assert.throws(()=>useStore(root),{code:'RECOVERY_STORE_LOCKED'});
    assert.throws(()=>useStore(path.join(part,'child')),{code:'RECOVERY_STORE_LOCKED'});
    useStore(path.join(root,'a-other')).release();
  }finally{unlock();}
});

test('another live process prevents exclusive upgrade until its verified release',async()=>{
  const owned=useStore(root);
  const proc=spawn(process.execPath,['--input-type=module','--eval',imports+`const s=useStore(${JSON.stringify(root)});process.stdout.write(${JSON.stringify('READY\n')});process.stdin.once('data',()=>{s.release();closeCommonStore();process.exit(0);});`],{env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='';proc.stderr.on('data',b=>stderr+=b);
  const exited=once(proc,'exit',{signal:AbortSignal.timeout(15000)});
  try{
    const first=await Promise.race([once(proc.stdout,'data',{signal:AbortSignal.timeout(15000)}),exited.then(([code])=>{throw new Error('Child exited before READY: '+code+' '+stderr);})]);assert.match(first[0].toString(),/READY/);
    assert.throws(()=>exclusiveStore(root,{ownSession:true}),{code:'RECOVERY_STORE_BUSY'});
    proc.stdin.end('release');
    assert.equal((await exited)[0],0,stderr);exclusiveStore(root,{ownSession:true})();
  }finally{owned.release();if(proc.exitCode===null&&proc.signalCode===null){proc.kill();await exited;}}
});

test('abrupt process exit releases only after its owned bridge process actually exits',async()=>{
  const result=child(`useStore(${JSON.stringify(root)});process.stdout.write(JSON.stringify(commonStoreIdentity()));process.exit(86);`);
  assert.equal(result.status,86,result.stderr);const identity=JSON.parse(result.stdout);
  let alive=true;const deadline=performance.now()+5000;
  while(alive&&performance.now()<deadline){try{process.kill(identity.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}if(alive)await delay(20);}
  assert.equal(alive,false,'the owned bridge must exit before ownership is reclaimed');exclusiveStore(root)();
});

test('unbound roots fail without creating local sidecars',()=>{
  const outside=path.join(path.dirname(process.env.ORBITA_POSTGRES_TEST_ROOT),'unbound-lease');
  assert.throws(()=>useStore(outside),{code:'ORBITA_PG_PATH_NOT_BOUND'});assert.equal(native.existsSync(outside),false);
});

test('Python semantic bridge registers independently in the same exclusion protocol',()=>{
  const pythonRoot=fileURLToPath(new URL('../agent-forensic-handoff/python/',import.meta.url));
  const program="import sys;sys.path.insert(0,sys.argv[1]);from store_access import use_store\ntry:\n with use_store(sys.argv[2]):print('ACQUIRED')\nexcept Exception as error:print(str(error))\n";
  const run=()=>spawnSync(process.env.ORBITA_POSTGRES_PYTHON,['-I','-B','-c',program,pythonRoot,root],{env:process.env,windowsHide:true,timeout:15000,encoding:'utf8'});
  const unlock=exclusiveStore(root);
  try{const blocked=run();assert.equal(blocked.status,0,blocked.stderr);assert.equal(blocked.stdout.trim(),'RECOVERY_STORE_LOCKED');}
  finally{unlock();}
  const passed=run();assert.equal(passed.status,0,passed.stderr);assert.equal(passed.stdout.trim(),'ACQUIRED');exclusiveStore(root)();
});

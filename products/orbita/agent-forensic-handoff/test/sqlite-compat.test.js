import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const moduleUrl=new URL('../src/sqlite-compat.js',import.meta.url).href;
const probe=fileURLToPath(new URL('./fixtures/sqlite-compat-probe.mjs',import.meta.url));
const preload=fileURLToPath(new URL('./fixtures/sqlite-compat-fault.cjs',import.meta.url));
const python=process.env.AFH_SQLITE_PYTHON||(process.platform==='win32'?'python':'python3');
function run(mode,{fallback=true,fault,env={}}={}){
  const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||os.tmpdir(),'orbita-sqlite-i02-'));
  const settings={...process.env,AFH_SQLITE_PYTHON:python,AFH_SQLITE_TIMEOUT_MS:'10000',ORBITA_SQLITE_PROBE_TRACE:path.join(root,'fault.jsonl'),...env};
  delete settings.ORBITA_SQLITE_PROBE_FAULT;
  if(fault)settings.ORBITA_SQLITE_PROBE_FAULT=fault;
  const args=[...(fallback?['--no-experimental-sqlite']:[]),...(fault?['--require',preload]:[]),probe,moduleUrl,mode,root];
  const p=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4000000,env:settings});
  assert.equal(p.status,0,JSON.stringify({stdout:p.stdout,stderr:p.stderr,error:p.error?.message,signal:p.signal,root}));
  const result=JSON.parse(p.stdout);
  assert.equal(result.nativeAvailable,!fallback,'the real fallback must be selected by Node itself');
  return result;
}

test('SQLite fallback matches native CAS, triggers, SQL scripts, rollback, RETURNING and exact bytes',()=>{
  const native=run('matrix',{fallback:false}),fallback=run('matrix');
  assert.equal(fallback.zeroUpdate.changes,0);
  assert.deepEqual(fallback.cas,[1,0]);
  assert.equal(fallback.insert.changes,1,'trigger writes must not inflate changes');
  assert.equal(fallback.returningRun.changes,2);
  assert.equal(fallback.partialInsideTransaction,4);
  assert.equal(fallback.afterErrorRollback,3);
  assert.equal(fallback.largeUnicodeExact,true);
  assert.deepEqual(fallback.blob,[0,255,13,10,128,1]);
  delete native.nativeAvailable;delete fallback.nativeAvailable;
  assert.deepEqual(fallback,native);
});
test('SQLite fallback executes real ingestion, FTS, identity evidence and historical registration filters',()=>{
  const native=run('ingest',{fallback:false}),fallback=run('ingest');
  assert.equal(fallback.originalExact,true);assert.equal(fallback.integrity,true);assert.equal(fallback.emoji,'😀');
  assert.equal(fallback.activeSearch,1);assert.equal(fallback.alternativeDefault,0);assert.equal(fallback.alternativeAll,1);assert.equal(fallback.beforeRegistration,0);
  delete native.nativeAvailable;delete fallback.nativeAvailable;assert.deepEqual(fallback,native);
});
test('SQLite fallback fails promptly when the configured executable is missing',()=>{
  const r=run('open-failure',{env:{AFH_SQLITE_PYTHON:path.join(os.tmpdir(),'orbita-does-not-exist-'+process.pid+'.exe')}});
  assert.equal(r.error.code,'SQLITE_BACKEND_START_FAILED');assert.ok(r.ms<10000);
});
test('SQLite fallback fails promptly when its child exits during startup',()=>{
  const r=run('open-failure',{fault:'early-exit'});assert.ok(['SQLITE_BACKEND_EXIT','SQLITE_BACKEND_PIPE'].includes(r.error.code));assert.ok(r.ms<10000);
});
test('SQLite fallback preserves embedded NUL; native transport is separately observed',()=>{
  const fallback=run('nul'),native=run('nul',{fallback:false});
  assert.equal(fallback.value,'before\u0000after');assert.equal(fallback.exact,true);
  // Node 24.15.0 returns only the prefix. Do not copy its truncation into fallback
  // or assert general parity for this distinct, explicitly recorded limitation.
  assert.ok(native.value==='before'||native.value==='before\u0000after');
});
for(const [fault,code] of [['exit-on-request','SQLITE_BACKEND_EXIT'],['hang-on-request','SQLITE_BACKEND_TIMEOUT'],['after-commit-exit','SQLITE_BACKEND_EXIT'],['invalid-response','SQLITE_BACKEND_PROTOCOL']]){
  test('SQLite fallback '+fault+' is bounded, invalidates every old handle and never replays',()=>{
    const r=run('fault',{fault});assert.equal(r.error.code,code);assert.ok(r.ms<10000);
    if(fault==='after-commit-exit'||fault==='invalid-response'){
      assert.deepEqual(r.persisted,[{value:'only once'}]);
      assert.ok(r.trace.some(x=>x.event==='acknowledgement-intercepted'&&x.ok&&x.changes===1));
    } else assert.deepEqual(r.persisted,[]);
  });
}
test('SQLite fallback drains stderr without blocking replies',()=>{assert.equal(run('text',{fault:'stderr-flood'}).exact,true);});
test('SQLite fallback incremental decoder preserves deliberate byte-split UTF-8 (preventive wire variant)',()=>{assert.equal(run('text',{fault:'utf8-fragments'}).exact,true);});
test('SQLite fallback pipe encoding is independent of a non-UTF-8 Python environment',()=>{
  assert.equal(run('text',{env:{PYTHONUTF8:'0',PYTHONIOENCODING:'cp1252'}}).exact,true);
});
for(const timeout of ['0','Infinity','broken','300001']){
  test('SQLite fallback refuses invalid deadline '+timeout,()=>{const r=run('open-failure',{env:{AFH_SQLITE_TIMEOUT_MS:timeout}});assert.equal(r.error.code,'SQLITE_BACKEND_CONFIGURATION');});
}

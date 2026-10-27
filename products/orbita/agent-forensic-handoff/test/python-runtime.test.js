import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pythonExecutable} from '../src/python-runtime.js';

test('I03 Python preserves specialized precedence and the common executable with spaces',()=>{
 const common='C:/owned root with spaces/python.exe';
 const env={AFH_PYTHON:common,AFH_VOLUME_PYTHON:'volume-python',AFH_SEMANTIC_PYTHON:'semantic-python'};
 assert.equal(pythonExecutable(['AFH_SEMANTIC_PYTHON','AFH_VOLUME_PYTHON'],{env}),'semantic-python');
 delete env.AFH_SEMANTIC_PYTHON;
 assert.equal(pythonExecutable(['AFH_SEMANTIC_PYTHON','AFH_VOLUME_PYTHON'],{env}),'volume-python');
 delete env.AFH_VOLUME_PYTHON;
 for(const specialized of ['AFH_VOLUME_PYTHON','AFH_SEMANTIC_PYTHON','AFH_JEV_PYTHON','AFH_SQLITE_PYTHON'])assert.equal(pythonExecutable([specialized],{env}),common);
});
test('I03 Python defaults are platform-specific and values are never shell-split',()=>{
 assert.equal(pythonExecutable([],{env:{},platform:'win32'}),'python');
 assert.equal(pythonExecutable([],{env:{},platform:'linux'}),'python3');
 assert.equal(pythonExecutable([],{env:{AFH_PYTHON:'/owned path/python --not-an-argument'}}),'/owned path/python --not-an-argument');
 for(const value of ['   ','python\nanything','python\0anything'])assert.throws(()=>pythonExecutable([],{env:{AFH_PYTHON:value}}),{code:'PYTHON_EXECUTABLE_INVALID'});
});
test('I03 SQLite fallback honors AFH_PYTHON when the specialized override is absent',t=>{
 const selected=pythonExecutable(['AFH_SQLITE_PYTHON']);
 const found=spawnSync(selected,['-I','-c','import sys;print(sys.executable)'],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(found.status,0,found.stderr);const executable=found.stdout.trim();assert.ok(path.isAbsolute(executable));
 const parent=fs.realpathSync(process.env.AFH_TEST_ROOT||os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'orbita-i03-python-'));
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),parent);assert.ok(path.basename(root).startsWith('orbita-i03-python-'));fs.rmSync(root,{recursive:true,force:true});});
 const env={...process.env,AFH_PYTHON:executable,PATH:path.join(root,'no interpreter on PATH')};delete env.AFH_SQLITE_PYTHON;delete env.NODE_OPTIONS;
 const script="import assert from 'node:assert/strict';const {DatabaseSync}=await import(process.argv[1]);const db=new DatabaseSync(process.argv[2]);db.exec('CREATE TABLE t(v TEXT)');db.prepare('INSERT INTO t VALUES(?)').run('café 漢字 😀');assert.equal(db.prepare('SELECT v FROM t').get().v,'café 漢字 😀');db.close();console.log('PASS');";
 const result=spawnSync(process.execPath,['--no-experimental-sqlite','--input-type=module','-e',script,new URL('../src/sqlite-compat.js',import.meta.url).href,path.join(root,'records.sqlite')],{env,encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(result.status,0,JSON.stringify({error:result.error?.message,stderr:result.stderr}));assert.match(result.stdout,/PASS/);
});

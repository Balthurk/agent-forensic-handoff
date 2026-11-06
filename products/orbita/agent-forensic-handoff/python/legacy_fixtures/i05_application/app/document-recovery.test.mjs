import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createBackup,restoreBackup,inventory} from './recovery.mjs';
const fixture=fileURLToPath(new URL('./document-crash-fixture.mjs',import.meta.url));
function run(root,op,env={}){return spawnSync(process.execPath,[fixture,op],{env:{...process.env,AFH_COSMOS_DATA:root,PYTHONDONTWRITEBYTECODE:'1',AFH_CRASH_AT:'',...env},encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:4*1024**2});}
test('document crashes retain immutable sources and recover committed library publication',()=>{
 for(const point of ['document-before-case-publish','document-after-case-publish','document-after-commit']){
  const dir=fs.mkdtempSync('C:/T/orbita-doc-crash-'),crash=run(dir,'import',{AFH_CRASH_AT:point});assert.equal(crash.status,86,crash.stderr);
  if(point==='document-after-commit'){const probe=run(dir,'probe');assert.equal(probe.status,0,probe.stderr);assert.equal(JSON.parse(probe.stdout).library.length,1);}
  const retried=run(dir,'import');assert.equal(retried.status,0,retried.stderr);const probe=run(dir,'probe');assert.equal(probe.status,0,probe.stderr);assert.equal(JSON.parse(probe.stdout).original.role,'document');
 }
});
test('corpus plan resumes retained output after process death without another inference; restore preserves the cycle',async()=>{
 const parent=fs.mkdtempSync('C:/T/orbita-plan-restore-'),dir=path.join(parent,'source');assert.equal(run(dir,'import').status,0);
 assert.equal(run(dir,'plan',{AFH_CRASH_AT:'corpus-after-plan'}).status,86);
 const failed=run(dir,'run',{AFH_CRASH_AT:'corpus-after-extract'});assert.equal(failed.status,86,failed.stderr);
 const resumed=run(dir,'run');assert.equal(resumed.status,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).processedTargets,1);assert.equal(fs.readFileSync(path.join(dir,'provider-calls.txt'),'utf8'),'call\n');
 const before=await inventory(dir),archive=path.join(parent,'memory.orbita'),destination=path.join(parent,'restored');await createBackup({source:dir,archive,password:'isolated-test-password'});await restoreBackup({archive,destination,password:'isolated-test-password'});assert.deepEqual(await inventory(destination),before);
 const probe=run(destination,'probe');assert.equal(probe.status,0,probe.stderr);assert.ok(JSON.parse(probe.stdout).original.text.includes('sin revisión expresa'));
 const again=run(destination,'run');assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(again.stdout).attempted,0);assert.equal(fs.readFileSync(path.join(destination,'provider-calls.txt'),'utf8'),'call\n');
});
test('uncertain provider outcome never reissues inference on ordinary continuation',()=>{
 const dir=fs.mkdtempSync('C:/T/orbita-plan-unknown-');assert.equal(run(dir,'import').status,0);const first=run(dir,'run',{DOC_TEST_LOST:'1'});assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).counts.unknown,1);
 const next=run(dir,'run');assert.equal(next.status,0,next.stderr);assert.equal(JSON.parse(next.stdout).attempted,0);assert.equal(fs.readFileSync(path.join(dir,'provider-calls.txt'),'utf8'),'call\n');
});

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createBackup,restoreBackup,inventory} from './recovery.mjs';
const lab=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-recovery-state-')),here=path.dirname(fileURLToPath(import.meta.url));
function run(root,op){const p=spawnSync(process.execPath,[path.join(here,'recovery-state-fixture.mjs'),op],{env:{...process.env,AFH_COSMOS_DATA:root,AFH_COSMOS_EMPTY_LIBRARY:'1'},encoding:'utf8',windowsHide:true,timeout:90000});assert.equal(p.status,0,p.stdout+p.stderr);return JSON.parse(p.stdout);}
test('F31 restores real N04, N06, learning, pending automatic review, outbox and retrieval; resumes retained work exactly once',async()=>{
 const source=path.join(lab,'source'),destination=path.join(lab,'restored'),archive=path.join(lab,'memory.orbita'),password='recovery-fixture-only';
 const before=run(source,'seed');assert.equal(before.decisions.length,3);assert.equal(before.learning.length,1);assert.equal(before.semantic.length,1);assert.equal(before.pending.jobs[0].status,'pending');
 const bytes=await inventory(source);await createBackup({source,archive,password});await restoreBackup({archive,destination,password});assert.deepEqual(await inventory(destination),bytes);
 const after=run(destination,'probe');assert.equal(after.paused.pausedAfterRestore,true);assert.equal(after.paused.results.length,0);after.paused=null;assert.deepEqual(after,before);
 const resumed=run(destination,'resume');assert.equal(resumed.calls,1);assert.equal(resumed.first.record.version,2);assert.equal(resumed.replay.record.version,2);
 const final=run(destination,'probe');assert.equal(final.semantic.length,2);assert.equal(final.pending.jobs[0].status,'complete');assert.deepEqual(final.decisions,before.decisions);assert.deepEqual(final.learning,before.learning);
 fs.writeFileSync(path.join(lab,'RESULT.json'),JSON.stringify({status:'PASS',decisions:3,learning:1,semanticVersionsAfter:2,inferences:1,pausedAutomaticBeforeResume:true,exactTreeRestored:bytes,fixture:'deterministic reviews; no actual model inference'},null,2));
});

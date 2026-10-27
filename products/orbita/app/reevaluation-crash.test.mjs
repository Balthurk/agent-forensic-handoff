import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const fixture=path.join(path.dirname(fileURLToPath(import.meta.url)),'reevaluation-crash-fixture.mjs');
function run(root,mode,crash=''){return spawnSync(process.execPath,[fixture,mode],{env:{...process.env,AFH_COSMOS_DATA:root,AFH_COSMOS_EMPTY_LIBRARY:'1',AFH_CRASH_AT:crash},encoding:'utf8',windowsHide:true,timeout:90000});}
function expireDeadOwnerLeases(root){
 // Child exit is already confirmed. Simulate elapsed lease time in this test
 // store only; keep production lease durations and all fences unchanged.
 for(const [file,table] of [['reevaluation/queue.sqlite','watches'],['reevaluation/generations/generations.sqlite','jobs'],['semantic/records.sqlite3','afh_publication_jobs']]){
  const db=new DatabaseSync(path.join(root,file));try{if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))db.exec('UPDATE '+table+' SET lease=0');}finally{db.close();}
 }
}
for(const phase of ['generation-after-output','reevaluation-after-record','publication-after-index','reevaluation-before-complete'])test('F29 fresh-process crash recovery without another inference: '+phase,async()=>{
 const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-reeval-crash-'));const seed=run(root,'seed');assert.equal(seed.status,0,seed.stdout+seed.stderr);
 const crashed=run(root,'run',phase);assert.equal(crashed.status,86,crashed.stdout+crashed.stderr);expireDeadOwnerLeases(root);
 const resumed=run(root,'run');assert.equal(resumed.status,0,resumed.stdout+resumed.stderr);const result=JSON.parse(resumed.stdout);assert.equal(result.record.version,2);assert.equal(result.disposition,'changed');assert.equal(fs.readFileSync(path.join(root,'model-calls.txt'),'utf8'),'call\n');
 const replay=run(root,'run');assert.equal(replay.status,0,replay.stdout+replay.stderr);assert.equal(JSON.parse(replay.stdout).record.version,2);assert.equal(fs.readFileSync(path.join(root,'model-calls.txt'),'utf8'),'call\n');
});
test('F29 response lost before retention stays unknown and never auto-repeats inference',()=>{
 const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-reeval-unknown-'));const seed=run(root,'seed');assert.equal(seed.status,0,seed.stdout+seed.stderr);const lost=run(root,'unknown');assert.equal(lost.status,1);assert.match(lost.stdout,/MODEL_RESPONSE_LOST/);const replay=run(root,'run');assert.equal(replay.status,1);assert.match(replay.stdout,/GENERATION_INFERENCE_UNKNOWN_NO_AUTORETRY/);assert.equal(fs.readFileSync(path.join(root,'model-calls.txt'),'utf8'),'call\n');
});
test('F29 source publication survives termination before discovery and scan reconciles exactly once',()=>{
 const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-reeval-discovery-'));const seed=run(root,'seed-watch');assert.equal(seed.status,0,seed.stdout+seed.stderr);
 const crashed=run(root,'arrival','reevaluation-after-library');assert.equal(crashed.status,86,crashed.stdout+crashed.stderr);assert.equal(JSON.parse(run(root,'status').stdout).jobs.length,0);
 const scan=run(root,'scan');assert.equal(scan.status,0,scan.stdout+scan.stderr);assert.equal(JSON.parse(scan.stdout).enqueued.length,1);assert.deepEqual(JSON.parse(scan.stdout).errors,[]);
 assert.equal(JSON.parse(run(root,'scan').stdout).enqueued.length,0);assert.equal(JSON.parse(run(root,'status').stdout).jobs.length,1);
});

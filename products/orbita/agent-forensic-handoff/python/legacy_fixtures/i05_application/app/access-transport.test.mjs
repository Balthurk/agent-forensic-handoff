import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const fixture=fileURLToPath(new URL('./access-transport-fixture.mjs',import.meta.url));
function run(mode){
 const p=spawnSync(process.execPath,[fixture,mode,'6500'],{env:{...process.env,AFH_COSMOS_DATA:'',AFH_MANAGED:'',AFH_CRASH_AT:''},encoding:'utf8',windowsHide:true,timeout:45000});
 assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
}
for(const mode of ['control','async-idle','blocked-fresh'])test('F35 CSRF and selection remain exact with '+mode+' transport',()=>{
 const r=run(mode);assert.deepEqual(r.calls.map(c=>[c.name,c.status,c.selected]),[['csrf-missing',403,false],['csrf-valid',200,true]]);
 assert.equal(r.calls[0].code,'ACCESS_CSRF_REQUIRED');
});
test('F35 a stalled pooled client cannot turn a transport failure into permission or replay',()=>{
 const r=run('blocked-loop');assert.equal(r.calls[0].selected,false);
 if(r.calls[0].error){
  assert.ok(['ECONNRESET','UND_ERR_SOCKET'].includes(r.calls[0].error.cause?.code));
  assert.equal(r.calls.length,1,'The failed POST must not be retried');
  assert.equal(r.events.filter(e=>e.event==='server-request'&&e.path==='/access/api/select').length,0);
 }else{
  // A future transport may safely discard the expired socket before dispatch.
  // Permission results must still be exact; do not require a Node runtime bug.
  assert.deepEqual(r.calls.map(c=>[c.status,c.selected]),[[403,false],[200,true]]);
 }
});

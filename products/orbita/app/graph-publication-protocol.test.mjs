import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('I07 mirror publication admits independent N04 writers and rejects stale fresh/replayed generations',()=>{
  const result=JSON.parse(execFileSync(process.env.ORBITA_POSTGRES_PYTHON,['-X','utf8','-B',fileURLToPath(new URL('./test_graph_publication_protocol.py',import.meta.url))],{env:process.env,encoding:'utf8',windowsHide:true,timeout:300000}));
  assert.equal(result.status,'PASS');assert.equal(result.tests,10);assert.equal(result.skipped,0);
  console.log('Nested real publication protocol checks: '+JSON.stringify(result));
});

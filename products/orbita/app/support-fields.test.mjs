import test from 'node:test';import assert from 'node:assert/strict';import {sameDecision} from './web/support-fields.mjs';
test('F44 a revision retains the exact decision binding regardless of JSON member order',()=>{
 assert.ok(sameDecision({caseId:'c',digest:'d',version:1},{caseId:'c',version:1,digest:'d'}));assert.equal(sameDecision({caseId:'c',digest:'d',version:1},{caseId:'c',digest:'d2',version:2}),false);
});

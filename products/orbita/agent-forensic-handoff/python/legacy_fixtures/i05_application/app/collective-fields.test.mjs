import test from 'node:test';import assert from 'node:assert/strict';
import {preserveEvidence,sameTarget} from './web/collective-fields.mjs';
test('F43 editing a label retains multiple witnesses and provenance despite JSON field order',()=>{
 const prior=[{quote:'Exact quote',sourceId:'a',provenance:{note:'retained'}},{sourceId:'b',quote:'Second support',start:8}];
 const result=preserveEvidence(prior,{sourceId:'a',quote:'Exact quote'});assert.deepEqual(result,prior);result[0].quote='changed';assert.equal(prior[0].quote,'Exact quote');
 assert.deepEqual(preserveEvidence(prior,{sourceId:'c',quote:'New original'}),[{sourceId:'c',quote:'New original'}]);
 assert.ok(sameTarget({id:'a',kind:'source',revision:'v1'},{kind:'source',id:'a',revision:'v1'}));assert.equal(sameTarget({kind:'source',id:'a',revision:'v1'},{kind:'source',id:'a',revision:'v2'}),false);
});

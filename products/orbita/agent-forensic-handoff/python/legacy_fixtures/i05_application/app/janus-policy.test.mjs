import test from 'node:test';import assert from 'node:assert/strict';import {requestRole} from './access-policy.mjs';
test('F30 backend availability is readable while publication and unclassified actions keep their role boundary',()=>{
 assert.equal(requestRole('POST','/api/graph-publication',{op:'capabilities'}),'reader');assert.equal(requestRole('POST','/api/graph-publication',{op:'publish'}),'editor');assert.throws(()=>requestRole('POST','/api/graph-publication',{op:'gremlin'}),/ACCESS_ROUTE_NOT_ADMITTED/);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {omissionSource,omissionExplanation} from './web/source-navigation.mjs';
const revision='a'.repeat(64);
test('A13 omission locators bind the exact selected source and preserve colon-bearing event IDs',()=>{
 const value=omissionSource({seed:'c:evt:42'},{sources:[{conversationId:'c',title:'Original',caseHash:revision}]});
 assert.deepEqual(value,{conversationId:'c',id:'evt:42',revision,conversationTitle:'Original',evidenceId:'fuente omitida',omitted:true});
});
test('A13 ambiguous, unselected or unversioned omissions cannot become guessed original links',()=>{
 for(const sources of [[],[{conversationId:'other',caseHash:revision}],[{conversationId:'c'}],[{conversationId:'c',caseHash:revision},{conversationId:'c:evt',caseHash:revision}]])assert.equal(omissionSource({seed:'c:evt:42'},{sources}),null);
 assert.equal(omissionSource({seed:'c:'},{sources:[{conversationId:'c',caseHash:revision}]}),null);
});
test('A13 budget and missing dependencies remain distinct and manual reading never asserts completeness',()=>{
 assert.match(omissionExplanation('budget'),/No se ha recortado/);
 assert.match(omissionExplanation('missing_dependency'),/no resuelve/);
 assert.match(omissionExplanation('future_reason'),/no forma parte/);
});

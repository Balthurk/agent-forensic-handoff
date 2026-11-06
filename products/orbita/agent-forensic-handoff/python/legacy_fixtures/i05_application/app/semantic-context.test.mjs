import test from 'node:test';import assert from 'node:assert/strict';
import {extractionInput,validateDraftSelection} from './knowledge.mjs';
test('antecedents include exact versions and whole originals; missing originals cannot form a relation target',()=>{
 const target={id:'target',text:'Revoco staging.',target:true,role:'user'},past={id:'past',text:'Permito staging si pasa QA.',role:'user'};
 const item={clauseVersionId:'cv-past',predicate:'permits',sourceRefs:[{id:'past'}]};const input=extractionInput('staging',[target,past],{items:[item,{...item,clauseVersionId:'cv-missing',sourceRefs:[{id:'missing'}]}]});
 assert.equal(input.knownClauses.length,1);assert.equal(input.sources[1].text,past.text);
 const draft={acts:[{targetSourceId:'target',clauses:[{arguments:[],conditions:[],temporal:[],relations:[{targetClauseVersionId:'cv-past',evidence:[{sourceId:'target',quote:target.text}]}]}]}]};validateDraftSelection(draft,input);
 draft.acts[0].clauses[0].relations[0].targetClauseVersionId='cv-missing';assert.throws(()=>validateDraftSelection(draft,input),/RELATION_OUTSIDE/);
 const bounded=extractionInput('',[target,{...past,text:'x'.repeat(100000)}],{items:[item]});assert.equal(bounded.sources.length,1);assert.equal(bounded.knownClauses.length,0);assert.ok(bounded.omissions.length);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=100000);
 assert.throws(()=>extractionInput('',[{...target,text:'x'.repeat(100001)}],{items:[]}),/EXCEEDS_BUDGET/);
 draft.acts[0].clauses[0].relations=[];draft.acts[0].clauses[0].arguments=[{evidence:[{sourceId:'not-in-input'}]}];assert.throws(()=>validateDraftSelection(draft,input),/WITNESS_OUTSIDE/);
});

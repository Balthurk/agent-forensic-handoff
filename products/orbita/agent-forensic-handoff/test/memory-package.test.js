import test from 'node:test';import assert from 'node:assert/strict';
import {queryPlan,buildMemoryPackage,wireBytes,dependencyClosure,rankEvidence} from '../src/memory-package.js';
import {loadTaxonomy,validateProposal,SEMANTIC_TYPES} from '../src/knowledge-proposals.js';
const record=(key,text='Evidence 🪐 ñ '.repeat(80))=>({key,id:key,text,conversationId:'c',start:0,end:[...text].length});
const base=()=>({query:'prueba',plan:queryPlan('prueba'),records:[record('a'),record('b')],seeds:['a'],links:{a:['b']},backends:[{status:'ok'}],needs:[{conversationId:'c'}]});
test('F01 whole UTF-8 package: exact boundary and one byte less remove whole episode',()=>{
 const full=buildMemoryPackage({...base(),maxBytes:100000});
 let bound=full.bytes; // maxBytes itself changes the serialized width; find the exact fixed boundary.
 for(let i=0;i<8;i++){const r=buildMemoryPackage({...base(),maxBytes:Math.max(4096,bound)});if(r.evidence.length===2)bound=r.bytes;else bound++;}
 // Use a >4K episode so the admission minimum does not mask the boundary.
 const b=base();b.records=[record('a','é🪐'.repeat(1500)),record('b','complete dependency')];
 let p=buildMemoryPackage({...b,maxBytes:100000});let n=p.bytes;
 for(let i=0;i<5;i++){p=buildMemoryPackage({...b,maxBytes:n});if(p.evidence.length)n=p.bytes;else n++;}
 const exact=buildMemoryPackage({...b,maxBytes:n});assert.equal(exact.evidence.length,2);assert.equal(wireBytes(exact),exact.bytes);assert.ok(exact.bytes<=n);
 const less=buildMemoryPackage({...b,maxBytes:exact.bytes-1});assert.equal(less.evidence.length,0);assert.equal(less.omissionSummary.budget,1);assert.ok(wireBytes(less)<=less.maxBytes);
});
test('F01 hundreds of omissions remain bounded and include diagnostics',()=>{const p=buildMemoryPackage({...base(),records:Array.from({length:250},(_,i)=>record('x'+i,'x'.repeat(10000))),seeds:Array.from({length:250},(_,i)=>'x'+i),links:{},maxBytes:4096});assert.equal(p.evidence.length,0);assert.equal(p.omissionSummary.total,250);assert.equal(p.omissions.length,16);assert.equal(p.omissionSummary.detailsOmitted,234);assert.equal(wireBytes(p),p.bytes);});
test('F01 metadata overflow is explicit, never an oversized success',()=>assert.throws(()=>buildMemoryPackage({...base(),query:'x'.repeat(9000),maxBytes:4096}),/METADATA/));
test('F02 unavailable, degraded, no_match and budget_exhausted are distinct',()=>{
 for(const [backends,seeds,state] of [[[{status:'unavailable'}],[],'unavailable'],[[{status:'ok'},{status:'unavailable'}],[],'degraded'],[[{status:'no_match'}],[],'no_match']]){const p=buildMemoryPackage({...base(),backends,seeds});assert.equal(p.state,state);assert.equal(p.abstention,true);}
 const p=buildMemoryPackage({...base(),records:[record('a','x'.repeat(30000)),record('b')],maxBytes:4096});assert.equal(p.state,'budget_exhausted');assert.equal(p.needs[0].status,'not_satisfied');
});
test('F03 bilingual aliases are explicit; exact search does not expand',()=>{assert.ok(queryPlan('Which constraints and goals?').aliases.includes('restricciones'));assert.deepEqual(queryPlan('constraints',{profile:'exact'}).aliases,[]);assert.deepEqual(queryPlan('"AssetGuard G13"').anchors,['AssetGuard G13']);});
test('F03 temporal intent is not silently implemented as a date filter',()=>{const p=queryPlan('última decisión');assert.equal(p.temporalIntent,true);assert.equal(p.temporalFilterApplied,false);assert.ok(p.warnings.length);assert.equal(queryPlan('no lo apruebes').negationPreserved,'no lo apruebes');});
test('F04 closure is transitive and cycle-safe',()=>{const map=new Map(['a','b','c'].map(id=>[id,record(id)]));assert.deepEqual(dependencyClosure('a',map,{a:['b'],b:['c'],c:['a']}).members,['a','b','c']);});
test('F04 missing dependency excludes the entire seed, retaining independent episode',()=>{const p=buildMemoryPackage({...base(),seeds:['a','b'],links:{a:['lost']}});assert.deepEqual(p.evidence.map(r=>r.id),['b']);assert.equal(p.omissions[0].reason,'missing_dependency');assert.equal(p.omissionSummary.missingDependency,1);});
test('F04 shared dependency is admitted once; evidence is not clipped',()=>{const b=base();b.seeds=['a','b'];const p=buildMemoryPackage(b);assert.equal(p.evidence.length,2);assert.deepEqual(p.evidence.map(x=>x.text),b.records.map(x=>x.text));assert.equal(new Set(p.evidence.map(x=>x.evidenceId)).size,2);});
test('F07 pins all 55 nodes, 8 families and 14 facets',()=>{const t=loadTaxonomy();assert.equal(t.nodes.length,55);assert.equal(t.nodes.filter(n=>n.parent_id===t.root_id).length,8);assert.equal(t.facets.length,14);});
const proposal=()=>({id:'p1',type:'unknown',text:'A source-backed proposal',actor:{id:'u',role:'user'},modality:'reported',scope:'c',status:'proposed',source_refs:[{conversationId:'c',eventId:'e',revision:'r',start:0,end:8,quote:'evidence'}],custom:{uncertain:true}});
test('F08 eighteen types and unknown extensions round-trip without implicit approval',()=>{assert.equal(SEMANTIC_TYPES.length,18);for(const type of SEMANTIC_TYPES){const p=validateProposal({...proposal(),type});assert.deepEqual(p.custom,{uncertain:true});assert.equal(p.status,'proposed');assert.deepEqual(p.labels,[]);}});
test('F07/F08 reject invented labels, facets, status, ranges and authority fields',()=>{
 for(const patch of [{labels:['imaginary']},{facets:{bogus:['value']}},{status:'approved'},{approval:{}},{source_refs:[]},{actor:null},{type:'truth'}])assert.throws(()=>validateProposal({...proposal(),...patch}));
});
test('F05 MMR diversifies without removing identity, zero ranks cannot manufacture hits',()=>{
 const records=[record('a','alpha beta gamma delta'),record('b','alpha beta gamma delta'),record('c','different topic evidence')];
 const ranks=new Map([['a',.04],['b',.039],['c',.035]]);assert.deepEqual(rankEvidence(records,ranks),['a','c','b']);assert.deepEqual(rankEvidence(records,new Map([['a',0]])),[]);
 assert.deepEqual(rankEvidence(records,ranks,{rerank:'rrf'}),['a','b','c']);
});
test('F08 rejects lossy JSON coercion in unknown fields',()=>{for(const value of [NaN,Infinity,undefined,()=>{}])assert.throws(()=>validateProposal({...proposal(),extra:value}),/Non-JSON/);});

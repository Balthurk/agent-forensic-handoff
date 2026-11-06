import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-semantic-app-'));process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {addSource,library,loadCase}=await import('./corpus.mjs');const {verifiedSources,knowledgeOperation}=await import('./knowledge.mjs');const {retrievePackage,coverage,closeMemory}=await import('./memory.mjs');
async function add(id,text){return addSource({filename:id+'.json',content:JSON.stringify({id,title:id,current_node:'u',mapping:{u:{id:'u',parent:null,children:[],message:{id:'u',author:{role:'user'},content:{content_type:'text',parts:[text]}}}}})});}
const clauses=(source,key,predicate,polarity='positive')=>({key,targetSourceId:source.id,type:'policy',summary:source.text,modality:'directive',clauses:[{key,quote:source.text,predicate,polarity,resolution:'resolved',arguments:[{role:'environment',literal:key,evidence:[{sourceId:source.id,quote:source.text}]}],conditions:[],temporal:[],relations:[]}]});
test('F09–F22 three-conversation permission/exception/revocation, source reopening and atomic budget',async t=>{
 t.after(()=>closeMemory());
 const a=await add('A','Permito staging de Alfa sólo si pasa QA.');const b=await add('B','Prohíbo producción de Beta.');const c=await add('C','Revoco únicamente el permiso de staging de Alfa.');const ids=[a.id,b.id,c.id],context=await verifiedSources(ids);
 const records=[];for(const [i,source] of context.sources.entries()){
  const draft={acts:[clauses(source,i===1?'production':'staging',i===2?'revokes':i===1?'forbids':'permits',i===1?'negative':'positive')]};
  if(i===0)draft.acts[0].clauses[0].conditions=[{literal:'sólo si pasa QA',scope:'Alfa staging',resolution:'resolved',evidence:[{sourceId:source.id,quote:'sólo si pasa QA'}]}];
  const result=await knowledgeOperation('extract',ids,{draft,producer:'fixture-producer',sourceCut:context.cut,requestId:'extract-'+i});assert.deepEqual(result.errors,[]);records.push(result.records[0]);
 }
 const originalVersion=records[0].payload.semantic_unit.clauses[0].clause_version_id;
 const p=structuredClone(records[2].payload),cl=p.semantic_unit.clauses[0];cl.relations=[{kind:'retracts',direction:'outgoing',status:'candidate',target_clause_version_id:originalVersion,evidence_keys:['/relations/0']}];cl.evidence_by_field['/relations/0']=structuredClone(cl.evidence_by_field['/predicate']);cl.clause_version_id='cv-linked-revocation';
 await knowledgeOperation('correct',ids,{id:p.id,expectedVersion:1,payload:p,requestId:'link-revocation'});
 const q=await knowledgeOperation('query',ids,{question:'staging',roots:[originalVersion]});assert.equal(q.items.length,2);assert.equal(q.edges[0].kind,'retracts');assert.equal(q.requiresAbstention,true);
 const before=await knowledgeOperation('query',ids,{question:'staging',knownAt:records[0].recorded_at});assert.equal(before.items.length,1);assert.equal(before.edges.length,0);
 const pkg=await retrievePackage('¿Cuál era el permiso de staging de Alfa y su revocación?',ids,{mode:'lexical',roots:[originalVersion]});assert.equal(pkg.bytes,Buffer.byteLength(JSON.stringify(pkg)));assert.ok(pkg.bytes<=100000);assert.equal(pkg.knowledge.items.length,2);assert.ok(pkg.evidence.some(e=>e.text.includes('sólo si pasa QA')));assert.ok(pkg.evidence.some(e=>e.text.includes('Revoco únicamente')));
 const small=await retrievePackage('staging',ids,{mode:'lexical',roots:[originalVersion],maxBytes:6500});assert.ok(small.bytes<=6500);assert.equal(small.knowledge.items.length,0);assert.ok(small.knowledge.omittedClauses>0);
 const absent=await retrievePackage('"no-existe-abcd-725"',ids,{mode:'lexical',profile:'exact'});assert.equal(absent.evidence.length,0);
 const cov=await coverage();assert.equal(cov.reduce((n,r)=>n+r.extracted.semanticRecords,0),3);
 const observed=await knowledgeOperation('history',ids,{id:p.id});assert.equal(observed.length,2);assert.equal(observed[0].payload.semantic_unit.clauses[0].relations.length,0);
 const item=library.find(i=>i.id===a.id);fs.appendFileSync(path.join(item.path,'acquisition/original.bin'),'tampered');await assert.rejects(knowledgeOperation('list',ids),/Integridad/);
});

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-learning-'));process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {addSource,library,loadCase}=await import('./corpus.mjs');const {learningOperation:op,learningSources}=await import('./learning.mjs');const {knowledgeOperation,verifiedSources,knowledgeCoverage}=await import('./knowledge.mjs');const {retrievePackage,closeMemory}=await import('./memory.mjs');
async function add(id,text){return addSource({filename:id+'.json',content:JSON.stringify({id,title:id,current_node:'u',mapping:{u:{id:'u',parent:null,children:[],message:{id:'u',author:{role:'user'},content:{content_type:'text',parts:[text]}}}}})});}
const here=path.dirname(fileURLToPath(import.meta.url));
test('F25 records, retries, concurrent correction, fresh process, full restore, semantic coexistence and source drift',async t=>{
 t.after(()=>closeMemory());
 const a=await add('A','El proceso falló al guardar el CSV con Excel abierto.');const b=await add('B','Cerrar Excel permitió guardar el CSV. No corrige permisos de acceso.');const ids=[a.id,b.id];const sources=await learningSources(ids);
 const claim=(text,index,quote)=>({text,evidence:[{sourceId:sources[index].id,quote}]});
 const episode={id:'csv-lock',title:'Guardar CSV con Excel abierto',condition:claim('Excel abierto',0,'con Excel abierto'),action:claim('Guardar CSV',0,'guardar el CSV'),failure:claim('Fallo de escritura',0,'El proceso falló'),observation:claim('Se pudo guardar',1,'Cerrar Excel permitió guardar el CSV'),repair:claim('Cerrar Excel',1,'Cerrar Excel'),outcome:{value:'success',evidence:[{sourceId:sources[1].id,quote:'permitió guardar el CSV'}]},counterexamples:[claim('No resuelve permisos',1,'No corrige permisos de acceso')],procedure:claim('Cerrar Excel antes de guardar',1,'Cerrar Excel permitió guardar el CSV'),extra:{future:'kept'}};
 const input={conversationIds:ids,episode,requestId:'initial'};const first=await op('record',input);assert.deepEqual(await op('record',input),first);assert.equal(first.payload.status,'proposed');
 // A semantic record and its source retrieval must work with a learning archive present.
 const context=await verifiedSources(ids),source=context.sources[0],quote=source.text;
 const draft={acts:[{key:'csv',targetSourceId:source.id,type:'feedback',summary:quote,modality:'stated',clauses:[{key:'failure',quote,predicate:'fallo de escritura',polarity:'positive',resolution:'resolved',arguments:[],conditions:[],temporal:[],relations:[]}]}]};
 const semantic=await knowledgeOperation('extract',ids,{draft,producer:'fixture',sourceCut:context.cut,requestId:'semantic'});assert.deepEqual(semantic.errors,[]);
 const snapshot=await knowledgeOperation('list',ids),before=await knowledgeCoverage(ids);
 const updated={...episode,title:'Fallo CSV: reparación con condición'};const writes=await Promise.allSettled(['x','y'].map(requestId=>op('record',{conversationIds:ids,episode:updated,requestId,expectedVersion:1,reason:'Precisión del título'})));
 assert.equal(writes.filter(r=>r.status==='fulfilled').length,1);assert.match(writes.find(r=>r.status==='rejected').reason.message,/VERSION_CONFLICT/);
 assert.deepEqual(await knowledgeOperation('list',ids),snapshot);assert.deepEqual(await knowledgeCoverage(ids),before);
 const packet=await retrievePackage('CSV',ids,{mode:'lexical'});assert.ok(packet.evidence.length>0);assert.equal(packet.knowledge.items.length,1);
 const query={op:'learning.query',input:{conversationIds:ids,question:'permisos CSV'}};
 function fresh(data,request=query){const p=spawnSync(process.execPath,[path.join(here,'incremental-cli.mjs')],{env:{...process.env,AFH_COSMOS_DATA:data},input:JSON.stringify(request),encoding:'utf8',timeout:30000,windowsHide:true});assert.equal(p.status,0,p.stdout+p.stderr);return JSON.parse(p.stdout).result;}
 const reopened=fresh(root);assert.equal(reopened.items.length,1);assert.equal(reopened.items[0].record.version,2);assert.equal(reopened.items[0].record.payload.learning_episode.episode.counterexamples.length,1);assert.equal(reopened.bytes,Buffer.byteLength(JSON.stringify(reopened)));assert.ok(reopened.bytes<=100000);
 const restored=root+'-restore';fs.cpSync(root,restored,{recursive:true});assert.deepEqual(fresh(restored),reopened);
 const history=fresh(restored,{op:'learning.history',input:{conversationIds:ids,id:'csv-lock'}});assert.equal(history.length,2);assert.deepEqual(history[0],first);
 assert.equal((await op('query',{conversationIds:[a.id],question:'CSV'})).status,'partial_selection');
 const controller=new AbortController();controller.abort(new Error('TEST_CANCEL'));await assert.rejects(op('query',{conversationIds:ids,question:'CSV'},{signal:controller.signal}),/TEST_CANCEL/);
 const item=library.find(i=>i.id===a.id);fs.appendFileSync(path.join(item.path,'acquisition/original.bin'),'tampered');await assert.rejects(op('query',{conversationIds:ids,question:'CSV'}),/Integridad/);
});

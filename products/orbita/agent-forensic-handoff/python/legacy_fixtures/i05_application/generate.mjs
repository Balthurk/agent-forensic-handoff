// Synthetic independent application oracle. Copied I05 sources are never edited.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {getLoadablePath} from 'sqlite-vec';
const here=path.dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(here,'SOURCE-MANIFEST.json'),'utf8'));
const verify=()=>{for(const [relative,expected] of Object.entries(manifest.files))assert.equal(sha(fs.readFileSync(path.join(here,relative))),expected,relative);};
assert.ok(path.isAbsolute(root));assert.equal(fs.readdirSync(root).length,0);
for(const key of Object.keys(process.env))assert.ok(!/^(ORBITA_|OPENAI_|ANTHROPIC_|JEV_|CODEX_|NODE_OPTIONS|PYTHONPATH|AFH_SEMANTIC_PG)/i.test(key),key);
assert.equal(process.env.AFH_COSMOS_DATA,root);verify();
assert.equal(sha(fs.readFileSync(getLoadablePath())),'fcf98662a7ad9dce394b96a88f91032047823831b951c76636787c312a6476e6');
const mod=relative=>import(pathToFileURL(path.join(here,relative)).href);
const {graphFixture}=await mod('app/graph-fixture.mjs');
const {ids}=await graphFixture();
const {library}=await mod('app/corpus.mjs');
const {buildSemanticIndex,verifySemanticProjection}=await mod('agent-forensic-handoff/src/semantic.js');
const provider={identity:{provider:'fixture-local',runtime:'deterministic-test-provider',runtimeVersion:'1',modelId:'fixture/legacy-application',revision:'fixture-v1',modelDigest:'a'.repeat(64),dimensions:2,dtype:'f32',pooling:'fixture',normalization:'l2-v1',license:'test-only',snapshotPath:null},async embed(texts){return texts.map(()=>[1,0]);}};
const projection=await buildSemanticIndex(library[0].path,{provider,batchSize:2});
assert.equal((await verifySemanticProjection(library[0].path,projection.projectionDir)).passed,true);
const {discoverContext,contextPage}=await mod('app/context.mjs');
const {retrievePackage,closeMemory}=await mod('app/memory.mjs');
const options={mode:'lexical',knownAt:'2099-01-01T00:00:00Z',validAt:'2026-10-25T00:00:00Z'};
const before=await discoverContext('revisar contexto',ids,options);
const retained=await retrievePackage('revisar contexto',ids,options);
assert.ok(retained.context.snapshot);
const request={id:retained.context.snapshot.id,conversationIds:ids,limit:1};
const page=await contextPage(request);assert.equal(page.freshness.current,true);assert.ok(page.items.length);
const nextPage=page.nextCursor?await contextPage({...request,cursor:page.nextCursor}):null;
const {volumeOperation,volumeCatalog}=await mod('app/volume.mjs');
let volumeState=await volumeOperation({op:'sync'});
for(let i=0;!volumeState.ready&&i<10;i++)volumeState=await volumeOperation({op:'sync'});
assert.equal(volumeState.ready,true);
let lake=await volumeOperation({op:'lake',limit:1});
for(let i=0;!lake.ready&&i<20;i++)lake=await volumeOperation({op:'lake',limit:1});
assert.equal(lake.ready,true);assert.equal((await volumeOperation({op:'verify'})).status,'VERIFIED');
const volumeRequest={op:'page',limit:1,backend:'sqlite'},volumePage=await volumeOperation(volumeRequest);
assert.ok(volumePage.cursor);const volumeNext=await volumeOperation({...volumeRequest,cursor:volumePage.cursor});
const volume={catalog:volumeCatalog(),request:volumeRequest,page:volumePage,nextPage:volumeNext};
await closeMemory();const {useStore}=await mod('app/store-access.mjs');useStore(root).release();
// These are this child's synthetic files only. All application consumers have
// closed before a coherent snapshot is enumerated; no historical DB is opened.
const walk=folder=>fs.readdirSync(folder,{withFileTypes:true}).flatMap(e=>{
 const file=path.join(folder,e.name);assert.equal(fs.lstatSync(file).isSymbolicLink(),false);
 return e.isDirectory()?walk(file):[file];
});
for(const file of walk(root).filter(p=>/\.sqlite3?$/.test(p))){const db=new DatabaseSync(file);try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}}
const entries=[];const bySource=new Map();
for(const file of walk(root).sort()){
 const source=path.relative(root,file).split(path.sep).join('/');let target=source,kind='file',family;
 if(/-(wal|shm|journal)$/.test(source)){assert.equal(fs.statSync(file).size,0);kind='custody';}
 else if(/\/case\.sqlite$/.test(source)){family='case';target=source.replace(/case\.sqlite$/,'case.pgstore');}
 else if(source==='documents.sqlite'){family='documents';target='documents.pgstore';}
 else if(source==='library-lock.sqlite'){family='library';target='library-lock.pgstore';}
 else if(/^semantic\/(.*\/)?records\.sqlite3$/.test(source)){family='semantic';target=source.replace(/records\.sqlite3$/,'records.pgstore');}
 else if(/^semantic\/(.*\/)?corpus\.sqlite3$/.test(source)){family='corpus';target=source.replace(/corpus\.sqlite3$/,'corpus.pgstore');}
 else if(/\/projections\/[^/]+\/semantic\.sqlite$/.test(source)){family='vector';target=source.replace(/semantic\.sqlite$/,'semantic.pgstore');}
 else if(source==='volume/operational.sqlite'){family='volume';target='volume/legacy-source.pgstore';}
 else if(/\.(sqlite|sqlite3|db)$/.test(source))throw new Error('UNCLASSIFIED_SYNTHETIC_STORE:'+source);
 if(family)kind='store';
 if(source==='library.json'||/\/(case|projection)\.json$/.test(source))kind='custody';
 if(source.startsWith('volume/lake/'))kind='custody';
 bySource.set(source,entries.length);entries.push({source,target,kind,sha256:sha(fs.readFileSync(file)),...(family?{family}:{})});
}
const derivations=[],caseByFolder=new Map();
for(const entry of entries.filter(e=>/\/case\.json$/.test(e.source))){
 const value=JSON.parse(fs.readFileSync(path.join(root,entry.source),'utf8')),folder=path.posix.dirname(entry.source),index=bySource.get(entry.source);
 caseByFolder.set(folder,index);derivations.push({kind:'case',entry:index,store:bySource.get(folder+'/case.sqlite'),caseHash:value.caseHash});
}
for(const entry of entries.filter(e=>/\/projection\.json$/.test(e.source))){
 const value=JSON.parse(fs.readFileSync(path.join(root,entry.source),'utf8')),folder=path.posix.dirname(entry.source),caseFolder=folder.split('/projections/')[0];
 derivations.push({kind:'projection',entry:bySource.get(entry.source),store:bySource.get(folder+'/semantic.sqlite'),case:caseByFolder.get(caseFolder),caseHash:value.caseHash,projectionHash:value.projectionHash});
}
const originalLibrary=JSON.parse(fs.readFileSync(path.join(root,'library.json'),'utf8'));
derivations.push({kind:'library',entry:bySource.get('library.json'),mappings:originalLibrary.map(item=>({id:item.id,case:caseByFolder.get('cases/'+item.id),originalPath:item.path}))});
derivations.push({kind:'volume',store:bySource.get('volume/operational.sqlite'),cases:[...caseByFolder.values()],parquet:entries.map((e,i)=>e.source.startsWith('volume/lake/')?i:null).filter(i=>i!==null)});
verify();
const engine=new DatabaseSync(':memory:');let sqliteVersion;try{sqliteVersion=engine.prepare('SELECT sqlite_version() v').get().v;}finally{engine.close();}
console.log(JSON.stringify({schema:'orbita-i05-application-result-1',sqliteVersion,sourceManifestSha256:sha(fs.readFileSync(path.join(here,'SOURCE-MANIFEST.json'))),originalSourcesUnchanged:true,ids,options,before,request,page,nextPage,volume,projectionRelative:path.relative(root,projection.projectionDir).split(path.sep).join('/'),plan:{schema:'orbita-legacy-plan-2',sourceRoot:root,entries,derivations}}));

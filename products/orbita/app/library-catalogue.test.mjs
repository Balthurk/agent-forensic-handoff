import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
const root=fs.mkdtempSync('C:/T/orbita-library-catalogue-');process.env.AFH_COSMOS_DATA=root;
const {bootstrapLibrary}=await import('./library-catalogue.mjs');
const {addSource,getLibrary}=await import('./corpus.mjs');const {verifiedSources}=await import('./knowledge.mjs');
let real;
test('small catalogue retains verified originals and the complete legacy library contract',async()=>{
 real=await addSource({filename:'original.jsonl',content:JSON.stringify({timestamp:'2026-10-25T00:00:00Z',type:'session_meta',payload:{id:'catalogue-original',cwd:'C:/fixture'}})+'\n'+JSON.stringify({timestamp:'2026-10-25T00:00:01Z',type:'response_item',payload:{type:'message',id:'catalogue-message',role:'user',content:[{type:'input_text',text:'No publicar sin comprobar vigencia.'}]}})+'\n'});
 const legacy=await getLibrary();assert.deepEqual(await bootstrapLibrary({catalogue:true}),{library:legacy});assert.equal(legacy[0].verified,true);
});
test('large listing never trusts claimed verification or reads missing originals to grant approval',async()=>{
 const current=JSON.parse(fs.readFileSync(path.join(root,'library.json')));
 for(let i=0;i<100;i++)current.push({id:'missing-'+i,title:'Metadata only '+i,path:path.join(root,'absent-'+i),verified:true,messages:999,records:999,hash:'forged',roles:{user:999}});
 fs.writeFileSync(path.join(root,'library.json'),JSON.stringify(current));
 const catalogue=await bootstrapLibrary({catalogue:true});assert.equal(catalogue.libraryMode,'catalogue');assert.equal(catalogue.library.length,101);assert.equal(catalogue.maxSelection,20);
 for(const item of catalogue.library){assert.equal(item.verified,false);assert.equal(item.verificationStatus,'on-demand');assert.equal(item.path,undefined);assert.equal(item.hash,undefined);assert.equal(item.messages,undefined);assert.equal(item.records,undefined);assert.equal(item.roles,null);}
 await assert.rejects(verifiedSources(['missing-0']));
});
test('on-demand selection checks the whole current original and rejects a later byte change',async()=>{
 const checked=await verifiedSources([real.id]);assert.equal(checked.sources.length,1);assert.equal(checked.sources[0].text,'No publicar sin comprobar vigencia.');assert.equal(checked.sources[0].verified,true);
 const caseRoot=path.join(root,'cases',real.id),source=fs.readdirSync(path.join(caseRoot,'evidence/sources')).find(p=>p.endsWith('.jsonl'));
 fs.appendFileSync(path.join(caseRoot,'evidence/sources',source),'\n');
 await assert.rejects(verifiedSources([real.id]),/Integridad/);
 const pending=await bootstrapLibrary({catalogue:true});assert.ok(pending.library.every(x=>x.verified===false));
});

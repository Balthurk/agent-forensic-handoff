import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','afh-app-tests-'));process.env.AFH_COSMOS_DATA=root;
const original=new URL('./data/cases/diagnostico',import.meta.url);
fs.cpSync(original,path.join(root,'cases','real'),{recursive:true,filter:s=>!s.includes('projections')});
fs.writeFileSync(path.join(root,'library.json'),JSON.stringify([{id:'real',title:'Frozen shared conversation',path:path.join(root,'cases','real')}]));
const memory=await import('./memory.mjs'),corpus=await import('./corpus.mjs');
test('P1 real conversation: full evidence, honest missing vector, proposals, source mutation and cache',async t=>{
 t.after(()=>memory.closeMemory());
 const cov=(await memory.coverage())[0];assert.equal(cov.denominator,445);assert.equal(cov.archived,445);assert.equal(cov.semantic.status,'not_indexed');assert.equal(cov.extracted.status,'not_performed');
 const lexical=await memory.retrievePackage('AssetGuard',['real'],{mode:'lexical'});assert.ok(lexical.evidence.length);assert.ok(lexical.bytes<=100000);assert.equal(Buffer.byteLength(JSON.stringify(lexical)),lexical.bytes);
 const c=await corpus.loadCase(corpus.library[0]);for(const e of lexical.evidence){const source=c.messages.find(m=>m.id===e.id);assert.equal(e.text,source.text);assert.equal(e.end,[...source.text].length);}
 for(const episode of lexical.episodes)assert.ok(episode.members.every(k=>lexical.evidence.some(e=>e.key===k)));
 const hybrid=await memory.retrievePackage('AssetGuard',['real'],{mode:'hybrid'});assert.equal(hybrid.state,'degraded');assert.equal(hybrid.backends.find(b=>b.channel==='semantic_full_text').status,'unavailable');assert.ok(hybrid.evidence.length);
 const semantic=await memory.retrievePackage('AssetGuard',['real'],{mode:'semantic'});assert.equal(semantic.state,'unavailable');assert.equal(semantic.abstention,true);
 await memory.indexConversations(['real']);
 const indexed=(await memory.coverage())[0];assert.equal(indexed.revision,cov.revision);assert.equal(indexed.denominator,445);assert.equal(indexed.semantic.status,'indexed');assert.ok(indexed.semantic.records>0);assert.equal(indexed.extracted.status,'not_performed');
 const vector=await memory.retrievePackage('How should regressions be checked between successive features?',['real'],{mode:'semantic'});
 assert.equal(vector.state,'ok');assert.ok(vector.evidence.length);assert.equal(vector.backends.find(b=>b.channel==='lexical_full_text').status,'not_requested');assert.equal(vector.backends.find(b=>b.channel==='semantic_full_text').status,'ok');
 assert.equal(indexed.semantic.representation,'full_source_text');assert.equal(indexed.semantic.sourceCodepoints,indexed.semantic.coveredCodepoints);assert.equal(indexed.semantic.truncatedChunks,0);
 const projection=path.join(root,'cases/real/projections',indexed.semantic.projectionId,'semantic.sqlite'),vectorBytes=fs.readFileSync(projection);fs.appendFileSync(projection,'tamper');
 try{const degraded=await memory.retrievePackage('AssetGuard',['real'],{mode:'hybrid'});assert.equal(degraded.state,'degraded');assert.ok(degraded.evidence.length);assert.equal((await memory.retrievePackage('AssetGuard',['real'],{mode:'semantic'})).state,'unavailable');}
 finally{fs.writeFileSync(projection,vectorBytes);}
 corpus.library.push({...corpus.library[0],id:'duplicate-import'});
 fs.writeFileSync(path.join(root,'library.json'),JSON.stringify(corpus.library)); // durable catalog fixture, as required across processes
 const empty=await memory.retrievePackage('nonexistent_unique_831736',['real','duplicate-import'],{mode:'lexical',profile:'exact'});assert.equal(empty.state,'no_match');assert.equal(empty.abstention,true);
 corpus.library.pop();fs.writeFileSync(path.join(root,'library.json'),JSON.stringify(corpus.library));
 const source=lexical.evidence.find(e=>e.role==='user'),quote=[...source.text].slice(0,25).join('');
 const proposal={id:'source-linked-proposal',type:'question',text:'Manual test proposal; not approved',actor:{id:'historical-user',role:'user'},modality:'reported',scope:'real',status:'proposed',labels:['tsm:interrogative'],facets:{},source_refs:[{conversationId:'real',eventId:source.id,revision:cov.revision,start:0,end:25,quote}],extension:{opaque:['preserved']}};
 const saved=await memory.createProposal(proposal);assert.equal(saved.sourceBinding[0].representationId,source.representationId);assert.deepEqual(saved.payload.extension,proposal.extension);
 assert.equal((await memory.listProposals())[0].bindingStatus,'valid');await assert.rejects(memory.createProposal(proposal),/EEXIST/);
 await assert.rejects(memory.createProposal({...proposal,id:'bad-quote',source_refs:[{...proposal.source_refs[0],quote:'invented'}]}),/QUOTE/);
 await assert.rejects(memory.createProposal({...proposal,id:'stale',source_refs:[{...proposal.source_refs[0],revision:'obsolete'}]}),/STALE/);
 const boosted=await memory.retrievePackage('nonexistent_unique_831736',['real'],{mode:'lexical',profile:'exact',labels:['tsm:interrogative']});assert.ok(boosted.evidence.some(e=>e.id===source.id));
 const without=await memory.retrievePackage('AssetGuard',['real'],{mode:'lexical',labels:['tsm:descriptive']});assert.ok(without.evidence.length,'unclassified evidence must remain retrievable');
 const file=path.join(root,'proposals',proposal.id+'.json'),raw=fs.readFileSync(file);const tampered=JSON.parse(raw);tampered.payload.text='tampered';fs.writeFileSync(file,JSON.stringify(tampered));assert.equal((await memory.listProposals())[0].bindingStatus,'invalid');fs.writeFileSync(file,raw);
 const sourceFile=path.join(root,'cases/real/acquisition/original.html');const actual=fs.existsSync(sourceFile)?sourceFile:path.join(root,'cases/real/acquisition',fs.readdirSync(path.join(root,'cases/real/acquisition')).find(n=>n.endsWith('.html')));
 const originalBytes=fs.readFileSync(actual);fs.appendFileSync(actual,' changed');
 try{await assert.rejects(corpus.getEvidence('real',source.id),/Integridad/);const failed=await memory.retrievePackage('AssetGuard',['real'],{mode:'lexical'});assert.equal(failed.state,'unavailable');assert.equal(failed.evidence.length,0);assert.equal((await memory.listProposals())[0].bindingStatus,'invalid');}
 finally{fs.writeFileSync(actual,originalBytes);}
 assert.equal((await memory.coverage())[0].revision,cov.revision);
});

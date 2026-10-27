import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {compareContextUnits,EXPLORER_ORDER_VERSION,projectContext,publicGraph} from './web/explorer-model.mjs';
const root=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-explorer-derived-'));
process.env.AFH_COSMOS_DATA=root;process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {explorerDerivedFixture}=await import('./explorer-derived-fixture.mjs');
const {retrievePackage,closeMemory}=await import('./memory.mjs');
const {readSnapshot}=await import('./context.mjs');
const {explorer}=await import('./explorer.mjs');
const {retrospectiveOperation}=await import('./retrospectives.mjs');
const {causalOperation}=await import('./causal.mjs');
let f,packet,snapshot,pages;
const call=(op,extra={})=>explorer({id:packet.context.snapshot.id,conversationIds:f.ids,op,...extra});
const unit=kind=>snapshot.units.find(u=>u.kind===kind);
const projection=kind=>projectContext(unit(kind),snapshot.evidence);
const rootNode=g=>g.nodes.find(n=>n.id===g.rootId);
before(async()=>{
  f=await explorerDerivedFixture();packet=await retrievePackage('copia archivos recuperación',f.ids,{mode:'lexical',maxBytes:200000});snapshot=readSnapshot(packet.context.snapshot.id).snapshot;
  pages=[];let p=await call('page');while(p){pages.push(p);p=p.nextCursor?await call('page',{cursor:p.nextCursor}):null;}
});
after(()=>closeMemory());
test('I01 total order is permutation-invariant, transitive and independent of prototype or locale',()=>{
  const kinds=['semantic','original','retrospective','causal_explanation','decision_intelligence','__proto__','constructor','future_á','future_a','decision','identity','collective'];
  const units=kinds.flatMap(kind=>['á','a'].map(id=>({kind,id}))),expected=[...units].sort(compareContextUnits);
  for(const a of units)for(const b of units){const ab=compareContextUnits(a,b);assert.ok(Number.isFinite(ab));assert.equal(Math.sign(ab)+Math.sign(compareContextUnits(b,a)),0);for(const c of units)if(ab<=0&&compareContextUnits(b,c)<=0)assert.ok(compareContextUnits(a,c)<=0);}
  for(let cut=0;cut<units.length;cut++)assert.deepEqual([...units.slice(cut),...units.slice(0,cut)].reverse().sort(compareContextUnits),expected);
  const permutations=xs=>xs.length?xs.flatMap((x,i)=>permutations(xs.filter((_,j)=>j!==i)).map(t=>[x,...t])):[[]];
  const sample=kinds.slice(0,6).map(kind=>({kind,id:kind}));for(const xs of permutations(sample))assert.deepEqual(xs.sort(compareContextUnits),[...sample].sort(compareContextUnits));
});
test('I01 derived roots retain exact identity, authorship, distinct declared dates and history; unknown types fail explicit',()=>{
  for(const kind of ['retrospective','decision_intelligence','causal_explanation']){
    const u=unit(kind),n=rootNode(projectContext(u,snapshot.evidence));assert.equal(n.kind,kind);assert.notEqual(n.state,'literal_provenance');assert.deepEqual(n.historyTarget,{kind,...u.data.reference});assert.equal(n.recordedAt,u.data.record.recorded_at);assert.ok(n.author);assert.ok(n.meaning);assert.ok(n.reportedTimes.length);
  }
  const r=rootNode(projection('retrospective'));assert.equal(r.reportedTimes[0].value,f.context.subjectAt);assert.notEqual(r.recordedAt,r.reportedTimes[0].value);assert.equal(r.author,'audit-editor');
  const unknown=rootNode(projectContext({kind:'future_type',id:'x',title:'Future',data:{}}));assert.equal(unknown.kind,'unsupported');assert.equal(unknown.sourceKind,'future_type');assert.equal(unknown.historyTarget,undefined);
  assert.equal(rootNode(projectContext({kind:'original',id:'x',title:'Original',data:{}})).kind,'original');
});
test('I01 retrospective projection retains adverse claims and incompatible attributed receipts without mind-reading',()=>{
  const g=projection('retrospective');assert.deepEqual(g.nodes.filter(n=>n.kind==='retrospective_claim').map(n=>n.state),['supports','contradicts']);
  const reports=g.nodes.filter(n=>n.kind==='personal_report');assert.deepEqual(reports.map(n=>n.state),['received','denied']);assert.ok(reports.every(n=>n.meaning.includes('no acredita conocimiento personal')));
  assert.equal(rootNode(g).detail.evaluation.personalReportConflicts.length,1);assert.ok(g.edges.filter(e=>e.kind==='provenance').length>=5);
});
test('I01 every intelligence subtype has an attributed projection, not outcome-based quality or authority',()=>{
  const views=snapshot.units.filter(u=>u.kind==='decision_intelligence');assert.deepEqual(views.map(u=>u.data.kind).sort(),['forecast','outcome','precedent','review']);
  for(const u of views){const g=projectContext(u,snapshot.evidence),n=rootNode(g);assert.equal(n.subtype,u.data.kind);assert.equal(n.state,'attributed_'+u.data.kind);assert.equal(g.executionAuthority,false);}
  const review=projectContext(views.find(u=>u.data.kind==='review'),snapshot.evidence);assert.equal(review.nodes.filter(n=>n.kind==='alternative').length,2);assert.deepEqual(review.nodes.filter(n=>n.kind==='criterion').map(n=>({title:n.title,key:n.detail.key})),[{title:'Conservar archivos',key:'preserve'},{title:'Recuperar todo',key:'restore'}]);assert.equal(rootNode(review).recordState,'withdrawn');
  const outcome=projectContext(views.find(u=>u.data.kind==='outcome'),snapshot.evidence);assert.equal(outcome.nodes.find(n=>n.kind==='outcome_value').state,'declared_false');
});
test('I01 causal map preserves every competing hypothesis, adverse witness and unresolved mechanism/counterfactual',()=>{
  const g=projection('causal_explanation'),n=rootNode(g);assert.equal(n.state,'causality_not_established');assert.equal(n.detail.evaluation.selectedCause,null);
  assert.equal(g.nodes.filter(n=>n.kind==='hypothesis').length,2);assert.equal(g.nodes.filter(n=>n.kind==='alternative').length,2);
  assert.deepEqual(g.nodes.filter(n=>n.kind==='causal_evidence').map(n=>n.state),['supports','contradicts','contradicts']);assert.equal(g.nodes.filter(n=>n.kind==='mechanism'&&n.state==='unknown').length,2);assert.equal(g.nodes.filter(n=>n.kind==='counterfactual'&&n.state==='unknown').length,2);
  const sources=g.nodes.filter(n=>n.kind==='source');assert.equal(new Set(sources.map(n=>n.id)).size,sources.length);assert.ok(sources.every(n=>n.originalKey));
  const small=publicGraph(g,{maxNodes:2});assert.equal(small.nodes.length,0);assert.equal(small.edges.length,0);assert.equal(small.counts.nodes,g.nodes.length);assert.equal(small.limited,true);
});
test('I01 exact derived history and historical originals preserve versions and source bindings',async()=>{
  for(const [kind,ref] of [['retrospective',f.context.reference],['decision_intelligence',f.reviewRecord.reference],['causal_explanation',f.causal.reference]]){
    const p=pages.find(p=>p.unit.kind===kind&&p.graph.nodes.find(n=>n.id===p.graph.rootId).reference.id===ref.id),input={unitId:p.unit.id,nodeId:p.graph.rootId};
    const history=await call('history',input);assert.deepEqual(history.items.map(x=>x.reference.version),[1,2]);assert.deepEqual(history.items[1].reference,ref);assert.equal(history.items[1].author,'audit-editor');assert.ok(history.items[1].reason);
    const old=await call('version',{...input,version:1}),source=old.sourceBindings[0];assert.ok(source);assert.equal(old.record.version,1);
    const original=await call('original',{...input,version:1,sourceId:source.id});assert.equal(original.original.verified,true);assert.equal(original.original.text,snapshot.evidence.find(e=>e.representationId===source.id&&e.payloadSha256===source.revision).text);
    await assert.rejects(call('version',{...input,version:3}),/VERSION_NOT_AT_CUT/);
  }
});
test('I01 positional cursors bind the new order and reject legacy/unknown order versions before retargeting',async()=>{
  assert.ok(pages[0].nextCursor);const key=readSnapshot(packet.context.snapshot.id).key,body=JSON.parse(Buffer.from(pages[0].nextCursor.split('.')[0],'base64url').toString('utf8'));assert.equal(body.order,EXPLORER_ORDER_VERSION);
  for(const order of [undefined,'future-order']){const c={...body,order},raw=Buffer.from(JSON.stringify(c)).toString('base64url'),cursor=raw+'.'+createHmac('sha256',key).update(raw).digest('hex');await assert.rejects(call('page',{cursor}),/CURSOR_ORDER_CHANGED/);}
  assert.deepEqual(await call('page',{cursor:pages[1].previousCursor}),pages[0]);
  assert.deepEqual(pages.map(p=>p.unit.id),[...snapshot.units].sort(compareContextUnits).map(u=>u.id));
});
test('I01 derived evolution remains pinned after subsequent changes and rejects another source selection',async()=>{
  const p=pages.find(p=>p.unit.kind==='causal_explanation'),input={unitId:p.unit.id,nodeId:p.graph.rootId};
  await causalOperation('put',{conversationIds:f.ids,id:'audit-causal',expectedVersion:2,binding:f.causal.reference,detail:{...f.detail,reason:'Cambio posterior al corte',state:'withdrawn'},requestId:'causal-later'});
  const history=await call('history',input);assert.equal(history.status,'stale_cut');assert.deepEqual(history.items.map(i=>i.reference.version),[1,2]);assert.deepEqual((await call('page',{unitId:p.unit.id})).graph,p.graph);
  await assert.rejects(call('history',{...input,conversationIds:f.ids.slice(0,1)}),/SELECTION_MISMATCH/);
});
test('I01 evolution cursor returns the thirteenth version and remains bound to its node, cut and budget',async()=>{
  const detail={...f.context.record.payload.retrospective.detail,title:'Copia: historia larga sintética'};
  let current=await retrospectiveOperation('put',{conversationIds:f.ids,id:'audit-long-history',detail,requestId:'long-1'});
  for(let i=2;i<=13;i++)current=await retrospectiveOperation('put',{conversationIds:f.ids,id:'audit-long-history',expectedVersion:i-1,binding:current.reference,detail:{...detail,reason:'Revisión '+i},requestId:'long-'+i});
  const fresh=await retrievePackage('copia historia larga',f.ids,{mode:'lexical',maxBytes:200000}),snap=readSnapshot(fresh.context.snapshot.id).snapshot,u=snap.units.find(u=>u.kind==='retrospective'&&u.data.reference.id==='audit-long-history'),g=projectContext(u,snap.evidence);
  const input={id:fresh.context.snapshot.id,conversationIds:f.ids,unitId:u.id,nodeId:g.rootId,op:'history'},first=await explorer(input);assert.equal(first.items.length,12);assert.ok(first.nextCursor);assert.equal(first.totalVersions,13);
  const last=await explorer({...input,cursor:first.nextCursor});assert.deepEqual(last.items.map(i=>i.reference.version),[13]);assert.equal(last.nextCursor,null);
  await assert.rejects(explorer({...input,cursor:first.nextCursor,maxBytes:4096}),/CURSOR_BINDING/);
  const earlier=snap.units.find(x=>x.kind==='retrospective'&&x.data.reference.id==='synthetic-context');
  await assert.rejects(explorer({...input,unitId:earlier.id,nodeId:projectContext(earlier,snap.evidence).rootId,cursor:first.nextCursor}),/CURSOR_BINDING/);
});
test('I01 full restore reopens new maps, exact histories, cursors and originals in a different process',async()=>{
  const {createBackup,restoreBackup}=await import('./recovery.mjs');
  const p=pages.find(p=>p.unit.kind==='causal_explanation'),requests=[{id:packet.context.snapshot.id,conversationIds:f.ids,unitId:p.unit.id},...['history','version'].map(op=>({id:packet.context.snapshot.id,conversationIds:f.ids,unitId:p.unit.id,nodeId:p.graph.rootId,op,version:1})),{id:packet.context.snapshot.id,conversationIds:f.ids,cursor:pages[0].nextCursor},{id:packet.context.snapshot.id,conversationIds:f.ids,unitId:p.unit.id,op:'original',originalKey:p.originals[0].key}];
  const before=await Promise.all(requests.map(explorer)),lab=fs.mkdtempSync(path.join(process.env.AFH_TEST_ROOT||'C:/T','orbita-derived-restore-')),archive=path.join(lab,'archive.orbita'),destination=path.join(lab,'restored');
  await createBackup({source:root,archive,password:'i01-synthetic-test-only',ownSession:true});await restoreBackup({archive,destination,password:'i01-synthetic-test-only'});
  const reader=path.join(lab,'read.mjs');fs.writeFileSync(reader,`import {explorer} from ${JSON.stringify(new URL('./explorer.mjs',import.meta.url).href)}; console.log(JSON.stringify(await Promise.all(${JSON.stringify(requests)}.map(explorer))));`);
  const result=spawnSync(process.execPath,[reader],{env:{...process.env,AFH_COSMOS_DATA:destination},encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),before);
});

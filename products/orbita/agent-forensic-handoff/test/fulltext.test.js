import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {splitFullText} from '../src/fulltext-chunks.js';import {buildMemoryPackage,wireBytes} from '../src/memory-package.js';
import {auditSession,buildSemanticIndex,verifySemanticProjection,semanticSearch} from '../src/index.js';
import {DatabaseSync} from '../src/sqlite-compat.js';
import {readUnifiedEvidence} from '../src/identity-evidence.js';
test('full-text segmentation covers long Unicode input without truncation, gaps or broken surrogate pairs',()=>{
 const text=('😀漢字 é\r\n '.repeat(17000))+'TAIL_NEEDLE';const points=[...text];
 const chunks=splitFullText(text,{countTokens:s=>[...s].length+2,maxTokens:384});let covered=0;
 for(const c of chunks){assert.ok(c.start<=covered);assert.equal(c.text,points.slice(c.start,c.end).join(''));assert.ok(c.tokens<=384);covered=Math.max(covered,c.end);assert.ok(!/[\uD800-\uDBFF]$/.test(c.text));}
 assert.equal(covered,points.length);assert.ok(chunks.at(-1).text.endsWith('TAIL_NEEDLE'));
 assert.throws(()=>splitFullText('x',{}),/COUNTER/);assert.throws(()=>splitFullText('x',{countTokens:()=>NaN}),/TOKEN/);
});
test('cost-aware admission recovers small answer episodes at fixed bytes without breaking shared dependencies',()=>{
 const records=[{key:'large',text:'a'.repeat(88000)},{key:'context',text:'context'.repeat(200)},{key:'answer',text:'requested conclusion'.repeat(1500)},{key:'other',text:'other answer'.repeat(700)}];
 const args={query:'question',plan:{},records,seeds:['large','answer','other'],links:{answer:['context'],other:['context']},maxBytes:100000};
 const old=buildMemoryPackage(args);assert.ok(!old.evidence.some(e=>e.key==='answer'));
 const next=buildMemoryPackage({...args,selectionPolicy:'marginal_utility'});assert.ok(next.evidence.some(e=>e.key==='answer'));assert.ok(next.evidence.some(e=>e.key==='other'));
 assert.equal(next.evidence.filter(e=>e.key==='context').length,1);assert.ok(next.bytes<=100000);assert.equal(wireBytes(next),next.bytes);
 for(const ep of next.episodes)assert.ok(ep.members.every(k=>next.evidence.some(e=>e.key===k)));
});
test('full-text projection finds tail evidence, indexes FTS and rejects altered coordinates',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'afh-fulltext-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const input=path.join(root,'source.jsonl');fs.writeFileSync(input,JSON.stringify({role:'assistant',session_id:'fulltext',content:'neutral '.repeat(2500)+'ZXQ_TAIL_NEEDLE 😀'})+'\n');
 const audit=await auditSession(input,{caseDir:path.join(root,'case'),harness:'generic',includeChildren:false});
 const provider={identity:{provider:'fixture-local',runtime:'test',runtimeVersion:'1',modelId:'fixture/tail',revision:'v1',modelDigest:'a'.repeat(64),dimensions:2,dtype:'f32',pooling:'fixture',normalization:'l2-v1',license:'test-only',snapshotPath:null},maxInputTokens:384,countTokens:s=>[...s].length+2,embed:async texts=>texts.map(s=>s.includes('ZXQ_TAIL_NEEDLE')?[1,0]:[0,1])};
 const built=await buildSemanticIndex(audit.caseDir,{provider,representation:'full_source_text'});assert.ok(built.metrics.fullText.sourceCodepoints>17000);assert.equal(built.metrics.fullText.truncatedChunks,0);
 const found=await semanticSearch(audit.caseDir,'ZXQ_TAIL_NEEDLE',{provider,projectionDir:built.projectionDir,minSimilarity:.9});assert.ok(found.results[0].semanticRange.start>15000);assert.match(found.results[0].semanticText,/ZXQ_TAIL_NEEDLE/);
 assert.equal((await verifySemanticProjection(audit.caseDir,built.projectionDir)).passed,true);
 const db=new DatabaseSync(path.join(built.projectionDir,'semantic.sqlite'));assert.ok(db.prepare("SELECT COUNT(*) n FROM semantic_fts WHERE semantic_fts MATCH 'ZXQ_TAIL_NEEDLE'").get().n>0);db.exec('UPDATE semantic_chunk SET start_cp=start_cp+1');db.close();
 const bad=await verifySemanticProjection(audit.caseDir,built.projectionDir);assert.equal(bad.passed,false);assert.ok(bad.findings.some(f=>f.check==='semantic.fulltext_ranges'&&!f.ok));
 const opened=await readUnifiedEvidence(audit.caseDir,found.results[0].semanticRange.representationId);assert.equal(opened.verified,true);assert.match(opened.quote,/ZXQ_TAIL_NEEDLE/);
});
test('episode diversity prevents one user turn from crowding out another relevant answer',()=>{
 const records=Array.from({length:12},(_,i)=>({key:'a'+i,text:'a'.repeat(4500)}));records.push({key:'b',text:'different relevant answer '.repeat(240)});
 const seeds=records.map(r=>r.key),utilities=Object.fromEntries(seeds.map(k=>[k,1])),groups=Object.fromEntries(seeds.map(k=>[k,k==='b'?'turn-b':'turn-a']));
 const pkg=buildMemoryPackage({query:'two relevant topics',plan:{},records,seeds,utilities,groups,maxBytes:16000,selectionPolicy:'marginal_utility'});
 assert.ok(pkg.evidence.some(e=>e.key==='b'));assert.ok(pkg.evidence.some(e=>e.key.startsWith('a')));assert.ok(pkg.bytes<=16000);
});

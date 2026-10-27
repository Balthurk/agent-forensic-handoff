import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=fs.mkdtempSync('C:/T/afh-capture-test-');process.env.AFH_COSMOS_DATA=path.join(root,'data');process.env.AFH_COSMOS_EMPTY_LIBRARY='1';
const {registerCapture,captureOnce,captureStatus}=await import('./capture.mjs');const {library,loadCase}=await import('./corpus.mjs');const {retrievePackage}=await import('./memory.mjs');
const line=(text,id='message-1')=>JSON.stringify({timestamp:'2026-10-22T10:00:00Z',type:'response_item',payload:{type:'message',id,role:'user',content:[{type:'input_text',text}]}})+'\n';
const header=JSON.stringify({timestamp:'2026-10-22T10:00:00Z',type:'session_meta',payload:{id:'01a154a3-e7d9-7990-9ebb-ac32839ca890',cwd:'C:/fixture'}})+'\n';
function child(req,crash){const p=spawnSync(process.execPath,[fileURLToPath(new URL('./capture-cli.mjs',import.meta.url))],{input:JSON.stringify(req),encoding:'utf8',env:{...process.env,AFH_CRASH_AT:crash||''},windowsHide:true});return {status:p.status,...(p.stdout?JSON.parse(p.stdout):{}),stderr:p.stderr};}
test('capture survives fresh-process crashes, append and UTF-8 boundaries, query uses original',async()=>{
 const source=path.join(root,'live.jsonl'),first=Buffer.from(header+line('Sólo inspeccionar. No borrar todavía.'));fs.writeFileSync(source,first);const job=registerCapture(source,[source]);
 const crashed=child({op:'capture',id:job.id,allowPaths:[source],options:{leaseMs:1}},'capture-after-fsync');assert.equal(crashed.status,86);
 await new Promise(r=>setTimeout(r,10));const one=await captureOnce(job.id,[source]);assert.equal(one.offset,first.length);assert.ok(one.caseId);
 const added=Buffer.from(line('La condición válida continúa: pingüino azul.','message-2'));fs.appendFileSync(source,added);const split=added.indexOf(Buffer.from('ü'))+1;
 const tail=await captureOnce(job.id,[source],{maxBytes:split});assert.equal(tail.caseId,one.caseId);assert.ok(tail.partialTail>0);
 const crash2=child({op:'capture',id:job.id,allowPaths:[source],options:{leaseMs:5000}},'capture-after-import');assert.equal(crash2.status,86,JSON.stringify(crash2));await new Promise(r=>setTimeout(r,5050));
 const two=child({op:'capture',id:job.id,allowPaths:[source]});assert.equal(two.ok,true,two.error);assert.notEqual(two.result.caseId,one.caseId);
 const repeat=await captureOnce(job.id,[source]);assert.equal(repeat.caseId,two.result.caseId);assert.equal(library.filter(i=>i.captureJob===job.id).length,2);assert.equal(library.filter(i=>i.captureJob===job.id&&i.currentRevision).length,1);
 const pkg=await retrievePackage('pingüino azul',[repeat.caseId],{mode:'lexical'});assert.ok(pkg.evidence.some(e=>e.text.includes('pingüino azul')));assert.deepEqual(fs.readFileSync(source),Buffer.concat([first,added]));
 assert.ok(captureStatus().events.some(e=>e.status==='recovered_uncommitted_bytes'));await assert.rejects(captureOnce(job.id,[]),/NOT_AUTHORIZED/);
 fs.writeFileSync(source,Buffer.from('X'+fs.readFileSync(source).subarray(1).toString()));await assert.rejects(captureOnce(job.id,[source]),/REWRITTEN/);fs.truncateSync(source,1);await assert.rejects(captureOnce(job.id,[source],{retry:true}),/TRUNCATED/);assert.equal(captureStatus().events.filter(e=>e.status==='failed').length,2);
});
test('malformed completed line is retained failure; incomplete tail is never parsed',async()=>{const source=path.join(root,'bad.jsonl');fs.writeFileSync(source,header+'{"x":');const j=registerCapture(source,[source]);const a=await captureOnce(j.id,[source]);assert.equal(a.partialTail,5);fs.appendFileSync(source,'!}\n');await assert.rejects(captureOnce(j.id,[source]),SyntaxError);assert.equal(captureStatus().jobs.find(x=>x.id===j.id).status,'failed');});

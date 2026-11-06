import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=fs.mkdtempSync('C:/T/orbita-documents-http-');
let child,url;
async function request(route,body){const response=await fetch(url+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return {status:response.status,value:await response.json()};}
async function finished(id){for(let i=0;i<400;i++){const value=(await request('/api/jobs/'+id)).value;if(value.status!=='running')return value;await new Promise(r=>setTimeout(r,25));}throw new Error('HTTP_JOB_TIMEOUT');}
test.before(async()=>{const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));url='http://127.0.0.1:'+port;child=spawn(process.execPath,[path.join(here,'server.mjs')],{env:{...process.env,AFH_COSMOS_DATA:root,AFH_COSMOS_PORT:String(port),AFH_COSMOS_EMPTY_LIBRARY:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',b=>err+=b);await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error(err||'START_TIMEOUT')),15000);child.stdout.once('data',()=>{clearTimeout(t);resolve();});child.once('exit',()=>{clearTimeout(t);reject(new Error(err));});});});
test.after(async()=>{if(child?.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}});
test('document HTTP roundtrip preserves binary bytes, source role, revision status and verified download; plans require bounded explicit model work',async()=>{
 const denied=await fetch(url+'/api/documents',{method:'POST',headers:{origin:'https://elsewhere.invalid','content-type':'application/json'},body:'{}'});assert.equal(denied.status,403);
 const bytes=Buffer.from('\ufeffNorma: no publicar sin firma.\r\nSólo durante 2026.\r\n'),input={documentId:'http-policy',filename:'norma.md',contentBase64:bytes.toString('base64')};
 let imported=await request('/api/documents',input);assert.equal(imported.status,200,JSON.stringify(imported));const first=imported.value.result;
 const raw=await fetch(url+'/api/documents/original?id='+first.id);assert.equal(raw.status,200);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),bytes);assert.equal(raw.headers.get('x-content-sha256'),createHash('sha256').update(bytes).digest('hex'));
 const result=(await request('/api/retrieve',{question:'no publicar firma',conversationIds:[first.id],retrieval:{mode:'lexical'}})).value;assert.equal(result.evidence[0].role,'document');
 const evidence=(await request('/api/evidence?conversation='+first.id+'&event='+encodeURIComponent(result.evidence[0].id))).value;assert.equal(evidence.document.currentRevision,true);assert.equal(evidence.text,bytes.toString());
 imported=await request('/api/documents',{...input,contentBase64:Buffer.from('Revocación de la norma anterior.').toString('base64'),expectedRevision:1});assert.equal(imported.status,200);assert.equal(imported.value.library.find(i=>i.id===first.id).currentRevision,false);
 const job=await request('/api/corpus-plan',{op:'plan'});assert.equal(job.status,202);const prepared=await finished(job.value.id);assert.equal(prepared.status,'complete');assert.equal(prepared.result.inventory.excludedHistoricalCases,1);assert.equal(prepared.result.totalTargets,1);
 for(const body of [{enableProposals:false,maxTargets:1},{enableProposals:true,maxTargets:9}]){const start=await request('/api/corpus-plan',{op:'run',id:prepared.result.id,...body});const rejected=await finished(start.value.id);assert.equal(rejected.status,'error');assert.match(rejected.error,/CORPUS_(PROPOSALS|TARGET_BUDGET)/);}
 assert.equal(fs.existsSync(path.join(root,'inference')),false);
 const boot=(await request('/api/bootstrap')).value;assert.equal(boot.build,'v8-recovery-agent-1');assert.equal(boot.currentBuild,'v8-documents-coverage-1');
 fs.appendFileSync(path.join(root,'cases',first.id,'acquisition/document/original.bin'),'tampered');const broken=await request('/api/documents/original?id='+first.id);assert.equal(broken.status,400);assert.match(broken.value.error,/Integridad/);
});
test('concurrent HTTP writers cannot silently replace the same document revision',async()=>{
 const outcomes=await Promise.all(['Primera condición','Segunda condición'].map(content=>request('/api/documents',{documentId:'concurrent-policy',filename:'race.txt',content})));
 assert.equal(outcomes.filter(r=>r.status===200).length,1,JSON.stringify(outcomes));assert.equal(outcomes.filter(r=>r.status===400).length,1);assert.match(outcomes.find(r=>r.status===400).value.error,/DOCUMENT_(WRITER_BUSY|REVISION_CONFLICT)/);
 const catalog=(await request('/api/documents')).value;assert.equal(catalog.versions.filter(r=>r.document_id==='concurrent-policy').length,1);assert.equal(catalog.documents.find(r=>r.id==='concurrent-policy').revision,1);
});

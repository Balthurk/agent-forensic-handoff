import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
const root=fs.mkdtempSync('C:/T/orbita-documents-test-');process.env.AFH_COSMOS_DATA=root;
const {importDocument,reconcileDocuments}=await import('./documents.mjs');const {getLibrary,getEvidence,library,loadCase}=await import('./corpus.mjs');const {verifiedSources}=await import('./knowledge.mjs');const {retrievePackage,closeMemory}=await import('./memory.mjs');
const {verifyCaseIntegrity}=await import('../agent-forensic-handoff/src/integrity.js');const {documentBlocks}=await import('../agent-forensic-handoff/src/document-evidence.js');
test('text formats preserve exact Unicode, CRLF, BOM and original ranges with document authorship',async()=>{
 for(const ext of ['txt','md','markdown','rst','json','jsonl','ndjson','yaml','yml','csv']){
  const text='\ufeffÁmbito α: no autoriza borrado.\r\nSolo si QA supera la revisión 🛰️.\r\n',bytes=Buffer.from(text);
  const item=await importDocument({documentId:'format-'+ext,filename:'source.'+ext,contentBase64:bytes.toString('base64')});assert.equal(item.document.format,'.'+ext);
  const original=fs.readFileSync(path.join(root,'cases',item.id,'acquisition/document/original.bin'));assert.deepEqual(original,bytes);
  const context=await verifiedSources([item.id]);assert.equal(context.sources.length,1);assert.equal(context.sources[0].role,'document');assert.equal(context.sources[0].text,text);
  const raw=await getEvidence(item.id,context.sources[0].eventId);assert.equal(raw.document.originalRange.start,0);assert.equal(raw.document.originalRange.end,bytes.length);assert.equal(raw.document.metadata.sourceDate,null);
  assert.equal((await verifyCaseIntegrity(path.join(root,'cases',item.id))).passed,true);
  const packet=await retrievePackage('no autoriza borrado',[item.id],{mode:'lexical',semanticKnowledge:false});assert.equal(packet.evidence[0].role,'document');assert.equal(packet.sources[0].document.sha256,item.document.sha256);
 }
});
test('document revisions require CAS, retain originals and idempotently reimport without adding corroboration',async()=>{
 const a=await importDocument({documentId:'policy',filename:'policy.txt',content:'Norma antigua: se permite publicar.',metadata:{title:'Política',sourceDate:'2026-01-01T00:00:00Z'}});
 const duplicate=await importDocument({documentId:'policy',filename:'renamed.txt',content:'Norma antigua: se permite publicar.'});assert.equal(duplicate.id,a.id);assert.equal(duplicate.duplicate,true);
 await assert.rejects(importDocument({documentId:'policy',filename:'policy.txt',content:'Revocación: no se permite publicar.'}),/REVISION_CONFLICT/);
 const b=await importDocument({documentId:'policy',expectedRevision:1,filename:'policy.txt',content:'Revocación: no se permite publicar.',metadata:{title:'Política',sourceDate:'2026-10-23T00:00:00Z'}});
 assert.notEqual(a.id,b.id);assert.equal(b.document.revision,2);reconcileDocuments();const all=await getLibrary();assert.equal(all.find(i=>i.id===a.id).currentRevision,false);assert.equal(all.find(i=>i.id===b.id).currentRevision,true);
 assert.ok((await loadCase(library.find(i=>i.id===a.id))).messages[0].text.includes('antigua'));
});
test('invalid bytes, binary data, formats and fabricated dates never silently become valid text evidence',async()=>{
 for(const sourceDate of ['2026-02-30T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:00-00:00'])await assert.rejects(importDocument({filename:'bad-date.txt',content:'X',metadata:{sourceDate}}),/DOCUMENT_TIME/);
 for(const input of [{filename:'x.txt',contentBase64:Buffer.from([0xc3,0x28]).toString('base64')},{filename:'x.txt',content:'a\u0000b'},{filename:'x.pdf',content:'%PDF'},{filename:'../x.txt',content:'x'},{filename:'x.txt',content:'x',metadata:{sourceDate:'ayer'}}])await assert.rejects(importDocument(input),/DOCUMENT_/);
 const malformed=await importDocument({filename:'invalid.json',content:'{"open":'});assert.equal(malformed.document.syntax,'invalid_json_preserved_as_text');
 const empty=await importDocument({filename:'empty.txt',content:''});assert.equal(empty.document.blocks,0);assert.equal((await verifyCaseIntegrity(path.join(root,'cases',empty.id))).passed,true);
});
test('block partition is lossless and bounded; changed prefixes cannot reuse old native chunk identities',()=>{
 const bytes=Buffer.from(('á🛰️ condición completa\r\n').repeat(5000)),chunks=documentBlocks(bytes,'partition');assert.ok(chunks.length>1);assert.deepEqual(Buffer.concat(chunks.map(c=>Buffer.from(c.text))),bytes);
 for(const c of chunks)assert.ok(c.end-c.start<=24576);
 const changed=documentBlocks(Buffer.concat([Buffer.from('NUEVO\n'),bytes]),'partition');assert.notEqual(changed[0].id,chunks[0].id);
});
test('tampered raw document fails core integrity and retrieval, including after manifest removal',async()=>{
 const item=await importDocument({filename:'tamper.txt',content:'Condición vinculante de prueba.'}),dir=path.join(root,'cases',item.id),original=path.join(dir,'acquisition/document/original.bin');fs.appendFileSync(original,'alterado');
 assert.equal((await verifyCaseIntegrity(dir)).passed,false);await assert.rejects(loadCase(library.find(x=>x.id===item.id)),/Integridad/);
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'case.json')));delete manifest.documentEvidence;fs.writeFileSync(path.join(dir,'case.json'),JSON.stringify(manifest));assert.equal((await verifyCaseIntegrity(dir)).passed,false);
});
test.after(async()=>{await closeMemory();});

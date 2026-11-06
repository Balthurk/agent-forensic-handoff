import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import native from 'node:fs';
import {execFileSync} from 'node:child_process';
import fs from '../src/common-files.js';
import {closeCommonStore} from '../src/common-store.js';
import {auditSession} from '../src/audit.js';
import {verifyCaseIntegrity} from '../src/integrity.js';
import {attachDocumentEvidence,documentBlocks,documentHash} from '../src/document-evidence.js';

const root=path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,'common-input');fs.mkdirSync(root,{recursive:true});
test.after(()=>{closeCommonStore();assert.equal(native.existsSync(root),false);});

test('native and explicitly common input preserve the same identity and exact malformed CRLF bytes',async()=>{
  const bytes=Buffer.from('not json\r\n'+JSON.stringify({role:'assistant',session_id:'literal',content:'Exact café 😀'})+'\r\n');
  const nativeRoot=path.join(path.dirname(process.env.ORBITA_POSTGRES_TEST_ROOT),'inputs','common-comparison');native.mkdirSync(nativeRoot,{recursive:true});
  const source=path.join(root,'literal.jsonl'),external=path.join(nativeRoot,'literal.jsonl');fs.writeFileSync(source,bytes);native.writeFileSync(external,bytes);
  const options={harness:'auto',includeChildren:false,verificationLevel:'V0'};
  const common=await auditSession(source,{...options,inputStorage:'postgresql-common',caseDir:path.join(root,'common-case')});
  const original=await auditSession(external,{...options,caseDir:path.join(root,'native-case')});
  assert.equal(common.caseHash,original.caseHash);assert.equal(common.manifest.sources[0].inputStorage,'postgresql-common');
  const archived=JSON.parse(fs.readFileSync(path.join(common.caseDir,'acquisition/native.json'),'utf8'));
  assert.deepEqual(fs.readFileSync(path.join(common.caseDir,archived.entries[0].path)),bytes);
  fs.unlinkSync(source);
  const child=`import {verifyCaseIntegrity} from ${JSON.stringify(new URL('../src/integrity.js',import.meta.url).href)};import {closeCommonStore} from ${JSON.stringify(new URL('../src/common-store.js',import.meta.url).href)};const result=await verifyCaseIntegrity(process.argv[1]);process.stdout.write(JSON.stringify({passed:result.passed,caseHash:result.caseHash}));closeCommonStore();`;
  const fresh=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',child,common.caseDir],{encoding:'utf8',timeout:30000,windowsHide:true}));
  assert.equal(fresh.passed,true);assert.equal(fresh.caseHash,common.caseHash);assert.deepEqual(native.readFileSync(external),bytes);
});

test('input storage never guesses another backend or falls back for an unbound root',async()=>{
  const source=path.join(root,'strict.jsonl');fs.writeFileSync(source,'{"role":"assistant","content":"strict"}\n');
  await assert.rejects(auditSession(source,{inputStorage:'unknown',caseDir:path.join(root,'invalid')}),{code:'ORBITA_INPUT_STORAGE_REQUIRED'});
  await assert.rejects(auditSession(source,{harness:'generic',caseDir:path.join(root,'native-fallback'),includeChildren:false}),/Unable to resolve session/);
  const outside=path.join(path.dirname(process.env.ORBITA_POSTGRES_TEST_ROOT),'unbound.jsonl');
  await assert.rejects(auditSession(outside,{inputStorage:'postgresql-common',caseDir:path.join(root,'unbound')}),{code:'ORBITA_PG_PATH_NOT_BOUND'});
  assert.equal(native.existsSync(source),false);
});

test('document acquisition keeps original UTF8 blocks in the common database and detects tampering',async()=>{
  const bytes=Buffer.from('café 漢字 😀 é\r\n'.repeat(3500)),id='document-common';
  const header={documentId:id,revision:1,filename:'literal.txt',sha256:documentHash(bytes),bytes:bytes.length,metadata:{title:'Literal'},metadataAuthority:'local_declaration_not_authenticated',format:'.txt',syntax:'verbatim_text'};
  const blocks=documentBlocks(bytes,id),records=[{type:'afh.document.header',session_id:id,document:header},...blocks.map(b=>({type:'afh.document.block',session_id:id,id:b.id,start:b.start,end:b.end,text:b.text}))];
  const source=path.join(root,'document.jsonl'),caseDir=path.join(root,'document-case');fs.writeFileSync(source,records.map(JSON.stringify).join('\n')+'\n');
  await auditSession(source,{caseDir,harness:'document',inputStorage:'postgresql-common',includeChildren:false});attachDocumentEvidence(caseDir,{bytes,header,blocks});
  const check=await verifyCaseIntegrity(caseDir);assert.equal(check.passed,true,JSON.stringify(check.findings.filter(f=>!f.ok)));
  const original=path.join(caseDir,'acquisition/document/original.bin');assert.deepEqual(fs.readFileSync(original),bytes);
  assert.ok(blocks.length>1);assert.equal(blocks.at(-1).end,bytes.length);fs.appendFileSync(original,'tamper');
  const failed=await verifyCaseIntegrity(caseDir);assert.equal(failed.passed,false);assert.equal(failed.findings.find(f=>f.check==='document.original_binding').ok,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {auditSession} from '../src/audit.js';
import {verifyCaseIntegrity} from '../src/integrity.js';
import {readUnifiedEvidence} from '../src/identity-evidence.js';
import {CaseDatabase} from '../src/database.js';
import {DatabaseSync,closeCommonStore} from '../src/common-store.js';
import fs from '../src/common-files.js';
const root=process.env.ORBITA_POSTGRES_TEST_ROOT;
const fixture=fileURLToPath(new URL('fixtures/codex/basic.jsonl',import.meta.url));
test.after(()=>{assert.equal(native.existsSync(root),false);closeCommonStore();});

test('complete case remains original-bound in a fresh reader and cloned common store',async()=>{
  const caseDir=path.join(root,'pipeline','case');
  const built=await auditSession(fixture,{harness:'codex',caseDir,includeChildren:false,verificationLevel:'V0'});
  const result=await verifyCaseIntegrity(caseDir);assert.equal(result.passed,true,JSON.stringify(result.findings.filter(x=>!x.ok)));
  assert.equal(built.manifest.storage.engine,'postgresql-common');
  const identity=JSON.parse(fs.readFileSync(path.join(caseDir,'identity.json'),'utf8'));
  const row=identity.representations.find(r=>r.text.length>0);
  const exact=await readUnifiedEvidence(caseDir,row.representation_id);assert.equal(exact.quote,row.text);assert.equal(exact.verified,true);
  const clone=path.join(root,'pipeline','copy');fs.cloneTreeSync(caseDir,clone);
  assert.equal((await verifyCaseIntegrity(clone)).passed,true);
  const child=`import {verifyCaseIntegrity} from ${JSON.stringify(new URL('../src/integrity.js',import.meta.url).href)};import {closeCommonStore} from ${JSON.stringify(new URL('../src/common-store.js',import.meta.url).href)};const r=await verifyCaseIntegrity(process.argv[1]);console.log(JSON.stringify({passed:r.passed,caseHash:r.caseHash,checks:r.findings.length}));closeCommonStore();`;
  const fresh=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',child,clone],{encoding:'utf8',timeout:30000,windowsHide:true}));
  assert.equal(fresh.passed,true);assert.equal(fresh.caseHash,built.caseHash);assert.ok(fresh.checks>=10);
  fs.rmSync(clone,{recursive:true});assert.equal(fs.existsSync(clone),false);assert.equal((await verifyCaseIntegrity(caseDir)).passed,true);
});

test('altered case row is detected by its stored typed manifest',async()=>{
  const caseDir=path.join(root,'pipeline','tamper');
  await auditSession(fixture,{harness:'codex',caseDir,includeChildren:false,verificationLevel:'V0'});
  const db=new CaseDatabase(path.join(caseDir,'case.pgstore'));
  try{db.run("UPDATE event SET input_preview='altered' WHERE id=(SELECT id FROM event ORDER BY id LIMIT 1)");}finally{db.close();}
  const result=await verifyCaseIntegrity(caseDir);assert.equal(result.passed,false);
  assert.equal(result.findings.find(x=>x.check==='postgresql.rows_integrity').ok,false);
});

test('every retained integrity metric is compared against fresh actual rows',async()=>{
  const caseDir=path.join(root,'pipeline','all-metrics');
  await auditSession(fixture,{harness:'codex',caseDir,includeChildren:false,verificationLevel:'V0'});
  const file=path.join(caseDir,'case.json'),original=fs.readFileSync(file),manifest=JSON.parse(original);
  const keys=['sources','sourceRecords','parsedRecords','unparsedRecords','events','tools','artifacts','decisions','tasks','validations','warnings','entities','temporalFacts','vigenteFacts','staleFacts','graphEdges'];
  assert.equal((await verifyCaseIntegrity(caseDir)).passed,true);
  for(const key of keys){
    assert.equal(typeof manifest.metrics[key],'number');
    const changed=structuredClone(manifest);changed.metrics[key]++;
    fs.writeFileSync(file,JSON.stringify(changed));
    const result=await verifyCaseIntegrity(caseDir);
    assert.equal(result.passed,false,key);const metric=result.findings.find(row=>row.check==='manifest.metrics');
    assert.equal(metric.ok,false,key);assert.ok(metric.detail.includes(key+':'),metric.detail);
    assert.equal(result.findings.find(row=>row.check==='postgresql.rows_integrity').ok,true);
  }
  fs.writeFileSync(file,original);assert.equal((await verifyCaseIntegrity(caseDir)).passed,true);
});

test('Node vector search, exact clone and busy tree purge use the common protocol',()=>{
  const dir=path.join(root,'pipeline','vectors'),db=new DatabaseSync(path.join(dir,'vector.pgstore'),{family:'vector',create:true});
  const value=Buffer.alloc(8);value.writeFloatLE(1,0);
  // Compute from literal bytes instead of a model or approximate conversion.
  try{
    const digest=createHash('sha256').update(value).digest('hex');
    for(const rowid of [5,2]){db.prepare('INSERT INTO semantic_embedding VALUES(?,?,?,?,?,?)').run(rowid,String(rowid),value,digest,2,'now');db.prepare('INSERT INTO vector_index VALUES(?,?)').run(rowid,value);}
    assert.deepEqual(db.nearestVectors(value,2),[{rowid:2,distance:0},{rowid:5,distance:0}]);
    const before=db.logicalManifest(),copy=dir+'-copy';fs.cloneTreeSync(dir,copy);
    const fresh=new DatabaseSync(path.join(copy,'vector.pgstore'),{family:'vector',readOnly:true});
    try{assert.deepEqual(fresh.logicalManifest(),before);assert.throws(()=>fs.rmSync(copy,{recursive:true}),{code:'55006'});}finally{fresh.close();db.close();}
    fs.rmSync(copy,{recursive:true});assert.equal(fs.existsSync(copy),false);
  }finally{db.close();}
});

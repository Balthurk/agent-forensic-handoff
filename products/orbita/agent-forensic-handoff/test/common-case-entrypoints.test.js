import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {auditSession} from '../src/audit.js';
import {CaseDatabase} from '../src/database.js';
import {appendGovernedTemporalFact} from '../src/bitemporal-graph.js';
import {verifyCaseIntegrity} from '../src/integrity.js';
import {rehydrateCase} from '../src/case-publication.js';
import {benchmarkLocations} from '../src/common-benchmark.js';
import {DatabaseSync,commonStoreIdentity,commonWorkerConfiguration,observeCommonWorker,closeCommonStore} from '../src/common-store.js';
import fs from '../src/common-files.js';

const root=process.env.ORBITA_POSTGRES_TEST_ROOT,receipt=process.env.ORBITA_POSTGRES_TEST_RECEIPTS;
const fixture=fileURLToPath(new URL('fixtures/codex/basic.jsonl',import.meta.url));
const bin=fileURLToPath(new URL('../bin/afh.js',import.meta.url));
const moduleURL=name=>new URL('../src/'+name,import.meta.url).href;
const nativeRoot=path.join(receipt,'native-entrypoints');native.mkdirSync(nativeRoot,{recursive:true});
test.after(()=>{assert.equal(native.existsSync(root),false);closeCommonStore();});
function envFor(owner,configuration=commonWorkerConfiguration(root)){
  const env={};
  for(const key of ['PATH','Path','SYSTEMROOT','SystemRoot','WINDIR','COMSPEC','TEMP','TMP'])if(process.env[key]!=null)env[key]=process.env[key];
  return {...env,ORBITA_POSTGRES_BINDING:JSON.stringify(configuration),ORBITA_POSTGRES_OWNER_ID:owner,
    ORBITA_POSTGRES_PYTHON:process.env.ORBITA_POSTGRES_PYTHON,AFH_PYTHON:process.env.AFH_PYTHON,
    AFH_MODEL_HOME:process.env.AFH_MODEL_HOME,AFH_COSMOS_DATA:root,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'};
}
function assertDrained(owner){
  const closeDeadline=Date.now()+3000;let backends;
  do{backends=observeCommonWorker(owner).backends;if(backends&&Date.now()<closeDeadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}while(backends&&Date.now()<closeDeadline);
  assert.equal(backends,0);
}
function run(args,{configuration,missing=false,expected=0}={}){
  const owner=randomUUID(),env=envFor(owner,configuration);
  if(missing)delete env.ORBITA_POSTGRES_BINDING;
  const result=spawnSync(process.execPath,args,{env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});
  assert.equal(result.status,expected,result.error?.message||result.stderr||result.stdout);
  assertDrained(owner);return result;
}
async function make(name){
  const dir=path.join(root,'entrypoints',name);
  await auditSession(fixture,{harness:'codex',caseDir:dir,includeChildren:false,verificationLevel:'V0'});return dir;
}
function eventFor(dir){
  const db=new CaseDatabase(path.join(dir,'case.pgstore'),{readOnly:true});
  try{return db.get("SELECT id FROM event WHERE kind='message.user' ORDER BY record_ordinal LIMIT 1").id;}
  finally{db.close();}
}

test('fresh CLI consumers audit, options, query, hydrate and export exact common evidence',()=>{
  const dir=path.join(root,'entrypoints','cli');
  const audited=run([bin,'audit',fixture,'--case-dir',dir,'--children','false','--harness','codex','--json']);
  assert.equal(JSON.parse(audited.stdout).manifest.storage.engine,'postgresql-common');
  const query=JSON.parse(run([bin,'query',dir,'parser','--mode','lexical','--json']).stdout);assert.ok(query.results.length>0);
  assert.ok(Array.isArray(JSON.parse(run([bin,'options',dir,'--json']).stdout)));
  for(const budget of [500,1700]){
    const hot=run([bin,'hydrate',dir,'--budget',String(budget)]).stdout;assert.ok(hot.length>0);
    const verification=JSON.parse(run([bin,'verify-case',dir,'--json']).stdout);assert.equal(verification.passed,true);
  }
  const db=new CaseDatabase(path.join(dir,'case.pgstore'),{readOnly:true});let uri;
  try{uri=db.get('SELECT uri FROM evidence_ref ORDER BY id LIMIT 1').uri;}finally{db.close();}
  const evidence=JSON.parse(run([bin,'evidence',dir,uri,'--json']).stdout);assert.ok(evidence.text.length>0);
  const identity=JSON.parse(fs.readFileSync(path.join(dir,'identity.json'),'utf8'));
  const item=identity.representations.find(row=>row.text.length>0);
  const opened=JSON.parse(run([bin,'evidence-open',dir,item.representation_id]).stdout);assert.equal(opened.quote,item.text);assert.equal(opened.verified,true);
  const exported=path.join(nativeRoot,'packet.json');run([bin,'export-n01',dir,'--output',exported]);
  assert.ok(JSON.parse(native.readFileSync(exported,'utf8')));assert.equal(native.existsSync(dir),false);
});

test('doctor checks the actual service and fails JSON mode on missing or rejected credentials',()=>{
  const success=JSON.parse(run([bin,'doctor','--json']).stdout),health=success.find(row=>row.name==='PostgreSQL common store');
  assert.equal(health.ok,true);assert.equal(health.required,true);assert.equal(health.detail.privileged,false);
  assert.equal(health.detail.readOnly,true);assert.equal(health.detail.database,'orbita');
  assert.equal(health.detail.settings.fsync,'on');assert.ok(health.detail.families.case>0);
  const missing=JSON.parse(run([bin,'doctor','--json'],{missing:true,expected:1}).stdout);
  assert.equal(missing.find(row=>row.name==='PostgreSQL common store').ok,false);
  const configuration=commonWorkerConfiguration(root),invalid='invalid-'+randomUUID();configuration.password=invalid;
  const rejected=run([bin,'doctor','--json'],{configuration,expected:1});
  assert.equal(JSON.parse(rejected.stdout).find(row=>row.name==='PostgreSQL common store').ok,false);
  assert.equal((rejected.stdout+rejected.stderr).includes(invalid),false);
});

test('full typed seal rejects non-temporal tampering even when a valid journal chain exists',async()=>{
  const dir=await make('seal-tamper'),event=eventFor(dir),file=path.join(dir,'case.json'),old=fs.readFileSync(file);
  const input={sourceEventId:event,subjectId:'setting',predicate:'VALUE',factText:'first'};
  appendGovernedTemporalFact(dir,input);assert.equal((await verifyCaseIntegrity(dir)).passed,true);
  const db=new CaseDatabase(path.join(dir,'case.pgstore'),{create:false});
  try{db.run('UPDATE hydration_pack SET token_estimate=token_estimate+1');}finally{db.close();}
  fs.writeFileSync(file,old);
  assert.throws(()=>appendGovernedTemporalFact(dir,input),/CASE_INTEGRITY_FAILED/);
  assert.ok(fs.readFileSync(file).equals(old));assert.equal((await verifyCaseIntegrity(dir)).passed,false);
});

test('invalid rehydration leaves manifest, rows and published context unchanged',async()=>{
  const dir=await make('rehydrate-invalid'),file=path.join(dir,'case.json'),hot=path.join(dir,'hot-context.md');
  const before=fs.readFileSync(file),context=fs.readFileSync(hot);
  await assert.rejects(rehydrateCase(dir,{tokenBudget:1000001}),/tokenBudget must be/);
  assert.ok(fs.readFileSync(file).equals(before));assert.ok(fs.readFileSync(hot).equals(context));
  assert.equal((await verifyCaseIntegrity(dir)).passed,true);
});

test('real process exits before and after commit expose coherent complete case publications',async()=>{
  for(const stage of ['after-render','after-seal','after-commit']){
    const dir=await make('crash-'+stage),file=path.join(dir,'case.json'),before=fs.readFileSync(file);
    const script=`import {rehydrateCase} from ${JSON.stringify(moduleURL('case-publication.js'))};await rehydrateCase(process.argv[1],{tokenBudget:400,_checkpoint(stage){if(stage===process.argv[2])process.exit(73);}});throw Error('checkpoint not reached');`;
    run(['--input-type=module','-e',script,dir,stage],{expected:73});
    const current=fs.readFileSync(file);assert.equal(current.equals(before),stage!=='after-commit');
    const check=JSON.parse(run([bin,'verify-case',dir,'--json']).stdout);assert.equal(check.passed,true);
  }
});

test('two actual append processes preserve every accepted revision or reject serialization',async()=>{
  const dir=await make('concurrent'),event=eventFor(dir),barrier=path.join(nativeRoot,'append-barrier');
  native.mkdirSync(barrier);
  const script=`import fs from 'node:fs';import path from 'node:path';import {setTimeout} from 'node:timers/promises';import {CaseDatabase} from ${JSON.stringify(moduleURL('database.js'))};import {appendGovernedTemporalFact} from ${JSON.stringify(moduleURL('bitemporal-graph.js'))};import {closeCommonStore} from ${JSON.stringify(moduleURL('common-store.js'))};const [dir,event,barrier,label]=process.argv.slice(1);const probe=new CaseDatabase(path.join(dir,'case.pgstore'),{readOnly:true});probe.close();fs.writeFileSync(path.join(barrier,label),'ready');while(!fs.existsSync(path.join(barrier,'go')))await setTimeout(10);try{const result=appendGovernedTemporalFact(dir,{id:'same-logical',sourceEventId:event,subjectId:'parallel',predicate:'VALUE',factText:label});console.log(JSON.stringify({ok:true,id:result.id}));}catch(error){console.log(JSON.stringify({ok:false,code:error.code}));}finally{closeCommonStore();}`;
  const pending=['alpha','beta'].map(label=>{
    const owner=randomUUID(),child=spawn(process.execPath,['--input-type=module','-e',script,dir,event,barrier,label],{env:envFor(owner),windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{try{assertDrained(owner);assert.equal(code,0,err);resolve(JSON.parse(out));}catch(e){reject(e);}});});
    return {label,child,done};
  });
  const finished=Promise.allSettled(pending.map(row=>row.done));
  let rows;
  try{
  const deadline=Date.now()+15000;
  while(!pending.every(row=>native.existsSync(path.join(barrier,row.label)))){
    if(Date.now()>deadline)throw new Error('APPEND_BARRIER_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,20));
  }
  native.writeFileSync(path.join(barrier,'go'),'go');
  rows=(await finished).map(row=>{if(row.status==='rejected')throw row.reason;return row.value;});
  }finally{
    for(const {child} of pending)if(child.exitCode===null&&child.signalCode===null)child.kill();
    await finished;
  }
  const accepted=rows.filter(row=>row.ok);
  assert.ok(accepted.length>=1);for(const row of rows.filter(row=>!row.ok))assert.equal(row.code,'40001');
  const db=new CaseDatabase(path.join(dir,'case.pgstore'),{readOnly:true});
  try{assert.equal(db.get("SELECT count(*) n FROM temporal_fact WHERE predicate='VALUE'").n,accepted.length);}
  finally{db.close();}
  assert.equal((await verifyCaseIntegrity(dir)).passed,true);
});

test('benchmarks reject implicit exports and overlapping operational/native roots',()=>{
  assert.throws(()=>benchmarkLocations({},'test'),/explicit native/);
  assert.throws(()=>benchmarkLocations({output:path.join(root,'export'),caseRoot:path.join(root,'case')},'test'),/must be separate/);
  assert.equal(native.existsSync(root),false);
});

test('real PostgreSQL numeric aggregates retain precision and rejected values keep the same bridge alive',()=>{
  const db=new DatabaseSync(path.join(root,'entrypoints','numeric.pgstore'),{family:'access',create:true});
  const pid=commonStoreIdentity().pid,large=9007199254740993n;
  try{
    for(const [name,count] of [['one',1],['two',2]])db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(name,count,large);
    assert.deepEqual(db.prepare('SELECT SUM(count) total FROM attempts').get(),{total:3});
    assert.deepEqual(db.prepare('SELECT SUM(count) total FROM attempts').all(),[{total:3}]);
    assert.throws(()=>db.prepare('SELECT SUM(until_at) total FROM attempts').get(),{code:'ORBITA_PG_INTEGER_OUT_OF_RANGE'});
    assert.equal(db.prepare('SELECT SUM(until_at) total FROM attempts').setReadBigInts(true).get().total,large*2n);
    assert.equal(db.prepare('SELECT AVG(count) mean FROM attempts').get().mean,1.5);
    assert.throws(()=>db.prepare("SELECT CAST('0.1' AS NUMERIC) value").get(),{code:'ORBITA_PG_NUMERIC_PRECISION_UNSUPPORTED'});
    assert.throws(()=>db.prepare("SELECT CAST('NaN' AS REAL) value").get(),{code:'ORBITA_PG_NUMERIC_NONFINITE'});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM attempts').get().n,2);
    assert.equal(commonStoreIdentity().pid,pid);
  }finally{db.close();}
});

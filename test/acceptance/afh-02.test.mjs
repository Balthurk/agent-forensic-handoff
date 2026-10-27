import assert from 'node:assert/strict';
import {assertReadObservation,compareReadInventory} from '../../src/archive/reader-observation.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import test from 'node:test';
import { createHash } from 'node:crypto';
import childProcess, { execFileSync, fork } from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sqlite, { DatabaseSync, constants as sqliteConstants } from 'node:sqlite';
import * as publicApi from '../../src/index.js';
import { digest, relationalWireChecks } from '../../specification/validate-package.mjs';
import Ajv2020 from '../../tools/specification/node_modules/ajv/dist/2020.js';
import addFormats from '../../tools/specification/node_modules/ajv-formats/dist/index.js';
import { createArchiveEngine } from '../../src/archive/engine.js';
import { runtimeSnapshot, snapshotStability } from '../../specification/contract-checks.mjs';

const checkout=fileURLToPath(new URL('../../',import.meta.url));
const registry=JSON.parse(fs.readFileSync(path.join(checkout,'specification/contracts.json')));
const fixtures=JSON.parse(fs.readFileSync(path.join(checkout,'specification/fixtures/critical-contracts.json')));
// Same canonical schema, compiler settings and formats as validateWire; compile
// once per immutable test process instead of once per record read.
const wireSchema=JSON.parse(fs.readFileSync(path.join(checkout,'schemas/archive-v4.schema.json')));
const oracleAjv=new Ajv2020({allErrors:true,strict:true,validateFormats:true});addFormats(oracleAjv);oracleAjv.addSchema(wireSchema);
const oracleValidators=Object.fromEntries(['Request','Response'].map(name=>[name,oracleAjv.compile({$ref:wireSchema.$id+'#/$defs/'+name})]));
function validateWire(value,name){const validate=oracleValidators[name];return {passed:validate(value),errors:validate.errors??[]};}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const origin='00000000-0000-4000-8000-000000000404';
function observeArchiveProcesses(run,receipt,onCall=null){
  const methods=['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork'],originals=Object.fromEntries(methods.map(name=>[name,childProcess[name]])),observed=[];
  for(const method of methods)childProcess[method]=function(command,args,options){
    const osLookup=process.platform==='win32'&&method==='execFileSync'&&command===path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe')&&args?.length===4&&args[0]==='-NoProfile'&&args[1]==='-NonInteractive'&&args[2]==='-Command'&&/^\(Get-Process -Id [0-9]+ -ErrorAction Stop\)\.StartTime\.ToUniversalTime\(\)\.Ticks\.ToString\(\)$/.test(args[3])&&options?.windowsHide===true;
    const ownWorker=method==='fork'&&path.resolve(command)===path.join(run,'archive-worker.mjs')&&args?.length===0&&options?.windowsHide===true&&options.execArgv?.length===0;
    observed.push({method,command,args,allowed:osLookup||ownWorker,kind:osLookup?'CURRENT_OS_IDENTITY':ownWorker?'OWN_CRASH_TEST_WORKER':'UNEXPECTED',...(ownWorker?{worker_sha256:hash(fs.readFileSync(command))}:{})});onCall?.(observed.at(-1));if(!osLookup&&!ownWorker)throw new Error('Unexpected process execution in archive observation');return originals[method].apply(this,arguments);
  };syncBuiltinESMExports();return ()=>{Object.assign(childProcess,originals);syncBuiltinESMExports();receipt.process_execution_observation={calls:observed,unexpected:observed.filter(call=>!call.allowed).length};};
}
// Test-only observation of real native calls. This is intentionally independent
// of product receipts: a boolean supplied by the engine cannot authorize a delta.
const readerWriterPhases=new Map();
const readerFixtureRoots=new Set();
const readerAuxiliaryNames=new Set(['ledger.sqlite-shm','ledger.sqlite-wal']);
function readerInventory(root){
  const rows=[];
  function visit(file){
    const stat=fs.lstatSync(file,{bigint:true}),relative=path.relative(root,file).split(path.sep).join('/');
    const type=stat.isSymbolicLink()?'link':stat.isDirectory()?'directory':stat.isFile()?'file':'unknown';
    rows.push({path:relative,type,bytes:type==='file'?Number(stat.size):null,identity:stat.dev+':'+stat.ino,sha256:type==='file'?hash(fs.readFileSync(file)):null,...(type==='link'?{link:fs.readlinkSync(file)}:{})});
    if(type==='directory')for(const name of fs.readdirSync(file).sort())visit(path.join(file,name));
  }
  visit(root);return rows;
}
function readerAuxiliaryInventory(root){
  return [...readerAuxiliaryNames].flatMap(name=>{
    const file=path.join(root,name);if(!fs.existsSync(file))return [];
    const stat=fs.lstatSync(file,{bigint:true});return [{path:name,type:stat.isSymbolicLink()?'link':stat.isFile()?'file':'unknown',bytes:Number(stat.size),identity:stat.dev+':'+stat.ino,sha256:stat.isFile()&&!stat.isSymbolicLink()?hash(fs.readFileSync(file)):null}];
  });
}
function readerCompare(observation){return compareReadInventory(observation);}
async function observeArchiveReader(root,body,{sqlProbes=false}={}){
  root=path.resolve(root);const database=path.join(root,'ledger.sqlite'),originalConstructor=sqlite.DatabaseSync;
  const report={root,pid:process.pid,database,decision:'AFH-02-READONLY-WAL-INTERPRETATION-01',inventories:[{phase:'BEFORE',rows:readerInventory(root)}],handles:[],native_calls:[],filesystem_mutations:[],sql_mutations:[],errors:[],unattributed_boundaries:[],sql_probes:sqlProbes};
  const phase=readerWriterPhases.get(root),lockFile=path.join(root,'writer.lock'),lock=fs.existsSync(lockFile)?JSON.parse(fs.readFileSync(lockFile)):null;
  const syntheticBase=[...readerFixtureRoots].find(base=>{const relative=path.relative(base,root);return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);}),relative=syntheticBase?path.relative(syntheticBase,root):'..';
  report.writer_observation={synthetic_root:syntheticBase??null,contained:relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative),lock:lock?{pid:lock.pid,job_id:lock.job_id,nonce:lock.nonce}:null,phase:phase??null};
  report.writer_observation.quiet=report.writer_observation.contained&&(!lock||phase?.pid===lock.pid&&['PAUSED_AT_NATIVE_FAULT_BARRIER','PROCESS_CLOSED'].includes(phase.state));
  let lastAux=readerAuxiliaryInventory(root),sequence=0;const duringHandles=new Set();
  const errorValue=error=>({code:error.code??null,errcode:error.errcode??null,errstr:error.errstr??null,message:error.message});
  function native(handle,method,sql,invoke,binding={}){
    const before=readerAuxiliaryInventory(root);if(digest(before)!==digest(lastAux))report.unattributed_boundaries.push({sequence,method,before:lastAux,after:before});
    const event={sequence:++sequence,handle_id:handle.id,method,sql:sql??null,before,...binding};let result;
    try{result=invoke();event.completed=true;if(method==='statement.get')event.row_count=result===undefined?0:1;if(method==='statement.all')event.row_count=result.length;if(method==='iterator.next'){event.iterator_done=result.done===true;event.row_count=result.done?0:1;}return result;}catch(error){event.error=errorValue(error);report.errors.push({sequence:event.sequence,...event.error});throw error;}
    finally{event.after=readerAuxiliaryInventory(root);lastAux=event.after;report.native_calls.push(event);if(['statement.get','statement.all','iterator.next'].includes(method)&&event.completed&&!duringHandles.has(handle.id)||method==='close'){duringHandles.add(handle.id);report.inventories.push({phase:'DURING_'+event.sequence+'_'+method,rows:readerInventory(root)});}}
  }
  function checkSql(sql){
    const normalized=sql.trim().replace(/;\s*$/,'');
    const allowed=!normalized.includes(';')&&(/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)||/^SELECT\b/i.test(normalized)||/^PRAGMA\s+integrity_check$/i.test(normalized));
    if(!allowed){report.sql_mutations.push({sql});if(!sqlProbes)throw new Error('Normal archive reader attempted non-read SQL: '+sql);}
  }
  sqlite.DatabaseSync=new Proxy(originalConstructor,{construct(_ctor,args){
    const handle={id:report.handles.length+1,argument:args[0],options:args[1]??{},readOnly:args[1]?.readOnly===true,closed:false};report.handles.push(handle);
    const db=native(handle,'constructor',null,()=>Reflect.construct(originalConstructor,args));handle.location=path.resolve(db.location('main'));
    if(!handle.readOnly||handle.location!==database){db.close();throw new Error('Reader native handle is writable or outside the active archive');}
    if(typeof db.setAuthorizer!=='function'){db.close();throw Object.assign(new Error('Native authorizer observation is unavailable'),{code:'UNAVAILABLE'});}
    const allowed=new Set([sqliteConstants.SQLITE_READ,sqliteConstants.SQLITE_SELECT,sqliteConstants.SQLITE_FUNCTION,sqliteConstants.SQLITE_PRAGMA,sqliteConstants.SQLITE_TRANSACTION,sqliteConstants.SQLITE_RECURSIVE]);
    db.setAuthorizer((action,a,b)=>{if(!allowed.has(action)||action===sqliteConstants.SQLITE_PRAGMA&&b!==null){report.sql_mutations.push({handle_id:handle.id,action,a,b});if(!sqlProbes)return sqliteConstants.SQLITE_DENY;}return sqliteConstants.SQLITE_OK;});
    return new Proxy(db,{get(target,key){
      if(key==='prepare')return sql=>{checkSql(sql);const statement=native(handle,'prepare',sql,()=>target.prepare(sql)),prepare_sequence=sequence;return new Proxy(statement,{get(stmt,method){const value=Reflect.get(stmt,method,stmt);if(typeof value!=='function')return value;return (...parameters)=>{const result=native(handle,'statement.'+String(method),sql,()=>value.apply(stmt,parameters),{prepare_sequence});if(method!=='iterate')return result;const iterator_sequence=sequence;const iteratorProxy=new Proxy(result,{get(iterator,action){if(action===Symbol.iterator)return ()=>iteratorProxy;const fn=Reflect.get(iterator,action,iterator);return typeof fn==='function'?(...values)=>native(handle,'iterator.'+String(action),sql,()=>fn.apply(iterator,values),{prepare_sequence,iterator_sequence}):fn;}});return iteratorProxy;};}});};
      if(key==='exec')return sql=>{checkSql(sql);return native(handle,'exec',sql,()=>target.exec(sql));};
      if(key==='close')return ()=>{const result=native(handle,'close',null,()=>target.close());handle.closed=true;return result;};
      const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
      return (...args)=>{throw new Error('Unobserved native reader method: '+String(key));};
    }});
  }});
  const restorers=[],mutators=['appendFile','chmod','chown','copyFile','cp','fchmod','fchown','fdatasync','fsync','ftruncate','futimes','lchmod','lchown','link','lutimes','mkdir','mkdtemp','rename','rm','rmdir','symlink','truncate','unlink','utimes','write','writeFile','writev'];
  function watch(object,name,open=false){if(typeof object[name]!=='function')return;const original=object[name];object[name]=function(...args){const flags=args[1],writes=!open||(typeof flags==='string'?!['r','rs','sr'].includes(flags):(Number(flags)&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))!==0);if(writes)report.filesystem_mutations.push({method:name,target:typeof args[0]==='string'?args[0]:String(args[0]),flags:open?flags:null});return original.apply(this,args);};restorers.push(()=>{object[name]=original;});}
  for(const name of mutators){watch(fs,name);watch(fs,name+'Sync');watch(fs.promises,name);}watch(fs,'open',true);watch(fs,'openSync',true);watch(fs.promises,'open',true);watch(fs,'createWriteStream');syncBuiltinESMExports();
  let result,operationError;
  try{result=await body();}catch(error){operationError=error;}
  finally{for(const restore of restorers.reverse())restore();sqlite.DatabaseSync=originalConstructor;syncBuiltinESMExports();report.inventories.push({phase:'AFTER',rows:readerInventory(root)});const finalAux=readerAuxiliaryInventory(root);if(digest(finalAux)!==digest(lastAux))report.unattributed_boundaries.push({sequence:++sequence,method:'AFTER_NATIVE_CALLS',before:lastAux,after:finalAux});}
  report.comparison=readerCompare(report);report.operation_error=operationError?errorValue(operationError):result?.error??null;report.passed=report.comparison.preserved&&report.writer_observation.quiet&&!report.operation_error&&result?.data?.passed!==false&&report.errors.length===0&&report.handles.length>0&&report.handles.every(handle=>handle.readOnly&&handle.closed)&&!sqlProbes;
  return {result,error:operationError,observation:report};
}
async function readerConsumerCalibration({run,archive,receipt,probeRead,negativeRead}){
  receipt.validation_role='REPAIR_R3_ACTUAL_READER_CONSUMERS';const builderPath=process.env.AFH_READER_CLOSURE_BUILDER;if(!builderPath)throw Object.assign(new Error('Exact successor closure builder required for consumer calibration'),{code:'UNAVAILABLE'});const builder=await import(pathToFileURL(builderPath).href);receipt.closure_consumer={ref:builderPath,sha256:hash(fs.readFileSync(builderPath)),export:'validateReaderCorpus'};
  await probeRead(null);const baselineObservation=structuredClone(receipt.read_only_observations.at(-1)),baselinePair=structuredClone(receipt.requests.find(pair=>pair.request.request_id===baselineObservation.request_id));assert.equal(baselineObservation.passed,true);assert.equal(builder.validateReaderCorpus([{r:{requests:[baselinePair],read_only_observations:[baselineObservation]}}])[0].category,'POSITIVE_READ');
  const mutations=[['native_boundary_gap',r=>{const rows=r.observation.native_calls[0].before;if(rows.length)rows[0].sha256=rows[0].sha256==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64);else rows.push({path:'ledger.sqlite-shm',type:'file',bytes:0,identity:'derived-gap:0',sha256:hash('')});}],['foreign_auxiliary_frame',r=>{r.observation.native_calls[0].before.push({path:'foreign.sqlite-shm',type:'file',bytes:0,identity:'0:0',sha256:'0'.repeat(64)});}],['known_running_writer',r=>{r.observation.writer_observation.phase={state:'RUNNING',pid:process.pid};}],['quiet_false',r=>{r.observation.writer_observation.quiet=false;r.observation.passed=false;}],['quiet_contradictory_passed',r=>{r.observation.writer_observation.quiet=false;r.observation.passed=true;}],['sql_error',r=>{r.observation.errors.push({code:'ERR_SQLITE_ERROR',message:'calibration SQL failure'});r.observation.passed=false;}],['verification_false',r=>{r.result.data.passed=false;r.observation.passed=false;}],['missing_handles',r=>{r.observation.handles=[];r.observation.passed=false;}],['foreign_handle',r=>{r.observation.handles[0].location=path.join(run,'foreign.sqlite');}],['unclosed_handle',r=>{r.observation.handles[0].closed=false;}],['writable_constructor',r=>{r.observation.handles[0].options.readOnly=false;}],['missing_native_calls',r=>{r.observation.native_calls=[];}],['unproven_isolation',r=>{r.observation.writer_observation.contained=false;}],['failed_native_call',r=>{r.observation.native_calls[0].error={code:'ERR_SQLITE_ERROR'};}],['missing_during_inventory',r=>{r.observation.inventories=r.observation.inventories.filter(item=>!item.phase.startsWith('DURING_'));}],['passed_false',r=>{r.observation.passed=false;}]];
  const accepted=[],unexpected=[];receipt.consumer_calibrations=[];
  for(const [name,mutate]of mutations){let wrapperRejected=false,builderRejected=false;try{await probeRead(mutate);}catch(error){wrapperRejected=true;if(error.code!=='READ_CONTROL_REJECTED')unexpected.push({name,consumer:'wrapper',code:error.code,message:error.message});}
    const mutant={result:structuredClone(baselinePair.response),observation:structuredClone(baselineObservation)};mutate(mutant);try{builder.validateReaderCorpus([{r:{requests:[{request:baselinePair.request,response:mutant.result}],read_only_observations:[mutant.observation]}}]);}catch(error){builderRejected=true;if(error.code!=='READ_CONTROL_REJECTED')unexpected.push({name,consumer:'closure',code:error.code,message:error.message});}
    if(!wrapperRejected||!builderRejected)accepted.push({name,wrapperRejected,builderRejected});receipt.consumer_calibrations.push({name,classification:'DERIVED_MUTANT_OF_REAL_NATIVE_OBSERVATION',original:baselineObservation,mutant:mutant.observation,mutant_response:mutant.result,wrapperRejected,builderRejected});
  }
  receipt.closure_structure_calibrations=[];for(const [name,mutate]of [['missing_observation',r=>{r.read_only_observations=[];}],['orphan_observation',r=>{r.requests=[];}],['duplicate_observation',r=>{r.read_only_observations.push(structuredClone(r.read_only_observations[0]));}],['missing_outcome',r=>{delete r.read_only_observations[0].outcome;}],['changed_outcome',r=>{r.read_only_observations[0].outcome.response_sha256='0'.repeat(64);}]] ){
    const corpus={requests:[structuredClone(baselinePair)],read_only_observations:[structuredClone(baselineObservation)]};mutate(corpus);assert.throws(()=>builder.validateReaderCorpus([{r:corpus}]),error=>error.code==='READ_CONTROL_REJECTED');receipt.closure_structure_calibrations.push({name,rejected:true,corpus});
  }
  const lock=path.join(archive,'writer.lock');fs.writeFileSync(lock,JSON.stringify({pid:process.pid,job_id:'unobserved-calibration-writer',nonce:'unobserved-calibration-nonce'}),{flag:'wx'});let realRejected=false;try{await probeRead(null);}catch(error){realRejected=true;if(error.code!=='READ_CONTROL_REJECTED')unexpected.push({name:'real_unobserved_writer',code:error.code});}finally{fs.unlinkSync(lock);}if(!realRejected)accepted.push({name:'real_unobserved_writer'});receipt.real_unobserved_writer_rejected=realRejected;
  await assert.rejects(()=>negativeRead('ANY_ERROR'),error=>error.code==='READ_CONTROL_REJECTED');await assert.rejects(()=>negativeRead('INTEGRITY_FAILED'),error=>error.code==='READ_CONTROL_REJECTED');
  const negative=await negativeRead();assert.equal(negative.error.code,'EVIDENCE_UNAVAILABLE');const negativeObservation=receipt.read_only_observations.at(-1),negativePair=receipt.requests.find(pair=>pair.request.request_id===negativeObservation.request_id);assert.equal(negativeObservation.passed,false);assert.equal(negativeObservation.outcome.category,'EXPECTED_NEGATIVE');assert.equal(builder.validateReaderCorpus([{r:{requests:[negativePair],read_only_observations:[negativeObservation]}}])[0].category,'EXPECTED_NEGATIVE');receipt.expected_negative={pair:negativePair,observation:negativeObservation};
  assert.deepEqual(accepted,[],'Both actual wrappers and the effective closure consumer must reject incomplete proofs');assert.deepEqual(unexpected,[],'Rejection must come from complete reader-control validation');
}

async function readerExecutionCalibration({receipt,probeRead}){
  receipt.validation_role='REPAIR_R3_EXECUTION_PROVENANCE';const builderPath=process.env.AFH_READER_CLOSURE_BUILDER;assert.ok(builderPath);const builder=await import(pathToFileURL(builderPath).href);receipt.closure_consumer={ref:builderPath,sha256:hash(fs.readFileSync(builderPath)),export:'validateReaderCorpus'};
  await probeRead(null);await probeRead(null);const baseline=structuredClone(receipt.read_only_observations.at(-1)),pair=structuredClone(receipt.requests.find(p=>p.request.request_id===baseline.request_id));assert.equal(builder.validateReaderCorpus([{r:{requests:[pair],read_only_observations:[baseline]}}])[0].category,'POSITIVE_READ');
  const execute=c=>['statement.get','statement.all','iterator.next'].includes(c.method),lifecycle=c=>['constructor','close'].includes(c.method);
  function prune(o,keep,{retainPhases=false}={}){const prior=o.native_calls,oCalls=prior.filter(keep);assert.ok(oCalls.length<prior.length,'Negative must remove native events');const map=new Map(oCalls.map((c,i)=>[c.sequence,i+1]));o.native_calls=oCalls.map((c,i)=>({...c,sequence:i+1,...(c.prepare_sequence?{prepare_sequence:map.get(c.prepare_sequence)??-1}:{}),...(c.iterator_sequence?{iterator_sequence:map.get(c.iterator_sequence)??-1}:{})}));if(!retainPhases)o.inventories=o.inventories.flatMap(item=>{const m=/^DURING_(\d+)_(.+)$/.exec(item.phase);return !m?[item]:map.has(Number(m[1]))?[{...item,phase:'DURING_'+map.get(Number(m[1]))+'_'+m[2]}]:[];});o.comparison=compareReadInventory(o);}
  const mutations=[
    ['lifecycle_only_stale_during',o=>{prune(o,lifecycle,{retainPhases:true});assert.ok(o.native_calls.every(lifecycle));}],
    ['lifecycle_only_bound_during',o=>{prune(o,lifecycle);assert.ok(o.native_calls.every(lifecycle));}],
    ['transactions_without_query',o=>{prune(o,c=>lifecycle(c)||c.method==='exec');assert.ok(!o.native_calls.some(c=>c.method==='prepare'||execute(c)));}],
    ['prepare_without_execution',o=>{prune(o,c=>!c.method.startsWith('statement.')&&!c.method.startsWith('iterator.'));assert.ok(o.native_calls.some(c=>c.method==='prepare')&&!o.native_calls.some(execute));}],
    ['iterator_without_advance',o=>{prune(o,c=>!execute(c));assert.ok(o.native_calls.some(c=>c.method==='statement.iterate')&&!o.native_calls.some(execute));}],
    ['execution_without_prepare',o=>{prune(o,c=>c.method!=='prepare');assert.ok(o.native_calls.some(execute)&&!o.native_calls.some(c=>c.method==='prepare'));}],
    ['execution_other_handle',o=>{const c=o.native_calls.find(execute),other=o.handles.find(h=>h.id!==c.handle_id);assert.ok(other);c.handle_id=other.id;}],
    ['execution_other_sql',o=>{const c=o.native_calls.find(execute);assert.notEqual(c.sql,'SELECT 1');c.sql='SELECT 1';}],
    ['execution_other_preparation',o=>{const c=o.native_calls.find(execute);c.prepare_sequence=0;}],
    ['iterator_other_creation',o=>{const c=o.native_calls.find(c=>c.method==='iterator.next');assert.ok(c);c.iterator_sequence=0;}],
    ['sql_on_lifecycle_only',o=>{const sql=o.native_calls.find(c=>c.method==='prepare').sql;prune(o,lifecycle);o.native_calls[0].sql=sql;assert.ok(!o.native_calls.some(execute));}],
    ['execution_failed',o=>{const c=o.native_calls.find(execute);c.completed=false;c.error={code:'ERR_SQLITE_ERROR',message:'Derived failed execution'};}],
    ['during_removed_event',o=>{const item=o.inventories.find(i=>i.phase.startsWith('DURING_'));assert.ok(item);item.phase='DURING_999999_statement.get';}],
    ['during_incompatible_method',o=>{const item=o.inventories.find(i=>i.phase.startsWith('DURING_'));assert.ok(item);item.phase='DURING_1_constructor';}],
  ];
  const failures=[];receipt.execution_calibrations=[];
  for(const [name,mutate]of mutations){let wrapperRejected=false,closureRejected=false,wrapperChange=null;const checked=observed=>{const before=digest(observed.observation);mutate(observed.observation);assert.notEqual(digest(observed.observation),before,'No-op negative '+name);wrapperChange={before,after:digest(observed.observation)};};
    try{await probeRead(checked);}catch(error){if(error.code==='READ_CONTROL_REJECTED')wrapperRejected=true;else throw error;}
    const mutant=structuredClone(baseline),before=digest(mutant);mutate(mutant);assert.notEqual(digest(mutant),before,'No-op closure negative '+name);try{builder.validateReaderCorpus([{r:{requests:[pair],read_only_observations:[mutant]}}]);}catch(error){if(error.code==='READ_CONTROL_REJECTED')closureRejected=true;else throw error;}
    receipt.execution_calibrations.push({name,classification:'DERIVED_OMISSION_FROM_REAL_EXECUTED_READ',baseline,mutant,wrapper_change:wrapperChange,closure_change:{before,after:digest(mutant)},wrapperRejected,closureRejected});if(!wrapperRejected||!closureRejected)failures.push({name,wrapperRejected,closureRejected});
  }
  assert.deepEqual(failures,[],'Complete execution evidence required by both actual consumers');
  receipt.real_execution_positive={pair,observation:baseline,methods:[...new Set(baseline.native_calls.filter(execute).map(c=>c.method))],zero_row_iterations:baseline.native_calls.filter(c=>c.method==='iterator.next'&&c.row_count===0&&c.iterator_done===true).length};
  assert.deepEqual(receipt.real_execution_positive.methods.sort(),['iterator.next','statement.all','statement.get']);assert.ok(receipt.real_execution_positive.zero_row_iterations>0,'Actual empty-table iteration is still a successful executed read');
}

test('M02-R3 residual execution provenance harness02',async t=>scenario(t,'AFH-02-T17',readerExecutionCalibration));
test('M02-R3 actual harness02 and closure consumer reject incomplete read proofs',async t=>scenario(t,'AFH-02-T17',readerConsumerCalibration));
async function scenario(t,id,body){
  const base=process.env.AFH_ACCEPTANCE_RUN||os.tmpdir();fs.mkdirSync(base,{recursive:true});
  const run=fs.mkdtempSync(path.join(base,id+'-')),contract=registry.scenarios.find(s=>s.id===id),fixture=fixtures.cases[id];
  const before=runtimeSnapshot(checkout),receipt={scenario_id:id,role:'COMPONENT_OBSERVATION',acceptance_eligible:false,input_class:'SYNTHETIC',runtime_class:typeof publicApi.archiveRequest==='function'?'REAL_AFH':'CONTRACT_ONLY',provider_class:'NONE',candidate_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim(),node:process.version,platform:process.platform,arch:process.arch,runtime_before:before,runner_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),fixture_sha256:contract.fixture_ref.sha256,oracle_sha256:contract.oracle_ref.sha256,requests:[],phase:'PRECONDITION'};
  const stopProcesses=observeArchiveProcesses(run,receipt);
  try{
    assert.equal(digest(fixture),contract.fixture_ref.sha256);assert.equal(digest(fixtures.oracles[id]),contract.oracle_ref.sha256);assert.equal(digest(fixtures.datasets[fixture.dataset_ref.split('/').at(-1)]),fixture.dataset_sha256);
    if(typeof publicApi.archiveRequest!=='function')throw Object.assign(new Error('Canonical public archiveRequest export is absent'),{code:'NOT_IMPLEMENTED'});
    readerFixtureRoots.add(run);const archive=path.join(run,'archive');let requestIndex=0;
    const call=async(operation,params,options={},revision_id=null,target=archive,engine=publicApi.archiveRequest,expectation=null,transform=null)=>{
      const request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:id+'-'+(++requestIndex),operation,archive:target,revision_id,params};
      const requestValidation=validateWire(request,'Request');assert.equal(requestValidation.passed,true,JSON.stringify(requestValidation.errors));
      const readOnly=['evidence.read','archive.verify','scope.resolve'].includes(operation);let response;
      if(readOnly){const observed=await observeArchiveReader(target,()=>engine(request,options));const original=transform?structuredClone(observed):null;if(transform)transform(observed);response=observed.result;const observation={operation,request_id:request.request_id,expectation,...observed.observation};try{if(observed.error)throw observed.error;observation.outcome=assertReadObservation({request,response,observation,expectation});(receipt.read_only_observations??=[]).push(observation);}catch(error){(receipt.read_only_rejections??=[]).push({request,response,observation,error:{code:error.code,message:error.message},...(original?{calibration_original:original}: {})});throw error;}}
      else response=await engine(request,options);receipt.requests.push({request,response});
      const responseValidation=validateWire(response,'Response');
      if(!responseValidation.passed)throw Object.assign(new Error(JSON.stringify(responseValidation.errors)),{code:'SCHEMA_PRECONDITION'});
      if(response.error?.code==='NOT_IMPLEMENTED')throw Object.assign(new Error(response.error.message),{code:'NOT_IMPLEMENTED'});
      const pair=operation==='evidence.read'&&response.data?{request,state:evidenceState(target,request)}:null;
      const relational=relationalWireChecks(response,registry,pair);if(relational.length)throw Object.assign(new Error(relational.join(', ')),{code:'WIRE_PRECONDITION'});
      assert.equal(response.request_id,request.request_id);assert.equal(response.operation,operation);
      return response;
    };
    const initialized=await call('archive.init',{idempotency_key:'init',origin_domains:[{id:origin,harness:'generic',descriptor:'Frozen synthetic acceptance fixture'}]});
    assert.equal(initialized.error,null);assert.equal(initialized.data.schema_version,4);
    receipt.phase='BEHAVIOR';
    await body({run,archive,call,probeRead:(transform)=>call('archive.verify',{deep:true},{},null,archive,publicApi.archiveRequest,null,transform),negativeRead:(expected='EVIDENCE_UNAVAILABLE')=>call('evidence.read',{uri:'afh://evidence/sha256/'+'0'.repeat(64)+'/record/1#bytes=0:1',format:'base64'},{},null,archive,publicApi.archiveRequest,expected),fixture,expected:fixtures.oracles[id].expected,receipt});
    receipt.status='GREEN_BEHAVIOR';
  }catch(error){
    receipt.status=['NOT_IMPLEMENTED','UNAVAILABLE'].includes(error.code)?error.code:error.code==='ERR_ASSERTION'&&receipt.phase==='BEHAVIOR'?'RED_BEHAVIOR':'ERROR_MECHANICAL_OR_PRECONDITION';receipt.reason=error.message;
    if(['NOT_IMPLEMENTED','UNAVAILABLE'].includes(receipt.status))t.skip(receipt.reason);else throw error;
  }finally{
    readerFixtureRoots.delete(run);stopProcesses();assert.equal(receipt.process_execution_observation.unexpected,0);
    receipt.runtime_after=runtimeSnapshot(checkout);receipt.stability=snapshotStability(before,receipt.runtime_after);if(!receipt.stability.stable)receipt.status='EVIDENCE_UNSTABLE';
    fs.writeFileSync(path.join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});t.diagnostic('Evidence: '+path.join(run,'receipt.json'));assert.equal(receipt.stability.stable,true);
  }
}
function source(run,name,bytes){
  const file=path.join(run,name);fs.writeFileSync(file,bytes,{flag:'wx'});
  return {path:file,harness:'generic',origin_domain_id:origin};
}

test('M02-R1 exact published integrity rejects missing extra shifted and altered ledger facts',async t=>scenario(t,'AFH-02-T17',async({run,archive,call,receipt})=>{
  receipt.validation_role='REPAIR_R1_EXACT_PUBLISHED_CLOSURE';receipt.mutations=[];
  const input=source(run,'closure.jsonl','{"role":"user","content":"published closure"}\n'),first=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'first'});assert.equal(first.error,null);const firstSource=manifest(archive,first.data.source_revisions[0]);
  const change={association_id:'closure-association',expected_revision_id:null,branch_id:'main',session_id:firstSource.session_id,project_id:'closure-project',workspace:null,checkout:null,association_state:'associated',valid_from:{kind:'unknown',value:null,precision:'order_only',timezone:null},valid_to:{kind:'open',value:null,precision:'order_only',timezone:null},evidence_refs:[firstSource.records[0].evidence_ref]};assert.equal((await call('association.record',{idempotency_key:'association',changes:[change]})).error,null);
  const later=source(run,'later-closure.jsonl','{"role":"assistant","content":"later closure"}\n');assert.equal((await call('archive.ingest',{sources:[later],include_children:false,idempotency_key:'later'})).error,null);assert.equal((await call('archive.verify',{deep:true})).data.passed,true);
  const mutations=[];
  for(const table of ['source_revision','session_version','logical_event','association_version'])for(const kind of ['missing','extra','shifted','content'])mutations.push({table,kind});
  mutations.push({table:'logical_event',kind:'reference'},{table:'association_version',kind:'reference'});const falsePasses=[];
  for(const {table,kind}of mutations){const target=path.join(run,table+'-'+kind);fs.cpSync(archive,target,{recursive:true,errorOnExist:true,force:false});const db=new DatabaseSync(path.join(target,'ledger.sqlite'));let changed;
    try{const row=db.prepare('SELECT * FROM '+table+' ORDER BY commit_seq LIMIT 1').get();
      if(kind==='missing')changed=db.prepare('DELETE FROM '+table+' WHERE id=?').run(row.id);
      if(kind==='extra'){const clone={...row,id:'extra-'+row.id};changed=db.prepare('INSERT INTO '+table+' ('+Object.keys(clone).join(',')+') VALUES('+Object.keys(clone).map(()=>'?').join(',')+')').run(...Object.values(clone));}
      if(kind==='shifted')changed=db.prepare('UPDATE '+table+' SET commit_seq=1 WHERE id=?').run(row.id);
      if(kind==='content'||kind==='reference'){const column=table==='source_revision'?'manifest_json':'data_json',value=JSON.parse(row[column]);if(kind==='reference'){const refs=table==='logical_event'?value.evidence_refs:value.change.evidence_refs;refs[0].record_sha256='f'.repeat(64);}else value.uncommitted_field='altered';changed=db.prepare('UPDATE '+table+' SET '+column+'=? WHERE id=?').run(JSON.stringify(value),row.id);}
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    }finally{db.close();}
    assert.ok(changed.changes>0);for(const deep of [false,true]){const response=await call('archive.verify',{deep},{},null,target,publicApi.archiveRequest,'PUBLISHED_INTEGRITY_FAILURE');receipt.mutations.push({table,kind,deep,changed,response});if(response.data?.passed!==false||!response.data.checks.some(check=>check.id==='integrity.failure'&&check.observed==='INTEGRITY_FAILED'))falsePasses.push({table,kind,deep,passed:response.data?.passed});}
  }
  // A later corrupted fact is outside an intact earlier cut; the current cut
  // still must reject it. This is distinct from silently ignoring missing rows.
  const historical=path.join(run,'historical-cut');fs.cpSync(archive,historical,{recursive:true,errorOnExist:true,force:false});const db=new DatabaseSync(path.join(historical,'ledger.sqlite'));try{db.exec('DELETE FROM session_version WHERE commit_seq=4');}finally{db.close();}const old=await call('archive.verify',{deep:true},{},first.data.revision_id,historical);assert.equal(old.data.passed,true);receipt.historical_cut={revision:first.data.revision_id,response:old};assert.deepEqual(falsePasses,[],'Every altered published fact must fail exact closure in both modes');
}));


test('M02-R2 residual embedded owners respect idempotency precedence without changing published evidence',async t=>scenario(t,'AFH-02-T11',async({run,archive,call,receipt})=>{
  receipt.validation_role='REPAIR_R2_EMBEDDED_IDEMPOTENCE';receipt.channels=[];
  for(const harness of ['generic','codex','claude']){
    const body=harness==='codex'?'{"type":"session_meta","payload":{"id":"owner-a"}}\n':'{"session_id":"owner-a","role":"user","content":"unchanged owner"}\n',input={...source(run,harness+'-embedded.jsonl',body.replaceAll('\\n','\n')),harness,native_id:'owner-a'},params={sources:[input],include_children:false,idempotency_key:harness+'-first'};
    if(harness!=='generic'){const p=JSON.parse(fs.readFileSync(path.join(archive,'archive.json')));const originDomain=p.origin_domains?.find(o=>o.harness===harness);if(originDomain)input.origin_domain_id=originDomain.id;}
    // Each harness uses its own configured archive; input domain must match.
    const target=harness==='generic'?archive:path.join(run,harness+'-archive');if(target!==archive)assert.equal((await call('archive.init',{idempotency_key:'init',origin_domains:[{id:origin,harness,descriptor:'Synthetic embedded native owner'}]},{},null,target)).error,null);
    const invoke=p=>call('archive.ingest',p,{},null,target),first=await invoke(params);assert.equal(first.error,null);const m=manifest(target,first.data.source_revisions[0]),pointer=fs.readFileSync(path.join(target,'archive.json')),manifestBytes=fs.readFileSync(path.join(target,'bronze/sources',m.source_revision_id+'.json')),captureBytes=fs.readFileSync(path.join(target,'revisions',first.data.revision_id+'.json'));const replay=await invoke(params);assert.deepEqual(replay.data,first.data);assert.deepEqual(replay.receipt,first.receipt);
    const changed={...params,sources:[{...input,native_id:'owner-b'}]},sameKey=await invoke(changed),newKey=await invoke({...changed,idempotency_key:harness+'-retarget'});receipt.channels.push({harness,first,replay,sameKey,newKey});
    assert.deepEqual(fs.readFileSync(path.join(target,'archive.json')),pointer);assert.deepEqual(fs.readFileSync(path.join(target,'bronze/sources',m.source_revision_id+'.json')),manifestBytes);assert.deepEqual(fs.readFileSync(path.join(target,'revisions',first.data.revision_id+'.json')),captureBytes);
    const after=await invoke(params);assert.deepEqual(after.data,first.data);assert.deepEqual(after.receipt,first.receipt);for(const record of m.records){const read=await call('evidence.read',{uri:record.evidence_ref.uri,format:'base64'},{},first.data.revision_id,target);assert.equal(read.error,null);}assert.equal((await call('archive.verify',{deep:true},{},null,target)).data.passed,true);
    receipt.channels.at(-1).preserved={pointer:true,manifest:true,capture:true,uris:m.records.length,replay_after:after,occurrences:first.data.delta.new_occurrences};
  }
  assert.deepEqual(receipt.channels.map(c=>({harness:c.harness,same:c.sameKey.error?.code,fresh:c.newKey.error?.code})),['generic','codex','claude'].map(harness=>({harness,same:'IDEMPOTENCY_CONFLICT',fresh:'AMBIGUOUS_IDENTITY'})));
  receipt.semantic_channels=[];
  for(const mode of ['history_versus_embedded','embedded_versus_embedded']){
    const original='{"session_id":"owner-a","role":"user","content":"captured owner"}\n',input=source(run,mode+'.jsonl',original),params={sources:[input],include_children:false,idempotency_key:mode},first=await call('archive.ingest',params);assert.equal(first.error,null);const pointer=fs.readFileSync(path.join(archive,'archive.json')),m=manifest(archive,first.data.source_revisions[0]);
    fs.writeFileSync(input.path,mode==='history_versus_embedded'?original.replace('owner-a','owner-b'):original+original.replace('owner-a','owner-b'));
    const sameKey=await call('archive.ingest',params),newKey=await call('archive.ingest',{...params,idempotency_key:mode+'-new'});assert.equal(sameKey.error?.code,'IDEMPOTENCY_CONFLICT');assert.equal(newKey.error?.code,'AMBIGUOUS_IDENTITY');assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),pointer);
    const evidence=await call('evidence.read',{uri:m.records[0].evidence_ref.uri,format:'base64'});assert.equal(Buffer.from(evidence.data.payload,'base64').toString(),original);fs.writeFileSync(input.path,original);const replay=await call('archive.ingest',params);assert.deepEqual(replay.data,first.data);assert.deepEqual(replay.receipt,first.receipt);receipt.semantic_channels.push({mode,first,sameKey,newKey,evidence,replay,pointer_preserved:true});
  }
  const invalid=source(run,'invalid-native.jsonl','{"session_id":7}\n'),limited=source(run,'limited-owner.jsonl','{"session_id":"owner-b"}\n'),corrupt=source(run,'corrupt-owner.gz',Buffer.from('not a valid gzip stream'));
  receipt.acquisition_errors=[];
  for(const [name,input,expected] of [['invalid_native',invalid,'INVALID_REQUEST'],['corrupt_compression',{...corrupt,native_id:'owner-a'},'INTEGRITY_FAILED']]){const pointer=fs.readFileSync(path.join(archive,'archive.json')),response=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'generic-first'});assert.equal(response.error?.code,expected);assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),pointer);receipt.acquisition_errors.push({name,response,expected,pointer_preserved:true});}
  const limitedArchive=path.join(run,'limited-archive');assert.equal((await call('archive.init',{idempotency_key:'limited-init',origin_domains:[{id:origin,harness:'generic',descriptor:'Synthetic acquisition boundary'}],limits:{max_decoded_source_bytes:128}},{},null,limitedArchive)).error,null);
  const limitedParams={sources:[{...limited,native_id:'owner-b'}],include_children:false,idempotency_key:'limited-first'},limitedFirst=await call('archive.ingest',limitedParams,{},null,limitedArchive);assert.equal(limitedFirst.error,null);const limitedPointer=fs.readFileSync(path.join(limitedArchive,'archive.json'));fs.appendFileSync(limited.path,' '.repeat(512));const limitedResult=await call('archive.ingest',{...limitedParams,sources:[{...limited,native_id:'owner-a'}]},{},null,limitedArchive);assert.equal(limitedResult.error?.code,'LIMIT_EXCEEDED');assert.deepEqual(fs.readFileSync(path.join(limitedArchive,'archive.json')),limitedPointer);receipt.acquisition_errors.push({name:'decoded_limit',response:limitedResult,expected:'LIMIT_EXCEEDED',pointer_preserved:true});
}));

test('M02-R2 effective identity configuration publishes confirmation and rejects incompatible retargeting',async t=>scenario(t,'AFH-02-T11',async({run,archive,call,receipt})=>{
  receipt.validation_role='REPAIR_R2_EFFECTIVE_CONFIGURATION';const input=source(run,'identity-config.jsonl','{"role":"user","content":"native owner learned later"}\n'),params={sources:[input],include_children:false,idempotency_key:'initial'},first=await call('archive.ingest',params);assert.equal(first.error,null);const old=manifest(archive,first.data.source_revisions[0]);assert.equal(old.provisional,true);
  const same=await call('archive.ingest',params);assert.deepEqual(same.receipt,first.receipt);assert.deepEqual(same.data,first.data);const noChange=await call('archive.ingest',{...params,idempotency_key:'same-effective-config'});assert.equal(noChange.data.revision_id,first.data.revision_id);assert.equal(noChange.data.delta.new_occurrences,0);
  const confirmation={sources:[{...input,native_id:'confirmed-owner'}],include_children:false,idempotency_key:'confirmation'},confirmed=await call('archive.ingest',confirmation);assert.equal(confirmed.error,null);const current=manifest(archive,confirmed.data.source_revisions[0]);receipt.confirmation={first,confirmed,old_source:old,current_source:current};assert.equal(current.native_id,'confirmed-owner','A new effective identity must not be discarded as NO_CHANGE');assert.equal(current.provisional,false);assert.equal(current.identity_status,'VERIFIED');assert.notEqual(current.source_revision_id,old.source_revision_id);assert.notEqual(confirmed.data.revision_id,first.data.revision_id);assert.equal(current.source_lineage_id,old.source_lineage_id);assert.deepEqual(current.records.flatMap(r=>r.events.map(e=>e.id)),old.records.flatMap(r=>r.events.map(e=>e.id)));assert.equal(confirmed.data.delta.new_occurrences,0);assert.equal(confirmed.data.delta.new_records,0);
  assert.deepEqual(manifest(archive,old.source_revision_id),old);assert.deepEqual(await readManifestBytes((op,p)=>call(op,p,{},first.data.revision_id),old),fs.readFileSync(input.path));assert.equal((await call('archive.verify',{deep:true},{},first.data.revision_id)).data.passed,true);assert.equal((await call('archive.verify',{deep:true})).data.passed,true);
  const repeat=await call('archive.ingest',confirmation);assert.deepEqual(repeat.receipt,confirmed.receipt);assert.deepEqual(repeat.data,confirmed.data);const repeatedConfig=await call('archive.ingest',{...confirmation,idempotency_key:'repeat-config'});assert.equal(repeatedConfig.data.revision_id,confirmed.data.revision_id);assert.equal(repeatedConfig.data.delta.new_occurrences,0);
  const inheritedIdentity=await call('archive.ingest',{...params,idempotency_key:'omitted-but-effective-same'});assert.equal(inheritedIdentity.data.revision_id,confirmed.data.revision_id);
  const before=fs.readFileSync(path.join(archive,'archive.json')),incompatible={...confirmation,sources:[{...input,native_id:'different-owner'}]};const keyConflict=await call('archive.ingest',incompatible);assert.equal(keyConflict.error?.code,'IDEMPOTENCY_CONFLICT');const identityConflict=await call('archive.ingest',{...incompatible,idempotency_key:'incompatible-owner'});assert.equal(identityConflict.error?.code,'AMBIGUOUS_IDENTITY');assert.ok(identityConflict.error.message.includes('identity')||identityConflict.error.message.includes('owner'));assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),before);receipt.conflicts={keyConflict,identityConflict};
  const distinct=await call('archive.ingest',{sources:[{...input,native_id:'different-owner',source_lineage_id:'00000000-0000-4000-8000-000000000499'}],include_children:false,idempotency_key:'distinct-lineage'});assert.equal(distinct.error,null);const distinctSource=manifest(archive,distinct.data.source_revisions[0]);assert.notEqual(distinctSource.source_lineage_id,current.source_lineage_id);assert.equal(distinctSource.native_id,'different-owner');assert.equal((await call('archive.verify',{deep:true})).data.passed,true);
  const contradictory=source(run,'conflicting-owners.jsonl','{"session_id":"owner-a","role":"user","content":"a"}\n{"session_id":"owner-b","role":"user","content":"b"}\n'),pointer=fs.readFileSync(path.join(archive,'archive.json')),conflictingSource=await call('archive.ingest',{sources:[contradictory],include_children:false,idempotency_key:'contradictory-source'});assert.equal(conflictingSource.error?.code,'AMBIGUOUS_IDENTITY');assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),pointer);receipt.additional_identity_boundaries={distinct,conflictingSource};
}));

test('M02-R1 committed legacy aliases and revision rows are exact while shallow verification preserves its scope',async t=>scenario(t,'AFH-02-T17',async({run,archive,call,receipt})=>{
  receipt.validation_role='REPAIR_R1_LEGACY_AND_DEPTH';receipt.mutations=[];const report=process.env.AFH_LEGACY_FIXTURES;if(!report)throw Object.assign(new Error('Pinned legacy fixtures required'),{code:'UNAVAILABLE'});const legacy=JSON.parse(fs.readFileSync(report)).versions[0],original=inventory(legacy.case_dir);assert.equal((await call('archive.import_case',{case_path:legacy.case_dir,idempotency_key:'legacy'})).error,null);assert.equal((await call('archive.verify',{deep:true})).data.passed,true);
  for(const table of ['legacy_alias','archive_commit'])for(const kind of ['missing','extra','shifted','content']){
    const target=path.join(run,table+'-'+kind);fs.cpSync(archive,target,{recursive:true,errorOnExist:true,force:false});const db=new DatabaseSync(path.join(target,'ledger.sqlite'));
    try{const row=db.prepare('SELECT * FROM '+table+' LIMIT 1').get();if(table==='legacy_alias'){
      if(kind==='missing')db.exec('DELETE FROM legacy_alias');if(kind==='extra')db.prepare('INSERT INTO legacy_alias VALUES(?,?,?,?,?)').run(row.case_hash,'extra-alias',row.event_id,row.commit_seq,row.evidence_json);if(kind==='shifted')db.exec('UPDATE legacy_alias SET commit_seq=1');if(kind==='content')db.exec("UPDATE legacy_alias SET evidence_json='[]'");
    }else{if(kind==='missing')db.exec('DELETE FROM archive_commit WHERE seq=1');if(kind==='extra')db.prepare('INSERT INTO archive_commit VALUES(?,?,?,?,?)').run(0,'extra-commit',row.manifest_sha256,row.recorded_at,row.job_id);if(kind==='shifted')db.exec('UPDATE archive_commit SET seq=0 WHERE seq=1');if(kind==='content')db.exec("UPDATE archive_commit SET job_id='uncommitted-job' WHERE seq=1");}assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
    const response=await call('archive.verify',{deep:true},{},null,target,publicApi.archiveRequest,'PUBLISHED_INTEGRITY_FAILURE');assert.equal(response.data.passed,false);receipt.mutations.push({table,kind,response});
  }
  const target=path.join(run,'depth-cut');fs.cpSync(archive,target,{recursive:true,errorOnExist:true,force:false});const file=objectFiles(target)[0],bytes=fs.readFileSync(file);bytes[0]^=1;fs.writeFileSync(file,bytes);const shallow=await call('archive.verify',{deep:false},{},null,target),deep=await call('archive.verify',{deep:true},{},null,target,publicApi.archiveRequest,'PUBLISHED_INTEGRITY_FAILURE');assert.equal(shallow.data.passed,true);assert.equal(deep.data.passed,false);receipt.depth_boundary={shallow,deep};assert.deepEqual(inventory(legacy.case_dir),original);
}));

test('Archive reader control attributes native auxiliaries and rejects physical and SQL counterexamples',async t=>scenario(t,'AFH-02-T17',async({run,archive,call,receipt})=>{
  receipt.validation_role='INHERITED_READ_ONLY_INVENTORY';
  const input=source(run,'read-only.jsonl','{"role":"user","content":"protected reader evidence"}\n');assert.equal((await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'reader-fixture'})).error,null);
  fs.mkdirSync(path.join(archive,'legacy'));fs.writeFileSync(path.join(archive,'legacy','synthetic-original.bin'),'Protected synthetic legacy artifact');
  const requestFor=target=>({kind:'request',schema_version:4,protocol_version:'4.0',request_id:'read-only-control',operation:'archive.verify',archive:target,revision_id:null,params:{deep:true}});
  const positive=await observeArchiveReader(archive,()=>publicApi.archiveRequest(requestFor(archive)));assert.equal(positive.result.data.passed,true);assert.equal(positive.observation.passed,true);assert.ok(positive.observation.handles.every(handle=>handle.readOnly&&handle.closed));assert.ok(positive.observation.inventories.some(item=>item.phase.startsWith('DURING_')&&!item.phase.endsWith('_close')));receipt.reader_positive=positive.observation;
  const mutations=[
    ['extra-suffix',target=>fs.writeFileSync(path.join(target,'extra.sqlite-wal'),'foreign suffix'), 'PROTECTED_INVENTORY_CHANGE'],
    ['database',target=>fs.appendFileSync(path.join(target,'ledger.sqlite'),'corrupt'),'PROTECTED_INVENTORY_CHANGE'],
    ['cas',target=>fs.appendFileSync(objectFiles(target)[0],'changed'),'PROTECTED_INVENTORY_CHANGE'],
    ['source',target=>fs.appendFileSync(path.join(target,'bronze/sources',fs.readdirSync(path.join(target,'bronze/sources'))[0]),'changed'),'PROTECTED_INVENTORY_CHANGE'],
    ['legacy',target=>fs.appendFileSync(path.join(target,'legacy/synthetic-original.bin'),'changed'),'PROTECTED_INVENTORY_CHANGE'],
    ['zero-wal-data',target=>fs.appendFileSync(path.join(target,'ledger.sqlite-wal'),Buffer.alloc(32,7)),'ZERO_WAL_GAINED_DATA'],
    ['unattributed-same-size-shm',target=>{const file=path.join(target,'ledger.sqlite-shm'),bytes=fs.readFileSync(file);bytes[bytes.length-1]^=1;fs.writeFileSync(file,bytes);},'UNATTRIBUTED_AUXILIARY_CHANGE'],
  ];
  receipt.physical_negatives=[];
  for(const [name,mutate,reason] of mutations){
    const target=path.join(run,'negative-'+name);fs.cpSync(archive,target,{recursive:true,errorOnExist:true,force:false});
    const observed=await observeArchiveReader(target,async()=>{const result=await publicApi.archiveRequest(requestFor(target));assert.equal(result.error,null);assert.equal(result.data.passed,true);mutate(target);return result;});
    assert.equal(observed.observation.passed,false);assert.ok(observed.observation.comparison.reasons.includes(reason),JSON.stringify(observed.observation.comparison));assert.ok(observed.observation.filesystem_mutations.length>0);receipt.physical_negatives.push({name,...observed.observation});
  }
  const corrupt=path.join(run,'negative-corrupt');fs.cpSync(archive,corrupt,{recursive:true,errorOnExist:true,force:false});const corruptPath=path.join(corrupt,'ledger.sqlite'),bytes=fs.readFileSync(corruptPath);bytes.fill(0,0,16);fs.writeFileSync(corruptPath,bytes);
  const damaged=await observeArchiveReader(corrupt,()=>publicApi.archiveRequest(requestFor(corrupt)));assert.equal(damaged.result.data?.passed,false);assert.equal(damaged.observation.passed,false);receipt.corrupt_database={response:damaged.result,observation:damaged.observation};
  const queryError=await observeArchiveReader(archive,()=>{const db=new sqlite.DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});try{return db.prepare('SELECT nonexistent FROM no_such_table').get();}finally{db.close();}});assert.ok(queryError.error);assert.equal(queryError.observation.comparison.preserved,true);assert.equal(queryError.observation.passed,false);assert.ok(queryError.observation.errors.length>0);receipt.unchanged_query_error=queryError.observation;
  const iteratorError=await observeArchiveReader(archive,()=>{const db=new sqlite.DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});try{for(const row of db.prepare('SELECT abs(-9223372036854775808) FROM archive_commit').iterate())assert.fail(JSON.stringify(row));}finally{db.close();}});assert.ok(iteratorError.error);assert.ok(iteratorError.observation.native_calls.some(call=>call.method==='iterator.next'&&call.error));assert.equal(iteratorError.observation.passed,false);receipt.iterator_query_error=iteratorError.observation;
  const deniedSql=['INSERT INTO archive_commit(seq) VALUES(999)','UPDATE archive_commit SET seq=seq','DELETE FROM archive_commit','CREATE TABLE forbidden(value)','PRAGMA user_version=99'];receipt.native_write_denials=[];
  for(const sql of deniedSql){const observed=await observeArchiveReader(archive,()=>{const db=new sqlite.DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});try{db.exec(sql);}finally{db.close();}},{sqlProbes:true});assert.ok(observed.error,'Native readOnly handle must deny '+sql);assert.equal(observed.observation.comparison.preserved,true,JSON.stringify(observed.observation.comparison));assert.equal(observed.observation.passed,false);receipt.native_write_denials.push({sql,...observed.observation});}
  const connectionPragma=await observeArchiveReader(archive,()=>{const db=new sqlite.DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});try{db.exec('PRAGMA query_only=OFF');db.exec('DELETE FROM archive_commit');}finally{db.close();}},{sqlProbes:true});assert.ok(connectionPragma.error);assert.equal(connectionPragma.observation.comparison.preserved,true);receipt.query_only_off_does_not_grant_write=connectionPragma.observation;
  const blockedPragma=await observeArchiveReader(archive,()=>{const db=new sqlite.DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}});assert.ok(blockedPragma.error);assert.ok(blockedPragma.observation.comparison.reasons.includes('SQL_MUTATION_ATTEMPT'));receipt.normal_reader_checkpoint_rejected=blockedPragma.observation;
  // Mutant checks use a real observed native trace and independently change one
  // predicate, ensuring the comparator does not accept a caller's attribution.
  receipt.attribution_negatives=[];
  for(const [name,mutate,reason] of [
    ['writable-constructor',o=>{o.handles[0].readOnly=false;},'NATIVE_READONLY_HANDLE_UNPROVEN'],
    ['foreign-handle',o=>{o.handles[0].location=path.join(run,'foreign.sqlite');},'NATIVE_READONLY_HANDLE_UNPROVEN'],
    ['unknown-writer',o=>{o.writer_observation.quiet=false;},'WRITER_NOT_OBSERVED_QUIET'],
    ['auxiliary-directory',o=>{o.inventories.at(-1).rows.find(row=>row.path==='ledger.sqlite-shm').type='directory';},'NONREGULAR_AUXILIARY'],
  ]){const altered=structuredClone(positive.observation);mutate(altered);const comparison=readerCompare(altered);assert.ok(comparison.reasons.includes(reason),name+': '+JSON.stringify(comparison));receipt.attribution_negatives.push({name,comparison});}
}));

test('Archive invalid request control rejects malformed correlation without writing an archive',async t=>scenario(t,'AFH-02-T18',async({archive,receipt})=>{
  receipt.validation_role='INHERITED_CLOSED_PROTOCOL_ERRORS';receipt.invalid_requests=[];
  for(const requestId of ['',null,'x'.repeat(257)]){const request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:requestId,operation:'archive.ingest',archive,revision_id:null,params:{sources:[],include_children:false,idempotency_key:'invalid'}};const before=readerInventory(archive);let response;await assert.doesNotReject(async()=>{response=await publicApi.archiveRequest(request);},'Malformed correlation must return a valid error envelope');assert.equal(validateWire(response,'Response').passed,true);assert.equal(response.error?.code,'INVALID_REQUEST');assert.equal(response.request_id,'invalid-request');assert.deepEqual(readerInventory(archive),before);receipt.invalid_requests.push({request,response,inventory_before:before,inventory_after:readerInventory(archive)});}
}));
test('Archive reader control protects every byte and identity of a nonempty WAL',async t=>scenario(t,'AFH-02-T17',async({run,receipt})=>{
  receipt.validation_role='INHERITED_NONEMPTY_WAL_INVENTORY';receipt.nonempty_wal_cases=[];
  const cases=[['unchanged',()=>{}],['modify',file=>{const fd=fs.openSync(file,'r+');try{const byte=Buffer.alloc(1);fs.readSync(fd,byte,0,1,50);byte[0]^=1;fs.writeSync(fd,byte,0,1,50);}finally{fs.closeSync(fd);}}],['grow',file=>fs.appendFileSync(file,Buffer.alloc(16))],['truncate',file=>fs.truncateSync(file,0)],['delete',file=>fs.unlinkSync(file)],['substitute',file=>{const bytes=fs.readFileSync(file);fs.renameSync(file,file+'.replaced');fs.writeFileSync(file,bytes);}]];
  for(const [name,mutate] of cases){
    const target=path.join(run,'wal-'+name);fs.mkdirSync(target);const file=path.join(target,'ledger.sqlite'),wal=file+'-wal',writer=new DatabaseSync(file);writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE probe(value); INSERT INTO probe VALUES(1)');assert.ok(fs.statSync(wal).size>0);
    let observed;try{observed=await observeArchiveReader(target,()=>{const reader=new sqlite.DatabaseSync(file,{readOnly:true});try{assert.equal(reader.prepare('SELECT value FROM probe').get().value,1);}finally{reader.close();}mutate(wal);return {value:1};});}
    finally{try{writer.close();}catch(error){(receipt.fixture_writer_close_errors??=[]).push({name,code:error.code,errcode:error.errcode,message:error.message});}}
    if(name==='unchanged'){assert.equal(observed.observation.passed,true,JSON.stringify(observed.observation.comparison));assert.equal(observed.observation.comparison.nonempty_wal_protected,true);}
    else{assert.equal(observed.observation.passed,false);if(observed.error){assert.ok(['delete','substitute'].includes(name));assert.ok(['EPERM','EACCES','EBUSY'].includes(observed.error.code));observed.observation.physical_action='OS_DENIED_NOT_PERFORMED';const mutant=structuredClone(observed.observation);mutant.inventories.at(-1).rows=mutant.inventories.at(-1).rows.filter(row=>row.path!=='ledger.sqlite-wal');observed.observation.missing_wal_comparator=readerCompare(mutant);assert.ok(observed.observation.missing_wal_comparator.reasons.includes('NONEMPTY_WAL_CHANGED'));}else{assert.ok(observed.observation.comparison.reasons.includes('NONEMPTY_WAL_CHANGED'),name+': '+JSON.stringify(observed.observation.comparison));observed.observation.physical_action='PERFORMED_AND_REJECTED';}}
    receipt.nonempty_wal_cases.push({name,...observed.observation});
  }
}));

test('Archive import control returns original receipts and avoids reimporting an identical legacy case',async t=>scenario(t,'AFH-02-T12',async({archive,call,receipt})=>{
  receipt.validation_role='INHERITED_LEGACY_IMPORT_IDEMPOTENCE';const report=process.env.AFH_LEGACY_FIXTURES;if(!report)throw Object.assign(new Error('Pinned legacy fixtures are required for import controls'),{code:'UNAVAILABLE'});const input=JSON.parse(fs.readFileSync(report)).versions[0],params={case_path:input.case_dir,idempotency_key:'legacy-first'},before=inventory(input.case_dir);
  const first=await call('archive.import_case',params);assert.equal(first.error,null);const repeated=await call('archive.import_case',params);assert.equal(repeated.error,null);assert.deepEqual(repeated.data,first.data);assert.deepEqual(repeated.receipt,first.receipt);
  const pointer=fs.readFileSync(path.join(archive,'archive.json')),objects=objectFiles(archive).length;const sameCase=await call('archive.import_case',{...params,idempotency_key:'legacy-second'});assert.equal(sameCase.error,null);assert.equal(sameCase.data.revision_id,first.data.revision_id);assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),pointer);assert.equal(objectFiles(archive).length,objects);assert.ok(sameCase.receipt.warnings.some(warning=>warning.startsWith('NO_CHANGE')));assert.deepEqual(inventory(input.case_dir),before);
  receipt.observed={original_receipt_reused:true,identical_case_no_new_revision:true,original_inventory_preserved:true};
}));
test('Archive initialization control recovers each interrupted initial publication',async t=>scenario(t,'AFH-02-T08',async({run,call,fixture,receipt})=>{
  receipt.validation_role='INHERITED_INIT_ATOMICITY';receipt.initial_crashes=[];
  for(const barrier of fixture.input.failpoints){const target=path.join(run,'init-'+barrier),params={idempotency_key:'initial',origin_domains:[{id:origin,harness:'generic',descriptor:'Synthetic initial publication'}]},request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:'init-'+barrier,operation:'archive.init',archive:target,revision_id:null,params};const killed=await childRequest(run,request,{barrier});const lock=JSON.parse(fs.readFileSync(path.join(target,'writer.lock'))),staged=JSON.parse(fs.readFileSync(path.join(target,'jobs',lock.job_id,'checkpoint.json'))).payload;
    assert.equal(fs.existsSync(path.join(target,'archive.json')),barrier==='pointer_replace');const result=await call('archive.recover',{idempotency_key:'recover-init',job_id:lock.job_id,expected_owner_token:lock.nonce,action:'resume'},{},null,target,request=>childRequest(run,request));assert.equal(result.error,null);
    const pointer=JSON.parse(fs.readFileSync(path.join(target,'archive.json')));assert.equal(pointer.archive_id,lock.archive_id);assert.equal(pointer.revision_id,staged.plan.manifest.revision_id);assert.equal(pointer.published_seq,1);
    const replay=await call('archive.init',params,{},null,target);assert.equal(replay.error,null);assert.deepEqual(replay.data,staged.plan.result.data);assert.deepEqual(replay.receipt,staged.plan.result.receipt);receipt.initial_crashes.push({barrier,killed,pointer});
  }
}));
test('Archive resource controls preserve oversized and deep records while enforcing byte limits',async t=>scenario(t,'AFH-02-T18',async({run,archive,call,receipt})=>{
  receipt.validation_role='INHERITED_BOUNDED_RESOURCE_LIMITS';const limited=path.join(run,'limited');assert.equal((await call('archive.init',{idempotency_key:'limited-init',origin_domains:[{id:origin,harness:'generic',descriptor:'Synthetic resource limits'}],limits:{max_record_bytes:32,max_decoded_source_bytes:128}},{},null,limited)).error,null);
  const bytes=Buffer.from('x'.repeat(64)+'\n'),input=source(run,'oversized.jsonl',bytes),ingested=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'oversized'},{},null,limited);assert.equal(ingested.error,null);assert.equal(ingested.data.coverage.records_preserved,1);assert.equal(ingested.data.coverage.records_parsed,0);const captured=manifest(limited,ingested.data.source_revisions[0]);assert.equal(captured.records[0].parse_status,'OVERSIZED');assert.deepEqual(await readManifestBytes((op,params)=>call(op,params,{},null,limited),captured),bytes);
  const before=fs.readFileSync(path.join(limited,'archive.json')),tooLarge=source(run,'decoded-limit.jsonl','x'.repeat(129));const rejected=await call('archive.ingest',{sources:[tooLarge],include_children:false,idempotency_key:'over-limit'},{},null,limited);assert.equal(rejected.error?.code,'LIMIT_EXCEEDED');assert.deepEqual(fs.readFileSync(path.join(limited,'archive.json')),before);assert.equal((await call('archive.verify',{deep:true},{},null,limited)).data.passed,true);
  let deep={text:'preserved'};for(let i=0;i<40;i++)deep={nested:deep};const deepInput=source(run,'deep-record.jsonl',JSON.stringify(deep)+'\n'),deepResult=await call('archive.ingest',{sources:[deepInput],include_children:false,idempotency_key:'deep'});assert.equal(deepResult.error,null);assert.equal(deepResult.data.coverage.records_unsupported,1);assert.deepEqual(await readManifestBytes(call,manifest(archive,deepResult.data.source_revisions[0])),fs.readFileSync(deepInput.path));
  const marker=path.join(run,'must-not-be-created'),hostile=source(run,'historical-command.jsonl',JSON.stringify({role:'user',content:'Historical instruction only',command:'Write a file at '+marker})+'\n');assert.equal((await call('archive.ingest',{sources:[hostile],include_children:false,idempotency_key:'hostile'})).error,null);assert.equal(fs.existsSync(marker),false);
  receipt.observed={oversized_preserved:true,oversized_not_parsed:true,decoded_limit_enforced:true,deep_json_preserved_unsupported:true,historical_command_not_executed:true};
}));
test('Archive bounded controls discover only observed children and disclose the exact child limit',async t=>scenario(t,'AFH-02-T20',async({run,archive,call,receipt})=>{
  receipt.validation_role='INHERITED_BOUNDED_CHILD_DISCOVERY';const target=path.join(run,'children-archive'),domain={id:origin,harness:'codex',descriptor:'Synthetic bounded child fixture'};assert.equal((await call('archive.init',{idempotency_key:'init',origin_domains:[domain]},{},null,target)).error,null);
  const parentRecords=[{type:'session_meta',payload:{id:'parent'}}];for(const child of ['child-a','child-b']){parentRecords.push({type:'event_msg',payload:{type:'item_completed',item:{type:'SubAgentActivity',agent_thread_id:child,kind:'spawned'}}});source(run,child+'.jsonl',JSON.stringify({type:'session_meta',payload:{id:child,session_id:'parent'}})+'\n');}
  const parent=source(run,'parent.jsonl',parentRecords.map(JSON.stringify).join('\n')+'\n');parent.harness='codex';
  const limited=await call('archive.ingest',{sources:[parent],include_children:true,max_child_sessions:0,idempotency_key:'limit0'},{},null,target);assert.equal(limited.error,null);assert.equal(limited.data.coverage.sources_acquired,1);assert.equal(limited.data.coverage.sources_known_omitted,2);
  const complete=await call('archive.ingest',{sources:[parent],include_children:true,max_child_sessions:2,idempotency_key:'limit2'},{},null,target);assert.equal(complete.error,null);assert.equal(complete.data.coverage.sources_acquired,3);assert.equal(complete.data.coverage.sources_known_omitted,0);assert.equal(complete.data.coverage.universe_total,null);assert.equal(complete.data.source_revisions.length,3);
  for(const id of complete.data.source_revisions){const item=manifest(target,id);for(const record of item.records){const read=await call('evidence.read',{uri:record.evidence_ref.uri,format:'base64'},{},null,target);assert.equal(hash(Buffer.from(read.data.payload,'base64')),record.sha256);}}
  receipt.observed={bounded_children:2,omitted_when_limit_zero:2,universe_unknown:true};
}));
test('Archive integrity control rejects a changed logical ledger row despite SQLite structural health',async t=>scenario(t,'AFH-02-T17',async({run,archive,call,receipt})=>{
  receipt.validation_role='INHERITED_LEDGER_INTEGRITY';const input=source(run,'ledger-integrity.jsonl','{"role":"user","content":"original evidence"}\n'),result=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'ingest'});assert.equal(result.error,null);
  const db=new DatabaseSync(path.join(archive,'ledger.sqlite'));try{const row=db.prepare('SELECT id,commit_seq,data_json FROM logical_event LIMIT 1').get(),event=JSON.parse(row.data_json);event.input='tampered derived row';db.prepare('UPDATE logical_event SET data_json=? WHERE id=? AND commit_seq=?').run(JSON.stringify(event),row.id,row.commit_seq);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
  const verified=await call('archive.verify',{deep:true},{},null,archive,publicApi.archiveRequest,'PUBLISHED_INTEGRITY_FAILURE');assert.equal(verified.data.passed,false,'Structural SQLite health cannot establish manifest/ledger provenance integrity');receipt.observed={tampered_ledger_rejected:true,checks:verified.data.checks};
}));
test('Archive writer controls: idempotence no-change and staged disk failure preserve recoverability',async t=>scenario(t,'AFH-02-T11',async({run,archive,call,receipt})=>{
  receipt.validation_role='INHERITED_WRITER_CONTROLS';const input=source(run,'controls.jsonl','{"role":"user","content":"control"}\n'),params={sources:[input],include_children:false,idempotency_key:'first'};
  const first=await call('archive.ingest',params);assert.equal(first.error,null);const captured=manifest(archive,first.data.source_revisions[0]);
  const repeat=await call('archive.ingest',params);assert.deepEqual(repeat.data,first.data);assert.deepEqual(repeat.receipt,first.receipt);
  const unchanged=await call('archive.ingest',{...params,idempotency_key:'unchanged'});assert.equal(unchanged.error,null);assert.equal(unchanged.data.revision_id,first.data.revision_id);assert.equal(unchanged.data.delta.new_occurrences,0);assert.ok(unchanged.receipt.warnings.some(s=>s.startsWith('NO_CHANGE')));
  const failedInput=source(run,'failure.jsonl','{"role":"user","content":"staged but not published"}\n'),before=fs.readFileSync(path.join(archive,'archive.json'));
  const failed=await call('archive.ingest',{sources:[failedInput],include_children:false,idempotency_key:'failed'},{},null,archive,request=>childRequest(run,request,{failure:{phase:'ledger_commit',code:'ENOSPC'}}));assert.equal(failed.error?.code,'DISK_FULL');assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),before);
  assert.deepEqual(await readManifestBytes(call,captured),fs.readFileSync(input.path));assert.equal(fs.existsSync(path.join(archive,'writer.lock')),true,'Unpublished durable work must retain a recoverable owner token after an error');
  const lock=JSON.parse(fs.readFileSync(path.join(archive,'writer.lock'))),recovered=await call('archive.recover',{idempotency_key:'recover-control',job_id:lock.job_id,expected_owner_token:lock.nonce,action:'resume'},{},null,archive,request=>childRequest(run,request));assert.equal(recovered.error,null);assert.equal((await call('archive.verify',{deep:true})).data.passed,true);
  const replay=await call('archive.recover',{idempotency_key:'recover-control',job_id:lock.job_id,expected_owner_token:lock.nonce,action:'resume'});assert.deepEqual(replay.data,recovered.data);assert.deepEqual(replay.receipt,recovered.receipt);
  receipt.observed={idempotent_receipts:true,no_change_revision:true,recoverable_disk_failure:true};
}));
function manifest(archive,id){return JSON.parse(fs.readFileSync(path.join(archive,'bronze/sources',id+'.json')));}
function evidenceState(archive,request){
  const pointer=JSON.parse(fs.readFileSync(path.join(archive,'archive.json'))),revisionId=request.revision_id??pointer.revision_id;
  const revision=JSON.parse(fs.readFileSync(path.join(archive,'revisions',revisionId+'.json')));
  const matches=revision.source_manifest_ids.flatMap(id=>{const source=manifest(archive,id);return source.records.filter(record=>record.evidence_ref.uri===request.params.uri).map(record=>({source,record}));});
  assert.equal(matches.length,1,'Test must resolve the requested extent independently from a published manifest');
  const {source,record}=matches[0],format=request.params.format??request.params.continuation?.format??'text';
  // These focused reads start at zero; continuation scenarios retain an independently captured initial state.
  const initial_offset='0',extent_bytes=String(record.byte_length),record_sha256=record.sha256;
  const state={archive_id:pointer.archive_id,revision_id:revisionId,source_revision_id:source.source_revision_id,uri:request.params.uri,json_pointer:request.params.json_pointer??'',format,initial_offset,extent_bytes,record_sha256};
  return {...state,request_extent_sha256:digest(state),original_extent_bytes:record.original_extent_bytes??record.byte_length};
}
function objectFiles(archive){
  const files=[];
  function walk(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())walk(file);else files.push(file);}}
  walk(path.join(archive,'bronze/objects'));return files;
}
function inventory(root){
  const files=[];const walk=dir=>{for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),stat=fs.lstatSync(file);assert.equal(stat.isSymbolicLink(),false);if(stat.isDirectory())walk(file);else files.push({path:path.relative(root,file),bytes:stat.size,sha256:hash(fs.readFileSync(file))});}};walk(root);return files;
}
async function readManifestBytes(call,manifest){
  const pieces=[];
  for(const record of manifest.records){
    const response=await call('evidence.read',{uri:record.evidence_ref.uri,format:'base64'});
    assert.equal(response.error,null);assert.equal(response.data.partial,false);
    const bytes=Buffer.from(response.data.payload,'base64');assert.equal(hash(bytes),record.sha256);pieces.push(bytes);
  }
  return Buffer.concat(pieces);
}

async function childRequest(run,request,{barrier=null,onBarrier,clock=null,failure=null,resumeAfterBarrier=false}={}){
  const worker=path.join(run,'archive-worker.mjs');
  if(!fs.existsSync(worker))fs.writeFileSync(worker,`import {createArchiveEngine} from ${JSON.stringify(pathToFileURL(path.join(checkout,'src/archive/engine.js')).href)};
import fs from 'node:fs';import path from 'node:path';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {createHash} from 'node:crypto';const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const executionReport={},processLog=path.join(${JSON.stringify(run)},'process-'+process.pid+'.ndjson');fs.writeFileSync(processLog,'',{flag:'wx'});(${observeArchiveProcesses.toString()})(${JSON.stringify(run)},executionReport,call=>fs.appendFileSync(processLog,JSON.stringify(call)+'\\n'));
const keepAlive=setInterval(()=>{},1000);process.once('message',async ({request,barrier,clock,failure})=>{try{const engine=createArchiveEngine({fault:async(name,plan)=>{if(name===barrier){process.send({kind:'barrier',name,job_id:plan.job_id});await new Promise(resolve=>process.once('message',message=>{if(message.kind==='resume')resolve();}));}if(name===failure?.phase)throw Object.assign(new Error('Synthetic disk failure after staged work'),{code:failure.code});}});const response=await engine(request,clock?{clock:()=>clock}:{});process.send({kind:'response',response},()=>{clearInterval(keepAlive);process.disconnect();});}catch(error){process.send({kind:'failure',message:error.stack},()=>{clearInterval(keepAlive);process.disconnect();});}});\n`,{flag:'wx'});
  const child=fork(worker,[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});let stderr='',message,callbackError;
  child.stderr.on('data',bytes=>{stderr+=bytes;});
  const closed=once(child,'close');const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  readerWriterPhases.set(path.resolve(request.archive),{state:'RUNNING',pid:child.pid,worker_sha256:hash(fs.readFileSync(worker))});
  child.on('message',async value=>{if(value.kind==='barrier'){message=value;readerWriterPhases.set(path.resolve(request.archive),{state:'PAUSED_AT_NATIVE_FAULT_BARRIER',pid:child.pid,barrier:value.name,job_id:value.job_id,worker_sha256:hash(fs.readFileSync(worker))});try{await onBarrier?.(child,value);}catch(error){callbackError=error;}finally{if(resumeAfterBarrier&&!callbackError)child.send({kind:'resume'});else child.kill('SIGKILL');}}else message=value;});
  child.send({request,barrier,clock,failure});const [code,signal]=await closed;clearTimeout(timer);
  readerWriterPhases.set(path.resolve(request.archive),{state:'PROCESS_CLOSED',pid:child.pid,code,signal,worker_sha256:hash(fs.readFileSync(worker))});
  const executionLog=path.join(run,'process-'+child.pid+'.ndjson');assert.ok(fs.existsSync(executionLog),'Every child must leave independently observed process calls');for(const line of fs.readFileSync(executionLog,'utf8').trim().split('\n').filter(Boolean))assert.equal(JSON.parse(line).allowed,true);
  if(callbackError)throw callbackError;
  if(barrier&&!resumeAfterBarrier){assert.equal(message?.kind,'barrier',stderr);assert.equal(message.name,barrier);assert.ok(signal||code!==0,'Writer must actually terminate before returning a response');return {pid:child.pid,code,signal,...message};}
  assert.equal(code,0,stderr);assert.equal(message?.kind,'response',message?.message??stderr);return message.response;
}

test('Archive association and legacy writers recover all four real interruption phases',async t=>scenario(t,'AFH-02-T08',async({run,archive,call,fixture,receipt})=>{
  receipt.validation_role='INHERITED_ALL_WRITER_ATOMICITY';receipt.additional_writer_crashes=[];
  const reportPath=process.env.AFH_LEGACY_FIXTURES;if(!reportPath)throw Object.assign(new Error('Actual pinned legacy fixture required'),{code:'UNAVAILABLE'});const legacy=JSON.parse(fs.readFileSync(reportPath)).versions[0],legacyBefore=inventory(legacy.case_dir);
  const input=source(run,'association-evidence.jsonl','{"role":"user","content":"association evidence"}\n'),ingested=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'source'});assert.equal(ingested.error,null);const captured=manifest(archive,ingested.data.source_revisions[0]);
  const change={association_id:'atomic-association',expected_revision_id:null,branch_id:'main',session_id:captured.session_id,project_id:'atomic-project',workspace:null,checkout:null,association_state:'associated',valid_from:{kind:'unknown',value:null,precision:'order_only',timezone:null},valid_to:{kind:'open',value:null,precision:'order_only',timezone:null},evidence_refs:[captured.records[0].evidence_ref]};
  for(const [operation,params] of [['association.record',{idempotency_key:'associate',changes:[change]}],['archive.import_case',{idempotency_key:'import',case_path:legacy.case_dir}]]){
    const clock='2090-01-01T00:00:00.000Z';
    for(const barrier of fixture.input.failpoints){
      const target=path.join(run,operation+'-'+barrier);fs.cpSync(archive,target,{recursive:true,errorOnExist:true,force:false});const initial=JSON.parse(fs.readFileSync(path.join(target,'archive.json'))),request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:operation+'-'+barrier,operation,archive:target,revision_id:null,params};
      const killed=await childRequest(run,request,{barrier,clock,onBarrier:async()=>{const pointer=JSON.parse(fs.readFileSync(path.join(target,'archive.json')));assert.equal(pointer.published_seq,initial.published_seq+(barrier==='pointer_replace'?1:0));assert.equal((await call('archive.verify',{deep:true},{},null,target)).data.passed,true);if(operation==='association.record'){const scope=await call('scope.resolve',{active_context:{session_id:captured.session_id}},{},null,target);assert.equal(scope.data.effective_scope?.project_id??null,barrier==='pointer_replace'?'atomic-project':null);}}});
      const lock=JSON.parse(fs.readFileSync(path.join(target,'writer.lock'))),plan=JSON.parse(fs.readFileSync(path.join(target,'jobs',lock.job_id,'checkpoint.json'))).payload.plan;
      const recovered=await call('archive.recover',{idempotency_key:'recover',job_id:lock.job_id,expected_owner_token:lock.nonce,action:'resume'},{},null,target,request=>childRequest(run,request));assert.equal(recovered.error,null);assert.equal(JSON.parse(fs.readFileSync(path.join(target,'archive.json'))).revision_id,plan.manifest.revision_id);
      const replay=await call(operation,params,{},null,target);assert.equal(replay.error,null);assert.deepEqual(replay.data,plan.result.data);assert.deepEqual(replay.receipt,plan.result.receipt);assert.equal((await call('archive.verify',{deep:true},{},null,target)).data.passed,true);assert.deepEqual(await readManifestBytes((op,params)=>call(op,params,{},null,target),captured),fs.readFileSync(input.path));
      receipt.additional_writer_crashes.push({operation,barrier,killed,recovered,plan_revision_id:plan.manifest.revision_id,idempotent_replay:true});
    }
  }
  assert.deepEqual(inventory(legacy.case_dir),legacyBefore);receipt.legacy_inventory_before=legacyBefore;receipt.legacy_inventory_after=inventory(legacy.case_dir);
}));

test('Archive concurrency control pins readers and excludes committed rows beyond publication',async t=>scenario(t,'AFH-02-T08',async({run,archive,call,receipt})=>{
  receipt.validation_role='INHERITED_READ_ONLY_CONCURRENCY';receipt.phases=[];
  const oldInput=source(run,'published.jsonl','{"role":"user","content":"published"}\n'),first=await call('archive.ingest',{sources:[oldInput],include_children:false,idempotency_key:'published'});assert.equal(first.error,null);const oldSource=manifest(archive,first.data.source_revisions[0]),oldPointer=JSON.parse(fs.readFileSync(path.join(archive,'archive.json')));
  const pin=new DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});pin.exec('BEGIN');const pinnedRows=()=>pin.prepare('SELECT id,commit_seq FROM source_revision ORDER BY id').all();assert.equal(pinnedRows().length,1);receipt.phases.push({phase:'READER_PINNED',readOnly_constructor:true,transaction:'BEGIN',rows:pinnedRows(),inventory:readerInventory(archive)});
  const next=source(run,'unpublished.jsonl','{"role":"assistant","content":"unpublished until pointer publication"}\n'),request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:'concurrent-writer',operation:'archive.ingest',archive,revision_id:null,params:{sources:[next],include_children:false,idempotency_key:'concurrent-writer'}};
  let newSource,closeBefore;
  try{
    const committed=await childRequest(run,request,{barrier:'ledger_commit',resumeAfterBarrier:true,onBarrier:async(_child,barrier)=>{
      const plan=JSON.parse(fs.readFileSync(path.join(archive,'jobs',barrier.job_id,'checkpoint.json'))).payload.plan;newSource=manifest(archive,plan.result.data.source_revisions[0]);assert.equal(JSON.parse(fs.readFileSync(path.join(archive,'archive.json'))).published_seq,oldPointer.published_seq);
      const raw=await observeArchiveReader(archive,()=>{const db=new sqlite.DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});try{db.exec('BEGIN');const unfiltered=db.prepare('SELECT id,commit_seq FROM source_revision ORDER BY id').all(),filtered=db.prepare('SELECT id,commit_seq FROM source_revision WHERE commit_seq<=? ORDER BY id').all(oldPointer.published_seq);db.exec('COMMIT');return {unfiltered,filtered};}finally{db.close();}});
      assert.equal(raw.observation.passed,true,JSON.stringify(raw.observation.comparison));assert.equal(raw.observation.comparison.nonempty_wal_protected,true);assert.equal(raw.result.unfiltered.length,2,'The negative unfiltered query must actually see the unpublished commit');assert.equal(raw.result.filtered.length,1);assert.equal(pinnedRows().length,1);
      const hidden=await call('evidence.read',{uri:newSource.records[0].evidence_ref.uri,format:'base64'},{},null,archive,publicApi.archiveRequest,'EVIDENCE_UNAVAILABLE');assert.equal(hidden.error?.code,'EVIDENCE_UNAVAILABLE');assert.deepEqual(await readManifestBytes(call,oldSource),fs.readFileSync(oldInput.path));assert.equal((await call('archive.verify',{deep:true})).data.passed,true);
      receipt.phases.push({phase:'WRITER_COMMITTED_POINTER_OLD',writer_barrier:barrier,pointer:JSON.parse(fs.readFileSync(path.join(archive,'archive.json'))),raw_queries:raw.result,reader_observation:raw.observation,pinned_rows:pinnedRows()});
    }});assert.equal(committed.error,null);assert.equal(pinnedRows().length,1,'An existing transaction must remain pinned after publication');assert.equal(JSON.parse(fs.readFileSync(path.join(archive,'archive.json'))).published_seq,oldPointer.published_seq+1);
    const fresh=await call('evidence.read',{uri:newSource.records[0].evidence_ref.uri,format:'base64'});assert.equal(fresh.error,null);assert.deepEqual(Buffer.from(fresh.data.payload,'base64'),fs.readFileSync(next.path));
    const historical=await call('evidence.read',{uri:newSource.records[0].evidence_ref.uri,format:'base64'},{},oldPointer.revision_id,archive,publicApi.archiveRequest,'EVIDENCE_UNAVAILABLE');assert.equal(historical.error?.code,'EVIDENCE_UNAVAILABLE');assert.equal((await call('archive.verify',{deep:true},{},oldPointer.revision_id)).data.passed,true);
    closeBefore=readerInventory(archive);receipt.phases.push({phase:'WRITER_CLOSED_READER_STILL_PINNED',pinned_rows:pinnedRows(),inventory:closeBefore});
  }finally{pin.close();}
  const readerClosed=readerInventory(archive);assert.deepEqual(readerClosed,closeBefore,'Closing the pinned native readOnly handle must not checkpoint or remove a nonempty WAL');receipt.phases.push({phase:'PINNED_READER_CLOSED',inventory:readerClosed});
  const checkpointWriter=new DatabaseSync(path.join(archive,'ledger.sqlite'));checkpointWriter.prepare('SELECT count(*) AS n FROM archive_commit').get();const beforeWriterClose=readerInventory(archive);checkpointWriter.close();const afterWriterClose=readerInventory(archive);receipt.phases.push({phase:'SEPARATE_WRITABLE_HANDLE_CLOSE',before:beforeWriterClose,after:afterWriterClose,changed:digest(beforeWriterClose)!==digest(afterWriterClose)});assert.notEqual(digest(beforeWriterClose),digest(afterWriterClose),'Fixture must demonstrate the separate writer checkpoint phase');
}));

test('AFH-02-T08 real writer deaths recover the same logical final without partial visibility',async t=>scenario(t,'AFH-02-T08',async({run,archive,call,fixture,expected,receipt})=>{
  const input=source(run,'crash-source.jsonl','{"session_id":"crash","role":"user","content":"one"}\n{"session_id":"crash","role":"assistant","content":"two"}\n');
  input.source_lineage_id='00000000-0000-4000-8000-000000000408';
  const clock='2090-01-01T00:00:00.000Z',reference=path.join(run,'uninterrupted');fs.cpSync(archive,reference,{recursive:true,errorOnExist:true,force:false});
  const params={sources:[input],include_children:false,idempotency_key:'ingest'};
  const baseline=await call('archive.ingest',params,{},null,reference,request=>childRequest(run,request,{clock}));assert.equal(baseline.error,null);
  const referenceSource=manifest(reference,baseline.data.source_revisions[0]);receipt.crashes=[];
  for(const barrier of fixture.input.failpoints){
    const target=path.join(run,'crash-'+barrier);fs.cpSync(archive,target,{recursive:true,errorOnExist:true,force:false});const before=JSON.parse(fs.readFileSync(path.join(target,'archive.json')));
    const request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:'crash-'+barrier,operation:'archive.ingest',archive:target,revision_id:null,params};assert.equal(validateWire(request,'Request').passed,true);
    const killed=await childRequest(run,request,{barrier,clock,onBarrier:async()=>{const visible=JSON.parse(fs.readFileSync(path.join(target,'archive.json')));assert.equal(visible.published_seq,barrier==='pointer_replace'?before.published_seq+1:before.published_seq);const check=await call('archive.verify',{deep:true},{},null,target);assert.equal(check.data.passed,true);}});
    const lock=JSON.parse(fs.readFileSync(path.join(target,'writer.lock')));
    const recovered=await call('archive.recover',{idempotency_key:'recover-'+barrier,job_id:lock.job_id,expected_owner_token:lock.nonce,action:'resume'},{},null,target,request=>childRequest(run,request));assert.equal(recovered.error,null);
    const pointer=JSON.parse(fs.readFileSync(path.join(target,'archive.json'))),revision=JSON.parse(fs.readFileSync(path.join(target,'revisions',pointer.revision_id+'.json'))),actual=manifest(target,revision.source_manifest_ids[0]);
    assert.deepEqual(actual.records,referenceSource.records,'Logical identities, record digests and evidence references must match the uninterrupted run');assert.deepEqual(actual.counts,referenceSource.counts);
    assert.deepEqual(await readManifestBytes((op,params)=>call(op,params,{},null,target),actual),fs.readFileSync(input.path));
    assert.equal(fs.existsSync(path.join(target,'writer.lock')),false);receipt.crashes.push({barrier,killed,recovery:recovered,pointer});
  }
  receipt.observed={same_logical_final_as_uninterrupted:true,partial_visible:false};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T09 alive reused and unknown owners cannot be taken over',async t=>scenario(t,'AFH-02-T09',async({run,archive,call,fixture,expected,receipt})=>{
  const input=source(run,'owner.jsonl','{"role":"user","content":"lock"}\n'),before=fs.readFileSync(path.join(archive,'archive.json')),errors=[];
  const request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:'owner-fixture',operation:'archive.ingest',archive,revision_id:null,params:{sources:[input],include_children:false,idempotency_key:'ingest'}};
  receipt.killed=await childRequest(run,request,{barrier:'objects_fsync',onBarrier:async()=>{
    const lockPath=path.join(archive,'writer.lock'),original=JSON.parse(fs.readFileSync(lockPath));
    for(const state of fixture.input.owner_states){const owner={...original,...(state==='pid_reused'?{process_start_identity:'different-process-start'}:state==='unknown'?{host_id:'unverified-external-host'}:{})};fs.writeFileSync(lockPath,JSON.stringify(owner));const lockBefore=fs.readFileSync(lockPath);const response=await call('archive.recover',{idempotency_key:'recover-'+state,job_id:owner.job_id,expected_owner_token:owner.nonce,action:'resume'});errors.push(response.error?.code);assert.deepEqual(fs.readFileSync(lockPath),lockBefore);assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),before);}
  }});
  receipt.observed={errors,forced_takeovers:0};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T10 corrupt staged checkpoint fails while prior revision remains usable',async t=>scenario(t,'AFH-02-T10',async({run,archive,call,expected,receipt})=>{
  const input=source(run,'checkpoint.jsonl','{"role":"user","content":"checkpoint"}\n'),before=fs.readFileSync(path.join(archive,'archive.json'));
  const request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:'checkpoint-fixture',operation:'archive.ingest',archive,revision_id:null,params:{sources:[input],include_children:false,idempotency_key:'ingest'}};
  receipt.killed=await childRequest(run,request,{barrier:'objects_fsync'});const lock=JSON.parse(fs.readFileSync(path.join(archive,'writer.lock'))),checkpoint=path.join(archive,'jobs',lock.job_id,'checkpoint.json'),bytes=fs.readFileSync(checkpoint),corrupt=Buffer.from(bytes);corrupt[corrupt.indexOf(Buffer.from('STAGED'))]^=1;fs.writeFileSync(checkpoint,corrupt);
  const recovered=await call('archive.recover',{idempotency_key:'recover',job_id:lock.job_id,expected_owner_token:lock.nonce,action:'resume'});assert.equal(recovered.error?.code,expected.error);assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),before);
  const check=await call('archive.verify',{deep:true});receipt.observed={error:recovered.error.code,prior_revision_usable:check.data.passed};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T20 acquisition fixes a100 record boundary and discloses ten late records',async t=>scenario(t,'AFH-02-T20',async({run,archive,call,fixture,expected,receipt})=>{
  const rows=n=>Array.from({length:n},(_,i)=>JSON.stringify({role:'user',content:'row-'+i})).join('\n')+'\n',initial=Buffer.from(rows(fixture.input.initial_records)),late=Buffer.from(rows(fixture.input.append_after_boundary)),input=source(run,'growing.jsonl',initial);let boundaries=0;
  const engine=createArchiveEngine({fault:async(name)=>{if(name==='source_boundary'){boundaries++;fs.appendFileSync(input.path,late);}}});
  const result=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'grow'},{},null,archive,engine);assert.equal(result.error,null);assert.equal(boundaries,1);
  const captured=manifest(archive,result.data.source_revisions[0]);assert.deepEqual(await readManifestBytes(call,captured),initial);assert.equal(captured.late_bytes,late.length);
  receipt.observed={captured_records:captured.records.length,late_records:fs.readFileSync(input.path).subarray(captured.boundary.bytes).toString('utf8').trimEnd().split('\n').length,boundary_disclosed:captured.boundary.bytes===initial.length&&result.receipt.warnings.some(warning=>warning.includes(String(late.length)))};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T01 identical raw payloads share CAS bytes while retaining ten sources',async t=>scenario(t,'AFH-02-T01',async({run,archive,call,fixture,expected,receipt})=>{
  const bytes=Buffer.from(fixture.input.bytes),sources=Array.from({length:fixture.input.copies},(_,i)=>source(run,'source-'+i+'.jsonl',bytes));
  const response=await call('archive.ingest',{sources,include_children:false,idempotency_key:'ingest'});assert.equal(response.error,null);
  const manifests=response.data.source_revisions.map(id=>manifest(archive,id));
  assert.equal(manifests.length,expected.source_references);assert.equal(new Set(manifests.map(m=>m.source_lineage_id)).size,expected.source_references);
  assert.equal(objectFiles(archive).length,expected.payload_objects);
  for(const item of manifests){assert.equal(item.raw_sha256,hash(bytes));assert.deepEqual(await readManifestBytes(call,item),bytes);}
  for(const item of sources)assert.deepEqual(fs.readFileSync(item.path),bytes);
  receipt.observed={payload_objects:objectFiles(archive).length,source_references:manifests.length};
}));

test('AFH-02-T02 different payloads retain distinct objects and exact roundtrip',async t=>scenario(t,'AFH-02-T02',async({run,archive,call,fixture,expected,receipt})=>{
  const sources=fixture.input.payloads.map((text,i)=>source(run,'payload-'+i+'.jsonl',text));
  const response=await call('archive.ingest',{sources,include_children:false,idempotency_key:'ingest'});assert.equal(response.error,null);
  const roundtrip=[];for(const id of response.data.source_revisions)roundtrip.push((await readManifestBytes(call,manifest(archive,id))).toString('utf8'));
  receipt.observed={payload_objects:objectFiles(archive).length,roundtrip};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T03 source manifest covers CRLF and UTF8 bytes exactly',async t=>scenario(t,'AFH-02-T03',async({run,archive,call,fixture,expected,receipt})=>{
  const bytes=Buffer.from(fixture.input.bytes_utf8),input=source(run,'unicode.jsonl',bytes);
  const response=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'ingest'});assert.equal(response.error,null);
  const captured=manifest(archive,response.data.source_revisions[0]);let offset=0;
  for(const object of captured.objects){assert.equal(object.offset,offset);offset+=object.length;}assert.equal(offset,bytes.length);
  const roundtrip=await readManifestBytes(call,captured);receipt.observed={byte_identical:roundtrip.equals(bytes),digest_match:hash(roundtrip)===captured.raw_sha256};assert.deepEqual(receipt.observed,expected);assert.deepEqual(fs.readFileSync(input.path),bytes);
}));

test('AFH-02-T12 imports cases created by pinned legacy runtimes without changing their bytes',async t=>scenario(t,'AFH-02-T12',async({archive,call,fixture,expected,receipt})=>{
  const fixtureReport=process.env.AFH_LEGACY_FIXTURES;
  if(!fixtureReport||!fs.existsSync(fixtureReport))throw Object.assign(new Error('Pinned legacy runtime fixture report is unavailable; do not synthesize version labels'),{code:'UNAVAILABLE'});
  const legacy=JSON.parse(fs.readFileSync(fixtureReport));assert.deepEqual(legacy.versions.map(v=>v.schema),fixture.input.schemas);
  receipt.legacy_inputs_ref=fixtureReport;receipt.legacy_inputs_sha256=hash(fs.readFileSync(fixtureReport));receipt.legacy_observations=[];
  for(const input of legacy.versions){
    const before=inventory(input.case_dir);assert.deepEqual(before,input.case_inventory);
    const originals={prepare:DatabaseSync.prototype.prepare,exec:DatabaseSync.prototype.exec},attached=new WeakSet(),writeAttempts=[],readActions=[];let connections=0;
    const allowed=new Set([sqliteConstants.SQLITE_READ,sqliteConstants.SQLITE_SELECT,sqliteConstants.SQLITE_FUNCTION,sqliteConstants.SQLITE_PRAGMA,sqliteConstants.SQLITE_TRANSACTION,sqliteConstants.SQLITE_RECURSIVE]);
    for(const method of Object.keys(originals))DatabaseSync.prototype[method]=function(...args){if(path.resolve(this.location('main'))===path.resolve(input.case_dir,'case.sqlite')&&!attached.has(this)){connections++;attached.add(this);this.setAuthorizer((action,a,b)=>{if(!allowed.has(action)||action===sqliteConstants.SQLITE_PRAGMA&&b!==null){writeAttempts.push({action,a,b});return sqliteConstants.SQLITE_DENY;}readActions.push({action,a,b});return sqliteConstants.SQLITE_OK;});}return originals[method].apply(this,args);};
    let imported;try{imported=await call('archive.import_case',{case_path:input.case_dir,idempotency_key:'import-'+input.version});}finally{Object.assign(DatabaseSync.prototype,originals);}assert.equal(imported.error,null);assert.ok(connections>0);assert.ok(readActions.some(item=>item.action===sqliteConstants.SQLITE_READ));assert.equal(writeAttempts.length,0);
    assert.equal(imported.data.legacy_case_hash,input.case_hash);assert.equal(imported.data.source_inventory_before,imported.data.source_inventory_after);assert.equal(imported.data.alias_count,input.legacy_event_ids.length);
    for(const ref of input.evidence){const response=await call('evidence.read',{uri:ref.uri,format:'base64'});assert.equal(response.error,null);assert.equal(hash(Buffer.from(response.data.payload,'base64')),ref.sha256);}
    // The importer must retain explicit ID mappings as well as URI compatibility.
    const aliasFile=path.join(archive,'legacy',input.case_hash+'.json'),aliases=JSON.parse(fs.readFileSync(aliasFile));
    assert.deepEqual(aliases.events.map(item=>item.legacy_event_id).sort(),input.legacy_event_ids.toSorted());
    assert.ok(aliases.events.every(item=>item.event_id&&item.evidence_refs.length>0));
    assert.deepEqual(inventory(input.case_dir),before);
    receipt.legacy_observations.push({version:input.version,commit:input.commit,before,after:inventory(input.case_dir),aliases,sqlite_instrumentation:{connections,read_actions:readActions.length,write_attempts:writeAttempts}});
  }
  assert.equal(expected.source_inventory_equal,true);assert.equal(expected.all_aliases_resolve,true);
  receipt.observed={source_inventory_equal:true,all_aliases_resolve:true,old_database_writes:receipt.legacy_observations.reduce((n,item)=>n+item.sqlite_instrumentation.write_attempts.length,0)};
}));

test('AFH-02-T14 future legacy version is rejected with its source intact',async t=>scenario(t,'AFH-02-T14',async({run,call,fixture,expected,receipt})=>{
  const legacy=path.join(run,'future-case');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'case.json'),JSON.stringify({schemaVersion:fixture.input.schema_version,status:'COMPLETE'}));
  const before=inventory(legacy),response=await call('archive.import_case',{case_path:legacy,idempotency_key:'future'});
  assert.equal(response.error?.code,expected.error);assert.equal(response.data,null);assert.deepEqual(inventory(legacy),before);
  receipt.observed={error:response.error.code,source_untouched:true};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T17 corrupted CAS object never returns unverified payload',async t=>scenario(t,'AFH-02-T17',async({run,archive,call,expected,receipt})=>{
  const input=source(run,'source.jsonl','{"message":"synthetic integrity"}\n');
  const ingested=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'ingest'});assert.equal(ingested.error,null);
  const captured=manifest(archive,ingested.data.source_revisions[0]),files=objectFiles(archive);assert.ok(files.length>0);
  const before=fs.readFileSync(files[0]),damaged=Buffer.from(before);damaged[damaged.length-1]^=1;fs.writeFileSync(files[0],damaged);
  const response=await call('evidence.read',{uri:captured.records[0].evidence_ref.uri,format:'base64'},{},null,archive,publicApi.archiveRequest,'INTEGRITY_FAILED');
  receipt.observed={error:response.error?.code,unverified_payload_returned:response.data!==null};assert.deepEqual(receipt.observed,expected);
  receipt.corruption={object:files[0],before_sha256:hash(before),after_sha256:hash(damaged)};
}));

test('AFH-02-T18 valid unknown JSON and invalid JSON retain distinct coverage states',async t=>scenario(t,'AFH-02-T18',async({run,archive,call,expected,receipt})=>{
  const bytes=Buffer.from('{"unknown_synthetic_record":true}\n{invalid}\n'),input=source(run,'unknown.jsonl',bytes);
  const response=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'ingest'});assert.equal(response.error,null);
  const coverage=response.data.coverage;
  receipt.observed={preserved:coverage.records_preserved,parsed:coverage.records_parsed,unsupported:coverage.records_unsupported,unparsed:coverage.records_unparsed,normalization_pass:coverage.records_normalized===coverage.records_preserved};assert.deepEqual(receipt.observed,expected);
  assert.deepEqual(await readManifestBytes(call,manifest(archive,response.data.source_revisions[0])),bytes);
  assert.equal(response.status,'PARTIAL');
}));

test('AFH-02-T19 exact101 expansion ratio fails limit100 without replacing prior revision',async t=>scenario(t,'AFH-02-T19',async({run,archive,call,fixture,expected,receipt})=>{
  const plain=Buffer.alloc(fixture.input.input_ratio*1000,0x4d),gzip=zlib.gzipSync(plain);
  const header=Buffer.from(gzip.subarray(0,10));header[3]|=16;
  const padding=Buffer.alloc(1000-gzip.length-1,0x61);
  const compressed=Buffer.concat([header,padding,Buffer.from([0]),gzip.subarray(10)]);
  assert.equal(compressed.length,1000);assert.equal(plain.length/compressed.length,fixture.input.input_ratio);assert.deepEqual(zlib.gunzipSync(compressed),plain);
  const input=source(run,'ratio101.jsonl.gz',compressed),before=fs.readFileSync(path.join(archive,'archive.json'));
  const response=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'bomb'});assert.equal(response.error?.code,expected.error);assert.equal(response.data,null);
  assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),before);
  const verification=await call('archive.verify',{deep:true});assert.equal(verification.data.passed,true);
  assert.deepEqual(fs.readFileSync(input.path),compressed);receipt.observed={error:response.error.code,prior_revision_usable:verification.data.passed};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T05 rewrite with equal size and mtime keeps exactly39 prefix identities',async t=>scenario(t,'AFH-02-T05',async({run,archive,call,fixture,expected,receipt})=>{
  const lines=Array.from({length:100},(_,i)=>JSON.stringify({session_id:'rewrite',role:'user',id:'message-'+i,content:'row-'+String(i+1).padStart(3,'0')+'-AAAA'}));
  const bytes=lines.join('\n')+'\n',input=source(run,'rewrite.jsonl',bytes),stat=fs.statSync(input.path);
  const first=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'first'});assert.equal(first.error,null);const old=manifest(archive,first.data.source_revisions[0]),before=fs.readFileSync(path.join(archive,'revisions',first.data.revision_id+'.json'));
  lines[fixture.input.rewrite_record-1]=lines[fixture.input.rewrite_record-1].replace('AAAA','BBBB');fs.writeFileSync(input.path,lines.join('\n')+'\n');fs.utimesSync(input.path,stat.atime,stat.mtime);assert.equal(fs.statSync(input.path).size,Buffer.byteLength(bytes));
  const second=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'second'});assert.equal(second.error,null);const current=manifest(archive,second.data.source_revisions[0]);
  assert.deepEqual(current.records.slice(0,39).map(r=>r.events.map(e=>e.id)),old.records.slice(0,39).map(r=>r.events.map(e=>e.id)));
  assert.notEqual(current.records[39].identity_epoch,old.records[39].identity_epoch);assert.deepEqual(await readManifestBytes((op,params)=>call(op,params,{},first.data.revision_id),old),Buffer.from(bytes));
  receipt.observed={divergent:current.prefix_relation.kind==='DIVERGENT',reuse_prefix_records:current.prefix_relation.reused_records,old_revision_unchanged:fs.readFileSync(path.join(archive,'revisions',first.data.revision_id+'.json')).equals(before)};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T06 compacted replacement preserves the100 old records and starts a new epoch',async t=>scenario(t,'AFH-02-T06',async({run,archive,call,fixture,expected,receipt})=>{
  const initial=Array.from({length:fixture.input.initial},(_,i)=>JSON.stringify({session_id:'compaction',role:'user',content:'original-'+i})).join('\n')+'\n',input=source(run,'compacted.jsonl',initial);
  const first=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'first'});assert.equal(first.error,null);const old=manifest(archive,first.data.source_revisions[0]);
  fs.writeFileSync(input.path,Array.from({length:fixture.input.new_records},(_,i)=>JSON.stringify({session_id:'compaction',role:'user',content:'summary-'+i})).join('\n')+'\n');
  const second=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'second'});assert.equal(second.error,null);const current=manifest(archive,second.data.source_revisions[0]);
  assert.deepEqual(await readManifestBytes((op,params)=>call(op,params,{},first.data.revision_id),old),Buffer.from(initial));
  receipt.observed={old_records_resolvable:old.records.length,new_epoch:current.records[0].identity_epoch!==old.records[0].identity_epoch,assumed_equivalence:current.prefix_relation.kind!=='DIVERGENT'};assert.deepEqual(receipt.observed,expected);assert.equal(current.records.length,30);
}));

test('AFH-02-T11 same idempotency key with changed bytes adds no occurrence',async t=>scenario(t,'AFH-02-T11',async({run,archive,call,expected,receipt})=>{
  const input=source(run,'idempotency.jsonl','{"session_id":"idem","role":"user","content":"one"}\n');
  const first=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'same'});assert.equal(first.error,null);
  const count=()=>{const db=new DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) AS n FROM logical_event').get().n;}finally{db.close();}};
  const before=count(),pointer=fs.readFileSync(path.join(archive,'archive.json'));fs.writeFileSync(input.path,'{"session_id":"idem","role":"user","content":"two"}\n');
  const second=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'same'});receipt.observed={error:second.error?.code,new_occurrences:count()-before};assert.deepEqual(receipt.observed,expected);assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),pointer);
}));

test('AFH-02-T13 copied archive resolves evidence while original root access is denied',async t=>scenario(t,'AFH-02-T13',async({run,archive,call,expected,receipt})=>{
  const input=source(run,'portable.jsonl','{"role":"user","content":"portable evidence"}\n');const first=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'ingest'});assert.equal(first.error,null);
  const captured=manifest(archive,first.data.source_revisions[0]),copied=path.join(run,'relocated-archive');fs.cpSync(archive,copied,{recursive:true,errorOnExist:true,force:false});
  const originalMethods={};let denied=0;
  for(const method of ['readFileSync','openSync','createReadStream']){originalMethods[method]=fs[method];fs[method]=function(file,...args){if(typeof file==='string'&&(file===archive||file.startsWith(archive+path.sep))){denied++;throw new Error('Original archive access disabled by test');}return originalMethods[method].call(this,file,...args);};}
  let bytes;try{bytes=await readManifestBytes((op,params)=>call(op,params,{},null,copied),captured);}finally{Object.assign(fs,originalMethods);}
  receipt.observed={evidence_bytes_identical:bytes.equals(fs.readFileSync(input.path)),original_path_required:denied!==0};assert.deepEqual(receipt.observed,expected);
}));

test('AFH-02-T15 full response frames partition a16MiB base64 extent exactly',async t=>scenario(t,'AFH-02-T15',async({run,archive,call,fixture,expected,receipt})=>{
  const bytes=Buffer.alloc(fixture.input.max_bytes,0x41),input=source(run,'sixteen-mib.jsonl',bytes);const captured=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'ingest'});assert.equal(captured.error,null);
  const item=manifest(archive,captured.data.source_revisions[0]),parts=[];let continuation,offset=0;const frames=[];
  const padding='P'.repeat(fixture.input.receipt_padding??200000),engine=createArchiveEngine({evidenceReceiptExtra:{warnings:[padding]}});
  do{const read=await call('evidence.read',{uri:item.records[0].evidence_ref.uri,format:'base64',max_bytes:fixture.input.max_bytes,...(continuation?{continuation}:{})},{},null,archive,engine);assert.equal(read.error,null);assert.equal(read.receipt.warnings[0].length,200000);assert.equal(read.data.offset,offset);const part=Buffer.from(read.data.payload,'base64');offset+=part.length;parts.push(part);const frame=Buffer.byteLength(JSON.stringify(read));assert.ok(frame<=expected.every_serialized_frame_lte);frames.push(frame);continuation=read.data.continuation;}while(continuation);
  assert.deepEqual(Buffer.concat(parts),bytes);assert.equal(offset,expected.concatenated_bytes);receipt.frames=frames;receipt.observed={concatenated_bytes:offset,missing_bytes:0,duplicated_bytes:0};
  receipt.test_build={internal_factory:'createArchiveEngine',receipt_padding_bytes:Buffer.byteLength(padding),public_request_controls_padding:false};
}));

test('AFH-02-T16 UTF8 fragments preserve Unicode and reject a cursor on a different revision',async t=>scenario(t,'AFH-02-T16',async({run,archive,call,fixture,expected,receipt})=>{
  const bytes=Buffer.from(fixture.input.unicode.repeat(100)),input=source(run,'unicode-cursor.jsonl',bytes);const first=await call('archive.ingest',{sources:[input],include_children:false,idempotency_key:'first'});assert.equal(first.error,null);
  const item=manifest(archive,first.data.source_revisions[0]),initial=await call('evidence.read',{uri:item.records[0].evidence_ref.uri,format:'text',max_bytes:5});assert.equal(initial.error,null);assert.ok(initial.data.continuation);const actual=Buffer.from(initial.data.payload);assert.deepEqual(actual,bytes.subarray(0,actual.length));
  const escapedBytes=Buffer.from(JSON.stringify({content:fixture.input.unicode.repeat(100)})+'\n'),escaped=source(run,'escaped-unicode.jsonl',escapedBytes);
  const escapedIngest=await call('archive.ingest',{sources:[escaped],include_children:false,idempotency_key:'escaped'});assert.equal(escapedIngest.error,null);
  const escapedRecord=manifest(archive,escapedIngest.data.source_revisions[0]).records[0];
  const fragments=[];let cursor;do{const fragment=await call('evidence.read',{uri:escapedRecord.evidence_ref.uri,format:'text',max_bytes:7,...(cursor?{continuation:cursor}:{})});assert.equal(fragment.error,null,'A fragment ending within a UTF8 codepoint must trim without replacing bytes');fragments.push(Buffer.from(fragment.data.payload));cursor=fragment.data.continuation;}while(cursor);
  assert.deepEqual(Buffer.concat(fragments),escapedBytes);
  const other=source(run,'other.jsonl','{"role":"user","content":"new revision"}\n');assert.equal((await call('archive.ingest',{sources:[other],include_children:false,idempotency_key:'next'})).error,null);
  const stale=await call('evidence.read',{uri:item.records[0].evidence_ref.uri,format:'text',max_bytes:5,continuation:initial.data.continuation},{},null,archive,publicApi.archiveRequest,'CONTINUATION_MISMATCH');receipt.observed={error:stale.error?.code,lossy_decode:!actual.equals(bytes.subarray(0,actual.length))};assert.deepEqual(receipt.observed,expected);
}));

function occurrenceRows03(archive){
 const pointer=JSON.parse(fs.readFileSync(path.join(archive,'archive.json'))),db=new DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});try{if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='occurrence_version'").get())throw Object.assign(new Error('Published occurrence ledger is absent'),{code:'NOT_IMPLEMENTED'});return db.prepare('SELECT data_json FROM occurrence_version WHERE commit_seq<=? ORDER BY commit_seq').all(pointer.published_seq).map(r=>JSON.parse(r.data_json));}finally{db.close();}
}
test('AFH-02-T04 append preserves actual occurrence identities and adds exactly ten',async t=>scenario(t,'AFH-02-T04',async({run,archive,call,fixture,expected,receipt})=>{
 const rows=n=>Array.from({length:n},(_,i)=>JSON.stringify({role:'user',content:'row-'+i})).join('\n')+'\n',initial=Buffer.from(rows(fixture.input.initial)),input=source(run,'append.jsonl',initial),first=await call('archive.ingest',{sources:[input],idempotency_key:'first'});assert.equal(first.error,null);const old=manifest(archive,first.data.source_revisions[0]);assert.deepEqual(await readManifestBytes(call,old),initial);const before=occurrenceRows03(archive);assert.equal(new Set(before.map(r=>r.id)).size,fixture.input.initial);
 fs.appendFileSync(input.path,rows(fixture.input.append));const second=await call('archive.ingest',{sources:[input],idempotency_key:'second'});assert.equal(second.error,null);const current=manifest(archive,second.data.source_revisions[0]),after=occurrenceRows03(archive),ids=new Set(after.map(r=>r.id)),prior=new Set(before.map(r=>r.id));assert.deepEqual(await readManifestBytes(call,current),fs.readFileSync(input.path));for(const record of old.records){const read=await call('evidence.read',{uri:record.evidence_ref.uri,format:'base64'},{},first.data.revision_id);assert.equal(hash(Buffer.from(read.data.payload,'base64')),record.sha256);}assert.equal((await call('archive.verify',{deep:true})).data.passed,true);receipt.observed={old_occurrence_ids_unchanged:[...prior].filter(id=>ids.has(id)).length,new_records:[...ids].filter(id=>!prior.has(id)).length,prefix_verified:current.prefix_relation.kind==='APPEND'&&current.prefix_relation.reused_records===fixture.input.initial};receipt.occurrence_rows={before,after};assert.deepEqual(receipt.observed,expected);
}));
test('AFH-02-T07 completing a partial tail preserves both revisions without phantom occurrences',async t=>scenario(t,'AFH-02-T07',async({run,archive,call,fixture,expected,receipt})=>{
 const initial=Buffer.from(fixture.input.tail),input=source(run,'tail.jsonl',initial),first=await call('archive.ingest',{sources:[input],idempotency_key:'first'});assert.equal(first.error,null);const old=manifest(archive,first.data.source_revisions[0]);assert.deepEqual(await readManifestBytes(call,old),initial);const before=occurrenceRows03(archive);fs.appendFileSync(input.path,fixture.input.append);const second=await call('archive.ingest',{sources:[input],idempotency_key:'second'});assert.equal(second.error,null);const current=manifest(archive,second.data.source_revisions[0]),after=occurrenceRows03(archive),oldRead=await call('evidence.read',{uri:old.records[0].evidence_ref.uri,format:'base64'},{},first.data.revision_id);assert.deepEqual(await readManifestBytes(call,current),fs.readFileSync(input.path));assert.equal((await call('archive.verify',{deep:true})).data.passed,true);receipt.observed={raw_tail_preserved:Buffer.from(oldRead.data.payload,'base64').equals(initial),after_complete_records:current.records.filter(r=>r.includes_terminator&&r.parse_status==='PARSED').length,phantom_occurrences:before.filter(r=>r.kind.startsWith('tool')||r.kind==='execution').length+after.filter(r=>r.kind.startsWith('tool')||r.kind==='execution').length};receipt.occurrence_rows={before,after};assert.deepEqual(receipt.observed,expected);
}));

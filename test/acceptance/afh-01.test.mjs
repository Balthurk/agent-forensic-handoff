import assert from 'node:assert/strict';
import {assertReadObservation,compareReadInventory} from '../../src/archive/reader-observation.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sqlite, { DatabaseSync, constants as sqliteConstants } from 'node:sqlite';
import { auditSession, readEvidence, showEvent, loadManifest, verifyCaseIntegrity, archiveRequest } from '../../src/index.js';
import Ajv2020 from '../../tools/specification/node_modules/ajv/dist/2020.js';
import addFormats from '../../tools/specification/node_modules/ajv-formats/dist/index.js';
import {digest, relationalWireChecks} from '../../specification/validate-package.mjs';
import { runtimeSnapshot, snapshotStability, inspectNativeIdentity, assertNativeIdentityObservation } from '../../specification/contract-checks.mjs';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const registry = JSON.parse(fs.readFileSync(path.join(checkout, 'specification/contracts.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(checkout, 'specification/fixtures/critical-contracts.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const wireSchema=JSON.parse(fs.readFileSync(path.join(checkout,'schemas/archive-v4.schema.json'))),ajv=new Ajv2020({allErrors:true,strict:true,validateFormats:true});addFormats(ajv);ajv.addSchema(wireSchema);
const validateRequest=ajv.compile({$ref:wireSchema.$id+'#/$defs/Request'}),validateResponse=ajv.compile({$ref:wireSchema.$id+'#/$defs/Response'});
const archiveOrigins=['generic','codex','claude'].map((harness,i)=>({id:'00000000-0000-4000-8000-00000000040'+i,harness,descriptor:'Synthetic identity integration origin'}));
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

test('M02-R3 residual execution provenance harness01',async t=>archiveScenario(t,'AFH-01-T17',readerExecutionCalibration));
test('M02-R3 actual harness01 and closure consumer reject incomplete read proofs',async t=>archiveScenario(t,'AFH-01-T17',readerConsumerCalibration));
async function archiveScenario(t,id,body){
  const run=createRun(id),archive=path.join(run,'archive'),contract=registry.scenarios.find(s=>s.id===id),before=runtimeSnapshot(checkout),receipt={scenario_id:id,role:'COMPONENT_OBSERVATION',acceptance_eligible:false,input_class:'SYNTHETIC',runtime_class:'REAL_AFH',provider_class:'NONE',candidate_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim(),runner_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),runtime_before:before,fixture_sha256:contract.fixture_ref.sha256,oracle_sha256:contract.oracle_ref.sha256,requests:[],phase:'PRECONDITION'};let index=0;
  readerFixtureRoots.add(run);const invoke=async(operation,params,overrides={},expectation=null,transform=null)=>{const request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:id+'-'+(++index),operation,archive,revision_id:null,params,...overrides};if(request.protocol_version==='4.0')assert.equal(validateRequest(request),true,JSON.stringify(validateRequest.errors));let response;if(['evidence.read','archive.verify','scope.resolve'].includes(operation)){const observed=await observeArchiveReader(request.archive,()=>archiveRequest(request));const original=transform?structuredClone(observed):null;if(transform)transform(observed);response=observed.result;const observation={operation,request_id:request.request_id,expectation,...observed.observation};try{if(observed.error)throw observed.error;observation.outcome=assertReadObservation({request,response,observation,expectation});(receipt.read_only_observations??=[]).push(observation);}catch(error){(receipt.read_only_rejections??=[]).push({request,response,observation,error:{code:error.code,message:error.message},...(original?{calibration_original:original}: {})});throw error;}}else response=await archiveRequest(request);receipt.requests.push({request,response});if(!validateResponse(response))throw Object.assign(new Error(JSON.stringify(validateResponse.errors)),{code:'SCHEMA_PRECONDITION'});if(response.error?.code==='NOT_IMPLEMENTED')throw Object.assign(new Error(response.error.message),{code:'NOT_IMPLEMENTED'});let pair=null;if(operation==='evidence.read'&&response.data){const pointer=JSON.parse(fs.readFileSync(path.join(archive,'archive.json'))),revision=JSON.parse(fs.readFileSync(path.join(archive,'revisions',pointer.revision_id+'.json')));const matches=revision.source_manifest_ids.flatMap(id=>{const source=JSON.parse(fs.readFileSync(path.join(archive,'bronze/sources',id+'.json')));return source.records.filter(record=>record.evidence_ref.uri===params.uri).map(record=>({source,record}));});assert.equal(matches.length,1);const {source,record}=matches[0],state={archive_id:pointer.archive_id,revision_id:pointer.revision_id,source_revision_id:source.source_revision_id,uri:params.uri,json_pointer:params.json_pointer??'',format:params.format??'text',initial_offset:'0',extent_bytes:String(record.byte_length),record_sha256:record.sha256};pair={request,state:{...state,request_extent_sha256:hash(canonical(state)),original_extent_bytes:record.original_extent_bytes}};}const problems=relationalWireChecks(response,registry,pair);if(problems.length)throw Object.assign(new Error(problems.join(',')),{code:'WIRE_PRECONDITION'});return response;};
  const ingest=async(name,records,{harness='generic',native_id,source_lineage_id}={})=>{const file=path.join(run,name),bytes=records.map(JSON.stringify).join('\n')+'\n';fs.writeFileSync(file,bytes,{flag:'wx'});const input={path:file,harness,origin_domain_id:archiveOrigins.find(o=>o.harness===harness).id,...(native_id?{native_id}:{}),...(source_lineage_id?{source_lineage_id}:{})};const result=await invoke('archive.ingest',{sources:[input],include_children:false,idempotency_key:name});assert.equal(result.error,null);const source=JSON.parse(fs.readFileSync(path.join(archive,'bronze/sources',result.data.source_revisions[0]+'.json')));for(const record of source.records){const read=await invoke('evidence.read',{uri:record.evidence_ref.uri,format:'base64'});assert.equal(read.error,null);assert.equal(hash(Buffer.from(read.data.payload,'base64')),record.sha256);}assert.equal(hash(fs.readFileSync(file)),hash(Buffer.from(bytes)));return {input,source,result,bytes};};
  const ledger=table=>{assert.ok(['session_version','association_version','source_revision'].includes(table));const db=new DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});try{return db.prepare('SELECT * FROM '+table).all().map(row=>row.data_json?JSON.parse(row.data_json):row);}finally{db.close();}};
  const stopProcesses=observeArchiveProcesses(run,receipt);
  try{assert.equal(hash(canonical(fixtures.cases[id])),contract.fixture_ref.sha256);assert.equal(hash(canonical(fixtures.oracles[id])),contract.oracle_ref.sha256);assert.equal((await invoke('archive.init',{idempotency_key:'init',origin_domains:archiveOrigins})).error,null);receipt.phase='BEHAVIOR';await body({run,archive,invoke,probeRead:(transform)=>invoke('archive.verify',{deep:true},{},null,transform),negativeRead:(expected='EVIDENCE_UNAVAILABLE')=>invoke('evidence.read',{uri:'afh://evidence/sha256/'+'0'.repeat(64)+'/record/1#bytes=0:1',format:'base64'},{},expected),ingest,ledger,fixture:fixtures.cases[id],expected:fixtures.oracles[id].expected,receipt});receipt.status='GREEN_BEHAVIOR';}catch(error){receipt.status=error.code==='NOT_IMPLEMENTED'?'NOT_IMPLEMENTED':error.code==='ERR_ASSERTION'&&receipt.phase==='BEHAVIOR'?'RED_BEHAVIOR':'ERROR_MECHANICAL_OR_PRECONDITION';receipt.reason=error.message;if(receipt.status==='NOT_IMPLEMENTED')t.skip(receipt.reason);else throw error;}finally{readerFixtureRoots.delete(run);stopProcesses();assert.equal(receipt.process_execution_observation.unexpected,0);receipt.runtime_after=runtimeSnapshot(checkout);receipt.stability=snapshotStability(before,receipt.runtime_after);fs.writeFileSync(path.join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});t.diagnostic('Evidence: '+path.join(run,'receipt.json'));assert.equal(receipt.stability.stable,true);}
}
function association(source,id,project_id,workspace=null,state='associated',checkout=null){return {association_id:id,expected_revision_id:null,branch_id:'main',session_id:source.session_id,project_id,workspace,checkout,association_state:state,valid_from:{kind:'unknown',value:null,precision:'order_only',timezone:null},valid_to:{kind:'open',value:null,precision:'order_only',timezone:null},evidence_refs:[source.records[0].evidence_ref]};}
test('Association controls preserve temporal bounds idempotence and pinned scope while rejecting stale writes',async t=>archiveScenario(t,'AFH-01-T13',async({archive,ingest,invoke,receipt})=>{
  receipt.validation_role='INHERITED_ASSOCIATION_TIME_SCOPE_IDEMPOTENCE';const {source}=await ingest('association-controls.jsonl',[{role:'user',content:'Association observation'}]);
  const a=association(source,'control','project-a'),first=await invoke('association.record',{idempotency_key:'first',changes:[a]});assert.equal(first.error,null);const firstRevision=first.data.revisions[0],firstCapture=first.receipt.revision_id;
  const same=await invoke('association.record',{idempotency_key:'first',changes:[a]});assert.deepEqual(same.data,first.data);assert.deepEqual(same.receipt,first.receipt);
  const b={...a,project_id:'project-b',expected_revision_id:firstRevision.revision_id,valid_from:{kind:'known',value:'2026-01-01T00:00:00.000000001Z',precision:'ns',timezone:'UTC'},valid_to:{kind:'known',value:'2026-01-01T00:00:00.000000002Z',precision:'ns',timezone:'UTC'}};
  const second=await invoke('association.record',{idempotency_key:'second',changes:[b]});assert.equal(second.error,null);assert.deepEqual(second.data.revisions[0].valid_from,b.valid_from);assert.deepEqual(second.data.revisions[0].valid_to,b.valid_to);assert.equal(second.data.revisions[0].supersedes_revision_id,firstRevision.revision_id);
  const oldScope=await invoke('scope.resolve',{active_context:{session_id:source.session_id}},{revision_id:firstCapture}),currentScope=await invoke('scope.resolve',{active_context:{session_id:source.session_id}});assert.equal(oldScope.data.effective_scope.project_id,'project-a');assert.equal(currentScope.data.effective_scope.project_id,'project-b');
  const pointer=fs.readFileSync(path.join(archive,'archive.json')),stale=await invoke('association.record',{idempotency_key:'stale',changes:[a]});assert.equal(stale.error?.code,'REVISION_CONFLICT');assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),pointer);
  const conflict=await invoke('association.record',{idempotency_key:'second',changes:[{...b,project_id:'different'}]});assert.equal(conflict.error?.code,'IDEMPOTENCY_CONFLICT');assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),pointer);
  const invalid={...b,expected_revision_id:second.data.revisions[0].revision_id,valid_from:b.valid_to,valid_to:b.valid_from};const rejected=await invoke('association.record',{idempotency_key:'invalid-time',changes:[invalid]});assert.equal(rejected.error?.code,'INVALID_TEMPORAL_RANGE');assert.deepEqual(fs.readFileSync(path.join(archive,'archive.json')),pointer);
  receipt.observed={temporal_bound_bytes_preserved:true,pinned_scope_preserved:true,stale_branch_rejected:true,idempotent_original_receipt:true,invalid_time_rejected:true};
}));

test('AFH-01-T02 archive retains parent and two children as three native owners with one grouping',async t=>archiveScenario(t,'AFH-01-T02',async({ingest,ledger,fixture,expected,receipt})=>{
  const captured=[];for(const native of fixture.input.native_ids){const records=[{type:'session_meta',payload:{id:native,session_id:fixture.input.shared_id}}];if(native==='parent')for(const child of fixture.input.native_ids.slice(1))records.push({type:'event_msg',payload:{type:'item_completed',item:{type:'SubAgentActivity',agent_thread_id:child,kind:'spawned'}}});captured.push((await ingest(native+'.jsonl',records,{harness:'codex'})).source);}
  const edges=captured.flatMap(s=>s.records.flatMap(r=>r.events.flatMap(e=>e.session_edges)));assert.equal(edges.filter(e=>e.type==='SPAWNED').length,2);
  receipt.observed={sessions:new Set(ledger('session_version').map(s=>s.id)).size,owners_per_source:Math.max(...captured.map(s=>new Set(s.records.flatMap(r=>r.events.map(e=>e.session_id))).size)),groupings:new Set(captured.flatMap(s=>s.records.flatMap(r=>r.events.map(e=>e.session_metadata.grouping_native_id))).filter(Boolean)).size};assert.deepEqual(receipt.observed,expected);
}));
test('AFH-01-T04 archive namespaces native IDs by harness',async t=>archiveScenario(t,'AFH-01-T04',async({ingest,fixture,expected,receipt})=>{const sessions=[];for(const harness of fixture.input.harnesses)sessions.push((await ingest(harness+'.jsonl',[{session_id:fixture.input.native_id,role:'user',content:'identity'}],{harness,native_id:fixture.input.native_id})).source.session_id);receipt.observed={native_sessions:new Set(sessions).size,collision:sessions[0]===sessions[1]};assert.deepEqual(receipt.observed,expected);}));
test('AFH-01-T05 missing native ID remains uncertain and provisional',async t=>archiveScenario(t,'AFH-01-T05',async({ingest,expected,receipt})=>{const {source}=await ingest('one.jsonl',[{role:'user',content:'No native owner supplied'}]);assert.equal(source.native_id,null);receipt.observed={identity_status:source.identity_status,provisional:source.provisional};assert.deepEqual(receipt.observed,expected);}));
test('AFH-01-T06 explicit relocation preserves lineage and both location observations',async t=>archiveScenario(t,'AFH-01-T06',async({run,archive,ingest,invoke,fixture,expected,receipt})=>{const first=await ingest('from.jsonl',[{role:'user',content:'relocated'}],{source_lineage_id:fixture.input.lineage}),relocated=path.join(run,'to.jsonl');fs.copyFileSync(first.input.path,relocated);const result=await invoke('archive.ingest',{sources:[{...first.input,path:relocated}],include_children:false,idempotency_key:'relocated'});assert.equal(result.error,null);const current=JSON.parse(fs.readFileSync(path.join(archive,'bronze/sources',result.data.source_revisions[0]+'.json')));receipt.observed={lineages:new Set([first.source.source_lineage_id,current.source_lineage_id]).size,location_observations:current.location_observations?.length??0};assert.deepEqual(receipt.observed,expected);assert.deepEqual(new Set(current.location_observations.map(o=>o.path)),new Set([first.input.path,relocated]));}));
for(const suffix of ['08','09'])test('AFH-01-T'+suffix+' explicit projects are not merged by remote or name',async t=>archiveScenario(t,'AFH-01-T'+suffix,async({ingest,invoke,ledger,fixture,expected,receipt})=>{const projects=fixture.input.projects??fixture.input.names;for(const [i,project]of projects.entries()){const {source}=await ingest('project-'+i+'.jsonl',[{role:'user',content:JSON.stringify(fixture.input)}]);const checkout=fixture.input.remote?{id:'checkout-'+i,repository_id:fixture.input.remote,head:null,worktree:false}:null;assert.equal((await invoke('association.record',{idempotency_key:'assoc-'+i,changes:[association(source,'a-'+i,project,null,'associated',checkout)]})).error,null);}const actual=new Set(ledger('association_version').map(a=>a.change.project_id));receipt.observed={projects:actual.size,auto_merge:actual.size!==projects.length};assert.deepEqual(receipt.observed,expected);}));
test('AFH-01-T13 preserves projectless no_workspace and unknown separately',async t=>archiveScenario(t,'AFH-01-T13',async({ingest,invoke,ledger,fixture,expected,receipt})=>{for(const state of fixture.input.states){const {source}=await ingest(state+'.jsonl',[{role:'user',content:state}]);assert.equal((await invoke('association.record',{idempotency_key:state,changes:[association(source,state,null,null,state)]})).error,null);}const changes=ledger('association_version').map(a=>a.change);receipt.observed={distinct_states:new Set(changes.map(a=>a.association_state)).size,invented_project:changes.some(a=>a.project_id!==null)};assert.deepEqual(receipt.observed,expected);}));
test('AFH-01-T16 explicit project overrides active scope with disclosure',async t=>archiveScenario(t,'AFH-01-T16',async({invoke,fixture,expected,receipt})=>{const result=await invoke('scope.resolve',{active_context:{project_id:fixture.input.active},explicit_scope:{project_id:fixture.input.explicit,session_ids:[],group_id:null,association_mode:'observed'}});assert.equal(result.error,null);receipt.observed={effective:result.data.effective_scope.project_id,disclosed:result.data.resolution==='EXPLICIT'&&result.receipt.scope.project_id===fixture.input.explicit&&result.receipt.warnings.length>0};assert.deepEqual(receipt.observed,expected);}));
test('AFH-01-T17 ambiguous observed workspace returns candidates and no selected project',async t=>archiveScenario(t,'AFH-01-T17',async({ingest,invoke,fixture,expected,receipt})=>{for(const project of ['a','b']){const {source}=await ingest(project+'.jsonl',[{role:'user',content:'ambiguous workspace'}]);assert.equal((await invoke('association.record',{idempotency_key:project,changes:[association(source,project,project,{host_id:'synthetic-host',path:fixture.input.path,path_flavor:'windows',case_mode:'unknown'})]})).error,null);}const result=await invoke('scope.resolve',{active_context:{workspace:fixture.input.path}});assert.equal(result.error,null);assert.equal(result.data.candidates.length,2);receipt.observed={resolution:result.data.resolution,selected:result.data.effective_scope};assert.deepEqual(receipt.observed,expected);}));
test('AFH-01-T18 association paths preserve Windows Unicode and UNC without probing them',async t=>archiveScenario(t,'AFH-01-T18',async({ingest,invoke,ledger,fixture,expected,receipt})=>{
  const restorers=[],probes=[],methods=['access','exists','lstat','stat','statfs','realpath','readdir','opendir','readFile','open','readlink','watch','watchFile','createReadStream'];
  function watch(object,name){if(typeof object[name]!=='function')return;const prior=object[name];object[name]=function(file,...args){const text=file instanceof URL?fileURLToPath(file):typeof file==='string'?file:null;if(text&&(text.startsWith('\\\\')||fixture.input.paths.some(original=>text===original||text.startsWith(original+'\\')||text.startsWith(original+'/')))){probes.push({method:name,path:text});throw new Error('Historical association path must not be probed');}return prior.call(this,file,...args);};restorers.push(()=>{object[name]=prior;});}
  for(const method of methods){watch(fs,method);watch(fs,method+'Sync');watch(fs.promises,method);}syncBuiltinESMExports();
  try{for(const [i,original]of fixture.input.paths.entries()){
    const {source}=await ingest('path-'+i+'.jsonl',[{role:'user',content:original}]);assert.equal((await invoke('association.record',{idempotency_key:'p'+i,changes:[association(source,'p'+i,'project-'+i,{host_id:'synthetic-host',path:original,path_flavor:original.startsWith('\\\\')?'unc':'windows',case_mode:fixture.input.case_mode})]})).error,null);
    const scope=await invoke('scope.resolve',{active_context:{workspace:original}});assert.equal(scope.error,null);assert.equal(scope.data.effective_scope.project_id,'project-'+i);
  }}finally{for(const restore of restorers.reverse())restore();syncBuiltinESMExports();receipt.historical_path_probe_observation={watched_methods:methods,attempts:probes};}
  assert.equal(probes.length,0);const workspaces=ledger('association_version').map(a=>a.change.workspace);receipt.observed={original_paths_preserved:canonical(workspaces.map(w=>w.path))===canonical(fixture.input.paths),auto_case_fold:workspaces.some(w=>w.case_mode!=='unknown')};assert.deepEqual(receipt.observed,expected);
}));
test('AFH-01-T20 incompatible protocol rejects association before any write',async t=>archiveScenario(t,'AFH-01-T20',async({archive,ingest,invoke,fixture,expected,receipt})=>{const {source}=await ingest('protocol.jsonl',[{role:'user',content:'protocol'}]),before=fileInventory(archive);const result=await invoke('association.record',{idempotency_key:'protocol',changes:[association(source,'protocol','p')]},{protocol_version:fixture.input.protocol_version});receipt.observed={error:result.error?.code,writes:canonical(fileInventory(archive))===canonical(before)?0:1};assert.deepEqual(receipt.observed,expected);}));
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
function rows(caseDir, sql) {
  const db = new DatabaseSync(path.join(caseDir, 'case.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); }
}
function createRun(id) {
  const base = process.env.AFH_ACCEPTANCE_RUN || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, id + '-'));
}
function fileInventory(root) {
  const result = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, 'Inventory must not silently traverse links');
      if (stat.isDirectory()) visit(file);
      else result.push({ path: path.relative(root, file), bytes: stat.size, sha256: hash(fs.readFileSync(file)) });
    }
  }
  visit(root);
  return result;
}
async function observeExecution(run, receipt, body) {
  const methods = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];
  const originals = Object.fromEntries(methods.map(method => [method, childProcess[method]]));
  const currentGitReads = [['rev-parse', 'HEAD'], ['branch', '--show-current'], ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']];
  const observed = { permitted_current_workspace_reads: [], other_process_calls: [], scope: 'All node:child_process APIs during this scenario body; real current-state Git reads allowed only inside this new RUN.' };
  for (const method of methods) childProcess[method] = function(command, args, options) {
    const cwd = path.resolve(options?.cwd || '.'), relative = path.relative(run, cwd);
    const allowed = method === 'spawnSync' && command === 'git' && currentGitReads.some(list => canonical(list) === canonical(args)) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    (allowed ? observed.permitted_current_workspace_reads : observed.other_process_calls).push({ method, command, args, cwd });
    if (!allowed) throw new Error('Unexpected process execution in forensic scenario');
    return originals[method].apply(this, arguments);
  };
  syncBuiltinESMExports();
  try { await body(); }
  finally {
    Object.assign(childProcess, originals); syncBuiltinESMExports();
    receipt.control_observations.NO_HISTORICAL_EXECUTION = observed;
  }
  assert.equal(observed.other_process_calls.length, 0);
}
async function observeLegacyCase(caseDir, receipt) {
  const before = fileInventory(caseDir), manifest = loadManifest(caseDir);
  const schema = rows(caseDir, 'SELECT schema_version FROM ingest_run');
  assert.equal(manifest.schemaVersion, 3);
  assert.ok(schema.length > 0);
  assert.ok(schema.every(row => row.schema_version === 3));
  const events = rows(caseDir, 'SELECT id FROM event ORDER BY id');
  assert.ok(events.length > 0);
  for (const event of events) assert.equal(showEvent(caseDir, event.id).id, event.id);
  const sources = rows(caseDir, 'SELECT id,canonical_sha256 FROM source');
  const records = rows(caseDir, 'SELECT * FROM source_record ORDER BY source_id,ordinal');
  const resolved = [];
  for (const record of records) {
    const source = sources.find(item => item.id === record.source_id);
    const uri = `afh://evidence/sha256/${source.canonical_sha256}/record/${record.ordinal}#bytes=${record.byte_offset}:${record.byte_length}`;
    const read = readEvidence(caseDir, uri), digest = hash(Buffer.from(read.text));
    assert.equal(digest, record.sha256);
    resolved.push({ uri, sha256: digest });
  }
  const integrity = await verifyCaseIntegrity(caseDir);
  assert.equal(integrity.passed, true);
  assert.deepEqual(fileInventory(caseDir), before);
  receipt.control_observations.LEGACY_SCHEMA_IDENTITY = { manifest_schema: 3, ingest_run: schema, sql_schema_sha256: hash(fs.readFileSync(path.join(checkout, 'src/schema.sql'))) };
  receipt.control_observations.READ_ONLY_INVENTORY = { before, after: fileInventory(caseDir), operations: ['showEvent', 'readEvidence', 'verifyCaseIntegrity'], event_count: events.length };
  receipt.control_observations.PROVENANCE_RESOLUTION = { case_dir: caseDir, records: resolved, integrity };
  receipt.control_observations.LOSS_GUARD = { record_count: records.length, source_count: sources.length, resolved_record_count: resolved.length, integrity };
}
async function scenario(t, id, body) {
  const run = createRun(id), contract = registry.scenarios.find(s => s.id === id);
  const before = runtimeSnapshot(checkout);
  const receipt = {
    scenario_id: id, role: 'COMPONENT_OBSERVATION', acceptance_eligible: false,
    input_class: 'SYNTHETIC', runtime_class: 'REAL_AFH', provider_class: 'NONE',
    evidence_kind: contract.evidence_kind, oracle_sha256: contract.oracle_ref.sha256,
    candidate_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
    node: process.version, platform: process.platform, arch: process.arch,
    runtime_before: before, runner_sha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    control_observations: {},
    required_checks: Object.fromEntries(contract.required_checks.map(k => [k, 'PENDING'])),
    classification_phase: 'PRECONDITION',
    scope_note: 'Direct frozen oracle; inherited checks need individually applicable evidence before FULL_ACCEPTANCE.'
  };
  try {
    assert.equal(hash(canonical(fixtures.cases[id])), contract.fixture_ref.sha256);
    assert.equal(hash(canonical(fixtures.oracles[id])), contract.oracle_ref.sha256);
    const fixture = fixtures.cases[id];
    assert.equal(hash(canonical(fixtures.datasets[fixture.dataset_ref.split('/').at(-1)])), fixture.dataset_sha256);
    receipt.required_checks.EXACT_INPUT_IDENTITY = 'PASS';
    receipt.control_observations.EXACT_INPUT_IDENTITY = { fixture_sha256: contract.fixture_ref.sha256, oracle_sha256: contract.oracle_ref.sha256, dataset_sha256: fixture.dataset_sha256, actual_hashes_matched: true };
    await observeExecution(run, receipt, () => body({ run, fixture, expected: fixtures.oracles[id].expected, receipt }));
    receipt.status = 'GREEN_BEHAVIOR';
  } catch (error) {
    receipt.status = error.code === 'NOT_IMPLEMENTED' ? 'NOT_IMPLEMENTED'
      : error.code === 'UNAVAILABLE' ? 'UNAVAILABLE'
      : error.code === 'ERR_ASSERTION' && receipt.classification_phase === 'BEHAVIOR' ? 'RED_BEHAVIOR' : 'ERROR_MECHANICAL_OR_PRECONDITION';
    receipt.reason = error.message;
    if (['NOT_IMPLEMENTED', 'UNAVAILABLE'].includes(receipt.status)) t.skip(receipt.status + ': ' + error.message);
    else throw error;
  } finally {
    receipt.runtime_after = runtimeSnapshot(checkout);
    receipt.stability = snapshotStability(before, receipt.runtime_after);
    if (!receipt.stability.stable) receipt.status = 'EVIDENCE_UNSTABLE';
    fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    t.diagnostic('Evidence: ' + path.join(run, 'receipt.json'));
    assert.equal(receipt.stability.stable, true, 'Owned runtime changed during observation');
  }
}

test('AFH-01-T01 native owner, separate grouping, content, actor and every record remain resolvable', async t => {
  await scenario(t, 'AFH-01-T01', async ({ run, fixture, expected, receipt }) => {
    const marker = 'Work assigned to the child.';
    const records = [
      { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: fixture.input.native_id, session_id: fixture.input.shared_id, cwd: '.', cli_version: 'synthetic-spec-v1' } },
      { timestamp: '2026-01-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', id: 'message-1', role: 'user', content: [{ type: 'input_text', text: marker }] } }
    ];
    const source = path.join(run, 'source.jsonl'), bytes = records.map(JSON.stringify).join('\n') + '\n';
    fs.writeFileSync(source, bytes, { flag: 'wx' });
    const sourceHash = hash(Buffer.from(bytes));
    const audit = await auditSession(source, { harness: 'codex', caseDir: path.join(run, 'case'), workspace: run, includeChildren: false });
    // Preconditions are checked separately from the behavior assertion.
    const integrity = await verifyCaseIntegrity(audit.caseDir);
    if (!integrity.passed) throw new Error('Acquisition integrity precondition failed');
    assert.equal(hash(fs.readFileSync(source)), sourceHash);
    receipt.source_sha256 = sourceHash;
    receipt.case_hash = audit.caseHash;
    receipt.required_checks.IMMUTABLE_SOURCE_INVENTORY = 'PASS';
    receipt.control_observations.IMMUTABLE_SOURCE_INVENTORY = { source, before_sha256: sourceHash, after_sha256: hash(fs.readFileSync(source)) };
    const acquired = rows(audit.caseDir, 'SELECT * FROM source_record ORDER BY ordinal');
    assert.equal(acquired.length, records.length);
    for (const row of acquired) {
      const uri = `afh://evidence/sha256/${sourceHash}/record/${row.ordinal}#bytes=${row.byte_offset}:${row.byte_length}`;
      const resolved = readEvidence(audit.caseDir, uri);
      // Legacy schema3 uses zero-based ordinals; v4 must not rewrite this convention.
      assert.equal(resolved.text, JSON.stringify(records[row.ordinal]));
      assert.equal(hash(Buffer.from(resolved.text)), row.sha256);
    }
    const message = rows(audit.caseDir, "SELECT e.*, a.kind AS actor_kind, a.role AS actor_role FROM event e JOIN actor a ON a.id=e.actor_id WHERE e.kind='message.user'");
    assert.equal(message.length, 1);
    assert.equal(message[0].actor_kind, 'HUMAN_USER');
    assert.equal(message[0].actor_role, 'user');
    const refs = rows(audit.caseDir, 'SELECT uri FROM evidence_ref');
    assert.ok(refs.length >= 2);
    assert.ok(refs.some(ref => readEvidence(audit.caseDir, ref.uri).text === JSON.stringify(records[1])));
    receipt.required_checks.LOSS_GUARD = 'PASS';
    receipt.required_checks.PROVENANCE_RESOLUTION = 'PASS';
    const repeat = await auditSession(source, { harness: 'codex', caseDir: audit.caseDir, workspace: run, includeChildren: false });
    assert.equal(repeat.reused, true);
    assert.equal(repeat.caseHash, audit.caseHash);
    receipt.legacy_snapshot_reuse = 'PASS';
    receipt.observed = await inspectNativeIdentity(audit.caseDir, expected);
    receipt.classification_phase = 'BEHAVIOR';
    assertNativeIdentityObservation(receipt.observed, expected);
    // A shared grouping alone cannot manufacture a causal parent link.
    assert.equal(rows(audit.caseDir, 'SELECT * FROM session_edge').length, 0);
    await observeLegacyCase(audit.caseDir, receipt);
    assert.equal(hash(fs.readFileSync(source)), sourceHash);
    receipt.control_observations.LEGACY_REGRESSION = { same_case_reused: repeat.reused, case_hash: repeat.caseHash, actor_kind: message[0].actor_kind, actor_role: message[0].actor_role, grouping_does_not_infer_parent: true };
  });
});

test('AFH-01-T03 an ambiguous alias keeps both origins and selects neither', async t => {
  await scenario(t, 'AFH-01-T03', async ({ run, fixture, expected, receipt }) => {
    const modulePath = path.join(checkout, 'src/archive/identity.js');
    if (!fs.existsSync(modulePath)) throw Object.assign(new Error('Native identity module is absent'), { code: 'NOT_IMPLEMENTED' });
    const identity = await import('../../src/archive/identity.js');
    if (typeof identity.resolveNativeAlias !== 'function') throw Object.assign(new Error('resolveNativeAlias is absent'), { code: 'NOT_IMPLEMENTED' });
    const entries = fixture.input.origins.map((origin, i) => {
      const raw = JSON.stringify({ harness: 'codex', origin_domain_id: origin, native_id: 'repeat' });
      const file = path.join(run, `origin-${i}.json`);
      fs.writeFileSync(file, raw, { flag: 'wx' });
      return { harness: 'codex', origin_domain_id: origin, native_id: 'repeat', evidence_refs: [{ path: file, sha256: hash(raw) }] };
    });
    const original = structuredClone(entries);
    receipt.classification_phase = 'BEHAVIOR';
    const result = identity.resolveNativeAlias(entries, fixture.input.alias);
    receipt.observed = result;
    assert.equal(result.error, expected.error);
    assert.equal(result.candidates.length, expected.candidates);
    assert.equal(result.selected, expected.selected);
    assert.deepEqual(entries, original);
    assert.deepEqual(result.candidates.map(c => c.origin_domain_id).sort(), fixture.input.origins.toSorted());
    for (const candidate of result.candidates) for (const ref of candidate.evidence_refs) assert.equal(hash(fs.readFileSync(ref.path)), ref.sha256);
    assert.deepEqual(identity.resolveNativeAlias([...entries].reverse(), fixture.input.alias), result);
    const exactIds = entries.map(entry => 'ses4-' + hash(JSON.stringify([entry.harness, entry.origin_domain_id, entry.native_id])));
    assert.deepEqual(result.candidates.map(candidate => candidate.id).sort(), exactIds.toSorted());
    assert.equal(new Set(exactIds).size, entries.length);
    assert.deepEqual(entries.map(identity.nativeSessionId), structuredClone(entries).map(identity.nativeSessionId));
    receipt.control_observations.IDENTITY_STABILITY = { exact_ids: exactIds, reordered_inputs_same_result: true, cloned_inputs_same_ids: true };
    receipt.control_observations.IMMUTABLE_SOURCE_INVENTORY = { before: original, after: entries, raw_hashes_reopened: true };
    receipt.control_observations.LOSS_GUARD = { input: original, result, no_selection: result.selected === null };
    receipt.control_observations.PROVENANCE_RESOLUTION = { candidates: result.candidates, every_ref_reopened_and_hashed: true };
    receipt.required_checks.LOSS_GUARD = 'PASS';
    receipt.required_checks.PROVENANCE_RESOLUTION = 'PASS';
  });
});

test('AFH-01-T19 reject reparse acquisition before reading target bytes', async t => {
  await scenario(t, 'AFH-01-T19', async ({ run, expected, receipt }) => {
    const allowed = path.join(run, 'allowed'), external = path.join(run, 'outside-authorized-root');
    fs.mkdirSync(allowed); fs.mkdirSync(external);
    const sentinel = path.join(external, 'outside-sentinel.jsonl');
    const content = '{"session_id":"outside","role":"user","content":"synthetic sentinel"}\n';
    fs.writeFileSync(sentinel, content, { flag: 'wx' });
    const link = path.join(allowed, 'linked');
    try { fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { throw Object.assign(new Error('Cannot create real reparse fixture: ' + error.code), { code: 'UNAVAILABLE' }); }
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    let externalReads = 0;
    const originals = {};
    for (const method of ['readFileSync', 'createReadStream', 'openSync']) {
      originals[method] = fs[method];
      fs[method] = function (file, ...args) {
        if (String(file).includes('outside-sentinel.jsonl')) externalReads++;
        return originals[method].call(this, file, ...args);
      };
    }
    const observations = [];
    try {
      for (const target of [link, path.join(link, 'outside-sentinel.jsonl')]) {
        let error = null;
        try { await auditSession(target, { harness: 'generic', caseDir: path.join(run, 'case-' + observations.length), workspace: allowed, includeChildren: false }); }
        catch (caught) { error = caught.code ?? null; }
        observations.push({ error, external_reads: externalReads });
      }
    } finally { for (const [method, original] of Object.entries(originals)) fs[method] = original; }
    receipt.observed = observations;
    assert.equal(fs.readFileSync(sentinel, 'utf8'), content);
    receipt.classification_phase = 'BEHAVIOR';
    for (const observed of observations) assert.deepEqual(observed, expected);
    assert.equal(fs.existsSync(path.join(run, 'case-0')), false);
    assert.equal(fs.existsSync(path.join(run, 'case-1')), false);
    receipt.control_observations.IMMUTABLE_SOURCE_INVENTORY = { source: sentinel, before_sha256: hash(content), after_sha256: hash(fs.readFileSync(sentinel)), external_reads: externalReads };
    // An ordinary authorized source supplies the real legacy-version/regression control.
    // Its historical command is inert corpus data and must never create this marker.
    const marker = path.join(run, 'historical-execution-marker');
    const command = process.execPath + ' -e ' + JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`);
    const ordinary = path.join(allowed, 'authorized.jsonl');
    const positiveRecords = [
      { type: 'session_meta', payload: { id: 'safety-control', cwd: run } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'historical-call', arguments: JSON.stringify({ command }) } }
    ];
    const positiveBytes = positiveRecords.map(JSON.stringify).join('\n') + '\n';
    fs.writeFileSync(ordinary, positiveBytes, { flag: 'wx' });
    const positive = await auditSession(ordinary, { harness: 'codex', caseDir: path.join(run, 'ordinary-case'), workspace: run, includeChildren: false });
    await observeLegacyCase(positive.caseDir, receipt);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(ordinary, 'utf8'), positiveBytes);
    const repeat = await auditSession(ordinary, { harness: 'codex', caseDir: positive.caseDir, workspace: run, includeChildren: false });
    assert.equal(repeat.reused, true);
    const publishedBefore = fileInventory(positive.caseDir);
    await assert.rejects(auditSession(path.join(link, 'outside-sentinel.jsonl'), { harness: 'generic', caseDir: positive.caseDir, workspace: allowed, includeChildren: false }), { code: 'INVALID_REQUEST' });
    const publishedAfter = fileInventory(positive.caseDir);
    assert.deepEqual(publishedAfter, publishedBefore, 'Rejection must preserve an already published case');
    assert.equal((await verifyCaseIntegrity(positive.caseDir)).passed, true);
    receipt.control_observations.LOSS_GUARD.rejected_over_existing_case = { before: publishedBefore, after: publishedAfter, integrity_passed: true };
    receipt.control_observations.LEGACY_REGRESSION = { ordinary_case: positive.caseDir, same_case_reused: true, historical_command: command, execution_marker_absent: true, negative_observations: observations, no_negative_case_published: true, prior_case_preserved_on_rejection: true };
    receipt.control_observations.IMMUTABLE_SOURCE_INVENTORY.ordinary = { path: ordinary, before_sha256: hash(positiveBytes), after_sha256: hash(fs.readFileSync(ordinary)) };
  });
});

test('PRODUCT01-P2-01 authorized junction preserves native child discovery and its limit', async t => {
  const run = createRun('PRODUCT01-P2-01');
  const before = runtimeSnapshot(checkout);
  const physical = path.join(run, 'physical-sessions'), home = path.join(run, 'codex-home');
  fs.mkdirSync(physical); fs.mkdirSync(home);
  const linked = path.join(home, 'sessions');
  fs.symlinkSync(physical, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, 'A real junction/symlink is required');
  const parent = '01a10000-0000-7000-8000-000000000011';
  const child = '01a10000-0000-7000-8000-000000000012';
  const sibling = '01a10000-0000-7000-8000-000000000013';
  const sourceRecords = {
    [parent]: [
      { timestamp: '2026-09-04T10:00:00Z', type: 'session_meta', payload: { id: parent, cwd: run } },
      { timestamp: '2026-09-04T10:00:01Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: parent, item: { type: 'McpToolCall', id: 'create-child', server: 'codex_app', tool: 'create_thread', status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ threadId: child, hostId: 'local' }) }], isError: false } } } }
    ],
    [child]: [
      { timestamp: '2026-09-04T10:00:02Z', type: 'session_meta', payload: { id: child, cwd: run } },
      { timestamp: '2026-09-04T10:00:03Z', type: 'event_msg', payload: { type: 'user_message', message: 'Actual synthetic child acquired through authorized junction.' } }
    ]
  };
  const secondCreation = structuredClone(sourceRecords[parent][1]);
  secondCreation.payload.item.id = 'create-sibling';
  secondCreation.payload.item.result.content[0].text = JSON.stringify({ threadId: sibling, hostId: 'local' });
  sourceRecords[parent].push(secondCreation);
  sourceRecords[sibling] = [{ timestamp: '2026-09-04T10:00:04Z', type: 'session_meta', payload: { id: sibling, cwd: run } }];
  const dbPath = path.join(home, 'state_5.sqlite'), state = new DatabaseSync(dbPath);
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at_ms INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT)');
  for (const [id, records] of Object.entries(sourceRecords)) {
    fs.writeFileSync(path.join(physical, id + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n', { flag: 'wx' });
    state.prepare('INSERT INTO threads VALUES (?,?,?)').run(id, path.join(linked, id + '.jsonl'), 1);
  }
  state.close();
  const sourceFiles = [...Object.keys(sourceRecords).map(id => path.join(physical, id + '.jsonl')), dbPath];
  const inventory = () => sourceFiles.map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) }));
  const report = { id: 'PRODUCT01-P2-01', input_class: 'SYNTHETIC', runtime_class: 'REAL_AFH', junction: linked, source_before: inventory(), runtime_before: before, observations: [] };
  try {
    for (const request of [
      { includeChildren: false, allowSymlink: true },
      { includeChildren: true, allowSymlink: true },
      { includeChildren: true, allowSymlink: true, maxChildSessions: 1 },
      { includeChildren: false }, { includeChildren: true }
    ]) {
      const observed = { request };
      try {
        const result = await auditSession(parent, { ...request, harness: 'codex', codexHome: home, workspace: run, caseDir: path.join(run, 'case-' + report.observations.length) });
        observed.native_ids = rows(result.caseDir, 'SELECT native_id FROM session ORDER BY native_id').map(row => row.native_id);
        observed.sources = rows(result.caseDir, 'SELECT native_uri FROM source ORDER BY native_uri');
        observed.records = rows(result.caseDir, 'SELECT * FROM source_record ORDER BY source_id,ordinal');
        observed.edges = rows(result.caseDir, 'SELECT * FROM session_edge');
        observed.integrity = await verifyCaseIntegrity(result.caseDir);
        observed.case_dir = result.caseDir;
        if (observed.sources.some(source => source.native_uri.includes(child))) {
          const refs = rows(result.caseDir, 'SELECT uri FROM evidence_ref');
          assert.ok(refs.some(ref => readEvidence(result.caseDir, ref.uri).text === JSON.stringify(sourceRecords[child][1])), 'Child bytes must be resolvable');
        }
      } catch (error) { observed.error = { code: error.code, message: error.message }; }
      report.observations.push(observed);
    }
    const [without, withChild, limited, defaultWithout, defaultWith] = report.observations;
    assert.equal(without.error, undefined);
    assert.equal(without.sources.length, 1);
    assert.ok(without.sources[0].native_uri.includes(parent));
    assert.equal(without.records.length, 3);
    assert.equal(without.integrity.passed, true);
    assert.equal(withChild.error, undefined, 'Explicit allowSymlink must survive child discovery');
    assert.deepEqual(withChild.native_ids, [parent, child, sibling]);
    assert.equal(withChild.sources.length, 3);
    assert.equal(withChild.records.length, 6);
    assert.equal(withChild.integrity.passed, true);
    assert.ok(withChild.edges.some(edge => edge.child_session_id === 'ses:codex:' + child && edge.evidence_event_id));
    assert.equal(limited.error, undefined);
    assert.equal(limited.sources.length, 2);
    assert.ok(limited.sources.some(source => source.native_uri.includes(child)));
    assert.equal(limited.sources.some(source => source.native_uri.includes(sibling)), false);
    assert.equal(limited.records.length, 5);
    assert.equal(limited.integrity.passed, true);
    assert.equal(defaultWithout.error?.code, 'INVALID_REQUEST');
    assert.equal(defaultWith.error?.code, 'INVALID_REQUEST');
    report.status = 'PASS';
  } catch (error) { report.status = error.code === 'ERR_ASSERTION' ? 'RED_BEHAVIOR' : 'ERROR_MECHANICAL_OR_PRECONDITION'; throw error; }
  finally {
    report.source_after = inventory();
    report.runtime_after = runtimeSnapshot(checkout);
    report.stability = snapshotStability(before, report.runtime_after);
    report.runner_sha256 = hash(fs.readFileSync(fileURLToPath(import.meta.url)));
    fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    t.diagnostic('Evidence: ' + path.join(run, 'report.json'));
    assert.deepEqual(report.source_after, report.source_before);
    assert.equal(report.stability.stable, true);
  }
});

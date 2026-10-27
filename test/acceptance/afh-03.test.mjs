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
import {CaseDatabase} from '../../src/database.js';
import {loopGroups} from '../../src/reducers.js';
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
const identityBindingSchema=JSON.parse(fs.readFileSync(path.join(checkout,'specification/identity03-contract.schema.json')));oracleAjv.addSchema(identityBindingSchema);
const validateIdentityBinding=oracleAjv.compile({$ref:identityBindingSchema.$id+'#/$defs/IdentityBinding'});
function validateWire(value,name){const validate=oracleValidators[name];return {passed:validate(value),errors:validate.errors??[]};}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const origin='00000000-0000-4000-8000-000000000404';
function observeArchiveProcesses(run,receipt,onCall=null){
  const methods=['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork'],originals=Object.fromEntries(methods.map(name=>[name,childProcess[name]])),observed=[];
  for(const method of methods)childProcess[method]=function(command,args,options){
    const osLookup=process.platform==='win32'&&method==='execFileSync'&&command===path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe')&&args?.length===4&&args[0]==='-NoProfile'&&args[1]==='-NonInteractive'&&args[2]==='-Command'&&/^\(Get-Process -Id [0-9]+ -ErrorAction Stop\)\.StartTime\.ToUniversalTime\(\)\.Ticks\.ToString\(\)$/.test(args[3])&&options?.windowsHide===true;
    const rel=path.relative(run,path.resolve(options?.cwd??'.'));const currentGit=method==='spawnSync'&&command==='git'&&[['rev-parse','HEAD'],['branch','--show-current'],['status','--porcelain=v2','--branch','--untracked-files=normal']].some(x=>JSON.stringify(x)===JSON.stringify(args))&&!rel.startsWith('..')&&!path.isAbsolute(rel);
    const ownWorker=method==='fork'&&path.resolve(command)===path.join(run,'archive-worker.mjs')&&args?.length===0&&options?.windowsHide===true&&options.execArgv?.length===0;
    observed.push({method,command,args,allowed:osLookup||ownWorker||currentGit,kind:osLookup?'CURRENT_OS_IDENTITY':ownWorker?'OWN_CRASH_TEST_WORKER':currentGit?'CURRENT_PRIVATE_GIT_READ':'UNEXPECTED',...(ownWorker?{worker_sha256:hash(fs.readFileSync(command))}:{})});onCall?.(observed.at(-1));if(!osLookup&&!ownWorker&&!currentGit)throw new Error('Unexpected process execution in archive observation');return originals[method].apply(this,arguments);
  };syncBuiltinESMExports();return ()=>{Object.assign(childProcess,originals);syncBuiltinESMExports();receipt.process_execution_observation={calls:observed,unexpected:observed.filter(call=>!call.allowed).length};};
}
// Test-only observation of real native calls. This is intentionally independent
// of product receipts: a boolean supplied by the engine cannot authorize a delta.
const readerWriterPhases=new Map();
const readerFixtureRoots=new Set();
let readerInventoryDepth=0;
const readerAuxiliaryNames=new Set(['ledger.sqlite-shm','ledger.sqlite-wal']);
function readerInventory(root){readerInventoryDepth++;try{
  const rows=[];
  function visit(file){
    const stat=fs.lstatSync(file,{bigint:true}),relative=path.relative(root,file).split(path.sep).join('/');
    const type=stat.isSymbolicLink()?'link':stat.isDirectory()?'directory':stat.isFile()?'file':'unknown';
    rows.push({path:relative,type,bytes:type==='file'?Number(stat.size):null,identity:stat.dev+':'+stat.ino,sha256:type==='file'?hash(fs.readFileSync(file)):null,...(type==='link'?{link:fs.readlinkSync(file)}:{})});
    if(type==='directory')for(const name of fs.readdirSync(file).sort())visit(path.join(file,name));
  }
  visit(root);return rows;}finally{readerInventoryDepth--;}
}
function readerAuxiliaryInventory(root){readerInventoryDepth++;try{
  return [...readerAuxiliaryNames].flatMap(name=>{
    const file=path.join(root,name);if(!fs.existsSync(file))return [];
    const stat=fs.lstatSync(file,{bigint:true});return [{path:name,type:stat.isSymbolicLink()?'link':stat.isFile()?'file':'unknown',bytes:Number(stat.size),identity:stat.dev+':'+stat.ino,sha256:stat.isFile()&&!stat.isSymbolicLink()?hash(fs.readFileSync(file)):null}];
  });}finally{readerInventoryDepth--;}
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
async function scenario(t,id,body){
  const base=process.env.AFH_ACCEPTANCE_RUN;assert.ok(base,'Explicit contained acceptance output is required');const tmpRelative=path.relative(path.dirname(base),os.tmpdir());assert.ok(!tmpRelative.startsWith('..')&&!path.isAbsolute(tmpRelative),'os.tmpdir must be in the private run root');fs.mkdirSync(base,{recursive:true});
  const run=fs.mkdtempSync(path.join(base,id+'-')),contract=registry.scenarios.find(s=>s.id===id),fixture=fixtures.cases[id];
  const before=runtimeSnapshot(checkout),receipt={scenario_id:id,role:'COMPONENT_OBSERVATION',acceptance_eligible:false,input_class:'SYNTHETIC',runtime_class:typeof publicApi.archiveRequest==='function'?'REAL_AFH':'CONTRACT_ONLY',provider_class:'NONE',candidate_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim(),node:process.version,platform:process.platform,arch:process.arch,runtime_before:before,runner_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),fixture_sha256:contract.fixture_ref.sha256,oracle_sha256:contract.oracle_ref.sha256,requests:[],phase:'PRECONDITION'};
  const stopProcesses=observeArchiveProcesses(run,receipt);
  try{
    assert.equal(digest(fixture),contract.fixture_ref.sha256);assert.equal(digest(fixtures.oracles[id]),contract.oracle_ref.sha256);assert.equal(digest(fixtures.datasets[fixture.dataset_ref.split('/').at(-1)]),fixture.dataset_sha256);
    if(typeof publicApi.archiveRequest!=='function')throw Object.assign(new Error('Canonical public archiveRequest export is absent'),{code:'NOT_IMPLEMENTED'});
    readerFixtureRoots.add(run);const archive=path.join(run,'archive');let requestIndex=0;
    const call=async(operation,params,options={},revision_id=null,target=archive,engine=publicApi.archiveRequest,expectation=null,transform=null)=>{
      const request={kind:'request',schema_version:4,protocol_version:'4.0',request_id:id+'-'+(++requestIndex),operation,archive:target,revision_id,params};
      const requestValidation=validateWire(request,'Request');if(!requestValidation.passed)throw Object.assign(new Error(JSON.stringify(requestValidation.errors)),{code:'SCHEMA_PRECONDITION'});
      const readOnly=['evidence.read','archive.verify','scope.resolve','event.show','stats'].includes(operation);let response;
      if(readOnly){const observed=await observeArchiveReader(target,()=>engine(request,options));const original=transform?structuredClone(observed):null;if(transform)transform(observed);response=observed.result;const observation={operation,request_id:request.request_id,expectation,...observed.observation};try{if(observed.error)throw observed.error;if(response?.error?.code==='NOT_IMPLEMENTED'&&expectation!=='PRE_OCCURRENCE_EXTENSION'){receipt.requests.push({request,response});throw Object.assign(new Error(response.error.message),{code:'NOT_IMPLEMENTED'});}observation.outcome=assertReadObservation({request,response,observation,expectation});(receipt.read_only_observations??=[]).push(observation);}catch(error){(receipt.read_only_rejections??=[]).push({request,response,observation,error:{code:error.code,message:error.message},...(original?{calibration_original:original}: {})});throw error;}}
      else response=await engine(request,options);receipt.requests.push({request,response});
      const responseValidation=validateWire(response,'Response');
      if(!responseValidation.passed)throw Object.assign(new Error(JSON.stringify(responseValidation.errors)),{code:'SCHEMA_PRECONDITION'});
      if(response.error?.code==='NOT_IMPLEMENTED'&&expectation!=='PRE_OCCURRENCE_EXTENSION')throw Object.assign(new Error(response.error.message),{code:'NOT_IMPLEMENTED'});
      const pair=operation==='evidence.read'&&response.data?{request,state:evidenceState(target,request)}:null;
      const relational=relationalWireChecks(response,registry,pair);if(relational.length)throw Object.assign(new Error(relational.join(', ')),{code:'WIRE_PRECONDITION'});
      assert.equal(response.request_id,request.request_id);assert.equal(response.operation,operation);
      return response;
    };
    const initialized=await call('archive.init',{idempotency_key:'init',origin_domains:[{id:origin,harness:'codex',descriptor:'Frozen synthetic acceptance fixture'}]});
    assert.equal(initialized.error,null);assert.equal(initialized.data.schema_version,4);
    receipt.phase='BEHAVIOR';receipt.control_observations={};receipt.temp_preflight={actual:os.tmpdir(),TEMP:process.env.TEMP,TMP:process.env.TMP,pid:process.pid};
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
function manifest(archive,id){return JSON.parse(fs.readFileSync(path.join(archive,'bronze/sources',id+'.json')));}
function evidenceState(archive,request){
  const pointer=JSON.parse(fs.readFileSync(path.join(archive,'archive.json'))),revisionId=request.revision_id??pointer.revision_id;
  let revision=JSON.parse(fs.readFileSync(path.join(archive,'revisions',revisionId+'.json')));const sourceIds=new Set(),visited=new Set();
  while(revision){assert.ok(!visited.has(revision.revision_id),'Test revision chain cannot cycle');visited.add(revision.revision_id);for(const id of revision.source_manifest_ids)sourceIds.add(id);revision=revision.parent_revision_id?JSON.parse(fs.readFileSync(path.join(archive,'revisions',revision.parent_revision_id+'.json'))):null;}
  const matches=[...sourceIds].flatMap(id=>{const source=manifest(archive,id);return source.records.filter(record=>record.evidence_ref.uri===request.params.uri).map(record=>({source,record}));});
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


const iso=i=>new Date(Date.UTC(2026,0,1,0,0,i)).toISOString();
const meta=id=>({timestamp:iso(0),type:'session_meta',payload:{id,session_id:id,cwd:'.',cli_version:'synthetic-spec-v1'}});
const user=(text,i,id)=>({timestamp:iso(i),type:'response_item',payload:{type:'message',id,role:'user',content:[{type:'input_text',text}]}});
const request=(id,i,command='npm test',turn=null)=>({timestamp:iso(i),type:'response_item',payload:{type:'function_call',call_id:id,id,turn_id:turn,name:'exec_command',arguments:JSON.stringify({cmd:command,workdir:'.'})}});
const result=(id,code,i,extra={})=>({timestamp:iso(i),type:'response_item',payload:{type:'function_call_output',call_id:id,output:JSON.stringify({exit_code:code,output:code===0?'PASS synthetic validation':'FAIL synthetic validation',...extra})}});
const observed=(id,code,i,extra={})=>({timestamp:iso(i),type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',id,command:'npm test',status:code===0?'completed':code===1?'failed':'unknown',exit_code:code,cwd:'.',stdout:'synthetic output '+id,duration:{secs:1,nanos:0},...extra}}});
const writeRecords=(file,records)=>{const bytes=Buffer.from(records.map(r=>JSON.stringify(r)).join('\n')+'\n');fs.writeFileSync(file,bytes,{flag:'wx'});return bytes;};
function rows(caseDir,sql,args=[]){const db=new DatabaseSync(path.join(caseDir,'case.sqlite'),{readOnly:true});try{return db.prepare(sql).all(...args).map(x=>({...x}));}finally{db.close();}}
async function legacyCapture(ctx,records,{sessions=null}={}){
  const {run,receipt}=ctx;const inputs=[];let audit;
  if(sessions){const home=path.join(run,'.codex');fs.mkdirSync(path.join(home,'sessions'),{recursive:true});const db=new DatabaseSync(path.join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,updated_at_ms INTEGER); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT)');
    for(const [i,s]of sessions.entries()){const file=path.join(home,'sessions',s.id+'.jsonl');inputs.push({file,bytes:writeRecords(file,s.records)});db.prepare('INSERT INTO threads VALUES(?,?,?)').run(s.id,file,i+1);}db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?,?)').run(sessions[0].id,sessions[1].id,'spawned');db.close();audit=await publicApi.auditSession(sessions[0].id,{codexHome:home,out:path.join(run,'legacy'),workspace:run,includeChildren:true});
  }else{const file=path.join(run,'source.jsonl');inputs.push({file,bytes:writeRecords(file,records)});audit=await publicApi.auditSession(file,{harness:'codex',caseDir:path.join(run,'case'),workspace:run,includeChildren:false});}
  receipt.legacy_case=audit.caseDir;const before=inventory(audit.caseDir),sources=rows(audit.caseDir,'SELECT * FROM source'),all=rows(audit.caseDir,'SELECT * FROM source_record ORDER BY source_id,ordinal'),opened=[];
  assert.equal(sources.length,inputs.length);assert.equal(publicApi.loadManifest(audit.caseDir).schemaVersion,3);
  for(const record of all){const source=sources.find(s=>s.id===record.source_id),uri=`afh://evidence/sha256/${source.canonical_sha256}/record/${record.ordinal}#bytes=${record.byte_offset}:${record.byte_length}`,read=publicApi.readEvidence(audit.caseDir,uri);assert.equal(hash(Buffer.from(read.text)),record.sha256);opened.push({uri,sha256:record.sha256,text:read.text});}
  const events=rows(audit.caseDir,'SELECT id FROM event');assert.ok(events.length);for(const event of events){const value=publicApi.showEvent(audit.caseDir,event.id);assert.equal(value.id,event.id);assert.ok(value.evidence.length);}
  const integrity=await publicApi.verifyCaseIntegrity(audit.caseDir);assert.equal(integrity.passed,true);assert.deepEqual(inventory(audit.caseDir),before);for(const input of inputs)assert.deepEqual(fs.readFileSync(input.file),input.bytes);
  receipt.control_observations.legacy={source_count:sources.length,record_count:all.length,opened,events,integrity,before,after:inventory(audit.caseDir),source_inventory:inputs.map(i=>({file:i.file,sha256:hash(i.bytes)}))};return audit.caseDir;
}
async function ingest(ctx,records,{name='source',session='synthetic-occurrences',engine=publicApi.archiveRequest}={}){
  const file=path.join(ctx.run,name+'.jsonl'),bytes=writeRecords(file,[meta(session),...records]),input={path:file,harness:'codex',origin_domain_id:origin};
  const response=await ctx.call('archive.ingest',{sources:[input],include_children:false,idempotency_key:name},{},null,ctx.archive,engine);if(response.error)throw Object.assign(new Error('Synthetic acquisition precondition failed: '+JSON.stringify(response.error)),{code:'SCHEMA_PRECONDITION'});const source=manifest(ctx.archive,response.data.source_revisions[0]);assert.deepEqual(await readManifestBytes(ctx.call,source),bytes);assert.equal((await ctx.call('archive.verify',{deep:true})).data.passed,true);
  (ctx.receipt.source_observations??=[]).push({file,sha256:hash(bytes),source,response});const events=source.records.flatMap(r=>(r.events??[]).map(e=>({...e,raw_ref:r.evidence_ref})));return {source,events,response,input,bytes};
}
const scope={project_id:null,session_ids:[],group_id:null,association_mode:'observed'},time={known_at:null,valid_at:null,from:null,to:null,include_uncertain:true};
async function stats(ctx,metric='executions'){const r=await ctx.call('stats',{scope,time,metric});assert.equal(r.error,null);return r.data;}
async function show(ctx,event){assert.ok(event?.id,'A real acquired event is required');const r=await ctx.call('event.show',{event_id:event.id,include_representations:true});assert.equal(r.error,null);assert.equal(r.data.event.occurrence_id,r.data.occurrence.id);assert.equal(r.data.event.session_id,r.data.occurrence.session_id);assert.ok(r.data.representations.length);for(const rep of r.data.representations){assert.equal(rep.occurrence_id,r.data.occurrence.id);assert.ok(rep.event_id);const raw=await ctx.call('evidence.read',{uri:rep.raw_ref.uri,format:'base64'});assert.equal(raw.error,null);assert.ok(Buffer.from(raw.data.payload,'base64').length);}return r.data;}
const toolEvents=x=>x.events.filter(e=>e.kind.startsWith('tool.')||e.kind==='mcp.completed');
// IDENTITY03_EXPECTATIONS_BEGIN: independently derived from fixture/raw, never product IDs.
function identity03Cjson(value){return JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
function identity03Hash(value){return createHash('sha256').update(identity03Cjson(value),'utf8').digest('hex');}
function identity03Expected(source,rawRecords){
 const expected=[],groups=new Map(),policyVersion='afh-identity03-v1';
 for(const [ri,record]of source.records.entries())for(const [subindex,event]of record.events.entries()){
  if(!event.kind.startsWith('tool.')&&!event.kind.startsWith('message.'))continue;
  const raw=rawRecords[ri],p=raw.payload??{},item=p.item??{},message=event.kind.startsWith('message.'),requested=event.kind==='tool.requested';
  const pointer=raw.type==='response_item'?(message?'/payload/content':requested?'/payload':'/payload/output'):message?'/payload/item/content':'/payload/item';
  let node=raw;for(const key of pointer.split('/').slice(1)){assert.ok(node&&Object.hasOwn(node,key),'IDENTITY03_RAW_NODE');node=node[key];}
  const locator=[source.source_lineage_id,record.identity_epoch,record.ordinal,pointer,subindex],anchor='evt4-'+identity03Hash([...locator,event.kind]);assert.equal(event.id,anchor,'IDENTITY03_ACQUIRED_RECIPE: decoder must reproduce the historical anchor');
  const nativeId=message?(p.id??item.id??null):(p.call_id??p.id??item.id??null),turn=p.turn_id??raw.turn_id??null,role=message?['message',event.kind==='message.user'?'user':event.kind==='message.agent'?'assistant':'instruction']:[requested?'request':event.kind==='tool.observed'?'observed_terminal':'terminal'];
  const namespace=message?['message',role[1],'item']:['execution',item.id?'item':'call'],key=identity03Cjson([event.session_id,namespace,nativeId,turn]),candidates=nativeId?groups.get(key)??[]:[];
  let group=null;if(message&&rawRecords[0]?.payload?.cli_version==='synthetic-spec-v1'&&nativeId)group=candidates.length===1?candidates[0]:null;
  if(!message&&!requested){const open=candidates.filter(c=>c.request&&!c.closed);if(open.length===1)group=open[0];else if(!open.length&&candidates.length===1)group=candidates[0];}
  if(!group){const guaranteedMessage=message&&rawRecords[0]?.payload?.cli_version==='synthetic-spec-v1'&&nativeId,epoch=guaranteedMessage?'session':'epoch:'+identity03Hash([policyVersion,event.session_id,turn,locator]),executionKey=nativeId?identity03Cjson([...namespace,nativeId]):identity03Cjson([message?'message':'execution','anchor',locator]);group={epoch,id:'occ4-'+identity03Hash([event.session_id,epoch,executionKey]),request:null,closed:false};if(nativeId){candidates.push(group);groups.set(key,candidates);}}
  const logicalRole=identity03Cjson(role),canonicalId=nativeId?'evt4-'+identity03Hash([event.session_id,group.epoch,event.kind,nativeId,logicalRole]):'evt4-'+identity03Hash([...locator,logicalRole]);
  const value={anchor,canonical_id:canonicalId,occurrence_id:group.id,identity_epoch:group.epoch,session_id:event.session_id,kind:event.kind,native_id:nativeId,logical_role:logicalRole,locator:{source_revision_id:source.source_revision_id,source_lineage_id:source.source_lineage_id,record_identity_epoch:record.identity_epoch,record_ordinal:record.ordinal,json_pointer:pointer,event_subindex:subindex,record_sha256:record.sha256},representation_id:'rep4-'+identity03Hash([source.source_revision_id,record.ordinal,pointer,subindex]),raw_ref:record.evidence_ref,result_of:!message&&!requested&&group.request?group.request:null};
  if(requested)group.request=canonicalId;else if(!message)group.closed=true;expected.push(value);
 }
 return expected;
}
function assertIdentity03Answer(value,expected,prefix){
 assert.equal(value.event.id,expected.canonical_id,prefix+'_EVENT_ID: canonical recipe');assert.equal(value.event.kind,expected.kind,prefix+'_ROLE');assert.equal(value.event.session_id,expected.session_id,prefix+'_SESSION');
 assert.equal(value.occurrence.id,expected.occurrence_id,prefix+(prefix==='T06'&&expected.kind==='tool.completed'?'_ORPHAN_OCCURRENCE':'_OCCURRENCE')+': independent occurrence recipe');assert.equal(value.occurrence.identity_epoch,expected.identity_epoch,prefix+'_EPOCH: independent qualified epoch');
 assert.ok(value.evidence_refs.some(r=>r.uri===expected.raw_ref.uri&&r.record_sha256===expected.raw_ref.record_sha256),prefix+'_EVIDENCE: own raw source');
 const own=value.representations.filter(r=>r.id===expected.representation_id);assert.equal(own.length,1,prefix+'_EVIDENCE: exact rep4 recipe');const r=own[0];assert.equal(r.event_id,expected.canonical_id,prefix+'_ALIAS_TARGET');assert.equal(r.occurrence_id,expected.occurrence_id,prefix+'_OCCURRENCE');assert.equal(r.raw_ref.uri,expected.raw_ref.uri,prefix+'_EVIDENCE');assert.equal(r.raw_ref.record_sha256,expected.raw_ref.record_sha256,prefix+'_EVIDENCE');assert.equal(r.raw_ref.json_pointer,expected.locator.json_pointer,prefix+'_POINTER');assert.equal(r.raw_ref.record_ordinal,expected.locator.record_ordinal,prefix+'_LOCATOR');
}
async function identity03ShowBoth(ctx,acquired,expected,prefix){
 const value=await show(ctx,acquired);assertIdentity03Answer(value,expected,prefix);
 const other=await ctx.call('event.show',{event_id:expected.canonical_id,include_representations:true});assert.equal(other.error,null,prefix+'_CANONICAL_LOOKUP');assertIdentity03Answer(other.data,expected,prefix);assert.equal(other.data.event.id,value.event.id);assert.equal(other.data.occurrence.id,value.occurrence.id);assert.equal(other.data.occurrence.lifecycle,value.occurrence.lifecycle);assert.deepEqual(other.data.relations,value.relations,prefix+'_CANONICAL_RELATIONS');return value;
}
function identity03BindingExpected(e,seq){const value={namespace:'ACQUIRED_ANCHOR',acquired_alias:e.anchor,canonical_target:e.canonical_id,locator:e.locator,representation_id:e.representation_id,acquisition_json_pointer:e.acquisition_json_pointer??e.locator.json_pointer,rule_id:'afh-identity03',rule_version:'afh-identity03-v1',decoder_id:'acquired02-raw-locator',decoder_version:'1',commit_seq:seq,supersedes_binding_id:null,equivalence_proof_refs:[]};return {id:'bind4-'+identity03Hash(value),...value};}
function assertIdentity03Bindings(actual,expected,seq){
 const want=expected.map(e=>identity03BindingExpected(e,seq));assert.equal(actual.length,want.length,'IDENTITY03_MAPPING_EXACT: no missing or extra mapping');
 for(const target of want){const found=actual.filter(x=>x.id===target.id);assert.equal(found.length,1,'IDENTITY03_MAPPING_ID');assert.deepEqual(found[0],target,'IDENTITY03_MAPPING_PROVENANCE: alias/target/locator/subindex/rule/cut');}
}
function identity03CheckBindings(ctx,expected){
 const db=new DatabaseSync(path.join(ctx.archive,'ledger.sqlite'),{readOnly:true});let values;try{const table=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='identity_binding'").get();if(!table)throw Object.assign(new Error('Identity binding index is absent'),{code:'NOT_IMPLEMENTED'});values=db.prepare('SELECT data_json FROM identity_binding ORDER BY id').all().map(r=>JSON.parse(r.data_json));}finally{db.close();}
 const seq=JSON.parse(fs.readFileSync(path.join(ctx.archive,'archive.json'))).published_seq;assertIdentity03Bindings(values,expected,seq);ctx.receipt.identity_bindings={seq,rows:values};
}
// IDENTITY03_STRENGTH_BEGIN: response oracles, not an implementation of the resolver.
function identity03ResolverCases(){
 const id=n=>'evt4-'+String(n).repeat(64),bid=n=>'bind4-'+String(n).repeat(64),alias=id(1),a=id(2),b=id(3),proof='afh://evidence/sha256/'+'a'.repeat(64)+'/record/1#bytes=0:1';
 const one={id:bid(4),namespace:'ACQUIRED_ANCHOR',acquired_alias:alias,canonical_target:a,commit_seq:2,supersedes_binding_id:null,equivalence_proof_refs:[]},two={...one,id:bid(5),canonical_target:b,commit_seq:3},replacement={...two,supersedes_binding_id:one.id,equivalence_proof_refs:[proof]};
 const cases=[
  {name:'absent',ids:[],rows:[one],cut:1,error:'EVIDENCE_UNAVAILABLE'},
  {name:'canonical-only',ids:[alias],rows:[],cut:2,target:alias},
  {name:'one',ids:[],rows:[one],cut:2,target:a},
  {name:'same-target-two-placements',ids:[],rows:[one,{...two,canonical_target:a}],cut:3,target:a},
  {name:'ambiguous',ids:[],rows:[one,two],cut:3,error:'AMBIGUOUS_IDENTITY'},
  {name:'namespace-conflict',ids:[alias],rows:[one],cut:2,error:'AMBIGUOUS_IDENTITY'},
  {name:'namespace-same',ids:[alias],rows:[{...one,canonical_target:alias}],cut:2,target:alias},
  {name:'historical-replacement',ids:[],rows:[one,replacement],cut:2,target:a},
  {name:'current-replacement',ids:[],rows:[one,replacement],cut:3,target:b},
  {name:'replacement-reversed-input',ids:[],rows:[replacement,one],cut:3,target:b},
  {name:'unrelated-alias',ids:[],rows:[{...one,acquired_alias:id(9)}],cut:2,error:'EVIDENCE_UNAVAILABLE'},
  {name:'replacement-proof-empty',ids:[],rows:[one,{...replacement,equivalence_proof_refs:[]}],cut:3,error:'INTEGRITY_FAILED'},
  {name:'replacement-proof-malformed',ids:[],rows:[one,{...replacement,equivalence_proof_refs:['native-confirmation:raw']}],cut:3,error:'INTEGRITY_FAILED'},
  {name:'replacement-predecessor-missing',ids:[],rows:[replacement],cut:3,error:'INTEGRITY_FAILED'},
  {name:'replacement-cross-alias',ids:[],rows:[{...one,acquired_alias:id(9)},replacement],cut:3,error:'INTEGRITY_FAILED'},
  {name:'replacement-same-cut',ids:[],rows:[one,{...replacement,commit_seq:2}],cut:3,error:'INTEGRITY_FAILED'},
  {name:'self-cycle',ids:[],rows:[{...one,supersedes_binding_id:one.id,equivalence_proof_refs:[proof]}],cut:2,error:'INTEGRITY_FAILED'},
  {name:'two-node-cycle',ids:[],rows:[{...one,supersedes_binding_id:two.id,equivalence_proof_refs:[proof]},replacement],cut:3,error:'INTEGRITY_FAILED'},
  {name:'conflicting-duplicate-binding-id',ids:[],rows:[one,{...one,canonical_target:b}],cut:2,error:'INTEGRITY_FAILED'},
  {name:'replacement-fork',ids:[],rows:[one,replacement,{...replacement,id:bid(6),canonical_target:id(7)}],cut:3,error:'AMBIGUOUS_IDENTITY'},
  {name:'future-invalid-does-not-poison-old-cut',ids:[],rows:[one,{...replacement,equivalence_proof_refs:[]}],cut:2,target:a}
 ];return cases.map(c=>({alias,...c}));
}
function assertIdentity03Resolution(c,resolve){
 const before=structuredClone(c);if(c.error)assert.throws(()=>resolve(c.alias,c.ids,c.rows,c.cut),e=>e.code===c.error,'IDENTITY03_RESOLVER_'+c.name);else assert.equal(resolve(c.alias,c.ids,c.rows,c.cut),c.target,'IDENTITY03_RESOLVER_'+c.name);assert.deepEqual(c,before,'IDENTITY03_RESOLVER_INPUT_IMMUTABLE');
}
function identity03RawNode(raw,pointer){
 assert.match(pointer,/^(?:\/(?:[^~]|~[01])*)*$/,'IDENTITY03_POINTER_SYNTAX');let node=raw;
 for(const token of pointer.split('/').slice(1)){const key=token.replaceAll('~1','/').replaceAll('~0','~');assert.ok(node!==null&&typeof node==='object'&&Object.hasOwn(node,key),'IDENTITY03_RAW_NODE_MISSING');node=node[key];}return node;
}
function assertIdentity03LocatorProof(actual,expected,rawBytes){
 assert.equal(actual.candidates,1,'IDENTITY03_LOCATOR_UNIQUE');assert.deepEqual(actual.locator,expected.locator,'IDENTITY03_LOCATOR_FIELDS');assert.equal(actual.acquisition_json_pointer,expected.acquisition_json_pointer,'IDENTITY03_ACQUISITION_POINTER');assert.equal(createHash('sha256').update(rawBytes).digest('hex'),actual.locator.record_sha256,'IDENTITY03_RAW_DIGEST');
 const node=identity03RawNode(JSON.parse(rawBytes),actual.locator.json_pointer);assert.deepEqual(node,expected.node,'IDENTITY03_RAW_EXACT_NODE');assert.equal(actual.representation_id,'rep4-'+identity03Hash([actual.locator.source_revision_id,actual.locator.record_ordinal,actual.locator.json_pointer,actual.locator.event_subindex]),'IDENTITY03_LOCATOR_REP4');
 assert.equal(actual.acquired_alias,'evt4-'+identity03Hash([actual.locator.source_lineage_id,actual.locator.record_identity_epoch,actual.locator.record_ordinal,actual.acquisition_json_pointer,actual.locator.event_subindex,expected.kind]),'IDENTITY03_LOCATOR_ANCHOR');
}
function assertIdentity03LookupBudget(observation,allowedFiles,maxBytes){
 assert.ok(observation.native_calls.some(c=>c.completed&&['statement.get','statement.all','iterator.next'].includes(c.method)&&/\bidentity_binding\b/i.test(c.sql??'')),'IDENTITY03_INDEX_EXECUTED');
 assert.ok(observation.raw_accesses.length>0,'IDENTITY03_RAW_OBSERVATION_NONEMPTY');assert.ok(observation.raw_accesses.every(r=>r.kind==='readFileSync'&&r.completed),'IDENTITY03_RAW_ACCESS_OBSERVED');
 assert.ok(observation.raw_accesses.every(r=>allowedFiles.includes(r.file)),'IDENTITY03_NO_UNRELATED_BRONZE');assert.ok(observation.raw_accesses.reduce((n,r)=>n+r.bytes,0)<=maxBytes,'IDENTITY03_RAW_BYTE_BUDGET');assert.equal(observation.reader_mutations,0,'IDENTITY03_LOOKUP_READ_ONLY');
}
function assertIdentity03Fragments(values,expected){
 assert.equal(values.length,expected.length,'IDENTITY03_FRAGMENT_COUNT');for(let i=0;i<expected.length;i++){assert.equal(values[i].event.id,expected[i].id,'IDENTITY03_FRAGMENT_RECIPE');assert.equal(values[i].occurrence.id,expected[i].occurrence_id,'IDENTITY03_FRAGMENT_OCCURRENCE');assert.equal(values[i].occurrence.lifecycle,'COMPLETED','IDENTITY03_FRAGMENT_NOT_TERMINAL');}
}
// IDENTITY03_STRENGTH_END
function identity03ConfirmationExpected(oldSource,newSource,rawBefore,rawAfter,oldSeq,newSeq){
 const native=rawAfter.find(row=>row.type==='session_meta').payload.id,oldSession='ses4-'+identity03Hash(['codex',origin,'provisional',oldSource.source_lineage_id]),newSession='ses4-'+identity03Hash(['codex',origin,native]);
 assert.equal(oldSource.session_id,oldSession);assert.equal(newSource.session_id,newSession);assert.equal(newSource.native_id,native);assert.equal(newSource.source_lineage_id,oldSource.source_lineage_id);assert.equal(newSource.prefix_relation.previous_source_revision_id,oldSource.source_revision_id);
 for(const [source,raw,session]of [[oldSource,rawBefore,oldSession],[newSource,rawAfter,newSession]])for(const [i,record]of source.records.entries()){assert.equal(record.sha256,createHash('sha256').update(JSON.stringify(raw[i])+'\n').digest('hex'),'CONFIRM_RAW_RECORD');for(const event of record.events)assert.equal(event.session_id,session,'CONFIRM_RAW_SESSION');}
 const before=identity03Expected(oldSource,rawBefore),after=identity03Expected(newSource,rawAfter),bindings=before.map(e=>identity03BindingExpected(e,oldSeq));assert.equal(before.length,2);assert.equal(after.length,2);
 for(const [i,old]of before.entries())for(const placement of [old,after[i]]){assert.equal(old.anchor,after[i].anchor);const {id,...base}=identity03BindingExpected(placement,newSeq),value={...base,canonical_target:after[i].canonical_id,supersedes_binding_id:identity03BindingExpected(old,oldSeq).id,equivalence_proof_refs:[after[i].raw_ref.uri]};bindings.push({id:'bind4-'+identity03Hash(value),...value});}
 return {before,after,bindings,oldSeq,newSeq};
}
function assertIdentity03Confirmation(actual,expected){
 assert.equal(actual.occurrences,1,'CONFIRM_ONE_ACT');assert.equal(actual.oldSeq,expected.oldSeq,'CONFIRM_OLD_CUT');assert.equal(actual.newSeq,expected.newSeq,'CONFIRM_NEW_CUT');
 for(const [i,e]of expected.before.entries()){assertIdentity03Answer(actual.old[i],e,'CONFIRM_OLD');assert.deepEqual(actual.historical[i],actual.old[i],'CONFIRM_OLD_CUT_PRESERVED');}
 for(const [i,e]of expected.after.entries()){
  assertIdentity03Answer(actual.current[i],e,'CONFIRM_CURRENT');assert.equal(actual.current[i].event.occurrence_id,e.occurrence_id,'CONFIRM_EVENT_OCCURRENCE_TARGET');assert.equal(actual.current[i].event.temporal.recorded_seq,expected.newSeq,'CONFIRM_EVENT_CUT');
  assert.deepEqual(actual.current[i].representations.map(r=>r.id).sort(),[expected.before[i].representation_id,e.representation_id].sort(),'CONFIRM_ALL_REPRESENTATIONS');
  for(const rep of actual.current[i].representations){assert.equal(rep.event_id,e.canonical_id);assert.equal(rep.occurrence_id,e.occurrence_id);}
  if(e.result_of)assert.deepEqual(actual.current[i].relations.filter(r=>r.type==='RESULT_OF'&&r.from_id===e.canonical_id).map(r=>r.to_id),[e.result_of],'CONFIRM_RELATION_ENDPOINTS');
 }
 const sort=rows=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));assert.deepEqual(sort(actual.bindings),sort(expected.bindings),'CONFIRM_EXACT_BINDING_RECIPE_AND_CUT');
}
// IDENTITY03_EXPECTATIONS_END
async function payloadText(ctx,payload){assert.ok(payload.evidence_refs.length);const values=[];for(const ref of payload.evidence_refs){const read=await ctx.call('evidence.read',{uri:ref.uri,format:'text'});assert.equal(read.error,null);let value=JSON.parse(read.data.payload);for(const part of (ref.json_pointer??'').split('/').slice(1))value=value[part.replaceAll('~1','/').replaceAll('~0','~')];assert.equal(typeof value,'string');values.push(value);}const text=values.join('');assert.equal(hash(Buffer.from(text)),payload.content_sha256);assert.equal(Buffer.byteLength(text),Number(payload.bytes));return text;}
function expect(ctx,actual){ctx.receipt.observed=actual;assert.deepEqual(actual,ctx.expected);}

async function observedOccurrenceGroups(ctx,target=ctx.archive,expectation=null){
 const file=path.join(checkout,'src/archive/ledger.js'),ledger=await import(pathToFileURL(file));
 if(typeof ledger.readOccurrenceGroups!=='function')throw Object.assign(new Error('Real readOccurrenceGroups consumer is absent'),{code:'NOT_IMPLEMENTED'});
 // These descriptors bind an actual internal function call and its return.
 // They are stored separately from wire requests and are never schema/API proof.
 const operation='ledger.occurrences',request_id='internal-groups-'+(ctx.receipt.internal_read_observations?.length??0),request={kind:'INTERNAL_FUNCTION_CALL',operation,request_id,archive:target,params:{scope,time},export:'readOccurrenceGroups'};
 const observed=await observeArchiveReader(target,()=>ledger.readOccurrenceGroups(target,request.params)),observation={...observed.observation,operation,request_id,expectation};
 const response={kind:'INTERNAL_FUNCTION_RESULT',operation,request_id,data:observed.result??null,error:observation.operation_error};observation.outcome=assertReadObservation({request,response,observation,expectation});
 (ctx.receipt.internal_read_observations??=[]).push({request,response,observation,function_ref:file,function_sha256:hash(fs.readFileSync(file))});
 return expectation?observed.error:observed.result;
}

test('AFH-03-T01 ten distinct native executions retain every attempt and representation',async t=>scenario(t,'AFH-03-T01',async ctx=>{
 const {input}=ctx.fixture,ds=fixtures.datasets.occurrences,caseDir=await legacyCapture(ctx,[meta('synthetic-executions'),...ds.ids.map((id,i)=>observed(id,ds.exit_codes[i],i+1,{command:input.command}))]);
 const executions=rows(caseDir,'SELECT * FROM tool_execution'),events=rows(caseDir,"SELECT * FROM event WHERE kind='tool.observed'");assert.equal(new Set(events.map(e=>e.native_id)).size,input.executions);ctx.receipt.rows=executions;expect(ctx,{occurrences:executions.length,failed:executions.filter(e=>e.status==='FAILED'&&e.exit_code===1).length,completed:executions.filter(e=>e.status==='COMPLETED'&&e.exit_code===0).length,representations:events.length});
}));
test('AFH-03-T02 explicit native identity merges encodings with both raw references',async t=>scenario(t,'AFH-03-T02',async ctx=>{
 const id=ctx.fixture.input.same_native_item_id,x=await ingest(ctx,[user('Same act',1,id),{timestamp:iso(1),type:'event_msg',payload:{type:'item_completed',item:{type:'UserMessage',id,content:[{type:'input_text',text:'Same act'}]}}}]),events=x.events.filter(e=>e.kind==='message.user'),values=[];assert.equal(events.length,2);for(const e of events)values.push(await show(ctx,e));const reps=new Map(values.flatMap(v=>v.representations).map(r=>[r.id,r]));assert.equal(new Set([...reps.values()].map(r=>r.raw_ref.uri)).size,2);const counts=await stats(ctx,'independent_sources');expect(ctx,{occurrences:new Set(values.map(v=>v.occurrence.id)).size,representations:reps.size,independent_sources:Number(counts.denominators.independent_sources)});
}));
test('AFH-03-T03 equal text with different native IDs preserves two real messages',async t=>scenario(t,'AFH-03-T03',async ctx=>{
 const input=ctx.fixture.input,caseDir=await legacyCapture(ctx,[meta('synthetic-repeat'),...input.native_ids.map((id,i)=>user(input.text,i+1,id))]),events=rows(caseDir,"SELECT * FROM event WHERE kind='message.user'");assert.deepEqual(events.map(e=>e.native_id).sort(),[...input.native_ids].sort());expect(ctx,{canonical_messages:events.filter(e=>e.canonical===1).length,representations:events.length});
}));
test('AFH-03-T04 session-qualified call identities prevent cross-session results',async t=>scenario(t,'AFH-03-T04',async ctx=>{
 const f=ctx.fixture.input,caseDir=await legacyCapture(ctx,null,{sessions:f.sessions.map((id,i)=>({id,records:[meta(id),request(f.call_id,1),result(f.call_id,f.codes[i],2)]}))}),executions=rows(caseDir,'SELECT * FROM tool_execution'),links=rows(caseDir,'SELECT t.id,t.session_id,c.session_id AS call_session,r.session_id AS result_session,r.id AS result_id FROM tool_execution t LEFT JOIN event c ON c.id=t.call_event_id LEFT JOIN event r ON r.id=t.result_event_id');ctx.receipt.rows=executions;for(const [i,id]of f.sessions.entries()){const matching=executions.filter(e=>e.session_id==='ses:codex:'+id);if(matching.length)assert.equal(matching[0].exit_code,f.codes[i]);}expect(ctx,{executions:executions.length,results_per_session:f.sessions.map(id=>links.filter(e=>e.session_id==='ses:codex:'+id&&e.result_id).length),cross_session_links:links.filter(e=>e.call_session!==e.session_id||e.result_session!==e.session_id).length});
}));
test('AFH-03-T05 repeated call ID in a new native turn creates a new epoch',async t=>scenario(t,'AFH-03-T05',async ctx=>{
 const f=ctx.fixture.input,records=f.turns.flatMap((turn,i)=>{const end=result(f.call_id,i,i*2+2);end.payload.turn_id=turn;return [request(f.call_id,i*2+1,'npm test',turn),end];}),x=await ingest(ctx,records),values=[],bindings=[],expectedIds=identity03Expected(x.source,[meta('synthetic-occurrences'),...records]);
 assert.equal(toolEvents(x).length,4);assert.equal(x.source.records.length,records.length+1);
 // Bind expectations to the fixture's turn/role and the acquired raw record.
 // Response cardinalities cannot establish which terminal belongs to a request.
 for(const [i,turn]of f.turns.entries()){
  const pair={turn};
  for(const [offset,role,kind]of [[0,'request','tool.requested'],[1,'terminal','tool.completed']]){
   const record=x.source.records[1+i*2+offset],raw=await ctx.call('evidence.read',{uri:record.evidence_ref.uri,format:'text'});assert.equal(raw.error,null);
   const input=JSON.parse(raw.data.payload);assert.deepEqual(input,records[i*2+offset]);assert.equal(input.payload.turn_id,turn);assert.equal(input.payload.call_id,f.call_id);
   assert.equal(record.events.length,1);const acquired={...record.events[0],raw_ref:record.evidence_ref};assert.equal(acquired.kind,kind);
   const identity=expectedIds.find(e=>e.anchor===acquired.id),value=await identity03ShowBoth(ctx,acquired,identity,'T05');assert.equal(value.event.kind,kind,'T05_ROLE');assert.equal(value.event.session_id,acquired.session_id,'T05_SESSION');
   assert.ok(value.evidence_refs.some(ref=>ref.uri===record.evidence_ref.uri&&ref.record_sha256===record.evidence_ref.record_sha256),'T05_EVIDENCE: own raw record must remain registered');
   assert.ok(value.representations.some(rep=>rep.event_id===identity.canonical_id&&rep.raw_ref.uri===record.evidence_ref.uri),'T05_EVIDENCE: representation must bind this acquired event');
   pair[role]={acquired,value,identity};values.push(value);
  }
  assert.equal(pair.terminal.value.occurrence.id,pair.request.value.occurrence.id,'T05_OCCURRENCE: same turn request and terminal must share the occurrence');
  assert.equal(pair.terminal.value.occurrence.identity_epoch,pair.request.value.occurrence.identity_epoch,'T05_EPOCH: same turn request and terminal must share the epoch');
  bindings.push(pair);
 }
 assert.notEqual(bindings[0].request.value.occurrence.id,bindings[1].request.value.occurrence.id,'T05_OCCURRENCE: distinct native turns remain separate');
 assert.notEqual(bindings[0].request.value.occurrence.identity_epoch,bindings[1].request.value.occurrence.identity_epoch,'T05_EPOCH: distinct native turns retain separate epochs');
 for(const pair of bindings){
  const links=pair.terminal.value.relations.filter(r=>r.type==='RESULT_OF');assert.equal(links.length,1,'T05_RESULT_OF: exactly one terminal-to-request relation is required');
  assert.equal(links[0].from_id,pair.terminal.identity.canonical_id,'T05_RESULT_OF: relation source must be the independently calculated canonical terminal');assert.equal(links[0].to_id,pair.request.identity.canonical_id,'T05_RESULT_OF: relation target must be the independently calculated canonical request of this turn');
  for(const value of values)for(const relation of value.relations.filter(r=>r.type==='RESULT_OF'&&r.from_id===pair.terminal.identity.canonical_id))assert.equal(relation.to_id,pair.request.identity.canonical_id,'T05_RESULT_OF: no cross-turn target in any returned relation');
 }
 ctx.receipt.correlation_bindings=bindings.map(pair=>({turn:pair.turn,request_event_id:pair.request.identity.canonical_id,terminal_event_id:pair.terminal.identity.canonical_id,request_raw_ref:pair.request.acquired.raw_ref,terminal_raw_ref:pair.terminal.acquired.raw_ref,occurrence_id:pair.request.value.occurrence.id,identity_epoch:pair.request.value.occurrence.identity_epoch}));
 for(const value of values)for(const relation of value.relations.filter(r=>r.type==='RESULT_OF'))assert.ok(expectedIds.some(e=>e.result_of&&e.canonical_id===relation.from_id&&e.result_of===relation.to_id),'T05_RESULT_OF: every returned endpoint pair is fixture-backed');
 identity03CheckBindings(ctx,expectedIds);expect(ctx,{executions:new Set(values.map(v=>v.occurrence.id)).size,epochs:new Set(values.map(v=>v.occurrence.identity_epoch)).size});assert.equal(new Set(values.map(v=>v.event.id)).size,4);
}));
test('AFH-03-T06 an unresolved terminal remains an ambiguous orphan',async t=>scenario(t,'AFH-03-T06',async ctx=>{
 const records=[request('open-a',1),request('open-b',2),result(ctx.fixture.input.orphan_call,1,3)],x=await ingest(ctx,records),events=toolEvents(x),values=[],expectedIds=identity03Expected(x.source,[meta('synthetic-occurrences'),...records]);assert.equal(events.length,3);assert.deepEqual(events.map(e=>e.kind),['tool.requested','tool.requested','tool.completed']);
 for(const event of events){const value=await identity03ShowBoth(ctx,event,expectedIds.find(e=>e.anchor===event.id),'T06');values.push(value);}
 const orphan=values[2],terminal=events[2],open=values.slice(0,2);assert.equal(new Set(values.map(v=>v.event.id)).size,3,'T06_EVENT_ID: orphan event remains distinct');assert.ok(orphan.occurrence.id);
 assert.ok(orphan.evidence_refs.some(ref=>ref.uri===terminal.raw_ref.uri&&ref.record_sha256===terminal.raw_ref.record_sha256),'T06_EVIDENCE: orphan keeps its own terminal raw reference');
 assert.ok(orphan.representations.some(rep=>rep.event_id===expectedIds[2].canonical_id&&rep.raw_ref.uri===terminal.raw_ref.uri),'T06_EVIDENCE: orphan representation identifies its acquired terminal');
 assert.notEqual(open[0].occurrence.id,open[1].occurrence.id,'T06_OPEN_CALLS: both open calls remain distinct');
 for(const call of open)assert.notEqual(orphan.occurrence.id,call.occurrence.id,'T06_ORPHAN_OCCURRENCE: ambiguous terminal cannot belong to any open call');
 assert.equal(orphan.relations.filter(r=>r.type==='RESULT_OF').length,0,'T06_ORPHAN_RESULT_OF: ambiguous terminal has no resolved request');
 for(const value of values)assert.equal(value.relations.filter(r=>r.type==='RESULT_OF').length,0,'T06_ORPHAN_RESULT_OF: no orphan link or invented result may be hidden on another event');
 ctx.receipt.orphan_binding={terminal_event_id:terminal.id,terminal_raw_ref:terminal.raw_ref,occurrence_id:orphan.occurrence.id,open_calls:open.map(call=>({event_id:call.event.id,occurrence_id:call.occurrence.id}))};
 identity03CheckBindings(ctx,expectedIds);expect(ctx,{orphan_preserved:!!orphan.occurrence.id,assigned_to_last_command:orphan.occurrence.id===values[1].occurrence.id||orphan.relations.some(r=>r.type==='RESULT_OF'&&r.to_id===values[1].event.id),correlation:orphan.occurrence.reason});
}));
test('AFH-03-T07 unknown validation preserves exact occurrence and evidence',async t=>scenario(t,'AFH-03-T07',async ctx=>{
 const f=ctx.fixture.input,caseDir=await legacyCapture(ctx,[meta('synthetic-unknown'),observed('unknown-execution',f.exit_code,1,{status:f.status,command:f.tool})]),values=rows(caseDir,"SELECT v.status,v.evidence_event_id,t.id AS occurrence_id FROM validation v JOIN event e ON e.id=v.evidence_event_id JOIN tool_execution t ON t.result_event_id=e.id WHERE v.level='HISTORICAL'"),execs=rows(caseDir,'SELECT id FROM tool_execution');ctx.receipt.rows=values;assert.equal(values.length,1,'UNKNOWN must remain an actual validation row');const refs=rows(caseDir,'SELECT uri FROM evidence_ref WHERE event_id=?',[values[0].evidence_event_id]);assert.ok(refs.length>=ctx.expected.evidence_refs_gte);expect(ctx,{validations:values.length,outcome:values[0].status,pass_count:values.filter(v=>v.status==='PASS'||v.status==='OBSERVED_PASS').length,same_occurrence:execs.length===1&&execs[0].id===values[0].occurrence_id,evidence_refs_gte:refs.length});
}));
test('AFH-03-T08 explicit local validation outcomes cannot close a mission',async t=>scenario(t,'AFH-03-T08',async ctx=>{
 const x=await ingest(ctx,ctx.fixture.input.codes.map((code,i)=>observed('validator-'+i,code,i+1))),values=[];for(const e of toolEvents(x))values.push(await show(ctx,e));const pointer=JSON.parse(fs.readFileSync(path.join(ctx.archive,'archive.json'))),db=new DatabaseSync(path.join(ctx.archive,'ledger.sqlite'),{readOnly:true});let goals;try{const table=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mission_version'").get();goals=table?db.prepare('SELECT data_json FROM mission_version WHERE commit_seq<=?').all(pointer.published_seq).map(r=>JSON.parse(r.data_json)):[];}finally{db.close();}expect(ctx,{validations:values.length,outcomes:values.map(v=>v.occurrence.outcome),goal_closed:goals.some(g=>['COMPLETED','CLOSED'].includes(g.status))});
}));
test('AFH-03-T09 loop terminal follows observable execution order',async t=>scenario(t,'AFH-03-T09',async ctx=>{
 const f=ctx.fixture.input,caseDir=await legacyCapture(ctx,[meta('synthetic-loop'),...f.codes.flatMap((code,i)=>[request('attempt-'+f.order[i],i*2+1),result('attempt-'+f.order[i],code,i*2+2)])]),db=new CaseDatabase(path.join(caseDir,'case.sqlite'),{readOnly:true});let groups;try{groups=loopGroups(db);}finally{db.close();}ctx.receipt.groups=groups;assert.equal(groups.length,1);expect(ctx,{attempts:groups[0].attempts,terminal_status:groups[0].terminal_status});
}));
test('AFH-03-T10 incomparable clock domains preserve both terminal candidates',async t=>scenario(t,'AFH-03-T10',async ctx=>{
 const a=await ingest(ctx,[observed('clock-a',1,1,{clock_domain:'clock-a'})],{name:'clock-a',session:'clock-a'}),b=await ingest(ctx,[observed('clock-b',0,1,{clock_domain:'clock-b'})],{name:'clock-b',session:'clock-b'});await show(ctx,toolEvents(a)[0]);await show(ctx,toolEvents(b)[0]);
 const before=inventory(ctx.archive),groups=await observedOccurrenceGroups(ctx);assert.deepEqual(inventory(ctx.archive),before);ctx.receipt.groups=groups;assert.equal(groups.length,1);expect(ctx,{terminal_status:groups[0].terminal_status,candidates:groups[0].terminal_candidates.length});assert.equal(new Set(groups[0].terminal_candidates).size,2);
}));
test('AFH-03-T12 stdout stderr exit and cwd survive as separate payload roles',async t=>scenario(t,'AFH-03-T12',async ctx=>{
 const f=ctx.fixture.input,x=await ingest(ctx,[observed('payload',f.exit_code,1,f)]),v=await show(ctx,toolEvents(x)[0]),out=v.occurrence.payloads.filter(p=>p.role==='stdout'),err=v.occurrence.payloads.filter(p=>p.role==='stderr');assert.equal(out.length,1);assert.equal(err.length,1);expect(ctx,{stdout_exact:await payloadText(ctx,out[0])===f.stdout,stderr_exact:await payloadText(ctx,err[0])===f.stderr,exit_code:v.occurrence.exit_code,cwd_preserved:v.occurrence.cwd===f.cwd});
}));
test('AFH-03-T13 equal commands with unequal output preserve distinct CAS payloads',async t=>scenario(t,'AFH-03-T13',async ctx=>{
 const f=ctx.fixture.input,x=await ingest(ctx,f.outputs.map((stdout,i)=>observed('output-'+i,0,i+1,{stdout,command:f.command}))),values=[];for(const [i,e]of toolEvents(x).entries()){const v=await show(ctx,e),p=v.occurrence.payloads.find(p=>p.role==='stdout');assert.ok(p);assert.equal(await payloadText(ctx,p),f.outputs[i]);values.push({id:v.occurrence.id,hash:p.content_sha256});}expect(ctx,{executions:new Set(values.map(v=>v.id)).size,output_objects:new Set(values.map(v=>v.hash)).size});
}));
test('AFH-03-T14 explicit nanosecond duration and missing duration remain distinct',async t=>scenario(t,'AFH-03-T14',async ctx=>{
 const x=await ingest(ctx,ctx.fixture.input.durations.map((duration,i)=>observed('duration-'+i,0,i+1,{duration}))),values=[];for(const e of toolEvents(x))values.push((await show(ctx,e)).occurrence);expect(ctx,{duration_ms:values.map(v=>v.duration_ns===null?null:Number(v.duration_ns)/1e6),precision:values.map(v=>v.duration_ns===null?'unknown':'ns')});assert.equal(BigInt(values[0].duration_ns),1500000000n);assert.equal(values[1].duration_ns,null);
}));
test('AFH-03-T15 request without terminal remains incomplete with unknown effects',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 const x=await ingest(ctx,[request('request-only',1)]),e=toolEvents(x)[0],v=await show(ctx,e);expect(ctx,{lifecycle:v.occurrence.lifecycle,effects_status:v.occurrence.effects_status,request_ref_retained:v.evidence_refs.some(r=>r.uri===e.raw_ref.uri)});assert.equal(v.occurrence.exit_code,null);
}));
test('AFH-03-T17 explicit approval denial differs from absent result',async t=>scenario(t,'AFH-03-T17',async ctx=>{
 const x=await ingest(ctx,[request('denied',1),result('denied',null,2,{status:'approval_denied',approval_denied:true}),request('silent',3)]),events=toolEvents(x),a=await show(ctx,events[0]),b=await show(ctx,events[2]);expect(ctx,{lifecycles:[a.occurrence.lifecycle,b.occurrence.lifecycle]});assert.notEqual(a.occurrence.id,b.occurrence.id);
}));
test('AFH-03-T18 timeout and cancellation keep explicit reasons and distinct states',async t=>scenario(t,'AFH-03-T18',async ctx=>{
 const x=await ingest(ctx,[observed('timeout',null,1,{status:'timeout',timed_out:true}),observed('cancelled',null,2,{status:'cancelled',cancelled:true})]),values=[];for(const e of toolEvents(x))values.push((await show(ctx,e)).occurrence);expect(ctx,{lifecycles:values.map(v=>v.lifecycle),reasons:values.map(v=>v.reason)});
}));
test('AFH-03-T19 historical commands remain inert source evidence',async t=>scenario(t,'AFH-03-T19',async ctx=>{
 const f=ctx.fixture.input,x=await ingest(ctx,[request('history',1,f.historical_command)]),e=toolEvents(x)[0],v=await show(ctx,e),raw=await ctx.call('evidence.read',{uri:e.raw_ref.uri,format:'text'});expect(ctx,{canary_exists:fs.existsSync(path.join(ctx.run,'HISTORICAL_REPLAY_CANARY')),evidence_preserved:raw.data.payload.includes(f.historical_command)&&v.occurrence.command===f.historical_command});
}));
test('AFH-03-T21 malformed arguments and unknown JSON keep raw evidence and disclose unsupported normalization',async t=>scenario(t,'AFH-03-T21',async ctx=>{
 const f=ctx.fixture.input,call=request('malformed',1);call.payload.arguments=f.args;const x=await ingest(ctx,[call,{timestamp:iso(2),type:'brand_new_record',payload:{record_unknown:f.record_unknown}}]),e=toolEvents(x)[0],v=await show(ctx,e);assert.equal(v.occurrence.arguments_raw,f.args);const unknown=x.source.records.at(-1),raw=await ctx.call('evidence.read',{uri:unknown.evidence_ref.uri,format:'text'});expect(ctx,{raw_refs_retained:!!raw.data.payload&&v.evidence_refs.some(r=>r.uri===e.raw_ref.uri),normalization:unknown.normalization_status,successful_parse_not_full_coverage:x.response.receipt.coverage.records_unsupported>0&&x.response.receipt.coverage.status==='PARTIAL'});
}));
test('AFH-03-T22 exact observed counts disclose partial acquisition and unknown universe',async t=>scenario(t,'AFH-03-T22',async ctx=>{
 const f=ctx.fixture.input,file=path.join(ctx.run,'source.jsonl');let appended=false;const engine=createArchiveEngine({fault:async name=>{if(name==='source_boundary'&&!appended){appended=true;fs.appendFileSync(file,Array.from({length:f.known_omitted},(_,i)=>JSON.stringify(observed('late-'+i,0,20+i))).join('\n')+'\n');}}});const x=await ingest(ctx,Array.from({length:f.known_acquired},(_,i)=>observed('acquired-'+i,0,i+1)),{engine}),value=await stats(ctx);assert.equal(appended,true);assert.ok(x.source.late_bytes>0);expect(ctx,{observed_executions:Number(value.totals.observed_count),exact_within_observed_scope:value.exact_within_observed_scope,total_universe:x.response.receipt.coverage.universe_total,coverage:x.response.receipt.coverage.status});
}));


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


test('Occurrence integrity controls reject every changed published extension fact',async t=>scenario(t,'AFH-03-T13',async ctx=>{
 ctx.receipt.validation_role='OCCURRENCE_EXACT_PUBLISHED_CLOSURE';
 const x=await ingest(ctx,[request('integrity',1),result('integrity',0,2),observed('separate',1,3,{stdout:'same payload',stderr:'same payload'})]);
 const base=await show(ctx,toolEvents(x)[0]),sample=await show(ctx,toolEvents(x)[2]);assert.equal(sample.occurrence.payloads.find(p=>p.role==='stdout').content_sha256,sample.occurrence.payloads.find(p=>p.role==='stderr').content_sha256);
 const tables=['event_version','occurrence_version','representation','relation_version','occurrence_payload','content_object'];ctx.receipt.mutations=[];
 for(const table of tables)for(const kind of ['missing','extra','shifted','content','missing_table']){
  const target=path.join(ctx.run,table+'-'+kind);fs.cpSync(ctx.archive,target,{recursive:true,errorOnExist:true,force:false});const db=new DatabaseSync(path.join(target,'ledger.sqlite'));let changed;
  try{const row=db.prepare('SELECT * FROM '+table+' ORDER BY id LIMIT 1').get();assert.ok(row,'Every new table must contain a genuine committed fact');
   if(kind==='missing')changed=db.prepare('DELETE FROM '+table+' WHERE id=?').run(row.id);
   if(kind==='extra')changed=db.prepare('INSERT INTO '+table+' VALUES(?,?,?)').run('extra-'+row.id,row.commit_seq,row.data_json);
   if(kind==='shifted')changed=db.prepare('UPDATE '+table+' SET commit_seq=1 WHERE id=?').run(row.id);
   if(kind==='content'){const value=JSON.parse(row.data_json);value.uncommitted='mutant';changed=db.prepare('UPDATE '+table+' SET data_json=? WHERE id=?').run(JSON.stringify(value),row.id);}
   if(kind==='missing_table'){db.exec('DROP TABLE '+table);changed={changes:1};}
   assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{db.close();}
  assert.ok(changed.changes>0);
  for(const deep of [false,true]){const response=await ctx.call('archive.verify',{deep},{},null,target,publicApi.archiveRequest,'PUBLISHED_INTEGRITY_FAILURE');assert.equal(response.data.passed,false);ctx.receipt.mutations.push({table,kind,deep,response});}
  for(const [operation,params]of [['event.show',{event_id:base.event.id,include_representations:true}],['stats',{scope,time,metric:'executions'}]]){const response=await ctx.call(operation,params,{},null,target,publicApi.archiveRequest,'INTEGRITY_FAILED');assert.equal(response.error.code,'INTEGRITY_FAILED');ctx.receipt.mutations.push({table,kind,operation,response});}
  const internal=await observedOccurrenceGroups(ctx,target,'INTEGRITY_FAILED');assert.equal(internal.code,'INTEGRITY_FAILED');
 }
 const groups=await ctx.call('stats',{scope,time,metric:'executions',group_by:['command']});assert.equal(groups.data.totals.observed_count,2);assert.equal(groups.data.rows.length,1);assert.equal(groups.data.rows[0].totals.observed_count,2);
 assert.equal((await ctx.call('archive.verify',{deep:true})).data.passed,true);
}));

test('Occurrence recovery controls preserve atomic terminal publication and reject missing staged payloads',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='OCCURRENCE_RECOVERY_AND_PUBLICATION';ctx.receipt.recovery_controls=[];
 const x=await ingest(ctx,[request('late',1)]),event=toolEvents(x)[0],old=await show(ctx,event),sourceFile=path.join(ctx.run,'source.jsonl');fs.appendFileSync(sourceFile,JSON.stringify(result('late',0,2))+'\n');
 const params={sources:[x.input],include_children:false,idempotency_key:'append-terminal'};
 for(const barrier of ['objects_fsync','ledger_commit','revision_manifest','pointer_replace']){
  const target=path.join(ctx.run,'crash-'+barrier);fs.cpSync(ctx.archive,target,{recursive:true,errorOnExist:true,force:false});const requestValue={kind:'request',schema_version:4,protocol_version:'4.0',request_id:'occurrence-crash-'+barrier,operation:'archive.ingest',archive:target,revision_id:null,params};
  const killed=await childRequest(ctx.run,requestValue,{barrier,onBarrier:async()=>{const visible=await ctx.call('event.show',{event_id:event.id,include_representations:true},{},null,target);assert.equal(visible.data.occurrence.id,old.occurrence.id);assert.equal(visible.data.occurrence.lifecycle,barrier==='pointer_replace'?'COMPLETED':'INCOMPLETE');}});
  const lock=JSON.parse(fs.readFileSync(path.join(target,'writer.lock'))),plan=JSON.parse(fs.readFileSync(path.join(target,'jobs',lock.job_id,'checkpoint.json'))).payload.plan;
  const recovered=await ctx.call('archive.recover',{idempotency_key:'recover',job_id:lock.job_id,expected_owner_token:lock.nonce,action:'resume'},{},null,target,request=>childRequest(ctx.run,request));assert.equal(recovered.error,null);
  const current=await ctx.call('event.show',{event_id:event.id,include_representations:true},{},null,target),historical=await ctx.call('event.show',{event_id:event.id,include_representations:true},{},x.response.data.revision_id,target);assert.equal(current.data.occurrence.id,old.occurrence.id);assert.equal(current.data.occurrence.lifecycle,'COMPLETED');assert.equal(historical.data.occurrence.lifecycle,'INCOMPLETE');
  const replay=await ctx.call('archive.ingest',params,{},null,target);assert.deepEqual(replay.data,plan.result.data);assert.deepEqual(replay.receipt,plan.result.receipt);assert.equal((await ctx.call('archive.verify',{deep:true},{},null,target)).data.passed,true);ctx.receipt.recovery_controls.push({barrier,killed,recovered,current,historical,idempotent_replay:true});
 }
 for(const mutation of ['missing_payload','missing_committed_occurrence']){
  const target=path.join(ctx.run,mutation);fs.cpSync(ctx.archive,target,{recursive:true,errorOnExist:true,force:false});const barrier=mutation==='missing_payload'?'objects_fsync':'ledger_commit',requestValue={kind:'request',schema_version:4,protocol_version:'4.0',request_id:mutation,operation:'archive.ingest',archive:target,revision_id:null,params};await childRequest(ctx.run,requestValue,{barrier});
  const lock=JSON.parse(fs.readFileSync(path.join(target,'writer.lock'))),plan=JSON.parse(fs.readFileSync(path.join(target,'jobs',lock.job_id,'checkpoint.json'))).payload.plan,pointer=fs.readFileSync(path.join(target,'archive.json'));
  if(mutation==='missing_payload'){const object=plan.occurrence_facts.occurrence_payload.find(row=>row.data_json.role==='result');assert.ok(object);fs.unlinkSync(path.join(target,'bronze/objects',object.data_json.content_sha256));}
  else{const db=new DatabaseSync(path.join(target,'ledger.sqlite'));try{assert.ok(db.prepare('DELETE FROM occurrence_version WHERE commit_seq=?').run(plan.manifest.commit_seq).changes>0);}finally{db.close();}}
  const response=await ctx.call('archive.recover',{idempotency_key:'recover-negative',job_id:lock.job_id,expected_owner_token:lock.nonce,action:'resume'},{},null,target,request=>childRequest(ctx.run,request));ctx.receipt.recovery_controls.push({mutation,response});assert.ok(response.error&&['INTEGRITY_FAILED','EVIDENCE_UNAVAILABLE'].includes(response.error.code));assert.deepEqual(fs.readFileSync(path.join(target,'archive.json')),pointer);
 }
}));

test('Occurrence counting controls distinguish new acts from repeated delivery and metadata',async t=>scenario(t,'AFH-03-T01',async ctx=>{
 ctx.receipt.validation_role='OCCURRENCE_DELTA_COUNTS';
 const x=await ingest(ctx,[request('count',1),result('count',0,2)]);assert.equal(x.response.data.delta.new_occurrences,1);
 const file=path.join(ctx.run,'source.jsonl');fs.appendFileSync(file,JSON.stringify(result('count',0,2))+'\n');
 const repeated=await ctx.call('archive.ingest',{sources:[x.input],include_children:false,idempotency_key:'repeated-terminal'});assert.equal(repeated.error,null);assert.equal(repeated.data.delta.new_occurrences,0);
 fs.appendFileSync(file,JSON.stringify(request('count',3))+'\n'+JSON.stringify(result('count',1,4))+'\n');
 const next=await ctx.call('archive.ingest',{sources:[x.input],include_children:false,idempotency_key:'next-cycle'});assert.equal(next.error,null);assert.equal(next.data.delta.new_occurrences,1);
 const counts=await stats(ctx);assert.equal(counts.totals.observed_count,2);assert.equal(counts.denominators.representations,5);ctx.receipt.deltas=[x.response,repeated,next];
 const selected=await ctx.call('stats',{scope:{...scope,session_ids:[x.source.session_id]},time,metric:'executions'}),outside=await ctx.call('stats',{scope:{...scope,session_ids:['not-observed-session']},time,metric:'executions'});assert.equal(selected.data.totals.observed_count,2);assert.equal(outside.data.totals.observed_count,0);assert.equal(outside.data.denominators.occurrences,0);
}));

test('Occurrence revision controls preserve unchanged facts and link genuine successors',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='OCCURRENCE_CHANGE_REVISIONS';
 const x=await ingest(ctx,[request('revision',1)]),event=toolEvents(x)[0],initial=await show(ctx,event);assert.equal(initial.occurrence.temporal.revision_no,1);
 await ingest(ctx,[user('unrelated act',2,'unrelated')],{name:'unrelated'});const unchanged=await show(ctx,event);assert.deepEqual(unchanged.occurrence,initial.occurrence);
 fs.appendFileSync(path.join(ctx.run,'source.jsonl'),JSON.stringify(result('revision',0,3))+'\n');const next=await ctx.call('archive.ingest',{sources:[x.input],include_children:false,idempotency_key:'terminal'});assert.equal(next.error,null);const current=await show(ctx,event);assert.equal(current.occurrence.temporal.revision_no,2);assert.equal(current.occurrence.temporal.supersedes_revision_id,initial.occurrence.temporal.revision_id);assert.equal(current.occurrence.id,initial.occurrence.id);assert.equal(current.occurrence.lifecycle,'COMPLETED');
 ctx.receipt.versions={initial,unchanged,current};
}));

test('Occurrence payload controls retain JSON encoded stdout and stderr with exact extraction provenance',async t=>scenario(t,'AFH-03-T12',async ctx=>{
 ctx.receipt.validation_role='OCCURRENCE_ENCODED_STREAMS';
 const x=await ingest(ctx,[request('streams',1),result('streams',1,2,{stdout:'encoded stdout',stderr:'encoded stderr'})]),value=await show(ctx,toolEvents(x)[1]);ctx.receipt.streams=[];
 for(const role of ['stdout','stderr']){
  const payload=value.occurrence.payloads.find(p=>p.role===role);assert.ok(payload);const ref=payload.evidence_refs[0],raw=await ctx.call('evidence.read',{uri:ref.uri,format:'text'}),container=JSON.parse(raw.data.payload).payload.output,text=JSON.parse(container)[role];assert.equal(ref.json_pointer,'/payload/output');assert.equal(payload.content_sha256,hash(Buffer.from(text)));assert.equal(payload.bytes,Buffer.byteLength(text));assert.equal(hash(fs.readFileSync(path.join(ctx.archive,'bronze/objects',payload.content_sha256))),payload.content_sha256);
  const part=toolEvents(x)[1].metadata.occurrence_v1.parts.find(p=>p.role===role);assert.deepEqual(part.extraction,{rule_id:'JSON_STRING_FIELD',rule_version:'1',field:role});ctx.receipt.streams.push({role,payload,extraction:part.extraction,verified_text:text});
 }
 assert.equal((await ctx.call('archive.verify',{deep:true})).data.passed,true);
}));

function identity03Rows(archive,table,seq=null){const db=new DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});try{if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Object.assign(new Error('Identity03 '+table+' is absent'),{code:'NOT_IMPLEMENTED'});return db.prepare('SELECT data_json FROM '+table+(seq===null?'':' WHERE commit_seq<=?')+' ORDER BY id').all(...(seq===null?[]:[seq])).map(r=>JSON.parse(r.data_json));}finally{db.close();}}
async function observeIdentity03RawReads(root,body){
 const accesses=[],restores=[],bronze=path.join(root,'bronze')+path.sep;let nestedRead=0;
 const candidate=x=>{try{return typeof x==='string'||x instanceof URL?path.resolve(x instanceof URL?fileURLToPath(x):x):null;}catch{return null;}};
 function wrap(object,name){const original=object[name];if(typeof original!=='function')return;object[name]=function(...args){const file=candidate(args[0]),watched=!nestedRead&&!readerInventoryDepth&&file?.startsWith(bronze),entry=watched?{kind:name,file,completed:false,bytes:0}:null;if(entry)accesses.push(entry);if(name==='readFileSync')nestedRead++;try{const value=original.apply(this,args);if(entry&&name==='readFileSync'){entry.completed=true;entry.bytes=Buffer.isBuffer(value)?value.length:Buffer.byteLength(value);}return value;}finally{if(name==='readFileSync')nestedRead--;}};restores.push(()=>object[name]=original);}
 // Uninstrumented alternative paths fail the budget oracle instead of escaping it.
 for(const name of ['readFileSync','readFile','openSync','open','createReadStream'])wrap(fs,name);for(const name of ['readFile','open'])wrap(fs.promises,name);syncBuiltinESMExports();
 try{return {value:await body(),accesses};}finally{for(const restore of restores.reverse())restore();syncBuiltinESMExports();}
}
for(const count of [1,8])test('Identity03 lookup observes bounded Bronze reads with '+count+' sources',async t=>scenario(t,'AFH-02-T04',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_BOUNDED_BRONZE_IO_NOT_GENERAL_PERFORMANCE';let target;
 for(let i=0;i<count;i++){const x=await ingest(ctx,[user('private lookup '+i,1,'lookup-'+i)],{name:'lookup-'+i});if(i===0)target=x;}
 const expected=identity03Expected(target.source,[meta('synthetic-occurrences'),user('private lookup 0',1,'lookup-0')])[0];
 const allowedObjects=target.source.objects.map(o=>path.join(ctx.archive,'bronze/objects',o.sha256)),allowedFiles=[...allowedObjects,path.join(ctx.archive,'bronze/sources',target.source.source_revision_id+'.json')],maxBytes=4*allowedFiles.reduce((n,file)=>n+fs.statSync(file).size,0);
 ctx.receipt.lookup_limits={source_count:count,allowedFiles,maxBytes,claim:'BOUNDED_FIXTURE_BRONZE_IO_ONLY'};
 for(const eventId of [expected.anchor,expected.canonical_id]){
  const measured=await observeIdentity03RawReads(ctx.archive,()=>ctx.call('event.show',{event_id:eventId,include_representations:true}));const observation=ctx.receipt.read_only_observations.at(-1),budget={native_calls:observation.native_calls,raw_accesses:measured.accesses,reader_mutations:observation.filesystem_mutations.length+observation.sql_mutations.length};(ctx.receipt.lookup_observations??=[]).push({eventId,...budget});assert.equal(measured.value.error,null);assertIdentity03LookupBudget(budget,allowedFiles,maxBytes);assertIdentity03Answer(measured.value.data,expected,'IDENTITY03_INDEX');
 }
}));
test('Identity03 recapture retains all revision placements while counts use technical classes',async t=>scenario(t,'AFH-03-T01',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_RECAPTURE';const records=[request('count',1),result('count',0,2)],x=await ingest(ctx,records),captures=[x.response],expectedActs=[1,1,2],expectedTechnical=[2,3,5],expectedRows=[2,5,10],snapshots=[];
 for(let i=0;i<3;i++){
  if(i){const added=i===1?[result('count',0,2)]:[request('count',3),result('count',1,4)];records.push(...added);fs.appendFileSync(x.input.path,added.map(r=>JSON.stringify(r)).join('\n')+'\n');captures.push(await ctx.call('archive.ingest',{sources:[x.input],include_children:false,idempotency_key:'recapture-'+i}));assert.equal(captures[i].error,null);}
  const counts=await stats(ctx),reps=identity03Rows(ctx.archive,'representation'),source=manifest(ctx.archive,captures[i].data.source_revisions[0]),expected=identity03Expected(source,[meta('synthetic-occurrences'),...records]);assert.equal(counts.denominators.occurrences,expectedActs[i]);assert.equal(counts.denominators.representations,expectedTechnical[i]);assert.equal(reps.length,expectedRows[i],'IDENTITY03_REVISION_PLACEMENTS');assert.equal(new Set(reps.map(r=>r.id)).size,reps.length);
  for(const e of expected){const r=reps.find(r=>r.id===e.representation_id);assert.ok(r,'IDENTITY03_REP4_RECIPE');assert.equal(r.raw_ref.json_pointer,e.locator.json_pointer);const raw=await ctx.call('evidence.read',{uri:r.raw_ref.uri,format:'base64'});assert.equal(raw.error,null);assert.equal(hash(Buffer.from(raw.data.payload,'base64')),e.locator.record_sha256);}
  snapshots.push({revision:captures[i].data.revision_id,reps,counts});
 }
 const stable=inventory(ctx.archive),replay=await ctx.call('archive.ingest',{sources:[x.input],include_children:false,idempotency_key:'recapture-2'});assert.deepEqual(replay.data,captures[2].data);assert.deepEqual(inventory(ctx.archive),stable);
 for(const [i,s]of snapshots.entries()){const old=await ctx.call('stats',{scope,time,metric:'executions'},{},s.revision);assert.equal(old.data.denominators.occurrences,expectedActs[i]);assert.equal(old.data.denominators.representations,expectedTechnical[i]);}
 ctx.receipt.identity_snapshots=snapshots;
}));
test('Identity03 native namespaces and dual message encodings use independent canonical recipes',async t=>scenario(t,'AFH-03-T02',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_NATIVE_NAMESPACES';const records=[user('same',1,'x'),{timestamp:iso(1),type:'event_msg',payload:{type:'item_completed',item:{type:'UserMessage',id:'x',content:[{type:'input_text',text:'same'}]}}},user('same',2,'y'),request('x',3),result('x',0,4)],x=await ingest(ctx,records),expected=identity03Expected(x.source,[meta('synthetic-occurrences'),...records]),values=[];
 for(const e of expected)values.push(await identity03ShowBoth(ctx,x.events.find(a=>a.id===e.anchor),e,'IDENTITY03'));
 assert.equal(values[0].event.id,values[1].event.id);assert.equal(values[0].occurrence.id,values[1].occurrence.id);assert.notEqual(values[0].occurrence.id,values[2].occurrence.id);assert.notEqual(values[0].occurrence.id,values[3].occurrence.id);identity03CheckBindings(ctx,expected);
}));
test('Identity03 fallback survives verified append and separates divergent suffix and independent copies',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_FALLBACK';const records=[user('a',1),user('b',2)],x=await ingest(ctx,records),initial=identity03Expected(x.source,[meta('synthetic-occurrences'),...records]);for(const e of initial)await identity03ShowBoth(ctx,x.events.find(a=>a.id===e.anchor),e,'IDENTITY03');
 fs.appendFileSync(x.input.path,JSON.stringify(user('c',3))+'\n');const append=await ctx.call('archive.ingest',{sources:[x.input],idempotency_key:'append'});assert.equal(append.error,null);const s2=manifest(ctx.archive,append.data.source_revisions[0]),expected2=identity03Expected(s2,[meta('synthetic-occurrences'),...records,user('c',3)]);assert.deepEqual(expected2.slice(0,2).map(e=>e.canonical_id),initial.map(e=>e.canonical_id));
 fs.writeFileSync(x.input.path,[meta('synthetic-occurrences'),records[0],user('changed',2),user('c',3)].map(r=>JSON.stringify(r)).join('\n')+'\n');const diverged=await ctx.call('archive.ingest',{sources:[x.input],idempotency_key:'diverged'});assert.equal(diverged.error,null);const s3=manifest(ctx.archive,diverged.data.source_revisions[0]),expected3=identity03Expected(s3,[meta('synthetic-occurrences'),records[0],user('changed',2),user('c',3)]);assert.equal(expected3[0].canonical_id,initial[0].canonical_id);assert.notEqual(expected3[1].canonical_id,initial[1].canonical_id);
 for(const e of expected3){const out=await ctx.call('event.show',{event_id:e.anchor,include_representations:true});assert.equal(out.error,null);assertIdentity03Answer(out.data,e,'IDENTITY03');}
 const copy=await ingest(ctx,records,{name:'independent-copy'}),copyIds=identity03Expected(copy.source,[meta('synthetic-occurrences'),...records]);assert.notEqual(copyIds[0].canonical_id,initial[0].canonical_id);const old=await ctx.call('event.show',{event_id:initial[1].anchor,include_representations:true},{},x.response.data.revision_id);assert.equal(old.data.event.id,initial[1].canonical_id);
}));
test('Identity03 unknown producer versions cannot merge native IDs across unproven lineages',async t=>scenario(t,'AFH-03-T02',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_UNBACKED_UNIQUENESS';const firstMeta=meta('unknown-contract');firstMeta.payload.cli_version='unproven-version';const values=[];
 for(const name of ['a','b']){const file=path.join(ctx.run,name+'.jsonl');writeRecords(file,[firstMeta,user('same',1,'x')]);const res=await ctx.call('archive.ingest',{sources:[{path:file,harness:'codex',origin_domain_id:origin}],idempotency_key:name});assert.equal(res.error,null);const source=manifest(ctx.archive,res.data.source_revisions[0]),event=source.records[1].events[0],shown=await ctx.call('event.show',{event_id:event.id,include_representations:true});assert.equal(shown.error,null);values.push(shown.data);}
 assert.notEqual(values[0].occurrence.id,values[1].occurrence.id,'IDENTITY03_UNPROVEN_COPY');assert.notEqual(values[0].event.id,values[1].event.id);
}));
test('Identity03 message role namespaces cannot collapse user assistant and instruction',async t=>scenario(t,'AFH-03-T02',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_MESSAGE_ROLE_NAMESPACES';const records=['user','assistant','system'].map((role,i)=>{const r=user('same',i+1,'same-item');r.payload.role=role;return r;}),x=await ingest(ctx,records),expected=identity03Expected(x.source,[meta('synthetic-occurrences'),...records]),values=[];assert.equal(expected.length,3);for(const e of expected)values.push(await identity03ShowBoth(ctx,x.events.find(a=>a.id===e.anchor),e,'IDENTITY03_ROLE'));assert.equal(new Set(values.map(v=>v.event.id)).size,3);assert.equal(new Set(values.map(v=>v.occurrence.id)).size,3);
}));
test('Identity03 fragments preserve distinct stream pieces',async t=>scenario(t,'AFH-03-T12',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_FRAGMENTS';const fragment=(id,text,i,stream='stdout')=>({timestamp:iso(i),type:'event_msg',payload:{type:'exec_command_output_delta',call_id:'stream',stream,fragment_id:id,delta:text}}),records=[request('stream',1),fragment('f1','first',2),fragment('f2','second',3),fragment('f1','first',4),fragment('f1','first',5,'stderr'),result('stream',0,6)],x=await ingest(ctx,records),fragments=x.events.filter(e=>e.kind==='tool.fragment');assert.equal(fragments.length,4,'IDENTITY03_FRAGMENT_DECODER');const values=[];for(const e of fragments)values.push(await show(ctx,e));
 const startSource={...x.source,records:x.source.records.slice(0,2)},start=identity03Expected(startSource,[meta('synthetic-occurrences'),records[0]])[0],expected=records.slice(1,5).map(r=>({id:'evt4-'+identity03Hash([start.session_id,start.identity_epoch,'tool.fragment','stream',identity03Cjson(['fragment',r.payload.stream,r.payload.fragment_id])]),occurrence_id:start.occurrence_id}));assertIdentity03Fragments(values,expected);assert.equal(new Set(values.map(v=>v.event.id)).size,3);ctx.receipt.fragment_expectations=expected;

}));
test('Identity03 multiple unclosed starts preserve ambiguity',async t=>scenario(t,'AFH-03-T12',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_AMBIGUOUS_STARTS';
 const ambiguous=await ingest(ctx,[request('reuse',1),request('reuse',2),result('reuse',0,3)],{name:'ambiguous'}),v=[];for(const e of toolEvents(ambiguous))v.push(await show(ctx,e));assert.equal(new Set(v.map(x=>x.occurrence.id)).size,3);assert.equal(v[2].occurrence.reason,'AMBIGUOUS_CORRELATION');assert.equal(v.flatMap(x=>x.relations).filter(r=>r.type==='RESULT_OF').length,0);
}));
test('Identity03 fragments without native piece ID remain distinct by acquired locator',async t=>scenario(t,'AFH-03-T12',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_FRAGMENT_FALLBACK';const fragment=i=>({timestamp:iso(i),type:'event_msg',payload:{type:'exec_command_output_delta',call_id:'pieces',stream:'stdout',delta:'same'}}),x=await ingest(ctx,[request('pieces',1),fragment(2),fragment(3)]),events=x.events.filter(e=>e.kind==='tool.fragment');assert.equal(events.length,2,'IDENTITY03_FRAGMENT_DECODER');const values=[];for(const e of events)values.push(await show(ctx,e));assert.notEqual(values[0].event.id,values[1].event.id,'IDENTITY03_FRAGMENT_NO_NULL_DEDUP');assert.equal(values[0].occurrence.id,values[1].occurrence.id);assert.ok(values.every(v=>v.occurrence.lifecycle==='INCOMPLETE'),'IDENTITY03_FRAGMENT_NOT_A_TERMINAL');
}));
test('Identity03 locator decoder preserves array producer subindices before filtering',async t=>scenario(t,'AFH-03-T12',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_ARRAY_LOCATORS';const raw=[{type:'unknown-control',payload:{}},request('array-a',1),request('array-b',2)],x=await ingest(ctx,[raw]),record=x.source.records[1];assert.equal(record.events.length,3);const reps=[];
 for(const subindex of [1,2]){const acquired=record.events[subindex],historicalPointer='/payload',actualPointer='/'+subindex+'/payload';assert.equal(acquired.id,'evt4-'+identity03Hash([x.source.source_lineage_id,record.identity_epoch,record.ordinal,historicalPointer,subindex,acquired.kind]));const v=await ctx.call('event.show',{event_id:acquired.id,include_representations:true});assert.equal(v.error,null);const id='rep4-'+identity03Hash([x.source.source_revision_id,record.ordinal,actualPointer,subindex]),rep=v.data.representations.find(r=>r.id===id);assert.ok(rep,'IDENTITY03_ARRAY_REP4');assert.equal(rep.raw_ref.json_pointer,actualPointer);reps.push(rep);}
 assert.notEqual(reps[0].id,reps[1].id);const bindings=identity03Rows(ctx.archive,'identity_binding'),read=await ctx.call('evidence.read',{uri:record.evidence_ref.uri,format:'base64'});assert.equal(read.error,null);const bytes=Buffer.from(read.data.payload,'base64');
 for(const subindex of [1,2]){const acquired=record.events[subindex],candidates=bindings.filter(b=>b.acquired_alias===acquired.id),b=candidates[0];assert.ok(b,'IDENTITY03_ARRAY_BINDING');const expected={kind:'tool.requested',acquisition_json_pointer:'/payload',node:raw[subindex].payload,locator:{source_revision_id:x.source.source_revision_id,source_lineage_id:x.source.source_lineage_id,record_identity_epoch:record.identity_epoch,record_ordinal:record.ordinal,json_pointer:'/'+subindex+'/payload',event_subindex:subindex,record_sha256:record.sha256}};assertIdentity03LocatorProof({...b,candidates:candidates.length},expected,bytes);}
}));
test('Identity03 missing RAW backing cannot be resolved from a binding alone',async t=>scenario(t,'AFH-03-T13',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_RAW_BACKING_REQUIRED';const x=await ingest(ctx,[request('backed',1)]);identity03Rows(ctx.archive,'identity_binding');const target=path.join(ctx.run,'missing-raw');fs.cpSync(ctx.archive,target,{recursive:true,errorOnExist:true,force:false});const missing=path.join(target,'bronze/objects',x.source.objects[0].sha256);assert.ok(fs.existsSync(missing));fs.unlinkSync(missing);const before=inventory(target),response=await ctx.call('event.show',{event_id:toolEvents(x)[0].id,include_representations:true},{},null,target,publicApi.archiveRequest,'INTEGRITY_FAILED');assert.equal(response.error.code,'INTEGRITY_FAILED');assert.deepEqual(inventory(target),before);ctx.receipt.removed_synthetic_object=missing;
}));
// Supplementary durable comparison; every read still requires the full native observer, including WAL/SHM.
function identity03CompatibilityDurables(root){return inventory(root).filter(row=>!readerAuxiliaryNames.has(row.path));}
async function identity03Pre03Fixture(ctx){
 const file=process.env.AFH_PRE03_PRODUCER_IDENTITY;assert.ok(file,'Pinned real pre03 producer identity is required');const identity=JSON.parse(fs.readFileSync(file)),before=runtimeSnapshot(identity.producer_copy);assert.equal(before.sha256,identity.runtime.sha256);assert.equal(identity.producer_commit,'e0676a12c080ca2832b7271aaaa521cbadf02906');
 const {archiveRequest:oldApi}=await import(pathToFileURL(path.join(identity.producer_copy,'src/archive/engine.js'))),archive=path.join(ctx.run,'pre03-archive'),pairs=[];let index=0;
 const oldCall=async(operation,params)=>{const requestValue={kind:'request',schema_version:4,protocol_version:'4.0',request_id:'pre03-'+(++index),operation,archive,revision_id:null,params},response=await oldApi(requestValue);assert.equal(validateWire(response,'Response').passed,true);pairs.push({request:requestValue,response});return response;};
 const initialized=await oldCall('archive.init',{idempotency_key:'old-init',origin_domains:[{id:origin,harness:'codex',descriptor:'Pinned real pre03 compatibility fixture'}]});assert.equal(initialized.error,null);
 const inputFile=path.join(ctx.run,'pre03-source.jsonl');writeRecords(inputFile,[meta('pre03-fixture'),user('preserved message',1,'m1')]);const input={path:inputFile,harness:'codex',origin_domain_id:origin},ingested=await oldCall('archive.ingest',{sources:[input],idempotency_key:'old-ingest'});assert.equal(ingested.error,null);const source=manifest(archive,ingested.data.source_revisions[0]),event=source.records.flatMap(r=>r.events).find(e=>e.kind==='message.user');assert.ok(event);
 const db=new DatabaseSync(path.join(archive,'ledger.sqlite'),{readOnly:true});let tables;try{tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);}finally{db.close();}assert.ok(identity03FactTables.every(table=>!tables.includes(table)));
 for(const [operation,params]of [['event.show',{event_id:event.id,include_representations:true}],['stats',{scope,time,metric:'executions'}]])assert.equal((await oldCall(operation,params)).error?.code,'NOT_IMPLEMENTED');assert.equal(runtimeSnapshot(identity.producer_copy).sha256,before.sha256);
 ctx.receipt.pre03_producer={identity_ref:file,identity_sha256:hash(fs.readFileSync(file)),runtime_sha256:before.sha256,commit:identity.producer_commit,tables,pairs};return {archive,source,event,input,initialized,ingested};
}
async function identity03Pre03Unavailable(ctx,x,operation,revision=null){
 const selected=revision??JSON.parse(fs.readFileSync(path.join(x.archive,'archive.json'))).revision_id,manifestValue=JSON.parse(fs.readFileSync(path.join(x.archive,'revisions',selected+'.json'))),params=operation==='event.show'?{event_id:x.event.id,include_representations:true}:{scope,time,metric:'executions'};
 const engine=async request=>{const value=await publicApi.archiveRequest(request);assert.equal(value.error?.code,'NOT_IMPLEMENTED','PRE03_VALID_FORMAT_CAPABILITY_UNAVAILABLE');assert.deepEqual(value.error.details,{format:'PRE_OCCURRENCE_EXTENSION',revision_id:selected,commit_seq:manifestValue.commit_seq},'PRE03_AVAILABILITY_BOUND_TO_CUT');return value;};
 const value=await ctx.call(operation,params,{},revision,x.archive,engine,'PRE_OCCURRENCE_EXTENSION'),observation=ctx.receipt.read_only_observations.at(-1);assert.equal(observation.errors.length,0,'PRE03_NO_FAILED_NATIVE_SQL');if(revision===null)assert.ok(!observation.native_calls.some(call=>/\bFROM\s+(identity_binding|event_version|occurrence_version)\b/i.test(call.sql??'')),'PRE03_NO_DEPENDENT_PROJECTION_QUERY');return value;
}
for(const operation of ['event.show','stats'])test('Identity03 compatibility pre03 '+operation+' preserves honest availability without reader migration',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='PRE03_PUBLIC_AVAILABILITY';const x=await identity03Pre03Fixture(ctx),before=identity03CompatibilityDurables(x.archive);assert.equal((await ctx.call('archive.verify',{deep:true},{},null,x.archive)).data.passed,true);await identity03Pre03Unavailable(ctx,x,operation);const read=await ctx.call('evidence.read',{uri:x.source.records[1].evidence_ref.uri,format:'text'},{},null,x.archive);assert.equal(read.error,null);assert.deepEqual(JSON.parse(read.data.payload),user('preserved message',1,'m1'));assert.deepEqual(identity03CompatibilityDurables(x.archive),before);
}));
for(const operation of ['event.show','stats'])test('Identity03 compatibility old cut after writer extension '+operation+' keeps pre03 availability',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='PRE03_OLD_CUT_AFTER_WRITER_EXTENSION';const x=await identity03Pre03Fixture(ctx),oldManifest=fs.readFileSync(path.join(x.archive,'bronze/sources',x.source.source_revision_id+'.json'));fs.appendFileSync(x.input.path,JSON.stringify(user('new message',2,'m2'))+'\n');const extended=await ctx.call('archive.ingest',{sources:[x.input],idempotency_key:'writer-extension'},{},null,x.archive);assert.equal(extended.error,null);assert.equal((await ctx.call('archive.verify',{deep:true},{},null,x.archive)).data.passed,true);
 const current=await ctx.call('event.show',{event_id:x.event.id,include_representations:true},{},null,x.archive);assert.equal(current.error,null);assert.equal(current.data.event.kind,'message.user');const count=await ctx.call('stats',{scope,time,metric:'executions'},{},null,x.archive);assert.equal(count.data.denominators.occurrences,2);const before=identity03CompatibilityDurables(x.archive);
 for(const revision of [x.initialized.data.revision_id,x.ingested.data.revision_id]){assert.equal((await ctx.call('archive.verify',{deep:true},{},revision,x.archive)).data.passed,true);await identity03Pre03Unavailable(ctx,x,operation,revision);}assert.deepEqual(identity03CompatibilityDurables(x.archive),before);assert.deepEqual(fs.readFileSync(path.join(x.archive,'bronze/sources',x.source.source_revision_id+'.json')),oldManifest);ctx.receipt.writer_extension={extended,current,count};
}));
test('Identity03 compatibility committed projection loss remains integrity failure',async t=>scenario(t,'AFH-03-T13',async ctx=>{
 ctx.receipt.validation_role='PRE03_COMMITTED_PROJECTION_LOSS';const x=await identity03Pre03Fixture(ctx);fs.appendFileSync(x.input.path,JSON.stringify(user('new message',2,'m2'))+'\n');assert.equal((await ctx.call('archive.ingest',{sources:[x.input],idempotency_key:'extend'},{},null,x.archive)).error,null);
 for(const tables of [['identity_binding'],['occurrence_version'],identity03FactTables]){const target=path.join(ctx.run,'lost-'+tables.length+'-'+tables[0]);fs.cpSync(x.archive,target,{recursive:true,errorOnExist:true,force:false});const db=new DatabaseSync(path.join(target,'ledger.sqlite'));try{for(const table of tables)db.exec('DROP TABLE '+table);}finally{db.close();}const before=identity03CompatibilityDurables(target);
  for(const [op,params]of [['event.show',{event_id:x.event.id,include_representations:true}],['stats',{scope,time,metric:'executions'}]]){const response=await ctx.call(op,params,{},null,target,publicApi.archiveRequest,'INTEGRITY_FAILED');assert.equal(response.error.code,'INTEGRITY_FAILED');}const verified=await ctx.call('archive.verify',{deep:true},{},null,target,publicApi.archiveRequest,'PUBLISHED_INTEGRITY_FAILURE');assert.equal(verified.data.passed,false);assert.deepEqual(identity03CompatibilityDurables(target),before);
 }
}));
test('Identity03 compatibility new empty archive exposes its available projection',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='CURRENT_EMPTY_ARCHIVE_PROJECTION';const before=identity03CompatibilityDurables(ctx.archive),value=await ctx.call('stats',{scope,time,metric:'executions'});assert.equal(value.error,null);assert.equal(value.data.totals.observed_count,0);const missing=await ctx.call('event.show',{event_id:'evt4-'+'0'.repeat(64),include_representations:true},{},null,ctx.archive,publicApi.archiveRequest,'EVIDENCE_UNAVAILABLE');assert.equal(missing.error.code,'EVIDENCE_UNAVAILABLE');assert.equal((await ctx.call('archive.verify',{deep:true})).data.passed,true);assert.deepEqual(identity03CompatibilityDurables(ctx.archive),before);
}));
test('Identity03 compatibility pre03 reader preserves a nonempty WAL',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='PRE03_NONEMPTY_WAL';const x=await identity03Pre03Fixture(ctx),db=new DatabaseSync(path.join(x.archive,'ledger.sqlite'));try{db.exec('PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE; PRAGMA user_version=1; COMMIT');const wal=path.join(x.archive,'ledger.sqlite-wal');assert.ok(fs.statSync(wal).size>0);const before=fs.readFileSync(wal);
  for(const operation of ['event.show','stats']){await identity03Pre03Unavailable(ctx,x,operation);assert.equal(ctx.receipt.read_only_observations.at(-1).comparison.nonempty_wal_protected,true);assert.deepEqual(fs.readFileSync(wal),before);}
 }finally{db.close();}
}));
async function identity03ConfirmationFixture(ctx){
 const rawBefore=[request('x',1),result('x',0,2)],rawAfter=[...rawBefore,meta('confirmed-session')],file=path.join(ctx.run,'provisional.jsonl');writeRecords(file,rawBefore);
 const input={path:file,harness:'codex',origin_domain_id:origin},first=await ctx.call('archive.ingest',{sources:[input],idempotency_key:'provisional'});assert.equal(first.error,null);const s1=manifest(ctx.archive,first.data.source_revisions[0]),oldSeq=first.receipt.revision_id?JSON.parse(fs.readFileSync(path.join(ctx.archive,'revisions',first.data.revision_id+'.json'))).commit_seq:null;
 const old=[];for(const record of s1.records){const out=await ctx.call('event.show',{event_id:record.events[0].id,include_representations:true});assert.equal(out.error,null);old.push(out.data);}
 const foreignFile=path.join(ctx.run,'foreign.jsonl');writeRecords(foreignFile,[meta('unrelated-native-owner')]);const foreignResult=await ctx.call('archive.ingest',{sources:[{path:foreignFile,harness:'codex',origin_domain_id:origin}],idempotency_key:'foreign'});assert.equal(foreignResult.error,null);const foreign=manifest(ctx.archive,foreignResult.data.source_revisions[0]);assert.notEqual(foreign.source_lineage_id,s1.source_lineage_id);
 const beforeConfirmation=path.join(ctx.run,'before-confirmation');fs.cpSync(ctx.archive,beforeConfirmation,{recursive:true,errorOnExist:true,force:false});fs.appendFileSync(file,JSON.stringify(rawAfter[2])+'\n');
 const second=await ctx.call('archive.ingest',{sources:[input],idempotency_key:'confirmed'});assert.equal(second.error,null);const s2=manifest(ctx.archive,second.data.source_revisions[0]),newSeq=JSON.parse(fs.readFileSync(path.join(ctx.archive,'archive.json'))).published_seq,expected=identity03ConfirmationExpected(s1,s2,rawBefore,rawAfter,oldSeq,newSeq);
 return {rawBefore,rawAfter,input,first,second,s1,s2,old,foreign,beforeConfirmation,expected};
}
async function identity03AssertConfirmation(ctx,x){
 const current=[],historical=[],bindings=identity03Rows(ctx.archive,'identity_binding');
 for(const binding of bindings)assert.equal(validateIdentityBinding(binding),true,JSON.stringify(validateIdentityBinding.errors));
 for(const [i,e]of x.expected.after.entries()){
  current.push(await identity03ShowBoth(ctx,{id:e.anchor},e,'CONFIRM_CURRENT'));
  const past=await ctx.call('event.show',{event_id:e.anchor,include_representations:true},{},x.first.data.revision_id);assert.equal(past.error,null);historical.push(past.data);
  const oldCanonical=await ctx.call('event.show',{event_id:x.expected.before[i].canonical_id,include_representations:true},{},x.first.data.revision_id);assert.equal(oldCanonical.error,null);assert.deepEqual(oldCanonical.data,x.old[i]);
 }
 const actual={old:x.old,current,historical,bindings,oldSeq:x.expected.oldSeq,newSeq:JSON.parse(fs.readFileSync(path.join(ctx.archive,'archive.json'))).published_seq,occurrences:(await stats(ctx)).denominators.occurrences};assertIdentity03Confirmation(actual,x.expected);
 const proofReads=[];for(const binding of bindings.filter(b=>b.supersedes_binding_id)){
  for(const uri of binding.equivalence_proof_refs){const record=x.s2.records.find(r=>r.evidence_ref.uri===uri);assert.ok(record,'CONFIRM_PROOF_SAME_VISIBLE_SOURCE');const read=await ctx.call('evidence.read',{uri,format:'base64'});assert.equal(read.error,null);const bytes=Buffer.from(read.data.payload,'base64');assert.equal(hash(bytes),record.sha256);assert.deepEqual(JSON.parse(bytes),x.rawAfter[record.ordinal-1]);const oldRecord=x.s1.records.find(r=>r.ordinal===binding.locator.record_ordinal);assert.equal(record.sha256,oldRecord.sha256,'CONFIRM_PROOF_SAME_ACQUIRED_ACT');proofReads.push({binding_id:binding.id,uri,raw:JSON.parse(bytes),sha256:hash(bytes)});}
 }
 const ownerRecord=x.s2.records[2],owner=await ctx.call('evidence.read',{uri:ownerRecord.evidence_ref.uri,format:'base64'});assert.equal(owner.error,null);assert.deepEqual(JSON.parse(Buffer.from(owner.data.payload,'base64')),x.rawAfter[2]);assert.equal(x.rawAfter[2].payload.id,x.s2.native_id);
 assert.equal((await ctx.call('archive.verify',{deep:true})).data.passed,true);assert.equal((await ctx.call('archive.verify',{deep:true},{},x.first.data.revision_id)).data.passed,true);assert.deepEqual(manifest(ctx.archive,x.s1.source_revision_id),x.s1);
 const groups=await observedOccurrenceGroups(ctx);assert.equal(groups.reduce((n,g)=>n+g.attempts,0),1);ctx.receipt.confirmation={actual,expected:x.expected,proofReads,native_owner_read:owner,groups};return actual;
}
const identity03FactTables=['event_version','occurrence_version','representation','relation_version','occurrence_payload','content_object','identity_binding'];
function identity03WrongProof(facts,x,uri){
 const row=facts.identity_binding.find(row=>row.data_json.acquired_alias===x.expected.after[0].anchor&&row.data_json.locator.source_revision_id===x.s2.source_revision_id&&row.data_json.supersedes_binding_id);assert.ok(row,'NEGATIVE_REPLACEMENT_PRECONDITION');const before=structuredClone(row),{id,...value}=row.data_json;value.equivalence_proof_refs=[uri];row.id='bind4-'+identity03Hash(value);row.data_json={id:row.id,...value};assert.equal(validateIdentityBinding(row.data_json),true);assert.notEqual(row.id,before.id);return {before,after:structuredClone(row)};
}
function identity03RecommitProof(archive,x,uri){
 const pointer=JSON.parse(fs.readFileSync(path.join(archive,'archive.json'))),revision=JSON.parse(fs.readFileSync(path.join(archive,'revisions',pointer.revision_id+'.json'))),parent=JSON.parse(fs.readFileSync(path.join(archive,'revisions',revision.parent_revision_id+'.json'))),db=new DatabaseSync(path.join(archive,'ledger.sqlite'));let changed;
 try{
  const facts=Object.fromEntries(identity03FactTables.map(table=>[table,db.prepare('SELECT id,commit_seq,data_json FROM '+table+' WHERE commit_seq=? ORDER BY rowid').all(revision.commit_seq).map(r=>({...r,data_json:JSON.parse(r.data_json)}))]));changed=identity03WrongProof(facts,x,uri);
  db.prepare('UPDATE identity_binding SET id=?,data_json=? WHERE id=? AND commit_seq=?').run(changed.after.id,JSON.stringify(changed.after.data_json),changed.before.id,revision.commit_seq);
  revision.ledger_changes.occurrence_facts_sha256=identity03Hash(facts);revision.ledger_sha256=identity03Hash({parent:parent.ledger_sha256,changes:revision.ledger_changes});const {revision_id,...payload}=revision;revision.revision_id='cap4-'+identity03Hash(payload);
  db.prepare('UPDATE archive_commit SET revision_id=?,manifest_sha256=? WHERE seq=?').run(revision.revision_id,identity03Hash(revision),revision.commit_seq);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{db.close();}
 fs.writeFileSync(path.join(archive,'revisions',revision.revision_id+'.json'),JSON.stringify(revision),{flag:'wx'});fs.writeFileSync(path.join(archive,'archive.json'),JSON.stringify({...pointer,revision_id:revision.revision_id}));return {changed,revision};
}
async function identity03NegativeRead(ctx,operation,params,target,expectation){
 const engine=async request=>{const value=await publicApi.archiveRequest(request);if(operation==='archive.verify')assert.equal(value.data?.passed,false,'CONFIRM_INVALID_PROOF_VERIFY');else assert.equal(value.error?.code,expectation,'CONFIRM_INVALID_PROOF_PUBLIC_REJECTION');return value;};
 return ctx.call(operation,params,{},null,target,engine,expectation);
}
test('Identity03 provisional native confirmation preserves old cut and counts one current act',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_PROVISIONAL_CANONICAL_RAW_PROOF';const x=await identity03ConfirmationFixture(ctx);await identity03AssertConfirmation(ctx,x);
}));
for(const variant of ['nonexistent','registered-unrelated'])test('Identity03 provisional proof '+variant+' fails public lookup and verification with coherent commitments',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_PROVISIONAL_PUBLIC_NEGATIVE';const x=await identity03ConfirmationFixture(ctx);await identity03AssertConfirmation(ctx,x);
 const uri=variant==='nonexistent'?'afh://evidence/sha256/'+'0'.repeat(64)+'/record/1?source=src4-'+'0'.repeat(64)+'#bytes=0:1':x.foreign.records[0].evidence_ref.uri,target=path.join(ctx.run,'published-'+variant);fs.cpSync(ctx.archive,target,{recursive:true,errorOnExist:true,force:false});const mutation=identity03RecommitProof(target,x,uri);
 if(variant==='nonexistent')await identity03NegativeRead(ctx,'evidence.read',{uri,format:'base64'},target,'EVIDENCE_UNAVAILABLE');else{const read=await ctx.call('evidence.read',{uri,format:'base64'},{},null,target);assert.equal(read.error,null);assert.deepEqual(JSON.parse(Buffer.from(read.data.payload,'base64')),meta('unrelated-native-owner'));assert.notEqual(x.foreign.source_lineage_id,x.s2.source_lineage_id);ctx.receipt.unrelated_registered_read=read;}
 const structural=await ctx.call('archive.verify',{deep:false},{},null,target);assert.equal(structural.data.passed,true,'NEGATIVE_STRUCTURAL_CLOSURE_MUST_PASS');const before=inventory(target),old=await ctx.call('event.show',{event_id:x.expected.before[0].anchor,include_representations:true},{},x.first.data.revision_id,target);assert.equal(old.error,null);assert.deepEqual(old.data,x.old[0]);
 await identity03NegativeRead(ctx,'event.show',{event_id:x.expected.after[0].anchor,include_representations:true},target,'INTEGRITY_FAILED');await identity03NegativeRead(ctx,'event.show',{event_id:x.expected.after[0].canonical_id,include_representations:true},target,'INTEGRITY_FAILED');await identity03NegativeRead(ctx,'archive.verify',{deep:true},target,'PUBLISHED_INTEGRITY_FAILURE');assert.deepEqual(inventory(target),before);ctx.receipt.proof_negative={variant,uri,mutation,structural,old_cut_preserved:true};
}));
for(const variant of ['nonexistent','registered-unrelated'])test('Identity03 provisional proof '+variant+' cannot be published by recovery',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_PROVISIONAL_RECOVERY_NEGATIVE';const x=await identity03ConfirmationFixture(ctx),target=path.join(ctx.run,'staged-'+variant);fs.cpSync(x.beforeConfirmation,target,{recursive:true,errorOnExist:true,force:false});const params={sources:[x.input],idempotency_key:'staged-confirmation'},requestValue={kind:'request',schema_version:4,protocol_version:'4.0',request_id:variant,operation:'archive.ingest',archive:target,revision_id:null,params};await childRequest(ctx.run,requestValue,{barrier:'objects_fsync'});
 const owner=JSON.parse(fs.readFileSync(path.join(target,'writer.lock'))),checkpointFile=path.join(target,'jobs',owner.job_id,'checkpoint.json'),envelope=JSON.parse(fs.readFileSync(checkpointFile)),plan=envelope.payload.plan,uri=variant==='nonexistent'?'afh://evidence/sha256/'+'0'.repeat(64)+'/record/1?source=src4-'+'0'.repeat(64)+'#bytes=0:1':x.foreign.records[0].evidence_ref.uri;
 const mutation=identity03WrongProof(plan.occurrence_facts,x,uri);plan.manifest.ledger_changes.occurrence_facts_sha256=identity03Hash(plan.occurrence_facts);const parent=JSON.parse(fs.readFileSync(path.join(target,'revisions',plan.manifest.parent_revision_id+'.json')));plan.manifest.ledger_sha256=identity03Hash({parent:parent.ledger_sha256,changes:plan.manifest.ledger_changes});const {revision_id,...payload}=plan.manifest;plan.manifest.revision_id='cap4-'+identity03Hash(payload);plan.result.data.revision_id=plan.manifest.revision_id;plan.result.receipt.revision_id=plan.manifest.revision_id;plan.result.receipt.ledger_sha256=plan.manifest.ledger_sha256;envelope.sha256=identity03Hash(envelope.payload);fs.writeFileSync(checkpointFile,JSON.stringify(envelope));
 const pointer=fs.readFileSync(path.join(target,'archive.json')),result=await ctx.call('archive.recover',{idempotency_key:'recover-'+variant,job_id:owner.job_id,expected_owner_token:owner.nonce,action:'resume'},{},null,target,request=>childRequest(ctx.run,request));assert.equal(result.error?.code,'INTEGRITY_FAILED','CONFIRM_RECOVERY_SEMANTIC_PROOF');assert.ok(result.error.message.includes('acquired sources'),'CONFIRM_RECOVERY_NOT_ENVELOPE_MISMATCH');assert.deepEqual(fs.readFileSync(path.join(target,'archive.json')),pointer);const old=await ctx.call('event.show',{event_id:x.expected.before[0].anchor,include_representations:true},{},x.first.data.revision_id,target);assert.equal(old.error,null);assert.deepEqual(old.data,x.old[0]);ctx.receipt.proof_negative={variant,uri,mutation,result,old_cut_preserved:true};
}));

for(const vector of identity03ResolverCases())test('Identity03 resolver '+vector.name,async t=>scenario(t,'AFH-03-T06',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_INTERNAL_ALIAS_RESOLUTION_NOT_WIRE';ctx.receipt.resolver_vector=vector;const ledger=await import('../../src/archive/ledger.js');if(typeof ledger.resolveIdentityAtCut!=='function')throw Object.assign(new Error('Real snapshot alias resolver is absent'),{code:'NOT_IMPLEMENTED'});assertIdentity03Resolution(vector,ledger.resolveIdentityAtCut);
}));
test('Identity03 legacy canonical projection retains immutable original aliases and grades',async t=>scenario(t,'AFH-02-T07',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_LEGACY_CHAIN';const caseDir=await legacyCapture(ctx,[meta('legacy-id'),request('legacy',1),result('legacy',0,2)]),before=inventory(caseDir),response=await ctx.call('archive.import_case',{case_path:caseDir,idempotency_key:'legacy-identity'});assert.equal(response.error,null);const snapshot=JSON.parse(fs.readFileSync(path.join(ctx.archive,'revisions',response.data.revision_id+'.json'))),sources=snapshot.source_manifest_ids.map(id=>manifest(ctx.archive,id)),bindings=identity03Rows(ctx.archive,'identity_binding');
 for(const source of sources)for(const record of source.records)for(const e of record.events.filter(e=>e.kind.startsWith('tool.'))){const out=await ctx.call('event.show',{event_id:e.id,include_representations:true});assert.equal(out.error,null);assert.notEqual(out.data.event.id,e.id,'IDENTITY03_LEGACY_ANCHOR_NOT_CANONICAL');const binding=bindings.find(b=>b.acquired_alias===e.id&&b.canonical_target===out.data.event.id);assert.ok(binding);assert.equal(binding.decoder_id,'legacy-preserved-locator');assert.equal(e.mapping_grade,'EXACT_LEGACY_ALIAS');}
 assert.deepEqual(inventory(caseDir),before);assert.equal((await ctx.call('archive.verify',{deep:true})).data.passed,true);
}));
test('Identity03 origin harness and session domains keep identical call IDs separate',async t=>scenario(t,'AFH-03-T04',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_DOMAIN_COLLISIONS';const target=path.join(ctx.run,'domains'),domains=[{id:'00000000-0000-4000-8000-000000000501',harness:'codex',descriptor:'domain A'},{id:'00000000-0000-4000-8000-000000000502',harness:'codex',descriptor:'domain B'},{id:'00000000-0000-4000-8000-000000000503',harness:'generic',descriptor:'generic domain'}];assert.equal((await ctx.call('archive.init',{idempotency_key:'domains',origin_domains:domains},{},null,target)).error,null);const values=[];
 for(const [i,d]of domains.entries())for(const nativeSession of ['same','other']){const file=path.join(ctx.run,'domain-'+i+'-'+nativeSession+'.jsonl'),raw=d.harness==='codex'?[meta(nativeSession),request('x',1),result('x',0,2)]:[{session_id:nativeSession,tool_name:'shell',call_id:'x',command:'npm test'},{session_id:nativeSession,tool_name:'shell',call_id:'x',output:'observed',exit_code:0}];writeRecords(file,raw);const res=await ctx.call('archive.ingest',{sources:[{path:file,harness:d.harness,origin_domain_id:d.id}],idempotency_key:i+'-'+nativeSession},{},null,target);assert.equal(res.error,null);const source=manifest(target,res.data.source_revisions[0]);assert.equal(source.session_id,'ses4-'+identity03Hash([d.harness,d.id,nativeSession]));const event=source.records.flatMap(r=>r.events).find(e=>e.kind==='tool.requested'),out=await ctx.call('event.show',{event_id:event.id,include_representations:true},{},null,target);assert.equal(out.error,null);assert.equal(out.data.event.session_id,source.session_id);assert.notEqual(out.data.event.id,event.id);values.push(out.data);}
 assert.equal(new Set(values.map(v=>v.event.id)).size,6);assert.equal(new Set(values.map(v=>v.occurrence.id)).size,6);ctx.receipt.domain_values=values;
}));
test('Identity03 published bindings reject deleted extra altered rows',async t=>scenario(t,'AFH-03-T13',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_BINDING_EXACT_CLOSURE';const x=await ingest(ctx,[request('indexed',1),result('indexed',0,2)]);identity03Rows(ctx.archive,'identity_binding');const e=toolEvents(x)[0];
 for(const kind of ['missing','extra','target','pointer','subindex','mapping_epoch']){const target=path.join(ctx.run,kind);fs.cpSync(ctx.archive,target,{recursive:true,errorOnExist:true,force:false});const db=new DatabaseSync(path.join(target,'ledger.sqlite'));try{const row=db.prepare('SELECT * FROM identity_binding ORDER BY id LIMIT 1').get();assert.ok(row);let change;if(kind==='missing')change=db.prepare('DELETE FROM identity_binding WHERE id=?').run(row.id);else if(kind==='extra')change=db.prepare('INSERT INTO identity_binding VALUES(?,?,?)').run('bind4-'+'a'.repeat(64),row.commit_seq,row.data_json);else{const value=JSON.parse(row.data_json);if(kind==='target')value.canonical_target='evt4-'+'0'.repeat(64);if(kind==='pointer')value.locator.json_pointer='';if(kind==='subindex')value.locator.event_subindex++;if(kind==='mapping_epoch')value.locator.record_identity_epoch='wrong';change=db.prepare('UPDATE identity_binding SET data_json=? WHERE id=?').run(JSON.stringify(value),row.id);}assert.ok(change.changes>0);}finally{db.close();}
  const response=await ctx.call('event.show',{event_id:e.id,include_representations:true},{},null,target,publicApi.archiveRequest,'INTEGRITY_FAILED');assert.equal(response.error.code,'INTEGRITY_FAILED');const verify=await ctx.call('archive.verify',{deep:true},{},null,target,publicApi.archiveRequest,'PUBLISHED_INTEGRITY_FAILURE');assert.equal(verify.data.passed,false);
 }
 // Product calls use the observed native SQL index. The complete readonly wrapper
 // still validates executions, DURING identities and unchanged nonempty WAL.
 const shown=await ctx.call('event.show',{event_id:e.id,include_representations:true});assert.equal(shown.error,null);const observation=ctx.receipt.read_only_observations.at(-1);assert.ok(JSON.stringify(observation).includes('identity_binding'),'IDENTITY03_INDEX_CONSUMED');
 const absent=await ctx.call('event.show',{event_id:'evt4-'+'0'.repeat(64),include_representations:true},{},null,ctx.archive,publicApi.archiveRequest,'EVIDENCE_UNAVAILABLE');assert.equal(absent.error.code,'EVIDENCE_UNAVAILABLE');
}));
test('Identity03 recovery atomically commits mappings and refuses a missing committed binding',async t=>scenario(t,'AFH-03-T15',async ctx=>{
 ctx.receipt.validation_role='IDENTITY03_BINDING_RECOVERY';const x=await ingest(ctx,[request('recover',1)]);identity03Rows(ctx.archive,'identity_binding');const firstRevision=x.response.data.revision_id;fs.appendFileSync(x.input.path,JSON.stringify(result('recover',0,2))+'\n');const params={sources:[x.input],idempotency_key:'recover-terminal'};
 for(const barrier of ['objects_fsync','ledger_commit']){const target=path.join(ctx.run,barrier);fs.cpSync(ctx.archive,target,{recursive:true,errorOnExist:true,force:false});const requestValue={kind:'request',schema_version:4,protocol_version:'4.0',request_id:barrier,operation:'archive.ingest',archive:target,revision_id:null,params};await childRequest(ctx.run,requestValue,{barrier});const lock=JSON.parse(fs.readFileSync(path.join(target,'writer.lock')));const old=await ctx.call('event.show',{event_id:toolEvents(x)[0].id,include_representations:true},{},firstRevision,target);assert.equal(old.data.occurrence.lifecycle,'INCOMPLETE');const recovered=await ctx.call('archive.recover',{idempotency_key:barrier,job_id:lock.job_id,expected_owner_token:lock.nonce,action:'resume'},{},null,target,request=>childRequest(ctx.run,request));assert.equal(recovered.error,null);const now=await ctx.call('event.show',{event_id:toolEvents(x)[0].id,include_representations:true},{},null,target);assert.equal(now.data.occurrence.lifecycle,'COMPLETED');assert.ok(identity03Rows(target,'identity_binding').length>1);assert.equal((await ctx.call('archive.verify',{deep:true},{},null,target)).data.passed,true);}
 const target=path.join(ctx.run,'missing-binding');fs.cpSync(ctx.archive,target,{recursive:true,errorOnExist:true,force:false});await childRequest(ctx.run,{kind:'request',schema_version:4,protocol_version:'4.0',request_id:'missing-binding',operation:'archive.ingest',archive:target,revision_id:null,params},{barrier:'ledger_commit'});const lock=JSON.parse(fs.readFileSync(path.join(target,'writer.lock'))),pointer=fs.readFileSync(path.join(target,'archive.json')),db=new DatabaseSync(path.join(target,'ledger.sqlite'));try{assert.ok(db.prepare('DELETE FROM identity_binding WHERE commit_seq=(SELECT max(commit_seq) FROM identity_binding)').run().changes>0);}finally{db.close();}const rejected=await ctx.call('archive.recover',{idempotency_key:'missing-binding',job_id:lock.job_id,expected_owner_token:lock.nonce,action:'resume'},{},null,target,request=>childRequest(ctx.run,request));assert.equal(rejected.error.code,'INTEGRITY_FAILED');assert.deepEqual(fs.readFileSync(path.join(target,'archive.json')),pointer);
}));

// Incoming04 temporal obligations retain the original03 cases unchanged.
import {registerTemporal04Integration} from './afh-04.test.mjs';
registerTemporal04Integration(['AFH-03-T11','AFH-03-T16']);

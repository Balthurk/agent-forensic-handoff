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
      const requestValidation=validateWire(request,'Request');assert.equal(requestValidation.passed,true,JSON.stringify(requestValidation.errors));
      const readOnly=['evidence.read','archive.verify','scope.resolve','event.show','stats'].includes(operation);let response;
      if(readOnly){const observed=await observeArchiveReader(target,()=>engine(request,options));const original=transform?structuredClone(observed):null;if(transform)transform(observed);response=observed.result;const observation={operation,request_id:request.request_id,expectation,...observed.observation};try{if(observed.error)throw observed.error;if(response?.error?.code==='NOT_IMPLEMENTED'){receipt.requests.push({request,response});throw Object.assign(new Error(response.error.message),{code:'NOT_IMPLEMENTED'});}observation.outcome=assertReadObservation({request,response,observation,expectation});(receipt.read_only_observations??=[]).push(observation);}catch(error){(receipt.read_only_rejections??=[]).push({request,response,observation,error:{code:error.code,message:error.message},...(original?{calibration_original:original}: {})});throw error;}}
      else response=await engine(request,options);receipt.requests.push({request,response});
      const responseValidation=validateWire(response,'Response');
      if(!responseValidation.passed)throw Object.assign(new Error(JSON.stringify(responseValidation.errors)),{code:'SCHEMA_PRECONDITION'});
      if(response.error?.code==='NOT_IMPLEMENTED')throw Object.assign(new Error(response.error.message),{code:'NOT_IMPLEMENTED'});
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
async function payloadText(ctx,payload){assert.ok(payload.evidence_refs.length);const values=[];for(const ref of payload.evidence_refs){const read=await ctx.call('evidence.read',{uri:ref.uri,format:'text'});assert.equal(read.error,null);let value=JSON.parse(read.data.payload);for(const part of (ref.json_pointer??'').split('/').slice(1))value=value[part.replaceAll('~1','/').replaceAll('~0','~')];assert.equal(typeof value,'string');values.push(value);}const text=values.join('');assert.equal(hash(Buffer.from(text)),payload.content_sha256);assert.equal(Buffer.byteLength(text),Number(payload.bytes));return text;}
function expect(ctx,actual){ctx.receipt.observed=actual;assert.deepEqual(actual,ctx.expected);}

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
 const f=ctx.fixture.input,records=f.turns.flatMap((turn,i)=>{const end=result(f.call_id,i,i*2+2);end.payload.turn_id=turn;return [request(f.call_id,i*2+1,'npm test',turn),end];}),x=await ingest(ctx,records),values=[],bindings=[];
 assert.equal(toolEvents(x).length,4);assert.equal(x.source.records.length,records.length+1);
 // Bind expectations to the fixture's turn/role and the acquired raw record.
 // Response cardinalities cannot establish which terminal belongs to a request.
 for(const [i,turn]of f.turns.entries()){
  const pair={turn};
  for(const [offset,role,kind]of [[0,'request','tool.requested'],[1,'terminal','tool.completed']]){
   const record=x.source.records[1+i*2+offset],raw=await ctx.call('evidence.read',{uri:record.evidence_ref.uri,format:'text'});assert.equal(raw.error,null);
   const input=JSON.parse(raw.data.payload);assert.deepEqual(input,records[i*2+offset]);assert.equal(input.payload.turn_id,turn);assert.equal(input.payload.call_id,f.call_id);
   assert.equal(record.events.length,1);const acquired={...record.events[0],raw_ref:record.evidence_ref};assert.equal(acquired.kind,kind);
   const value=await show(ctx,acquired);assert.equal(value.event.id,acquired.id,'T05_EVENT_ID: response must identify the acquired '+role);assert.equal(value.event.kind,kind,'T05_ROLE');assert.equal(value.event.session_id,acquired.session_id,'T05_SESSION');
   assert.ok(value.evidence_refs.some(ref=>ref.uri===record.evidence_ref.uri&&ref.record_sha256===record.evidence_ref.record_sha256),'T05_EVIDENCE: own raw record must remain registered');
   assert.ok(value.representations.some(rep=>rep.event_id===acquired.id&&rep.raw_ref.uri===record.evidence_ref.uri),'T05_EVIDENCE: representation must bind this acquired event');
   pair[role]={acquired,value};values.push(value);
  }
  assert.equal(pair.terminal.value.occurrence.id,pair.request.value.occurrence.id,'T05_OCCURRENCE: same turn request and terminal must share the occurrence');
  assert.equal(pair.terminal.value.occurrence.identity_epoch,pair.request.value.occurrence.identity_epoch,'T05_EPOCH: same turn request and terminal must share the epoch');
  bindings.push(pair);
 }
 assert.notEqual(bindings[0].request.value.occurrence.id,bindings[1].request.value.occurrence.id,'T05_OCCURRENCE: distinct native turns remain separate');
 assert.notEqual(bindings[0].request.value.occurrence.identity_epoch,bindings[1].request.value.occurrence.identity_epoch,'T05_EPOCH: distinct native turns retain separate epochs');
 for(const pair of bindings){
  const links=pair.terminal.value.relations.filter(r=>r.type==='RESULT_OF');assert.equal(links.length,1,'T05_RESULT_OF: exactly one terminal-to-request relation is required');
  assert.equal(links[0].from_id,pair.terminal.acquired.id,'T05_RESULT_OF: relation source must be the acquired terminal');assert.equal(links[0].to_id,pair.request.acquired.id,'T05_RESULT_OF: relation target must be the acquired request of this turn');
  for(const value of values)for(const relation of value.relations.filter(r=>r.type==='RESULT_OF'&&r.from_id===pair.terminal.acquired.id))assert.equal(relation.to_id,pair.request.acquired.id,'T05_RESULT_OF: no cross-turn target in any returned relation');
 }
 ctx.receipt.correlation_bindings=bindings.map(pair=>({turn:pair.turn,request_event_id:pair.request.acquired.id,terminal_event_id:pair.terminal.acquired.id,request_raw_ref:pair.request.acquired.raw_ref,terminal_raw_ref:pair.terminal.acquired.raw_ref,occurrence_id:pair.request.value.occurrence.id,identity_epoch:pair.request.value.occurrence.identity_epoch}));
 expect(ctx,{executions:new Set(values.map(v=>v.occurrence.id)).size,epochs:new Set(values.map(v=>v.occurrence.identity_epoch)).size});assert.equal(new Set(values.map(v=>v.event.id)).size,4);
}));
test('AFH-03-T06 an unresolved terminal remains an ambiguous orphan',async t=>scenario(t,'AFH-03-T06',async ctx=>{
 const x=await ingest(ctx,[request('open-a',1),request('open-b',2),result(ctx.fixture.input.orphan_call,1,3)]),events=toolEvents(x),values=[];assert.equal(events.length,3);assert.deepEqual(events.map(e=>e.kind),['tool.requested','tool.requested','tool.completed']);
 for(const event of events){const value=await show(ctx,event);assert.equal(value.event.id,event.id,'T06_EVENT_ID: every response must identify its acquired event');values.push(value);}
 const orphan=values[2],terminal=events[2],open=values.slice(0,2);assert.equal(new Set(values.map(v=>v.event.id)).size,3,'T06_EVENT_ID: orphan event remains distinct');assert.ok(orphan.occurrence.id);
 assert.ok(orphan.evidence_refs.some(ref=>ref.uri===terminal.raw_ref.uri&&ref.record_sha256===terminal.raw_ref.record_sha256),'T06_EVIDENCE: orphan keeps its own terminal raw reference');
 assert.ok(orphan.representations.some(rep=>rep.event_id===terminal.id&&rep.raw_ref.uri===terminal.raw_ref.uri),'T06_EVIDENCE: orphan representation identifies its acquired terminal');
 assert.notEqual(open[0].occurrence.id,open[1].occurrence.id,'T06_OPEN_CALLS: both open calls remain distinct');
 for(const call of open)assert.notEqual(orphan.occurrence.id,call.occurrence.id,'T06_ORPHAN_OCCURRENCE: ambiguous terminal cannot belong to any open call');
 assert.equal(orphan.relations.filter(r=>r.type==='RESULT_OF').length,0,'T06_ORPHAN_RESULT_OF: ambiguous terminal has no resolved request');
 for(const value of values)assert.equal(value.relations.filter(r=>r.type==='RESULT_OF'&&[terminal.id,orphan.occurrence.id].includes(r.from_id)).length,0,'T06_ORPHAN_RESULT_OF: no orphan link may be hidden on another event');
 ctx.receipt.orphan_binding={terminal_event_id:terminal.id,terminal_raw_ref:terminal.raw_ref,occurrence_id:orphan.occurrence.id,open_calls:open.map(call=>({event_id:call.event.id,occurrence_id:call.occurrence.id}))};
 expect(ctx,{orphan_preserved:!!orphan.occurrence.id,assigned_to_last_command:orphan.occurrence.id===values[1].occurrence.id||orphan.relations.some(r=>r.type==='RESULT_OF'&&r.to_id===values[1].event.id),correlation:orphan.occurrence.reason});
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
 const file=path.join(checkout,'src/archive/ledger.js');if(!fs.existsSync(file))throw Object.assign(new Error('Real ledger occurrence-group consumer is absent'),{code:'NOT_IMPLEMENTED'});const ledger=await import(pathToFileURL(file));if(typeof ledger.readOccurrenceGroups!=='function')throw Object.assign(new Error('Real readOccurrenceGroups consumer is absent'),{code:'NOT_IMPLEMENTED'});const before=inventory(ctx.archive),groups=await ledger.readOccurrenceGroups(ctx.archive,{scope,time});assert.deepEqual(inventory(ctx.archive),before);ctx.receipt.groups=groups;assert.equal(groups.length,1);expect(ctx,{terminal_status:groups[0].terminal_status,candidates:groups[0].terminal_candidates.length});assert.equal(new Set(groups[0].terminal_candidates).size,2);
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

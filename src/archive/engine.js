import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateRequest,response,errorResponse,makeReceipt,coverage,hash,digest,failure} from './protocol.js';
import {localRoot,inside,readJson,writeJson,readObject,sourceManifest,revisionManifest,openSnapshot,openLedger,initializeLedger,acquireLock,releaseLock,checkpoint,claimRecovery,readCheckpoint} from './storage.js';
import {acquisitionLimits,acquireSource} from './acquisition.js';
import {readArchiveEvidence} from './read-evidence.js';
import {inspectLegacy,prepareLegacyImport} from './legacy.js';
import {prepareAssociations,resolveScope} from './associations.js';
import {verifyPublishedArchive} from './verify.js';
import {acquireObservedChildren} from './children.js';

function timestamp(clock){const value=clock?clock():Date.now();const date=value instanceof Date?value:new Date(value);if(!Number.isFinite(date.valueOf()))throw failure('INVALID_REQUEST','Clock is invalid');return date.toISOString();}
function sumCoverage(sources,observedThrough){const c=coverage({sources_acquired:sources.length,observed_through:observedThrough});for(const source of sources)for(const [key,value]of Object.entries(source.counts))c[key]+=value;if(c.records_unsupported||c.records_unparsed)c.status='PARTIAL';return c;}
function requestDigest(request,sourceHashes=[]){return digest({operation:request.operation,params:request.params,source_hashes:sourceHashes});}
function durableResponse(root,request,sha,snapshot){const db=openLedger(root,true);try{const row=db.prepare('SELECT * FROM mutation_receipt WHERE operation=? AND idempotency_key=? AND commit_seq<=?').get(request.operation,request.params.idempotency_key,snapshot.commit_seq);if(!row)return null;if(row.request_sha256!==sha)throw failure('IDEMPOTENCY_CONFLICT','Idempotency key is bound to different input');const prior=JSON.parse(row.response_json);return response(request,prior.data,prior.receipt,prior.status);}finally{db.close();}}
function createRevision(snapshot,sourceIds,jobId,time,changes){const payload={schema_version:4,archive_id:snapshot.archive_id,access_domain_id:snapshot.access_domain_id,parent_revision_id:snapshot.revision_id??null,commit_seq:(snapshot.commit_seq??0)+1,recorded_at:time,source_manifest_ids:sourceIds,limits:snapshot.limits,origin_domains:snapshot.origin_domains,ledger_sha256:digest({parent:snapshot.ledger_sha256??null,changes}),ledger_changes:changes,job_id:jobId,coverage:changes.coverage};return {revision_id:'cap4-'+digest(payload),...payload};}
function publishPointer(root,manifest,limits,originDomains){writeJson(inside(root,'archive.json'),{schema_version:4,archive_id:manifest.archive_id,access_domain_id:manifest.access_domain_id,revision_id:manifest.revision_id,published_seq:manifest.commit_seq,limits,origin_domains:originDomains},{replace:true});}
function insertSources(db,sources,seq){
  const insert=db.prepare('INSERT OR IGNORE INTO source_revision VALUES(?,?,?,?)'),session=db.prepare('INSERT OR REPLACE INTO session_version VALUES(?,?,?)'),event=db.prepare('INSERT OR IGNORE INTO logical_event VALUES(?,?,?)');
  for(const source of sources){insert.run(source.source_revision_id,source.source_lineage_id,seq,JSON.stringify(source));session.run(source.session_id,seq,JSON.stringify({id:source.session_id,native_id:source.native_id,harness:source.harness,origin_domain_id:source.origin_domain_id,identity_status:source.identity_status,provisional:source.provisional,source_revision_id:source.source_revision_id}));for(const record of source.records)for(const e of record.events)event.run(e.id,seq,JSON.stringify({...e,evidence_refs:[record.evidence_ref]}));}
}
async function commitPlan(root,plan,fault){
  const db=openLedger(root);try{
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    const exists=db.prepare('SELECT revision_id FROM archive_commit WHERE seq=?').get(plan.manifest.commit_seq);
    if(exists&&exists.revision_id!==plan.manifest.revision_id)throw failure('REVISION_CONFLICT','Another commit occupies the staged sequence');
    if(!exists){insertSources(db,plan.changed_sources,plan.manifest.commit_seq);for(const alias of plan.legacy?.events??[])db.prepare('INSERT INTO legacy_alias VALUES(?,?,?,?,?)').run(plan.legacy.case_hash,alias.legacy_event_id,alias.event_id,plan.manifest.commit_seq,JSON.stringify(alias.evidence_refs));db.prepare('INSERT INTO archive_commit VALUES(?,?,?,?,?)').run(plan.manifest.commit_seq,plan.manifest.revision_id,digest(plan.manifest),plan.manifest.recorded_at,plan.job_id);db.prepare('INSERT INTO mutation_receipt VALUES(?,?,?,?,?)').run(plan.request.operation,plan.request.params.idempotency_key,plan.request_sha256,JSON.stringify(plan.result),plan.manifest.commit_seq);}
    if(!exists)for(const association of plan.associations??[])db.prepare('INSERT INTO association_version VALUES(?,?,?,?)').run(association.change.association_id,association.change.branch_id,plan.manifest.commit_seq,JSON.stringify(association));
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
  await fault?.('ledger_commit',plan);
  if(plan.legacy)writeJson(inside(root,'legacy',plan.legacy.case_hash+'.json'),plan.legacy);
  writeJson(inside(root,'revisions',plan.manifest.revision_id+'.json'),plan.manifest);await fault?.('revision_manifest',plan);
  publishPointer(root,plan.manifest,plan.limits,plan.origin_domains);await fault?.('pointer_replace',plan);
}
async function importLegacyArchive(root,request,options,services){
  const caseRoot=localRoot(request.params.case_path);inspectLegacy(caseRoot);
  const snapshot=openSnapshot(root);if(request.revision_id!==null&&request.revision_id!==snapshot.revision_id)throw failure('REVISION_CONFLICT','Import requires latest published revision');
  const jobId='job-'+randomUUID(),lock=acquireLock(root,snapshot.archive_id,jobId);let retainLock=false;
  try{
    if(openSnapshot(root).revision_id!==snapshot.revision_id)throw failure('REVISION_CONFLICT','Archive changed before import acquired writer');
    const imported=prepareLegacyImport(root,caseRoot,snapshot.limits),sha=requestDigest(request,[imported.source_inventory_before]),prior=durableResponse(root,request,sha,snapshot);if(prior)return prior;
    const legacyPath=inside(root,'legacy',imported.metadata.caseHash+'.json');
    if(fs.existsSync(legacyPath)){
      const existing=readJson(legacyPath);if(existing.source_inventory_sha256!==imported.source_inventory_before)throw failure('INTEGRITY_FAILED','Legacy case identity is bound to a different source inventory');
      const result=response(request,{revision_id:snapshot.revision_id,legacy_case_hash:existing.case_hash,alias_count:existing.events.length,source_inventory_before:imported.source_inventory_before,source_inventory_after:imported.source_inventory_after},makeReceipt(snapshot,{warnings:['NO_CHANGE: this exact legacy case inventory is already imported']}));
      const db=openLedger(root);try{db.exec('PRAGMA synchronous=FULL');db.prepare('INSERT INTO mutation_receipt VALUES(?,?,?,?,?)').run(request.operation,request.params.idempotency_key,sha,JSON.stringify(result),snapshot.commit_seq);}finally{db.close();}checkpoint(root,jobId,{state:'COMPLETED',owner:lock,result});return result;
    }
    const now=timestamp(options.clock);if(now<snapshot.recorded_at)throw failure('CLOCK_REGRESSION','Clock precedes the latest committed observation');
    const sources=[...snapshot.source_manifest_ids.map(id=>sourceManifest(root,id)),...imported.sources],c=sumCoverage(sources,now);
    const legacy={case_hash:imported.metadata.caseHash,schema_version:imported.metadata.schemaVersion,source_inventory_sha256:imported.source_inventory_before,original_report:imported.metadata,events:imported.aliases,artifacts:imported.artifacts};
    const manifest=createRevision(snapshot,sources.map(s=>s.source_revision_id),jobId,now,{coverage:c,legacy_case_hash:imported.metadata.caseHash,legacy_sha256:digest(legacy),inventory:imported.source_inventory_before});
    const result=response(request,{revision_id:manifest.revision_id,legacy_case_hash:legacy.case_hash,alias_count:legacy.events.length,source_inventory_before:imported.source_inventory_before,source_inventory_after:imported.source_inventory_after},makeReceipt(manifest,{warnings:['LEGACY_NORMALIZATION_PRESERVED: original report and known producer limitations remain applicable']}));
    const plan={job_id:jobId,manifest,request,request_sha256:sha,result,changed_sources:imported.sources,legacy,limits:snapshot.limits,origin_domains:snapshot.origin_domains};checkpoint(root,jobId,{state:'STAGED',owner:lock,plan});retainLock=true;await services.fault?.('objects_fsync',plan);await commitPlan(root,plan,services.fault);checkpoint(root,jobId,{state:'COMPLETED',owner:lock,plan});retainLock=false;return result;
  }finally{if(!retainLock)releaseLock(root,lock);}
}
async function recordAssociations(root,request,options,services){
  const snapshot=openSnapshot(root),sha=requestDigest(request);if(request.revision_id!==null&&request.revision_id!==snapshot.revision_id)throw failure('REVISION_CONFLICT','Association requires latest published revision');
  const jobId='job-'+randomUUID(),lock=acquireLock(root,snapshot.archive_id,jobId);let retainLock=false;
  try{
    if(openSnapshot(root).revision_id!==snapshot.revision_id)throw failure('REVISION_CONFLICT','Archive changed before association acquired writer');
    const prior=durableResponse(root,request,sha,snapshot);if(prior)return prior;
    const now=timestamp(options.clock);if(now<snapshot.recorded_at)throw failure('CLOCK_REGRESSION','Clock precedes the latest committed observation');
    const associations=prepareAssociations(root,request,snapshot,now),manifest=createRevision(snapshot,snapshot.source_manifest_ids,jobId,now,{coverage:snapshot.coverage,associations});
    const result=response(request,{revisions:associations.map(a=>a.revision),commit_seq:manifest.commit_seq},makeReceipt(manifest));
    const plan={job_id:jobId,manifest,request,request_sha256:sha,result,changed_sources:[],associations,limits:snapshot.limits,origin_domains:snapshot.origin_domains};checkpoint(root,jobId,{state:'STAGED',owner:lock,plan});retainLock=true;await services.fault?.('objects_fsync',plan);await commitPlan(root,plan,services.fault);checkpoint(root,jobId,{state:'COMPLETED',owner:lock,plan});retainLock=false;return result;
  }finally{if(!retainLock)releaseLock(root,lock);}
}
async function initArchive(root,request,options,services){
  const limits=acquisitionLimits(request.params.limits);const sha=requestDigest(request);
  if(fs.existsSync(root)){if(fs.existsSync(inside(root,'archive.json'))){const snapshot=openSnapshot(root),prior=durableResponse(root,request,sha,snapshot);if(prior)return prior;}throw failure('TARGET_EXISTS','Archive target already exists');}
  const origins=request.params.origin_domains??[];if(new Set(origins.map(x=>x.id)).size!==origins.length)throw failure('INVALID_REQUEST','Origin domain identifiers must be unique');
  fs.mkdirSync(root);const archiveId=randomUUID(),accessId=request.params.access_domain_id??randomUUID(),jobId='job-'+randomUUID();const lock=acquireLock(root,archiveId,jobId);let retainLock=false;
  try{
    for(const dir of ['bronze/objects','bronze/sources','revisions','projections','jobs'])fs.mkdirSync(inside(root,dir),{recursive:true});initializeLedger(root);
    const now=timestamp(options.clock),manifest=createRevision({archive_id:archiveId,access_domain_id:accessId,limits,origin_domains:origins},[],jobId,now,{coverage:coverage({observed_through:now}),sources:[]});
    const result=response(request,{archive_id:archiveId,revision_id:manifest.revision_id,schema_version:4},makeReceipt(manifest));
    const plan={job_id:jobId,manifest,request,request_sha256:sha,result,changed_sources:[],limits,origin_domains:origins};checkpoint(root,jobId,{state:'STAGED',owner:lock,plan});retainLock=true;await services.fault?.('objects_fsync',plan);await commitPlan(root,plan,services.fault);checkpoint(root,jobId,{state:'COMPLETED',owner:lock,plan});retainLock=false;return result;
  }finally{if(!retainLock)releaseLock(root,lock);}
}
async function ingestArchive(root,request,options,services){
  const snapshot=openSnapshot(root);if(request.revision_id!==null&&request.revision_id!==snapshot.revision_id)throw failure('REVISION_CONFLICT','Mutation must use latest published revision');
  const jobId='job-'+randomUUID(),lock=acquireLock(root,snapshot.archive_id,jobId);let retainLock=false;
  try{
    if(openSnapshot(root).revision_id!==snapshot.revision_id)throw failure('REVISION_CONFLICT','Published revision changed before writer acquisition');
    const now=timestamp(options.clock);
    const previous=snapshot.source_manifest_ids.map(id=>sourceManifest(root,id)),acquired=[];let bytes=0;
    checkpoint(root,jobId,{state:'STARTED',owner:lock,request,parent_revision_id:snapshot.revision_id});
    const acquire=async input=>{
      const origin=snapshot.origin_domains.find(item=>item.id===input.origin_domain_id);if(!origin||origin.harness!==input.harness)throw failure('INVALID_REQUEST','Source origin domain is not registered for this harness');
      const item=await acquireSource(root,input,previous,snapshot.limits,{signal:options.signal,onBoundary:boundary=>services.fault?.('source_boundary',{job_id:jobId,boundary})});bytes+=item.manifest.raw_bytes;if(bytes>snapshot.limits.max_job_bytes)throw failure('LIMIT_EXCEEDED','Job byte limit exceeded');return item;
    };for(const input of request.params.sources)acquired.push(await acquire(input));
    const childCoverage=await acquireObservedChildren(acquired,previous,request.params,acquire);
    const sha=requestDigest(request,acquired.map(x=>x.manifest.raw_sha256)),prior=durableResponse(root,request,sha,snapshot);if(prior)return prior;
    const conflict=acquired.find(item=>item.identity_conflict);if(conflict)throw failure('AMBIGUOUS_IDENTITY','Native session owners conflict within the acquired source lineage',conflict.identity_conflict);
    if(now<snapshot.recorded_at)throw failure('CLOCK_REGRESSION','Clock precedes the latest committed observation');
    const delta={bytes_read:acquired.reduce((n,x)=>n+x.bytes_read,0),prefix_bytes_verified:acquired.reduce((n,x)=>n+x.prefix_bytes_verified,0),new_records:acquired.reduce((n,x)=>n+x.new_records,0),new_occurrences:acquired.reduce((n,x)=>n+x.new_occurrences,0),reused_objects:acquired.reduce((n,x)=>n+x.reused_objects,0)};
    const selected=new Map(previous.map(source=>[source.source_lineage_id,source]));for(const item of acquired)selected.set(item.manifest.source_lineage_id,item.manifest);
    const sources=[...selected.values()],sourceIds=sources.map(x=>x.source_revision_id),c=sumCoverage(sources,now),changed=acquired.filter(x=>!x.unchanged).map(x=>x.manifest);
    c.sources_known_omitted=childCoverage.omitted;if(childCoverage.omitted){c.status='PARTIAL';c.excluded.push({reason:'OBSERVED_CHILD_NOT_ACQUIRED_WITHIN_LIMIT_OR_RESOLUTION_BOUNDARY',count:childCoverage.omitted,scope:{project_id:null,session_ids:[],group_id:null,association_mode:'observed'}});}
    if(!changed.length){
      const result=response(request,{revision_id:snapshot.revision_id,source_revisions:acquired.map(x=>x.manifest.source_revision_id),delta,coverage:snapshot.coverage,job_id:jobId},makeReceipt(snapshot,{warnings:['NO_CHANGE: source bytes and configuration match the published revision']}),snapshot.coverage.status==='PARTIAL'?'PARTIAL':'OK');
      const db=openLedger(root);try{db.prepare('INSERT INTO mutation_receipt VALUES(?,?,?,?,?)').run(request.operation,request.params.idempotency_key,sha,JSON.stringify(result),snapshot.commit_seq);}finally{db.close();}checkpoint(root,jobId,{state:'COMPLETED',owner:lock,result});return result;
    }
    const manifest=createRevision(snapshot,sourceIds,jobId,now,{coverage:c,sources:changed.map(x=>x.source_revision_id)});
    const warnings=acquired.filter(x=>x.late_bytes).map(x=>'Source grew by '+x.late_bytes+' bytes after its captured boundary');
    if(childCoverage.known)warnings.push('Child acquisition: '+childCoverage.children_acquired+' new, '+childCoverage.omitted+' known omitted; limit '+childCoverage.limit+'; '+childCoverage.resolution_boundary);
    const result=response(request,{revision_id:manifest.revision_id,source_revisions:acquired.map(x=>x.manifest.source_revision_id),delta,coverage:c,job_id:jobId},makeReceipt(manifest,{warnings}),c.status==='PARTIAL'?'PARTIAL':'OK');
    const plan={job_id:jobId,manifest,request,request_sha256:sha,result,changed_sources:changed,limits:snapshot.limits,origin_domains:snapshot.origin_domains};checkpoint(root,jobId,{state:'STAGED',owner:lock,plan});retainLock=true;await services.fault?.('objects_fsync',plan);await commitPlan(root,plan,services.fault);checkpoint(root,jobId,{state:'COMPLETED',owner:lock,plan});retainLock=false;return result;
  }finally{if(!retainLock)releaseLock(root,lock);}
}
async function recoverArchive(root,request,services){
  let snapshot;
  if(fs.existsSync(inside(root,'archive.json')))snapshot=openSnapshot(root);
  else{
    const owner=readJson(inside(root,'writer.lock')),saved=readCheckpoint(root,request.params.job_id),plan=saved.plan;
    if(plan?.request?.operation!=='archive.init'||plan.manifest.commit_seq!==1||plan.manifest.parent_revision_id!==null||plan.manifest.archive_id!==owner.archive_id)throw failure('INTEGRITY_FAILED','An unpublished archive requires a valid initial publication checkpoint');
    snapshot={archive_id:owner.archive_id,access_domain_id:plan.manifest.access_domain_id,revision_id:null,commit_seq:0,ledger_sha256:null,coverage:coverage()};
  }
  const sha=requestDigest(request),prior=durableResponse(root,request,sha,snapshot);if(prior)return prior;
  if(request.revision_id!==null&&request.revision_id!==snapshot.revision_id)throw failure('REVISION_CONFLICT','Recovery requires the latest published revision');
  const {saved,lock}=claimRecovery(root,request,snapshot.archive_id);let completed=false;
  try{
    checkpoint(root,lock.job_id,{...saved,owner:lock});
    const plan=saved.plan;let latest=snapshot;
    if(plan){
      validateRequest(plan.request);
      const {revision_id,...payload}=plan.manifest;
      if(plan.job_id!==lock.job_id||plan.manifest.archive_id!==snapshot.archive_id||revision_id!=='cap4-'+digest(payload)||plan.result.receipt.revision_id!==revision_id)throw failure('INTEGRITY_FAILED','Recovery plan revision binding differs');
      const db=openLedger(root,true);let committed;try{committed=db.prepare('SELECT revision_id FROM archive_commit WHERE seq=?').get(plan.manifest.commit_seq);}finally{db.close();}
      if(request.params.action==='abandon'&&committed)throw failure('REVISION_CONFLICT','A durably committed revision must complete publication');
      if(request.params.action==='resume'){
        if(snapshot.revision_id!==plan.manifest.parent_revision_id&&snapshot.revision_id!==revision_id)throw failure('REVISION_CONFLICT','Recovery plan is not the latest pending revision');
        for(const item of plan.changed_sources){const source=sourceManifest(root,item.source_revision_id);if(digest(source)!==digest(item))throw failure('INTEGRITY_FAILED','Checkpoint source differs from immutable manifest');for(const object of [...source.objects,...source.decoded_objects])readObject(root,object);}
        await commitPlan(root,plan,services.fault);latest=openSnapshot(root);
      }
    }else if(request.params.action==='resume')throw failure('EVIDENCE_UNAVAILABLE','Checkpoint has no fully staged acquisition to resume');
    const result=response(request,{job_status:request.params.action==='abandon'?'ABANDONED':'COMPLETED',resumed_from:saved.state,lost_uncommitted_work:request.params.action==='abandon'?(plan?.changed_sources.reduce((n,s)=>n+s.records.length,0)??0):0},makeReceipt(latest));
    const db=openLedger(root);try{db.exec('PRAGMA synchronous=FULL');db.prepare('INSERT INTO mutation_receipt VALUES(?,?,?,?,?)').run(request.operation,request.params.idempotency_key,sha,JSON.stringify(result),latest.commit_seq);}finally{db.close();}
    checkpoint(root,lock.job_id,{state:request.params.action==='abandon'?'ABANDONED':'COMPLETED',owner:lock,plan,recovery_result:result});completed=true;return result;
  }finally{if(completed)releaseLock(root,lock);}
}
function verifyArchive(root,request){
  let snapshot;const checks=[],gaps=[];const add=(id,ok,observed,expected)=>checks.push({id,ok,observed,expected});
  try{
    snapshot=openSnapshot(root,request.revision_id);checks.push(...verifyPublishedArchive(root,snapshot,request.params));
  }catch(error){add('integrity.failure',false,error.code??'INTERNAL_ERROR','all published references verified');gaps.push(error.message);}
  return response(request,{passed:checks.length>0&&checks.every(c=>c.ok),checks,gaps},makeReceipt(snapshot));
}
// Test builds inject lifecycle barriers through this internal factory. The public
// API exports only the default engine; corpus data and public options cannot set them.
export function createArchiveEngine(services={}){return async function archiveRequest(request,options={}){
  let root;
  try{
    validateRequest(request);if(options.signal?.aborted)throw failure('CANCELLED','Request cancelled');root=localRoot(request.archive);
    if(request.operation==='archive.init')return await initArchive(root,request,options,services);
    if(request.operation==='archive.ingest')return await ingestArchive(root,request,options,services);
    if(request.operation==='archive.import_case')return await importLegacyArchive(root,request,options,services);
    if(request.operation==='archive.recover')return await recoverArchive(root,request,services);
    if(request.operation==='association.record')return await recordAssociations(root,request,options,services);
    if(request.operation==='scope.resolve')return resolveScope(root,request,openSnapshot(root,request.revision_id));
    if(request.operation==='archive.verify')return verifyArchive(root,request);
    if(request.operation==='evidence.read')return readArchiveEvidence(root,request,{receiptExtra:services.evidenceReceiptExtra});
    throw failure('NOT_IMPLEMENTED','Operation is not implemented in this candidate');
  }catch(error){
    const sqliteCode=error.code==='ERR_SQLITE_ERROR'?error.errcode&255:null;
    if(error.code==='ENOSPC'||sqliteCode===13)error=failure('DISK_FULL','Archive disk is full');
    else if(error.code==='ABORT_ERR')error=failure('CANCELLED','Archive request cancelled');
    else if(error.code==='ENOENT')error=failure('EVIDENCE_UNAVAILABLE','Requested archive or source artifact is unavailable');
    else if([5,6].includes(sqliteCode))error=failure('BUSY','SQLite could not acquire the required bounded lock');
    else if([11,26].includes(sqliteCode))error=failure('INTEGRITY_FAILED','SQLite ledger is corrupt or invalid');
    else if(['EACCES','EPERM'].includes(error.code))error=failure('UNAVAILABLE','Filesystem access or atomic replacement is unavailable');
    return errorResponse(request,error);
  }
};}
export const archiveRequest=createArchiveEngine();

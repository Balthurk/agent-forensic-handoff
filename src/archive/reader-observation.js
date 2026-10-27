// Internal acceptance-observation validation, shared by the actual harness
// consumers and their private closure builder. It grants no product authority.
import path from 'node:path';
import {digest,hash} from './protocol.js';
const readerAuxiliaryNames=new Set(['ledger.sqlite-shm','ledger.sqlite-wal']);
export function compareReadInventory(observation){
  const reasons=[],add=reason=>{if(!reasons.includes(reason))reasons.push(reason);},before=observation.inventories[0].rows;
  const protectedRows=rows=>rows.filter(row=>!readerAuxiliaryNames.has(row.path));
  for(const snapshot of observation.inventories){
    if(snapshot.rows.some(row=>!['file','directory'].includes(row.type)))add('UNSUPPORTED_FILE_TYPE');
    if(snapshot.rows.some(row=>readerAuxiliaryNames.has(row.path)&&row.type!=='file'))add('NONREGULAR_AUXILIARY');
    if(digest(protectedRows(snapshot.rows))!==digest(protectedRows(before)))add('PROTECTED_INVENTORY_CHANGE');
  }
  const auxiliarySnapshots=[before.filter(row=>readerAuxiliaryNames.has(row.path)),...observation.native_calls.flatMap(call=>[call.before,call.after]),observation.inventories.at(-1).rows.filter(row=>readerAuxiliaryNames.has(row.path))];
  const firstWal=auxiliarySnapshots[0].find(row=>row.path==='ledger.sqlite-wal')??null;
  for(const rows of auxiliarySnapshots){
    if(rows.some(row=>row.type!=='file'))add('NONREGULAR_AUXILIARY');
    const wal=rows.find(row=>row.path==='ledger.sqlite-wal')??null;
    if(firstWal?.bytes>0){if(digest(wal)!==digest(firstWal))add('NONEMPTY_WAL_CHANGED');}
    else if(wal&&wal.bytes!==0)add('ZERO_WAL_GAINED_DATA');
  }
  const changed=auxiliarySnapshots.some(rows=>digest(rows)!==digest(auxiliarySnapshots[0]));
  if(changed){
    if(!observation.writer_observation.quiet)add('WRITER_NOT_OBSERVED_QUIET');
    if(!observation.handles.length||observation.handles.some(handle=>!handle.readOnly||handle.location!==observation.database||!handle.closed))add('NATIVE_READONLY_HANDLE_UNPROVEN');
    if(observation.unattributed_boundaries.length)add('UNATTRIBUTED_AUXILIARY_CHANGE');
    for(const call of observation.native_calls){
      if(digest(call.before)!==digest(call.after)&&!observation.handles.some(handle=>handle.id===call.handle_id&&handle.readOnly&&handle.location===observation.database))add('UNATTRIBUTED_NATIVE_CHANGE');
    }
  }
  if(observation.filesystem_mutations.length)add('JAVASCRIPT_FILESYSTEM_MUTATION');
  if(!observation.sql_probes&&observation.sql_mutations.length)add('SQL_MUTATION_ATTEMPT');
  return {preserved:reasons.length===0,reasons,auxiliary_changes:changed,nonempty_wal_protected:firstWal?.bytes>0};
}

export function assertReadObservation({request,response,observation:o,expectation=null,requireOutcome=false}){
  const reasons=[],need=(condition,reason)=>{if(!condition)reasons.push(reason);};
  const reject=()=>{if(reasons.length)throw Object.assign(new Error('Reader control rejected: '+[...new Set(reasons)].join(', ')),{code:'READ_CONTROL_REJECTED',details:{reasons:[...new Set(reasons)]}});};
  need(!!request&&!!response&&!!o,'MISSING_REQUEST_RESPONSE_OBSERVATION');reject();
  need(['archive.verify','evidence.read','scope.resolve','event.show','stats','ledger.occurrences','graph.neighbors','ledger.association_pair'].includes(request.operation),'UNSUPPORTED_READ_OPERATION');
  need(o.operation===request.operation&&o.request_id===request.request_id&&response.operation===request.operation&&response.request_id===request.request_id,'REQUEST_RESPONSE_BINDING');
  need(typeof request.archive==='string'&&path.resolve(request.archive)===o.root&&o.database===path.join(o.root,'ledger.sqlite'),'ARCHIVE_BINDING');
  for(const field of ['handles','native_calls','inventories','errors','filesystem_mutations','sql_mutations','unattributed_boundaries'])need(Array.isArray(o[field]),'MISSING_'+field.toUpperCase());reject();
  need(o.sql_probes===false,'WRITE_PROBE_IS_NOT_A_NORMAL_READ');need(o.filesystem_mutations.length===0,'JAVASCRIPT_WRITE_ATTEMPT');need(o.sql_mutations.length===0,'SQL_WRITE_ATTEMPT');need(o.errors.length===0,'SQL_OR_NATIVE_ERROR');need(o.unattributed_boundaries.length===0,'UNATTRIBUTED_BOUNDARY');
  const writer=o.writer_observation;need(!!writer,'MISSING_WRITER_OBSERVATION');reject();
  const relative=typeof writer.synthetic_root==='string'?path.relative(writer.synthetic_root,o.root):'..';
  const contained=relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative),phase=writer.phase;
  const quiet=contained&&phase?.state!=='RUNNING'&&(!writer.lock||phase?.pid===writer.lock.pid&&['PAUSED_AT_NATIVE_FAULT_BARRIER','PROCESS_CLOSED'].includes(phase.state));
  need(contained&&writer.contained===true&&writer.quiet===true&&quiet,'WRITER_QUIET_UNPROVEN');
  if(writer.lock){need(/^[a-f0-9]{64}$/.test(phase?.worker_sha256??''),'WRITER_PHASE_PROVENANCE');if(phase?.state==='PAUSED_AT_NATIVE_FAULT_BARRIER')need(phase.job_id===writer.lock.job_id&&['objects_fsync','ledger_commit','revision_manifest','pointer_replace','association_row_insert'].includes(phase.barrier),'WRITER_BARRIER_BINDING');}
  need(o.handles.length>0&&o.native_calls.length>0,'NATIVE_HANDLES_OR_CALLS_MISSING');
  const handles=new Map();for(const handle of o.handles){need(Number.isSafeInteger(handle.id)&&handle.id>0&&!handles.has(handle.id),'HANDLE_IDENTITY');handles.set(handle.id,handle);need(handle.readOnly===true&&handle.options?.readOnly===true&&handle.closed===true,'READONLY_CLOSED_HANDLE_REQUIRED');need(handle.location===o.database&&typeof handle.argument==='string'&&path.resolve(handle.argument)===o.database,'HANDLE_DATABASE_PROVENANCE');}
  const opened=new Set(),closed=new Set(),preparations=new Map(),iterators=new Map(),executedPreparations=new Set(),executions=new Map(),readHandles=new Set(),calls=new Map();let previousSequence=0,auxiliaryPrevious=o.inventories[0]?.rows?.filter(row=>readerAuxiliaryNames.has(row.path));
  for(const call of o.native_calls){
    need(Array.isArray(call.before)&&Array.isArray(call.after),'NATIVE_AUXILIARY_INVENTORY_MISSING');
    for(const rows of [call.before,call.after])if(Array.isArray(rows))need(rows.every(row=>readerAuxiliaryNames.has(row.path)&&row.type==='file'&&typeof row.identity==='string'&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&/^[a-f0-9]{64}$/.test(row.sha256)),'NATIVE_AUXILIARY_PROVENANCE');
    if(auxiliaryPrevious&&call.before)need(digest(auxiliaryPrevious)===digest(call.before),'NATIVE_AUXILIARY_BOUNDARY_GAP');auxiliaryPrevious=call.after;
    need(Number.isSafeInteger(call.sequence)&&call.sequence===previousSequence+1,'NATIVE_SEQUENCE');previousSequence=call.sequence;
    need(handles.has(call.handle_id),'UNBOUND_NATIVE_CALL');need(call.completed===true&&!call.error,'FAILED_NATIVE_CALL');
    if(call.method==='constructor'){need(!opened.has(call.handle_id),'DUPLICATE_CONSTRUCTOR');opened.add(call.handle_id);}
    else{need(opened.has(call.handle_id)&&!closed.has(call.handle_id),'NATIVE_HANDLE_LIFECYCLE');if(call.method==='close')closed.add(call.handle_id);}
    if(call.sql!==null){need(typeof call.sql==='string','MISSING_SQL');if(typeof call.sql==='string'){const sql=call.sql.trim().replace(/;\s*$/,'');need(!sql.includes(';')&&(/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)||/^SELECT\b/i.test(sql)||/^PRAGMA\s+integrity_check$/i.test(sql)),'NONREAD_SQL');}}
    calls.set(call.sequence,call);
    const method=call.method,statement=['statement.get','statement.all','statement.iterate'].includes(method),iterator=['iterator.next','iterator.return'].includes(method),sql=typeof call.sql==='string'?call.sql.trim().replace(/;\s*$/,''):'';
    need(['constructor','close','exec','prepare'].includes(method)||statement||iterator,'UNSUPPORTED_NATIVE_READ_METHOD');
    if(['constructor','close'].includes(method))need(call.sql===null&&call.prepare_sequence===undefined&&call.iterator_sequence===undefined,'LIFECYCLE_IS_NOT_SQL_EXECUTION');
    if(method==='exec')need(/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql),'TRANSACTION_IS_NOT_QUERY_EXECUTION');
    if(method==='prepare'){
      need(/^SELECT\b/i.test(sql)||['archive.verify','event.show','stats','ledger.occurrences','graph.neighbors'].includes(request.operation)&&/^PRAGMA\s+integrity_check$/i.test(sql),'OPERATION_READ_SQL_REQUIRED');preparations.set(call.sequence,call);
    }
    if(statement||iterator){
      const prepared=preparations.get(call.prepare_sequence);need(!!prepared&&prepared.sequence<call.sequence&&prepared.handle_id===call.handle_id&&prepared.sql===call.sql,'EXECUTION_PREPARATION_BINDING');
      if(method==='statement.iterate')iterators.set(call.sequence,{call,advanced:false,closed:false});
      if(iterator){const creation=iterators.get(call.iterator_sequence);need(!!creation&&creation.call.sequence<call.sequence&&creation.call.handle_id===call.handle_id&&creation.call.prepare_sequence===call.prepare_sequence&&creation.call.sql===call.sql&&!creation.closed,'ITERATOR_CREATION_BINDING');if(creation){if(method==='iterator.next'){creation.advanced=true;need(typeof call.iterator_done==='boolean','ITERATOR_ADVANCE_RESULT');if(call.iterator_done)creation.closed=true;}else creation.closed=true;}}
      if(['statement.get','statement.all','iterator.next'].includes(method)){
        need(Number.isSafeInteger(call.row_count)&&call.row_count>=0&&(method==='statement.all'||call.row_count<=1),'EXECUTED_READ_RESULT_MISSING');if(method==='iterator.next')need(call.row_count===(call.iterator_done?0:1),'ITERATOR_RESULT_INCONSISTENT');
        executions.set(call.sequence,call);readHandles.add(call.handle_id);executedPreparations.add(call.prepare_sequence);
      }
    }
  }
  need(opened.size===handles.size&&closed.size===handles.size,'CONSTRUCTOR_OR_CLOSE_EVIDENCE_MISSING');
  need(executions.size>0&&[...handles.keys()].every(id=>readHandles.has(id)),'EXECUTED_READ_PER_HANDLE_REQUIRED');
  need([...preparations.keys()].every(id=>executedPreparations.has(id)),'PREPARATION_WITHOUT_EXECUTION');need([...iterators.values()].every(item=>item.advanced),'ITERATOR_WITHOUT_ADVANCE');
  const duringReadHandles=new Set();
  for(const inventory of o.inventories){if(['BEFORE','AFTER'].includes(inventory.phase))continue;const match=/^DURING_(\d+)_(.+)$/.exec(inventory.phase??''),call=match?calls.get(Number(match[1])):null;need(!!call&&call.method===match[2]&&(executions.has(call.sequence)||call.method==='close'),'DURING_NATIVE_EVENT_BINDING');if(call&&Array.isArray(inventory.rows)){need(digest(inventory.rows.filter(row=>readerAuxiliaryNames.has(row.path)))===digest(call.after),'DURING_AUXILIARY_EVENT_BINDING');if(executions.has(call.sequence))duringReadHandles.add(call.handle_id);}}
  need([...handles.keys()].every(id=>duringReadHandles.has(id)),'DURING_EXECUTION_PER_HANDLE_REQUIRED');
  const finalAuxiliary=o.inventories.at(-1)?.rows?.filter(row=>readerAuxiliaryNames.has(row.path));if(finalAuxiliary&&auxiliaryPrevious)need(digest(finalAuxiliary)===digest(auxiliaryPrevious),'FINAL_AUXILIARY_BOUNDARY_GAP');
  need(o.inventories.length>=3&&o.inventories[0]?.phase==='BEFORE'&&o.inventories.at(-1)?.phase==='AFTER'&&o.inventories.some(item=>item.phase.startsWith('DURING_')),'FULL_INVENTORY_PHASES');
  for(const inventory of o.inventories){need(Array.isArray(inventory.rows),'INVENTORY_ROWS_MISSING');if(!Array.isArray(inventory.rows))continue;need(new Set(inventory.rows.map(row=>row.path)).size===inventory.rows.length,'DUPLICATE_INVENTORY_PATH');need(inventory.rows.some(row=>row.path===''&&row.type==='directory')&&inventory.rows.some(row=>row.path==='ledger.sqlite'&&row.type==='file'),'ACTIVE_DATABASE_INVENTORY_MISSING');for(const row of inventory.rows)need(typeof row.identity==='string'&&(row.type==='directory'||row.type==='file'&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&/^[a-f0-9]{64}$/.test(row.sha256)),'UNTYPED_INVENTORY_ROW');}
  reject();if(o.shm_observation||request.operation==='ledger.association_pair'||phase?.barrier==='association_row_insert'&&phase.state==='PAUSED_AT_NATIVE_FAULT_BARRIER')assertAssociationPairObservation({request,response,observation:o});const comparison=compareReadInventory(o);need(comparison.preserved===true&&digest(comparison)===digest(o.comparison),'INVENTORY_COMPARISON_INCONSISTENT');
  let category;
  if(expectation===null){
    category='POSITIVE_READ';need(o.passed===true,'PASSED_NOT_TRUE');need(o.operation_error===null&&response.error===null&&response.data!==null,'POSITIVE_READ_HAS_ERROR');
    if(request.operation==='archive.verify')need(response.data?.passed===true&&response.data.checks?.length>0&&response.data.checks.every(check=>check.ok===true),'VERIFICATION_NOT_TRUE');
    if(request.operation==='graph.neighbors'){
      const data=response.data,executed=[...executions.values()],relationReads=executed.filter(call=>/\bFROM\s+relation_version\b/i.test(call.sql??'')),entityReads=executed.filter(call=>/\bFROM\s+(event_version|session_version)\b/i.test(call.sql??''));
      need(relationReads.length>0,'GRAPH_RELATION_READ_REQUIRED');need(entityReads.length>0,'GRAPH_ENTITY_READ_REQUIRED');
      need(Array.isArray(data?.nodes)&&Array.isArray(data?.edges)&&Array.isArray(data?.paths)&&typeof data?.truncated==='boolean','GRAPH_RESULT_SHAPE');
      if(Array.isArray(data?.nodes)&&Array.isArray(data?.edges)){
        need(data.nodes.length<=(request.params?.max_nodes??5000)&&Number(data.visited)===data.nodes.length,'GRAPH_RESULT_BOUND');
        need(data.edges.length<=relationReads.reduce((sum,call)=>sum+call.row_count,0),'GRAPH_EDGE_ROWS_NOT_OBSERVED');
        need(data.nodes.length<=entityReads.reduce((sum,call)=>sum+call.row_count,0),'GRAPH_NODE_ROWS_NOT_OBSERVED');
      }
    }
  }else{
    category='EXPECTED_NEGATIVE';need(o.passed===false,'NEGATIVE_CANNOT_CLAIM_POSITIVE_PASS');
    if(expectation==='PUBLISHED_INTEGRITY_FAILURE')need(request.operation==='archive.verify'&&response.error===null&&o.operation_error===null&&response.data?.passed===false&&response.data.checks?.some(check=>check.id==='integrity.failure'&&check.ok===false&&check.observed==='INTEGRITY_FAILED'),'EXPECTED_PUBLISHED_INTEGRITY_FAILURE_NOT_OBSERVED');
    else if(expectation==='PRE_OCCURRENCE_EXTENSION'){
      const details=response.error?.details;
      need(['event.show','stats','ledger.occurrences'].includes(request.operation)&&response.data===null&&response.error?.code==='NOT_IMPLEMENTED'&&details?.format==='PRE_OCCURRENCE_EXTENSION'&&Number.isSafeInteger(details.commit_seq)&&details.commit_seq>0&&/^cap4-[a-f0-9]{64}$/.test(details.revision_id??'')&&(!request.revision_id||request.revision_id===details.revision_id)&&digest(o.operation_error)===digest(response.error),'EXPECTED_PRE_OCCURRENCE_AVAILABILITY_NOT_OBSERVED');
      need(o.native_calls.some(call=>call.completed&&['statement.get','statement.all','iterator.next'].includes(call.method)&&/\barchive_commit\b/i.test(call.sql??'')),'PRE_OCCURRENCE_COMMIT_READ_NOT_OBSERVED');
    }
    else if(['EVIDENCE_UNAVAILABLE','INTEGRITY_FAILED','CONTINUATION_MISMATCH'].includes(expectation)){
      const applicable=request.operation==='evidence.read'||['event.show','graph.neighbors'].includes(request.operation)&&['EVIDENCE_UNAVAILABLE','INTEGRITY_FAILED'].includes(expectation)||['stats','ledger.occurrences'].includes(request.operation)&&expectation==='INTEGRITY_FAILED';
      need(applicable&&response.data===null&&response.error?.code===expectation&&digest(o.operation_error)===digest(response.error),'EXPECTED_EVIDENCE_ERROR_NOT_OBSERVED');
    }
    else need(false,'UNKNOWN_NEGATIVE_EXPECTATION');
  }
  reject();const outcome={category,expectation,request_sha256:digest(request),response_sha256:digest(response)};
  if(requireOutcome)need(!!o.outcome&&digest(o.outcome)===digest(outcome),'RECORDED_OUTCOME_BINDING');reject();return outcome;
}

export function assertAssociationPairObservation({request,response,observation:o}){
 const reasons=[],need=(value,reason)=>{if(!value)reasons.push(reason);},reject=()=>{if(reasons.length)throw Object.assign(new Error('Association pair control rejected: '+[...new Set(reasons)].join(', ')),{code:'READ_CONTROL_REJECTED',details:{reasons:[...new Set(reasons)]}});};
 need(request.kind==='INTERNAL_FUNCTION_CALL'&&request.export==='atomic04Pair'&&request.operation==='ledger.association_pair'&&response.kind==='INTERNAL_FUNCTION_RESULT','PAIR_INTERNAL_FUNCTION_IDENTITY');
 const sql='SELECT data_json FROM association_version a WHERE commit_seq<=? AND commit_seq=(SELECT max(b.commit_seq) FROM association_version b WHERE b.id=a.id AND b.branch_id=a.branch_id AND b.commit_seq<=?) ORDER BY id',seq=request.params?.published_seq;
 need(request.params?.sql===sql&&Number.isSafeInteger(seq)&&seq>0,'PAIR_QUERY_PUBLICATION_CUT');need(response.error===null&&Array.isArray(response.data?.rows)&&response.data.pointer?.published_seq===seq&&response.data.pointer?.revision_id===request.revision_id,'PAIR_RESULT_PUBLICATION_BINDING');
 const reads=o.native_calls.filter(c=>c.method==='statement.all');need(reads.length===1&&reads[0]?.sql===sql&&digest(reads[0]?.bound_parameters)===digest([seq,seq]),'PAIR_EXECUTED_SQL_PARAMETERS');need(Array.isArray(reads[0]?.result_rows)&&reads[0]?.row_count===reads[0]?.result_rows?.length,'PAIR_EXECUTED_ROWS');reject();
 let decoded;try{decoded=reads[0].result_rows.map(row=>JSON.parse(row.data_json));}catch{need(false,'PAIR_EXECUTED_JSON');}need(digest(decoded)===digest(response.data.rows),'PAIR_ROWS_RESPONSE_BINDING');need(response.data.rows.length===2&&new Set(response.data.rows.map(row=>row.revision?.assertion_id)).size===2,'PAIR_TWO_DISTINCT_ASSERTIONS');reject();
 const phase=o.writer_observation.phase,mapped=o.shm_observation;
 if(phase?.barrier!=='association_row_insert'||phase.state!=='PAUSED_AT_NATIVE_FAULT_BARRIER'){need(!mapped,'MAPPING_OUTSIDE_INSERT_SCOPE');reject();return;}
 const w=o.writer_observation,pre=w.progress_before,post=w.progress_after;
 need(phase.first_insert===true&&phase.resume_allowed===false&&pre?.alive===true&&post?.alive===true,'FIRST_INSERT_PARKED_WRITER');
 need(pre?.ref===phase.progress_ref&&post?.ref===phase.progress_ref&&pre?.sha256===phase.progress_sha256&&post?.sha256===pre?.sha256&&digest(pre?.payload)===digest(post?.payload)&&pre?.sha256===hash(JSON.stringify(pre?.payload)),'WRITER_PROGRESS_ADVANCED_OR_UNBOUND');
 const progress=pre?.payload;need(progress?.pid===phase.pid&&progress?.job_id===phase.job_id&&progress?.barrier==='association_row_insert'&&progress?.insert_count===1&&progress?.resume_allowed===false&&typeof progress?.sql==='string'&&progress.sql.startsWith('INSERT INTO association_version')&&progress?.sql_sha256===hash(progress.sql)&&Array.isArray(progress.bound_parameters),'FIRST_INSERT_SQL_PROVENANCE');
 need(!!mapped&&Array.isArray(mapped.boundaries)&&Array.isArray(mapped.attestations),'MAPPED_SHM_EVIDENCE_REQUIRED');reject();
 const m=mapped.manifest;need(m?.id==='AFH-SHM04-ACCEPTANCE-HELPER-01'&&m.platform==='win32'&&m.max_bytes===16777216&&m.timeout_ms===10000&&m.max_buffer===1048576&&digest(m.fixed_args)===digest(['-I','-B']),'MAPPING_SCOPE_CONFIGURATION');
 need(m?.helper?.sha256&&m?.executable?.sha256&&m?.manifest?.sha256&&digest(request.observer_binding)===digest({manifest:m.manifest,helper:m.helper,executable:m.executable}),'MAPPING_HELPER_IDENTITY');
 need(path.resolve(m.helper?.ref??'.')===path.join(path.resolve(m.root??'.'),'mapped-shm-readonly.py')&&path.resolve(m.manifest?.ref??'.')===path.join(path.resolve(m.root??'.'),'helper-manifest.json'),'MAPPING_TOOL_ROOT');
 need(Number.isSafeInteger(mapped.reader_index)&&mapped.reader_index>0&&mapped.observation_id==='obs04-'+digest({root:o.root,pid:o.pid,reader_index:mapped.reader_index,writer:pre}),'MAPPING_OBSERVATION_IDENTITY');reject();
 const expected=[{phase:'BEFORE',native_sequence:0,side:'FULL',rows:o.inventories[0].rows},{phase:'INITIAL_AUX',native_sequence:0,side:'AUX',rows:o.inventories[0].rows}];
 for(const call of o.native_calls){expected.push({phase:'NATIVE',native_sequence:call.sequence,side:'BEFORE',rows:call.before},{phase:'NATIVE',native_sequence:call.sequence,side:'AFTER',rows:call.after});for(const inv of o.inventories.filter(i=>i.phase==='DURING_'+call.sequence+'_'+call.method))expected.push({phase:inv.phase,native_sequence:call.sequence,side:'FULL',rows:inv.rows});}
 expected.push({phase:'AFTER',native_sequence:0,side:'FULL',rows:o.inventories.at(-1).rows},{phase:'FINAL_AUX',native_sequence:0,side:'AUX',rows:o.inventories.at(-1).rows});
 need(mapped.boundaries.length===expected.length&&mapped.attestations.length===expected.length,'MAPPED_BOUNDARY_COUNT');need(new Set(mapped.boundaries.map(b=>b.boundary_id)).size===expected.length&&new Set(mapped.attestations.map(a=>a.attestation_id)).size===expected.length,'MAPPED_DUPLICATE_IDENTITIES');reject();
 for(const e of expected){
  const id='shm04-'+digest({observation_id:mapped.observation_id,phase:e.phase,native_sequence:e.native_sequence,side:e.side}),b=mapped.boundaries.find(b=>b.boundary_id===id),row=e.rows.find(r=>r.path==='ledger.sqlite-shm');
  need(!!b&&b.phase===e.phase&&b.native_sequence===e.native_sequence&&b.side===e.side&&b.attestation_ids?.length===1,'MAPPED_EXPLICIT_BOUNDARY_BINDING');need(!!row&&row.type==='file'&&row.bytes>0&&row.bytes<=m.max_bytes,'MAPPED_SHM_OMITTED_OR_UNSUPPORTED');reject();
  const a=mapped.attestations.find(a=>a.attestation_id===b.attestation_ids[0]),r=a?.report;need(!!a&&!!r&&a.boundary_id===id&&a.phase===e.phase&&a.native_sequence===e.native_sequence&&a.side===e.side&&r.boundary_id===id,'MAPPED_ATTESTATION_BOUNDARY');reject();
  need(a.attestation_id==='map04-'+digest({boundary_id:id,helper:m.helper,report:r})&&digest(a.helper)===digest(m.helper)&&digest(a.executable)===digest(m.executable),'MAPPED_ATTESTATION_IDENTITY');
  need(r.file===path.join(o.root,'ledger.sqlite-shm')&&r.archive_root===o.root&&r.local_drive_type===3&&r.mapped_read_only===true,'MAPPED_EXACT_LOCAL_SHM');
  need(r.metadata?.identity===row.identity&&r.metadata?.bytes===row.bytes&&r.bytes_read===row.bytes&&r.sha256===row.sha256&&!(r.metadata?.attributes&1024),'MAPPED_IDENTITY_EXTENT_DIGEST');
  need(a.process?.command===m.executable.ref&&a.process?.cwd===m.root&&a.process?.status===0&&a.process?.timeout_ms===m.timeout_ms&&a.process?.max_buffer===m.max_buffer&&Number.isSafeInteger(r.pid)&&r.pid>0&&a.process.pid===r.pid&&digest(a.process.args)===digest([...m.fixed_args,m.helper.ref,path.join(o.root,'ledger.sqlite-shm'),o.root,id]),'MAPPED_PROCESS_ADMISSION');
  const invoked=a.process.observed_call;need(invoked?.method==='spawnSync'&&invoked?.allowed===true&&invoked?.kind==='EXACT_READONLY_SHM_ACCEPTANCE_HELPER'&&invoked?.boundary_id===id&&invoked?.archive_root===o.root&&invoked?.command===m.executable.ref&&digest(invoked?.args)===digest(a.process.args)&&digest(invoked?.helper)===digest(m.helper)&&digest(invoked?.executable)===digest(m.executable)&&invoked?.native_result?.pid===r.pid&&invoked?.native_result?.status===0&&invoked?.native_result?.signal===null&&invoked?.native_result?.error===null,'MAPPED_ACTUAL_PROCESS_CALL');
  const c=r.native_calls;need(Array.isArray(c),'MAPPED_NATIVE_CALLS');reject();
  need(digest(c.map(x=>x.api))===digest(['CreateFileW','GetFileInformationByHandle','ReadFile','CreateFileMappingW','MapViewOfFile','copy_from_mapped_view','MapViewOfFile','GetFileInformationByHandle','UnmapViewOfFile','CloseHandle','CloseHandle']),'MAPPED_NATIVE_LIFECYCLE');reject();
  need(c[0].ok===true&&c[0].desired_access==='GENERIC_READ'&&c[0].share==='READ|WRITE|DELETE'&&c[0].creation==='OPEN_EXISTING'&&c[0].flags==='FILE_FLAG_OPEN_REPARSE_POINT','MAPPED_READONLY_BACKING_HANDLE');
  for(const [index,when]of [[1,'before'],[7,'after']]){const {api,when:actualWhen,...meta}=c[index];need(actualWhen===when&&digest(meta)===digest(r.metadata),'MAPPED_NATIVE_METADATA_STABLE');}
  need(c[3].ok===true&&c[3].protect==='PAGE_READONLY'&&c[3].maximum_size===0&&c[3].name===null&&c[3].file_handle==='same GENERIC_READ handle','MAPPED_READONLY_MAPPING');
  need(c[4].ok===true&&c[4].access==='FILE_MAP_READ'&&c[4].offset===0&&c[4].bytes===row.bytes&&c[5].bytes===row.bytes&&c[5].sha256===row.sha256,'MAPPED_COMPLETE_READ');
  need(c[6].role==='WRITE_ACCESS_NEGATIVE'&&c[6].access==='FILE_MAP_WRITE'&&c[6].ok===false&&c[6].error===5,'MAPPED_WRITE_VIEW_REJECTED');
  need(c[8].ok===true&&c[9].ok===true&&c[9].handle==='mapping'&&c[10].ok===true&&c[10].handle==='file','MAPPED_HANDLES_CLOSED');
  need(c[2].ok===r.readfile_ok&&c[2].error===r.readfile_error&&(r.readfile_ok===true?c[2].bytes===row.bytes&&c[2].sha256===row.sha256:c[2].error===33&&c[2].bytes===0&&c[2].sha256===null),'MAPPED_READFILE_RESULT');
 }
 reject();
}

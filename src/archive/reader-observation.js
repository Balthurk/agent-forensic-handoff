// Internal acceptance-observation validation, shared by the actual harness
// consumers and their private closure builder. It grants no product authority.
import path from 'node:path';
import {digest} from './protocol.js';
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
  need(['archive.verify','evidence.read','scope.resolve'].includes(request.operation),'UNSUPPORTED_READ_OPERATION');
  need(o.operation===request.operation&&o.request_id===request.request_id&&response.operation===request.operation&&response.request_id===request.request_id,'REQUEST_RESPONSE_BINDING');
  need(typeof request.archive==='string'&&path.resolve(request.archive)===o.root&&o.database===path.join(o.root,'ledger.sqlite'),'ARCHIVE_BINDING');
  for(const field of ['handles','native_calls','inventories','errors','filesystem_mutations','sql_mutations','unattributed_boundaries'])need(Array.isArray(o[field]),'MISSING_'+field.toUpperCase());reject();
  need(o.sql_probes===false,'WRITE_PROBE_IS_NOT_A_NORMAL_READ');need(o.filesystem_mutations.length===0,'JAVASCRIPT_WRITE_ATTEMPT');need(o.sql_mutations.length===0,'SQL_WRITE_ATTEMPT');need(o.errors.length===0,'SQL_OR_NATIVE_ERROR');need(o.unattributed_boundaries.length===0,'UNATTRIBUTED_BOUNDARY');
  const writer=o.writer_observation;need(!!writer,'MISSING_WRITER_OBSERVATION');reject();
  const relative=typeof writer.synthetic_root==='string'?path.relative(writer.synthetic_root,o.root):'..';
  const contained=relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative),phase=writer.phase;
  const quiet=contained&&phase?.state!=='RUNNING'&&(!writer.lock||phase?.pid===writer.lock.pid&&['PAUSED_AT_NATIVE_FAULT_BARRIER','PROCESS_CLOSED'].includes(phase.state));
  need(contained&&writer.contained===true&&writer.quiet===true&&quiet,'WRITER_QUIET_UNPROVEN');
  if(writer.lock){need(/^[a-f0-9]{64}$/.test(phase?.worker_sha256??''),'WRITER_PHASE_PROVENANCE');if(phase?.state==='PAUSED_AT_NATIVE_FAULT_BARRIER')need(phase.job_id===writer.lock.job_id&&['objects_fsync','ledger_commit','revision_manifest','pointer_replace'].includes(phase.barrier),'WRITER_BARRIER_BINDING');}
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
      need(/^SELECT\b/i.test(sql)||request.operation==='archive.verify'&&/^PRAGMA\s+integrity_check$/i.test(sql),'OPERATION_READ_SQL_REQUIRED');preparations.set(call.sequence,call);
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
  reject();const comparison=compareReadInventory(o);need(comparison.preserved===true&&digest(comparison)===digest(o.comparison),'INVENTORY_COMPARISON_INCONSISTENT');
  let category;
  if(expectation===null){
    category='POSITIVE_READ';need(o.passed===true,'PASSED_NOT_TRUE');need(o.operation_error===null&&response.error===null&&response.data!==null,'POSITIVE_READ_HAS_ERROR');
    if(request.operation==='archive.verify')need(response.data?.passed===true&&response.data.checks?.length>0&&response.data.checks.every(check=>check.ok===true),'VERIFICATION_NOT_TRUE');
  }else{
    category='EXPECTED_NEGATIVE';need(o.passed===false,'NEGATIVE_CANNOT_CLAIM_POSITIVE_PASS');
    if(expectation==='PUBLISHED_INTEGRITY_FAILURE')need(request.operation==='archive.verify'&&response.error===null&&o.operation_error===null&&response.data?.passed===false&&response.data.checks?.some(check=>check.id==='integrity.failure'&&check.ok===false&&check.observed==='INTEGRITY_FAILED'),'EXPECTED_PUBLISHED_INTEGRITY_FAILURE_NOT_OBSERVED');
    else if(['EVIDENCE_UNAVAILABLE','INTEGRITY_FAILED','CONTINUATION_MISMATCH'].includes(expectation))need(request.operation==='evidence.read'&&response.data===null&&response.error?.code===expectation&&digest(o.operation_error)===digest(response.error),'EXPECTED_EVIDENCE_ERROR_NOT_OBSERVED');
    else need(false,'UNKNOWN_NEGATIVE_EXPECTATION');
  }
  reject();const outcome={category,expectation,request_sha256:digest(request),response_sha256:digest(response)};
  if(requireOutcome)need(!!o.outcome&&digest(o.outcome)===digest(outcome),'RECORDED_OUTCOME_BINDING');reject();return outcome;
}

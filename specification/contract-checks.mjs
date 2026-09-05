// Specification-only evidence/contract validators. These are not product APIs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function runtimeSnapshot(root) {
  const files=[];
  const visit=relative=>{
    const full=path.join(root,relative);
    if(!fs.existsSync(full))return;
    const stat=fs.lstatSync(full);
    if(stat.isSymbolicLink())throw new Error('Unresolved runtime symlink: '+relative);
    if(stat.isDirectory()){
      for(const entry of fs.readdirSync(full).sort()) {
        if(['node_modules','.git','private'].includes(entry))continue;
        visit(relative+'/'+entry);
      }
    }else if(stat.isFile())files.push({file:relative.replaceAll('\\','/'),bytes:stat.size,sha256:hash(fs.readFileSync(full))});
  };
  // Includes effective owned untracked files, external-asset identities come from receipts.
  for(const item of ['src','bin','schemas','config','configs','afh.config.json','package.json','package-lock.json','.npmrc'])visit(item);
  files.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
  return {files,sha256:hash(JSON.stringify(files))};
}
export function snapshotStability(before,after){
  const b=new Map(before.files.map(x=>[x.file,x.sha256])),a=new Map(after.files.map(x=>[x.file,x.sha256]));
  const changes=[...new Set([...b.keys(),...a.keys()])].sort().filter(k=>b.get(k)!==a.get(k)).map(file=>({file,before:b.get(file)??null,after:a.get(file)??null}));
  return {stable:changes.length===0&&before.sha256===after.sha256,changes};
}

export function exactTimestamp(value){
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if(!m)throw new Error('INVALID_TIMESTAMP');
  const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(year<1||month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>60)throw new Error('INVALID_TIMESTAMP');
  const zone=m[8].toUpperCase(),fraction=m[7]??'';
  const zoneHour=zone==='Z'?0:Number(zone.slice(1,3)),zoneMinute=zone==='Z'?0:Number(zone.slice(4,6));
  if(zoneHour>23||zoneMinute>59)throw new Error('INVALID_TIMESTAMP');
  // Unknown UTC offset and unverified leap seconds preserve literals, never fabricate an instant.
  if(zone==='-00:00'||second===60)return {ns:null,reason:zone==='-00:00'?'UNKNOWN_OFFSET':'LEAP_SECOND_UNVERIFIED',fraction_digits:fraction.length};
  // Gregorian civil-day arithmetic: integers only, no Date.parse precision/calendar normalization.
  const y=year-1;
  const dayIndex=BigInt(365*y+Math.floor(y/4)-Math.floor(y/100)+Math.floor(y/400)+days.slice(0,month-1).reduce((a,b)=>a+b,0)+day-1);
  const offset=(zone[0]==='-'?-1:1)*(zoneHour*60+zoneMinute);
  const seconds=dayIndex*86400n+BigInt(hour*3600+minute*60+second-offset*60);
  return {ns:seconds*1000000000n+BigInt(fraction.padEnd(9,'0')||'0'),fraction_digits:fraction.length,hour,minute,second,fraction};
}
export function boundWindow(bound){
  if(bound.kind!=='known')return {kind:bound.kind,lower:null,upper:null};
  const parsed=exactTimestamp(bound.value);
  if(parsed.ns===null)return {kind:'unknown',lower:null,upper:null,reason:parsed.reason};
  const unit={ns:1n,ms:1000000n,s:1000000000n,day:86400000000000n}[bound.precision];
  if(!unit)throw new Error('INVALID_PRECISION');
  const digits={ns:9,ms:3,s:0,day:0}[bound.precision];
  if(parsed.fraction_digits>digits || (bound.precision==='day'&&(parsed.hour||parsed.minute||parsed.second)))throw new Error('PRECISION_MISMATCH');
  return {kind:'known',lower:parsed.ns,upper:parsed.ns+unit-1n};
}
export function temporalRange(from,to){
  if(from.kind==='open')throw new Error('OPEN_START_FORBIDDEN');
  const a=boundWindow(from),b=boundWindow(to);
  if(a.kind==='known'&&b.kind==='known'){
    if(a.lower>b.upper)throw new Error('INVALID_TEMPORAL_RANGE');
    return {comparison:a.upper<=b.lower?'VALID':'UNKNOWN_PRECISION_OVERLAP'};
  }
  return {comparison:a.kind==='unknown'||b.kind==='unknown'?'UNKNOWN_BOUND':'PROVISIONAL_OR_UNBOUNDED'};
}
export function temporalChecks(value){
  const errors=[];
  const visit=(v,p)=>{
    if(!v||typeof v!=='object')return;
    if(v.kind==='known'&&Object.hasOwn(v,'precision')&&Object.hasOwn(v,'value'))try{boundWindow(v);}catch(e){errors.push(p+':'+e.message);}
    for(const [start,end]of [['valid_from','valid_to'],['started','ended']])if(v[start]?.kind){try{if(v[end])temporalRange(v[start],v[end]);else if(v[start].kind==='open')throw new Error('OPEN_START_FORBIDDEN');}catch(e){errors.push(p+':'+e.message);}}
    for(const [key,child]of Object.entries(v))visit(child,p+'/'+key);
  };
  visit(value,'');return [...new Set(errors)];
}

export function validateEvidencePair(request,response,state){
  const errors=[];const fail=code=>errors.push(code);
  if(request.operation!=='evidence.read'||response.operation!=='evidence.read')return ['EVIDENCE_OPERATION_MISMATCH'];
  if(request.request_id!==response.request_id||request.protocol_version!==response.protocol_version)fail('RESPONSE_CORRELATION');
  if(response.error)return errors;
  if(!state)return [...errors,'AUTHORITATIVE_EXTENT_REQUIRED'];
  const d=response.data,p=request.params,c=d.continuation,previous=p.continuation;
  const expectedOffset=previous?BigInt(previous.next_offset):BigInt(p.offset??0);
  const format=p.format??previous?.format??'text';
  for(const [key,want]of Object.entries({archive_id:state.archive_id,revision_id:state.revision_id,source_revision_id:state.source_revision_id,uri:state.uri,format,request_extent_sha256:state.request_extent_sha256,record_sha256:state.record_sha256}))if(d[key]!==want)fail('EVIDENCE_IDENTITY_'+key);
  if(p.uri!==state.uri || (request.revision_id!==null&&request.revision_id!==state.revision_id)||response.receipt.archive_id!==state.archive_id||response.receipt.revision_id!==state.revision_id)fail('REQUEST_SNAPSHOT_MISMATCH');
  if(previous){
    for(const key of ['archive_id','revision_id','source_revision_id','uri','format','request_extent_sha256'])if(previous[key]!==d[key])fail('INPUT_CURSOR_'+key);
    if(p.offset!==undefined&&BigInt(p.offset)!==expectedOffset)fail('INPUT_OFFSET_CONFLICT');
  }
  const n=BigInt(d.bytes_returned),end=BigInt(state.initial_offset)+BigInt(state.extent_bytes),next=expectedOffset+n;
  if(BigInt(d.offset)!==expectedOffset||BigInt(d.extent_bytes)!==BigInt(state.extent_bytes))fail('EVIDENCE_EXTENT_MISMATCH');
  if(expectedOffset<BigInt(state.initial_offset)||next>end||n>BigInt(p.max_bytes??1048576))fail('EVIDENCE_OUT_OF_RANGE');
  const remaining=end-next;
  if(previous&&BigInt(previous.remaining_bytes)!==end-expectedOffset)fail('INPUT_REMAINING_MISMATCH');
  if(d.partial!==(remaining>0n)||d.partial!==(c!==null))fail('CONTINUATION_REQUIRED');
  if(d.partial&&n===0n)fail('NO_CONTINUATION_PROGRESS');
  if(c){
    for(const key of ['archive_id','revision_id','source_revision_id','uri','format','request_extent_sha256'])if(c[key]!==d[key])fail('OUTPUT_CURSOR_'+key);
    if(BigInt(c.next_offset)!==next)fail('NEXT_OFFSET_MISMATCH');
    if(BigInt(c.remaining_bytes)!==remaining)fail('REMAINING_BYTES_MISMATCH');
  }
  if(d.original_extent_bytes!==state.original_extent_bytes)fail('ORIGINAL_EXTENT_MISMATCH');
  if(d.availability==='TRUNCATED_AT_SOURCE'&&d.original_extent_bytes!==null)fail('UNKNOWN_ORIGINAL_EXTENT_REQUIRED');
  if(Buffer.byteLength(JSON.stringify(response))>8388608)fail('FRAME_TOO_LARGE');
  return [...new Set(errors)];
}

export async function validateUnresolvedAssignment(caseDir,claim,claimRefs,{marker,recipient,origin}){
  const { readEvidence }=await import('../src/index.js');
  const problems=[];
  const db=new DatabaseSync(path.join(caseDir,'case.sqlite'),{readOnly:true});
  try{
    if(!claim||claim.recipient_session_id!==recipient||claim.origin_session_id!==origin||claim.origin_status!=='UNRESOLVED')problems.push('ASSIGNMENT_IDENTITY_OR_ORIGIN');
    if(!claim?.authority_chain?.length)problems.push('TRANSMISSION_CHAIN_MISSING');
    if(!claimRefs?.length)problems.push('CLAIM_EVIDENCE_MISSING');
    let matched=false;
    for(const step of claim?.authority_chain??[]){
      const event=db.prepare('SELECT * FROM event WHERE id=?').get(step.event_id??'');
      const ref=db.prepare('SELECT * FROM evidence_ref WHERE event_id=? AND uri=?').get(step.event_id??'',step.evidence_uri??'');
      if(!event||!ref){problems.push('CHAIN_REFERENCE_UNRESOLVED');continue;}
      // Runtime IO errors propagate as mechanical; registered-but-wrong evidence is an oracle failure.
      const raw=readEvidence(caseDir,step.evidence_uri);
      const registered=claimRefs.some(r=>r===step.evidence_uri||r===ref.id||r?.uri===step.evidence_uri||r?.id===ref.id);
      const sourceNative=origin.split(':').slice(2).join(':');
      if(event.session_id!==recipient||!raw.text.includes(marker)||!raw.text.includes('<source_thread_id>'+sourceNative+'</source_thread_id>')||!raw.text.includes('<codex_delegation>')||!registered)problems.push('TRANSMISSION_CONTENT_OR_RECIPIENT_MISMATCH');
      else matched=true;
    }
    if(!matched)problems.push('NO_BOUND_TRANSMISSION');
    // This probe deliberately captures no parent human event; no authority upgrade is justified.
    if(claim?.authority_origin&&claim.authority_origin!=='UNKNOWN'&&claim.authority_origin!=='AGENT_ATTRIBUTED')problems.push('UNPROVEN_HUMAN_AUTHORITY');
  }finally{db.close();}
  return {passed:problems.length===0,problems:[...new Set(problems)]};
}

// F2: shared assertions exercised by both real baseline probes and adversarial package tests.
export function assertNativeIdentityObservation(value,{event_session,grouping}){
  assert.equal(value.events.length,1,'Expected the acquired child message to remain present');
  assert.equal(value.events[0].native_id,event_session,'Native event owner');
  assert.equal(value.events[0].session_id,'ses:codex:'+event_session,'Canonical legacy session alias');
  assert.equal(value.grouping,grouping,'Grouping must be preserved separately from the native owner');
  assert.equal(value.metadata_provenance,true,'Grouping and identity must bind to the acquired session_meta bytes');
}
export async function inspectNativeIdentity(caseDir,{event_session,grouping}){
  const {readEvidence}=await import('../src/index.js');
  const db=new DatabaseSync(path.join(caseDir,'case.sqlite'),{readOnly:true});
  try{
    const events=db.prepare("SELECT e.id,e.session_id,s.native_id,s.metadata_json FROM event e LEFT JOIN session s ON s.id=e.session_id WHERE e.kind='message.user'").all();
    const metadata=events[0]?JSON.parse(events[0].metadata_json??'{}'):{};
    const refs=db.prepare("SELECT e.session_id,r.uri FROM event e JOIN evidence_ref r ON r.event_id=e.id WHERE e.kind='session.meta'").all();
    let resolved=false;
    for(const ref of refs){const record=JSON.parse(readEvidence(caseDir,ref.uri).text);if(ref.session_id===events[0]?.session_id&&record.type==='session_meta'&&record.payload.id===event_session&&record.payload.session_id===grouping)resolved=true;}
    return {events,grouping:metadata.grouping_native_id??null,metadata_provenance:resolved,evidence_refs:refs.map(r=>r.uri)};
  }finally{db.close();}
}
export function assertHumanDecisionCandidates(rows,{marker,session_id}){
  const matches=rows.filter(r=>r.decision_text===marker&&r.session_id===session_id&&r.actor_kind==='HUMAN_USER'&&r.actor_role==='user'&&r.source_kind==='message.user'&&r.provenance_resolved===true);
  assert.ok(matches.length>=1,'At least one exact human decision candidate with resolved provenance is required');
  return matches.length;
}
export async function inspectHumanDecisionCandidates(caseDir,{marker,session_id},candidateRows=null){
  const {readEvidence}=await import('../src/index.js');
  const db=new DatabaseSync(path.join(caseDir,'case.sqlite'),{readOnly:true});
  try{
    const rows=candidateRows?structuredClone(candidateRows):db.prepare('SELECT id,decision_text,source_event_id FROM decision_record').all();
    for(const row of rows){const source=db.prepare('SELECT e.session_id,e.kind AS source_kind,a.kind AS actor_kind,a.role AS actor_role FROM event e LEFT JOIN actor a ON a.id=e.actor_id WHERE e.id=?').get(row.source_event_id);Object.assign(row,{session_id:null,source_kind:null,actor_kind:null,actor_role:null},source??{});}
    for(const row of rows){row.provenance_resolved=false;row.evidence_refs=[];const refs=db.prepare('SELECT uri FROM evidence_ref WHERE event_id=?').all(row.source_event_id);
      for(const ref of refs){const raw=JSON.parse(readEvidence(caseDir,ref.uri).text);const payload=raw.payload;const content=payload?.content?.map(x=>x.text??'').join('');row.evidence_refs.push(ref.uri);if(row.session_id===session_id&&payload?.role==='user'&&content===marker)row.provenance_resolved=true;}
    }
    return rows;
  }finally{db.close();}
}

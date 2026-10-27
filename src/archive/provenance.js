import {createHash} from 'node:crypto';
import {canonical,digest,failure} from './protocol.js';
import {selectTemporal} from './temporal.js';

const unknown=()=>({kind:'unknown',value:null,precision:'order_only',timezone:null});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const unresolved=message=>{throw failure('PROVENANCE_UNRESOLVED',message);};
const text=value=>typeof value==='string'&&value.length>0;
const unique=refs=>[...new Map(refs.map(ref=>[digest(ref),ref])).values()];
const ordinalCompare=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;

function boundedCapture(capture){
  const stack=[[capture,0,new Set()]];let units=0;
  while(stack.length){const [value,depth,ancestors]=stack.pop();if(++units>1048576||depth>32)throw failure('LIMIT_EXCEEDED','Provenance capture exceeds bounded traversal');
    if(value===null||typeof value==='string'||typeof value==='boolean')continue;
    if(typeof value==='number'){if(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value))throw failure('INVALID_REQUEST','Capture numbers must be exact JSON');continue;}
    if(!value||typeof value!=='object'||ancestors.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw failure('INVALID_REQUEST','Capture must be plain acyclic JSON');
    const next=new Set(ancestors);next.add(value);const keys=Reflect.ownKeys(value);
    if(Array.isArray(value)&&(keys.length!==value.length+1||Object.keys(value).length!==value.length))throw failure('INVALID_REQUEST','Capture arrays must be dense');
    for(const key of keys){if(Array.isArray(value)&&key==='length')continue;const property=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!Object.hasOwn(property,'value')||!property.enumerable)throw failure('INVALID_REQUEST','Capture cannot contain accessors or hidden fields');stack.push([property.value,depth+1,next]);}
  }
  if(Buffer.byteLength(canonical(capture))>8*1024*1024)throw failure('LIMIT_EXCEEDED','Provenance capture exceeds eight MiB');
  if(!Array.isArray(capture.records)||!Array.isArray(capture.occurrences)||capture.records.length>100000||capture.occurrences.length>100000)throw failure('INVALID_REQUEST','Capture requires bounded records and occurrences');
  if(Object.keys(capture).sort().join(',')!=='occurrences,records')throw failure('INVALID_REQUEST','Capture object has unknown fields');
  const refs=new Set(),occurrences=new Set();
  for(const record of capture.records){if(Object.keys(record).sort().join(',')!=='evidence_ref,raw,recorded_at,recorded_seq,session_id')throw failure('INVALID_REQUEST','Captured record shape differs');const id=digest(record.evidence_ref);if(refs.has(id))unresolved('Duplicate captured reference identity');refs.add(id);}
  for(const occurrence of capture.occurrences){if(!text(occurrence.id)||occurrences.has(occurrence.id)||occurrence.temporal?.subject_id!==occurrence.id||occurrence.temporal?.assertion_id!==occurrence.id||!occurrence.temporal.scope.session_ids.includes(occurrence.session_id))unresolved('Occurrence identity or session differs from its temporal subject');occurrences.add(occurrence.id);}
}

function revision(id,records,rule='CAPTURED_PROVENANCE'){
  const latest=[...records].sort((a,b)=>b.recorded_seq-a.recorded_seq)[0],value={assertion_id:id,subject_id:id,branch_id:'main',revision_no:1,recorded_seq:latest.recorded_seq,recorded_at:latest.recorded_at,supersedes_revision_id:null,valid_from:unknown(),valid_to:unknown(),provenance:{evidence_refs:unique(records.map(r=>r.evidence_ref)),epistemic:'DIRECT_EVIDENCE',rule_id:rule,rule_version:'1',source_independence_ids:[],authority_origin:'HARNESS',transformation:'EXTRACTED'},scope:{project_id:null,session_ids:[...new Set(records.map(r=>r.session_id))],group_id:null,association_mode:'observed'}};
  return {...value,revision_id:'provfact4-'+digest(value)};
}
function payload(record){return record.raw?.payload??record.raw;}
function output(record){const p=payload(record);if(p?.type!=='function_call_output')return null;try{const value=JSON.parse(p.output);return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}}
function human(record){const p=payload(record);if(p?.type!=='message'||p.role!=='user')return null;const content=(p.content??[]).map(part=>part.text??'').join('\n');try{return {event_id:p.id,value:JSON.parse(content)};}catch{return null;}}
function patchDescriptor(raw,artifact){
  if(typeof raw!=='string')unresolved('Artifact producer does not preserve patch text');
  let patch=raw;try{const parsed=JSON.parse(raw);if(parsed&&typeof parsed==='object'&&typeof parsed.patch==='string')patch=parsed.patch;}catch{}
  const lines=patch.split(/\r?\n/),descriptors=[];
  for(let i=0;i<lines.length;i++){
    const header=/^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i]);if(!header)continue;
    let end=i+1;while(end<lines.length&&!/^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* End Patch$/.test(lines[end]))end++;
    const body=lines.slice(i+1,end),move=body.find(line=>line.startsWith('*** Move to: '));descriptors.push({operation:move?'MOVE':header[1].toUpperCase(),path:move?move.slice(13):header[2],previous_path:move?header[2]:null,body});
  }
  if(!descriptors.length){const before=lines.find(l=>l.startsWith('--- '))?.slice(4).split('\t')[0],after=lines.find(l=>l.startsWith('+++ '))?.slice(4).split('\t')[0];if(before&&after){const operation=before==='/dev/null'?'ADD':after==='/dev/null'?'DELETE':'UPDATE';descriptors.push({operation,path:(after==='/dev/null'?before:after).replace(/^[ab]\//,''),previous_path:null,body:lines.slice(lines.findIndex(l=>l.startsWith('+++ '))+1)});}}
  if(!descriptors.length&&lines.some(line=>line.startsWith('@@'))&&artifact.content===undefined)return {operation:artifact.operation,path:artifact.path,previous_path:artifact.previous_path??null,body:null,unresolved:true};
  const matches=descriptors.filter(d=>d.operation===artifact.operation&&d.path===artifact.path&&(d.previous_path??null)===(artifact.previous_path??null));if(matches.length!==1)unresolved('Artifact operation/path is not bound to exactly one captured patch section');return matches[0];
}
function checkPatchImages(descriptor,before,after){
  if(!before||!after||!descriptor.body||!['UPDATE','MOVE'].includes(descriptor.operation))return;
  const split=bytes=>{const lines=bytes.toString('utf8').split('\n');if(lines.at(-1)==='')lines.pop();return lines;},lines=split(before),expected=split(after),hunks=[];let hunk=null;
  for(const line of descriptor.body){if(line.startsWith('@@')){hunk={old:[],next:[]};hunks.push(hunk);}else if(/^[ +\-]/.test(line)){if(!hunk){hunk={old:[],next:[]};hunks.push(hunk);}if(line[0]!=='+' )hunk.old.push(line.slice(1));if(line[0]!=='-')hunk.next.push(line.slice(1));}}
  let cursor=0;for(const item of hunks){if(!item.old.length)unresolved('Insertion patch needs a captured location/context to verify its complete postimage');const positions=[];for(let i=cursor;i<=lines.length-item.old.length;i++)if(item.old.every((line,j)=>lines[i+j]===line))positions.push(i);if(positions.length!==1)unresolved('Patch context does not select one position in the captured preimage');lines.splice(positions[0],item.old.length,...item.next);cursor=positions[0]+item.next.length;}
  if(canonical(lines)!==canonical(expected))unresolved('Patch transformation disagrees with captured complete pre/postimages');
}
function nativeGit(object){
  if(!text(object.repository_id)||!['sha1','sha256'].includes(object.object_format)||typeof object.native_object_base64!=='string')unresolved('Native Git object requires repository, format and bytes');
  const bytes=Buffer.from(object.native_object_base64,'base64');if(bytes.toString('base64')!==object.native_object_base64)unresolved('Git bytes are not canonical base64');
  const zero=bytes.indexOf(0),headerBytes=bytes.subarray(0,Math.max(0,zero));
  if(zero<0||headerBytes.some(byte=>byte>0x7f))unresolved('Git native object header must be byte-exact ASCII');
  const header=/^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(headerBytes.toString('ascii'));
  if(!header||BigInt(header[2])!==BigInt(bytes.length-zero-1))unresolved('Git native object header or byte length differs');
  const oid=createHash(object.object_format).update(bytes).digest('hex');if(oid!==object.oid||object.object_type!==header[1])unresolved('Git native object digest or type differs from the captured identity');
  const body=bytes.subarray(zero+1),length=object.object_format==='sha1'?40:64,parents=[];
  if(header[1]==='commit'){
    const lines=body.toString('utf8').split('\n\n')[0].split('\n');if(!new RegExp('^tree [a-f0-9]{'+length+'}$').test(lines[0]??''))unresolved('Commit tree header has the wrong namespace');
    for(const line of lines.filter(l=>l.startsWith('parent '))){const parent=line.slice(7);if(!new RegExp('^[a-f0-9]{'+length+'}$').test(parent))unresolved('Commit parent has the wrong object format');parents.push(parent);}
  }
  if(header[1]==='tree'){
    let offset=0;while(offset<body.length){const end=body.indexOf(0,offset);if(end<0||! /^(?:[0-7]{5,6}) [^\0/]+$/.test(body.subarray(offset,end).toString('utf8'))||end+1+length/2>body.length)unresolved('Git tree entry is incomplete');offset=end+1+length/2;}
  }
  if(object.parents!==undefined&&canonical(object.parents)!==canonical(parents))unresolved('Reported Git parents differ from native commit bytes');
  return {repository_id:object.repository_id,object_format:object.object_format,oid,object_type:header[1],parents,epistemic:'DIRECT_EVIDENCE'};
}

/** Pure derivation from caller-authenticated captured RAW and public occurrences. */
export function deriveProvenance(capture,selection){
  boundedCapture(capture);selectTemporal([],selection);
  const recordRevisions=capture.records.map(record=>revision('record4-'+digest(record.evidence_ref),[record],'CAPTURED_RECORD_VISIBILITY'));
  const visibleRecords=new Set(selectTemporal(recordRevisions,selection).matches.map(m=>m.revision.revision_id)),records=capture.records.filter((r,i)=>visibleRecords.has(recordRevisions[i].revision_id)).sort((a,b)=>a.recorded_seq-b.recorded_seq||a.session_id.localeCompare(b.session_id)||a.evidence_ref.source_revision_id.localeCompare(b.evidence_ref.source_revision_id)||ordinalCompare(a.evidence_ref.record_ordinal,b.evidence_ref.record_ordinal));
  const occurrenceMatches=new Set(selectTemporal(capture.occurrences.map(o=>o.temporal),selection).matches.map(m=>m.revision.revision_id)),occurrences=capture.occurrences.filter(o=>occurrenceMatches.has(o.temporal.revision_id));
  const byRef=new Map(records.map(r=>[digest(r.evidence_ref),r])),out={artifacts:[],validations:[],relations:[],decisions:[],git_objects:[]},artifactDetails=new Map(),validationDetails=new Map(),gitDetails=new Map(),chains=new Map();
  const occurrenceRecords=occurrence=>{const own=occurrence.temporal.provenance.evidence_refs.map(ref=>byRef.get(digest(ref))).filter(Boolean);for(const record of own){const p=payload(record);if(record.session_id!==occurrence.session_id||['function_call','function_call_output'].includes(p?.type)&&p.call_id!==occurrence.native_id)unresolved('Captured occurrence evidence has a different session or native call identity');}return own;};
  const bound=(record)=>{const p=payload(record),matches=occurrences.filter(o=>o.kind==='execution'&&o.session_id===record.session_id&&o.native_id===p.call_id&&o.temporal.provenance.evidence_refs.some(ref=>digest(ref)===digest(record.evidence_ref)));if(matches.length!==1)unresolved('Tool result is not bound to exactly one acquired occurrence/session/native call');occurrenceRecords(matches[0]);return matches[0];};
  const relation=(type,from,to,from_type,to_type,evidence,grade='EXPLICIT')=>{const id='provrel4-'+digest([type,from,to,unique(evidence.map(r=>r.evidence_ref))]);if(!out.relations.some(r=>r.id===id))out.relations.push({id,type,from_id:from,to_id:to,from_type,to_type,grade,temporal:revision(id,evidence,'PROVENANCE_'+type)});};
  for(const record of records){const data=output(record);if(!data)continue;
    if(data.artifact){
      const a=data.artifact;if(!text(a.artifact_id)||!text(a.path)||!['ADD','UPDATE','MOVE','DELETE'].includes(a.operation))unresolved('Artifact metadata identity/operation is malformed');
      const occurrence=bound(record),own=occurrenceRecords(occurrence),calls=own.filter(r=>payload(r)?.type==='function_call'&&payload(r).call_id===payload(record).call_id&&payload(r).name==='apply_patch');if(calls.length!==1)unresolved('Artifact requires its exact apply_patch call and terminal record');
      const call=calls[0],descriptor=patchDescriptor(payload(call).arguments,a),lineages=occurrence.temporal.provenance.source_independence_ids,key=canonical([record.session_id,a.artifact_id,lineages.length===1?lineages[0]:record.evidence_ref.source_revision_id]),previous=chains.get(key),prior=previous&&previous.record.evidence_ref.source_revision_id===record.evidence_ref.source_revision_id&&BigInt(previous.record.evidence_ref.record_ordinal)<BigInt(record.evidence_ref.record_ordinal)?previous:null;
      let bytes=null;if(a.operation!=='DELETE'&&typeof a.content==='string')bytes=Buffer.from(a.content,'utf8');
      if(a.operation==='DELETE'&&a.content!==undefined)unresolved('Deleted artifact cannot declare a postimage');
      if(bytes&&a.content_sha256!==undefined&&a.content_sha256!==sha(bytes))unresolved('Captured artifact postimage hash differs from its bytes');
      if(bytes&&descriptor.operation==='ADD'&&descriptor.body){const plus=descriptor.body.filter(line=>line.startsWith('+')).map(line=>line.slice(1)).join('\n')+'\n';if(plus!==a.content)unresolved('ADD patch differs from its complete captured postimage');}
      if(a.operation==='MOVE'&&prior&&prior.artifact.path!==a.previous_path)unresolved('MOVE predecessor does not own the prior path');
      if(prior&&['UPDATE','DELETE'].includes(a.operation)&&prior.artifact.path!==a.path)unresolved('Artifact predecessor does not own the affected path');
      if(prior&&a.before_sha256!==undefined&&a.before_sha256!==prior.artifact.content_sha256)unresolved('Reported preimage differs from the captured predecessor');
      checkPatchImages(descriptor,prior?.bytes,bytes);
      const refs=unique([call.evidence_ref,record.evidence_ref]),id='artifact4-'+digest([a.artifact_id,a.operation,a.path,occurrence.id,refs]),artifact={id,artifact_id:a.artifact_id,operation:a.operation,path:a.path,previous_path:a.previous_path??null,before_sha256:prior?.artifact.content_sha256??null,content_sha256:bytes?sha(bytes):null,predecessor_id:prior?.artifact.id??null,producer_occurrence_id:occurrence.id,patch_ref:call.evidence_ref,status:!descriptor.unresolved&&occurrence.outcome==='OBSERVED_PASS'&&(a.operation==='DELETE'||bytes)?'OBSERVED':'UNKNOWN',disposition:'RETAINED',evidence_refs:refs};
      out.artifacts.push(artifact);const detail={artifact,record,call,occurrence,bytes};artifactDetails.set(id,detail);chains.set(key,detail);
    }
    if(data.validation){const v=data.validation,occurrence=bound(record);if(!['PASS','FAIL','UNKNOWN'].includes(v.result)||!(v.target_revision==null||text(v.target_revision))||!(v.target_sha256==null||/^[a-f0-9]{64}$/.test(v.target_sha256))||!(v.criterion==null||text(v.criterion)))unresolved('Validation metadata is malformed');
      const actual=v.result==='PASS'&&occurrence.outcome!=='OBSERVED_PASS'||v.result==='FAIL'&&occurrence.outcome!=='OBSERVED_FAIL'?'UNKNOWN':v.result,id='validation4-'+digest([occurrence.id,record.evidence_ref,v]),validation={id,target_revision:v.target_revision??null,target_sha256:v.target_sha256??null,criterion:v.criterion??null,result:actual,occurrence_id:occurrence.id,criterion_state:'UNRESOLVED',evidence_refs:unique([record.evidence_ref,...occurrenceRecords(occurrence).filter(r=>payload(r)?.type==='function_call').map(r=>r.evidence_ref)])};out.validations.push(validation);validationDetails.set(id,{record,occurrence});
    }
    if(data.git_object){bound(record);const object=nativeGit(data.git_object),id='git4-'+digest([object.repository_id,object.object_format,object.oid]),existing=out.git_objects.find(o=>o.id===id);if(existing){if(canonical({...existing,evidence_refs:[]})!==canonical({id,...object,evidence_refs:[]}))unresolved('Same Git identity has conflicting content');existing.evidence_refs=unique([...existing.evidence_refs,record.evidence_ref]);gitDetails.get(id).push(record);}else{out.git_objects.push({id,...object,evidence_refs:[record.evidence_ref]});gitDetails.set(id,[record]);}}
    if(data.git_report){bound(record);const report=data.git_report;if(!text(report.repository_id)||!['sha1','sha256'].includes(report.object_format))unresolved('Git report namespace is malformed');const id='gitreport4-'+digest([report,record.evidence_ref]);out.git_objects.push({id,repository_id:report.repository_id,object_format:report.object_format,oid:null,object_type:'unknown',parents:[],epistemic:'UNCERTAIN',evidence_refs:[record.evidence_ref]});gitDetails.set(id,[record]);}
  }
  for(const record of records){const message=human(record);if(!message||!message.value||typeof message.value!=='object')continue;const value=message.value;
    if(value.operation==='DISCARD'&&value.disposition==='DISCARD'&&text(value.artifact_id)&&text(message.event_id)){
      const candidates=out.artifacts.filter(a=>a.artifact_id===value.artifact_id).map(a=>artifactDetails.get(a.id)).filter(d=>d.record.session_id===record.session_id&&d.record.evidence_ref.source_revision_id===record.evidence_ref.source_revision_id&&BigInt(d.record.evidence_ref.record_ordinal)<BigInt(record.evidence_ref.record_ordinal)).sort((a,b)=>ordinalCompare(b.record.evidence_ref.record_ordinal,a.record.evidence_ref.record_ordinal));
      if(candidates.length){const d=candidates[0];d.artifact.disposition='DISCARD';d.artifact.evidence_refs=unique([...d.artifact.evidence_refs,record.evidence_ref]);relation('DISCARDED',message.event_id,d.artifact.id,'event','artifact',[record,d.call,d.record]);}
    }
    if(text(value.subject_id)&&text(value.decision)){
      const id='decision4-'+digest([value.subject_id,record.evidence_ref]),valid_to=value.valid_to&&typeof value.valid_to==='object'?value.valid_to:unknown(),temporal={...revision(id,[record]),valid_to};if(selectTemporal([temporal],selection).matches.length)out.decisions.push({id,subject_id:value.subject_id,valid_to,revocation_inferred:false,goal_closed:false,evidence_refs:[record.evidence_ref]});
    }
  }
  for(const validation of out.validations){if(validation.result!=='PASS'||!validation.criterion||!validation.target_revision||!validation.target_sha256)continue;const matches=out.artifacts.filter(a=>a.artifact_id===validation.target_revision&&a.content_sha256===validation.target_sha256&&a.status==='OBSERVED');if(matches.length!==1)continue;const a=matches[0],d=artifactDetails.get(a.id),v=validationDetails.get(validation.id);if(d.record.session_id!==v.record.session_id)continue;validation.criterion_state='VERIFIED';relation('VALIDATES',validation.id,a.id,'validation','artifact',[v.record,d.call,d.record]);}
  for(const success of out.validations.filter(v=>v.result==='PASS'&&v.criterion_state==='UNRESOLVED'&&v.target_revision&&v.criterion))for(const failed of out.validations.filter(v=>v.result==='FAIL'&&v.target_revision&&v.criterion===success.criterion)){
    const a=validationDetails.get(success.id),b=validationDetails.get(failed.id);if(a.record.session_id===b.record.session_id)relation('CONTRADICTS',success.id,failed.id,'validation','validation',[a.record,b.record],'DETERMINISTIC_RULE');
  }
  for(const child of out.git_objects.filter(o=>o.epistemic==='DIRECT_EVIDENCE'&&o.object_type==='commit'))for(const parentOid of child.parents){const parent=out.git_objects.find(o=>o.repository_id===child.repository_id&&o.object_format===child.object_format&&o.oid===parentOid&&o.object_type==='commit'&&o.epistemic==='DIRECT_EVIDENCE');if(parent)relation('COMMIT_PARENT',child.id,parent.id,'git_object','git_object',[...gitDetails.get(child.id),...gitDetails.get(parent.id)]);}
  return structuredClone(out);
}

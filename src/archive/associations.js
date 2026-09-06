import {openLedger} from './storage.js';
import {digest,canonical,failure,makeReceipt,response} from './protocol.js';
import {readArchiveEvidence} from './read-evidence.js';

function instantNanoseconds(bound){
  if(bound.kind!=='known')return null;
  const match=/^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(bound.value);if(!match)throw failure('INVALID_REQUEST','Known time must have exact supported precision and timezone');
  const milliseconds=Date.parse(match[1]+match[3]);if(!Number.isSafeInteger(milliseconds))throw failure('INVALID_REQUEST','Known time is invalid');return BigInt(milliseconds)*1000000n+BigInt((match[2]??'').padEnd(9,'0'));
}

export function prepareAssociations(root,request,snapshot,now){
  const db=openLedger(root,true),revisions=[],seen=new Set();
  try{db.exec('BEGIN');for(const change of request.params.changes){
    const from=instantNanoseconds(change.valid_from),to=instantNanoseconds(change.valid_to);if(from!==null&&to!==null&&from>=to)throw failure('INVALID_TEMPORAL_RANGE','Association validity must be a nonempty half-open interval');
    const key=canonical([change.association_id,change.branch_id]);if(seen.has(key))throw failure('INVALID_REQUEST','A batch cannot revise the same association branch twice');seen.add(key);
    if(!db.prepare('SELECT id FROM session_version WHERE id=? AND commit_seq<=? LIMIT 1').get(change.session_id,snapshot.commit_seq))throw failure('EVIDENCE_UNAVAILABLE','Association session is not visible in this archive');
    const priorRow=db.prepare('SELECT data_json FROM association_version WHERE id=? AND branch_id=? AND commit_seq<=? ORDER BY commit_seq DESC LIMIT 1').get(change.association_id,change.branch_id,snapshot.commit_seq),prior=priorRow?JSON.parse(priorRow.data_json):null;
    if((prior?.revision.revision_id??null)!==change.expected_revision_id)throw failure('REVISION_CONFLICT','Association branch does not match expected revision');
    if(prior&&prior.change.session_id!==change.session_id)throw failure('INVALID_REQUEST','An association identity cannot change its subject');
    for(const ref of change.evidence_refs){const read=readArchiveEvidence(root,{...request,operation:'evidence.read',revision_id:snapshot.revision_id,params:{uri:ref.uri,format:'base64',max_bytes:1}});if(canonical(read.receipt.evidence_refs[0])!==canonical(ref))throw failure('INTEGRITY_FAILED','Association evidence fields differ from the captured record');}
    const scope={project_id:change.project_id,session_ids:[change.session_id],group_id:null,association_mode:'observed'},provenance={evidence_refs:change.evidence_refs,epistemic:'DIRECT_EVIDENCE',rule_id:'EXPLICIT_ASSOCIATION_RECORD',rule_version:'1',source_independence_ids:[...new Set(change.evidence_refs.map(r=>r.source_revision_id))],authority_origin:'UNKNOWN',transformation:'LITERAL'};
    const payload={assertion_id:change.association_id,subject_id:change.session_id,branch_id:change.branch_id,revision_no:(prior?.revision.revision_no??0)+1,recorded_seq:snapshot.commit_seq+1,recorded_at:now,supersedes_revision_id:prior?.revision.revision_id??null,valid_from:change.valid_from,valid_to:change.valid_to,provenance,scope};
    revisions.push({change,revision:{...payload,revision_id:'assoc4-'+digest({change,payload})}});
  }db.exec('COMMIT');}finally{db.close();}return revisions;
}
export function resolveScope(root,request,snapshot){
  const {active_context:active,explicit_scope:explicit}=request.params;
  if(explicit){const warnings=active.project_id&&active.project_id!==explicit.project_id?['EXPLICIT_SCOPE_OVERRIDE: explicit project overrides active project']:[];return response(request,{candidates:[explicit],effective_scope:explicit,resolution:'EXPLICIT'},makeReceipt(snapshot,{scope:explicit,warnings}));}
  if(active.project_id){const scope={project_id:active.project_id,session_ids:active.session_id?[active.session_id]:[],group_id:null,association_mode:'observed'};return response(request,{candidates:[scope],effective_scope:scope,resolution:'OBSERVED'},makeReceipt(snapshot,{scope}));}
  const db=openLedger(root,true);let visible;
  try{db.exec('BEGIN');visible=db.prepare('SELECT data_json FROM association_version a WHERE commit_seq<=? AND commit_seq=(SELECT max(b.commit_seq) FROM association_version b WHERE b.id=a.id AND b.branch_id=a.branch_id AND b.commit_seq<=?) ORDER BY id,branch_id').all(snapshot.commit_seq,snapshot.commit_seq).map(row=>JSON.parse(row.data_json));db.exec('COMMIT');}finally{db.close();}
  const observed=visible.filter(({change})=>(active.session_id&&change.session_id===active.session_id)||(active.workspace&&change.workspace?.path===active.workspace)||(active.checkout&&change.checkout?.id===active.checkout));
  const projects=new Map();for(const {change}of observed){const key=canonical([change.project_id,change.association_state]);if(!projects.has(key))projects.set(key,{project_id:change.project_id,session_ids:[],group_id:null,association_mode:'observed'});const scope=projects.get(key);if(!scope.session_ids.includes(change.session_id))scope.session_ids.push(change.session_id);}
  const candidates=[...projects.values()];if(candidates.some(scope=>scope.session_ids.length>256))throw failure('LIMIT_EXCEEDED','Observed scope exceeds the explicit session limit');const effective=candidates.length===1?candidates[0]:null;return response(request,{candidates,effective_scope:effective,resolution:effective?'OBSERVED':'AMBIGUOUS'},makeReceipt(snapshot,{scope:effective,warnings:effective?[]:['Scope does not resolve to a unique observed association']}));
}

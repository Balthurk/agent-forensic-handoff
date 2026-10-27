import {openLedger,openSnapshot,revisionManifest,sourceManifest,readObject} from './storage.js';
import {makeReceipt,response,failure,digest,canonical} from './protocol.js';
import {occurrenceTables,emptyOccurrenceState,prepareOccurrenceFacts} from './occurrences.js';
import {verifyPublishedArchive} from './verify.js';
import {selectTemporal} from './temporal.js';
import {traverseArchiveGraph} from '../graph.js';

function requireOccurrenceProjection(root,snapshot){
  // Availability belongs to the requested published cut, even after a later
  // writer adds the physical tables to an older archive.
  const seen=new Set();let revision=snapshot;
  while(revision){
    if(seen.has(revision.revision_id))throw failure('INTEGRITY_FAILED','Occurrence history contains a cycle');
    seen.add(revision.revision_id);
    if(revision.ledger_changes.occurrence_facts_sha256)return;
    revision=revision.parent_revision_id?revisionManifest(root,revision.parent_revision_id):null;
  }
  throw failure('NOT_IMPLEMENTED','Occurrence projection is not available at this revision',{format:'PRE_OCCURRENCE_EXTENSION',revision_id:snapshot.revision_id,commit_seq:snapshot.commit_seq});
}

export function acquiredSourceHistory(root,snapshot){
  const chain=[],seen=new Set();let value=snapshot;
  while(value){if(seen.has(value.revision_id))throw failure('INTEGRITY_FAILED','Acquisition history contains a cycle');seen.add(value.revision_id);chain.push(value);value=value.parent_revision_id?revisionManifest(root,value.parent_revision_id):null;}
  const sources=new Map();
  for(const revision of chain.reverse())for(const id of revision.ledger_changes.sources??revision.source_manifest_ids)if(!sources.has(id))sources.set(id,sourceManifest(root,id));
  return [...sources.values()];
}

export function readOccurrenceGroups(root,{scope,time}){
  if(scope.project_id||scope.group_id||Object.entries(time).some(([key,value])=>key!=='include_uncertain'&&value!==null))throw failure('NOT_IMPLEMENTED','Historical and association grouping is not implemented');
  const snapshot=openSnapshot(root);verifyPublishedArchive(root,snapshot,{deep:false});requireOccurrenceProjection(root,snapshot);const db=openLedger(root,true);
  try{
    db.exec('BEGIN');
    const activeOccurrences=activeOccurrenceIds(db,snapshot.commit_seq);
    const rows=db.prepare(`SELECT * FROM (WITH current AS (
      SELECT data_json FROM occurrence_version a WHERE commit_seq<=? AND commit_seq=(SELECT max(b.commit_seq) FROM occurrence_version b WHERE b.id=a.id AND b.commit_seq<=?)
    ) SELECT json_group_array(json(data_json)) AS occurrences FROM current
      WHERE json_extract(data_json,'$.id') IN (SELECT value FROM json_each(?)) AND json_extract(data_json,'$.kind')='execution' AND (?='[]' OR json_extract(data_json,'$.session_id') IN (SELECT value FROM json_each(?)))
      GROUP BY coalesce(json_extract(data_json,'$.command'),json_extract(data_json,'$.id')),json_extract(data_json,'$.cwd'))`).all(snapshot.commit_seq,snapshot.commit_seq,JSON.stringify(activeOccurrences),JSON.stringify(scope.session_ids),JSON.stringify(scope.session_ids));
    const groups=rows.map(row=>{
      const values=JSON.parse(row.occurrences),sequences=new Map();
      for(const occurrence of values){
        const refs=occurrence.temporal.provenance.evidence_refs,lineages=occurrence.temporal.provenance.source_independence_ids;
        // Record order is comparable only within one acquired source and clock.
        // Independent sources never inherit a total order from their capture time.
        const key=lineages.length===1?JSON.stringify([lineages[0],occurrence.clock_domain]):occurrence.id;
        const ordinal=Math.max(...refs.map(ref=>ref.record_ordinal)),previous=sequences.get(key);
        if(!previous||ordinal>previous.ordinal)sequences.set(key,{ordinal,values:[occurrence]});
        else if(ordinal===previous.ordinal)previous.values.push(occurrence);
      }
      const candidates=[...sequences.values()].flatMap(value=>value.values);
      return {command:values[0].command,attempts:values.length,terminal_status:candidates.length===1?candidates[0].lifecycle:'UNKNOWN',terminal_candidates:candidates.map(value=>value.id)};
    });
    db.exec('COMMIT');return groups;
  }finally{db.close();}
}

export function insertOccurrenceFacts(db,facts,expectedDigest){
  if(digest(facts)!==expectedDigest)throw failure('INTEGRITY_FAILED','Staged occurrence facts differ from their commitment');
  for(const table of occurrenceTables){const insert=db.prepare('INSERT INTO '+table+' VALUES(?,?,?)');for(const row of facts[table])insert.run(row.id,row.commit_seq,JSON.stringify(row.data_json));}
}
export function verifyCommittedOccurrenceFacts(db,facts,seq,expectedDigest){
  if(digest(facts)!==expectedDigest)throw failure('INTEGRITY_FAILED','Occurrence recovery commitment differs');
  const present=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
  for(const table of occurrenceTables){
    if(!present.has(table))throw failure('INTEGRITY_FAILED','Committed occurrence table is missing during recovery');
    const expected=new Map(facts[table].map(row=>[row.id,row]));let count=0;
    for(const row of db.prepare('SELECT * FROM '+table+' WHERE commit_seq=?').iterate(seq)){
      let data;try{data=JSON.parse(row.data_json);}catch{throw failure('INTEGRITY_FAILED','Committed occurrence JSON is malformed');}
      if(canonical({...row,data_json:data})!==canonical(expected.get(row.id)??null))throw failure('INTEGRITY_FAILED','Committed occurrence fact differs during recovery');count++;
    }
    if(count!==expected.size)throw failure('INTEGRITY_FAILED','Committed occurrence facts are missing during recovery');
  }
}
export function publishedOccurrenceState(root,snapshot){
  const db=openLedger(root,true);
  try{db.exec('BEGIN');const present=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name)),state=emptyOccurrenceState();for(const table of occurrenceTables)if(present.has(table))for(const value of latest(db,table,snapshot.commit_seq))state[table].set(value.id,value);db.exec('COMMIT');return {state,present:present.has('occurrence_version')};}finally{db.close();}
}
function latest(db,table,seq){return db.prepare('SELECT data_json FROM '+table+' a WHERE commit_seq<=? AND commit_seq=(SELECT max(b.commit_seq) FROM '+table+' b WHERE b.id=a.id AND b.commit_seq<=?) ORDER BY id').all(seq,seq).map(row=>JSON.parse(row.data_json));}
function visibleIdentityBindings(rows,cut){
  const byId=new Map();for(const row of rows){if(row.commit_seq>cut)continue;const old=byId.get(row.id);if(old&&canonical(old)!==canonical(row))throw failure('INTEGRITY_FAILED','Conflicting identity binding ID');byId.set(row.id,row);}
  const replaced=new Set();for(const row of byId.values())if(row.supersedes_binding_id){
    const prior=byId.get(row.supersedes_binding_id);if(!prior||prior.namespace!==row.namespace||prior.acquired_alias!==row.acquired_alias||prior.commit_seq>=row.commit_seq||!row.equivalence_proof_refs?.length||row.equivalence_proof_refs.some(ref=>!/^afh:\/\/evidence\/sha256\/[a-f0-9]{64}\/record\/[0-9]+(?:\?source=src4-[a-f0-9]{64})?#bytes=[0-9]+:[0-9]+$/.test(ref)))throw failure('INTEGRITY_FAILED','Identity replacement lacks a valid earlier binding or proof reference');
    const visited=new Set([row.id]);let current=prior;while(current){if(visited.has(current.id))throw failure('INTEGRITY_FAILED','Identity replacement cycle');visited.add(current.id);current=byId.get(current.supersedes_binding_id);}replaced.add(prior.id);
  }
  return [...byId.values()].filter(row=>!replaced.has(row.id));
}
export function resolveIdentityAtCut(query,canonicalIds,bindings,cut){
  const active=visibleIdentityBindings(bindings,cut),targets=new Set(canonicalIds.includes(query)?[query]:[]);for(const b of active)if(b.namespace==='ACQUIRED_ANCHOR'&&b.acquired_alias===query)targets.add(b.canonical_target);
  if(targets.size>1)throw failure('AMBIGUOUS_IDENTITY','Canonical and acquired identities select different targets');if(!targets.size)throw failure('EVIDENCE_UNAVAILABLE','Identity is not visible at this cut');return [...targets][0];
}
function activeOccurrenceIds(db,cut){
  const activeEvents=new Set(visibleIdentityBindings(latest(db,'identity_binding',cut),cut).map(b=>b.canonical_target));
  return [...new Set(latest(db,'event_version',cut).filter(e=>activeEvents.has(e.id)).map(e=>e.occurrence_id))];
}
function identityRowsForQuery(db,query,cut){
  const candidate=db.prepare("SELECT data_json FROM identity_binding WHERE commit_seq<=? AND (json_extract(data_json,'$.acquired_alias')=? OR json_extract(data_json,'$.canonical_target')=?)").all(cut,query,query).map(r=>JSON.parse(r.data_json)),aliases=[...new Set(candidate.map(b=>b.acquired_alias))];
  return aliases.length?db.prepare("SELECT data_json FROM identity_binding WHERE json_extract(data_json,'$.namespace')='ACQUIRED_ANCHOR' AND json_extract(data_json,'$.acquired_alias') IN (SELECT value FROM json_each(?)) AND commit_seq<=?").all(JSON.stringify(aliases),cut).map(r=>JSON.parse(r.data_json)):[];
}
function proveIdentityBindings(root,db,bindings,snapshot){
  const sources=new Map(),derived=new Map();
  const source=(id,cut=snapshot.commit_seq)=>{if(!db.prepare('SELECT id FROM source_revision WHERE id=? AND commit_seq<=?').get(id,cut))throw failure('INTEGRITY_FAILED','Identity proof source is not visible at the binding cut');if(!sources.has(id))try{sources.set(id,sourceManifest(root,id));}catch{throw failure('INTEGRITY_FAILED','Identity proof manifest unavailable');}return sources.get(id);};
  const facts=s=>{if(!derived.has(s.source_revision_id))try{derived.set(s.source_revision_id,prepareOccurrenceFacts([s],snapshot.commit_seq,snapshot.recorded_at,root).facts);}catch(error){throw failure(error.code==='EVIDENCE_UNAVAILABLE'?'EVIDENCE_UNAVAILABLE':'INTEGRITY_FAILED','Identity proof cannot be reproduced from RAW');}return derived.get(s.source_revision_id);};
  for(const binding of bindings){
    const {id,...value}=binding;if(id!=='bind4-'+digest(value)||binding.rule_id!=='afh-identity03'||binding.rule_version!=='afh-identity03-v1'||binding.decoder_version!=='1')throw failure('INTEGRITY_FAILED','Identity binding recipe/version differs');
    const s=source(binding.locator.source_revision_id),f=facts(s),expected=f.identity_binding.find(row=>row.data_json.acquired_alias===binding.acquired_alias&&row.data_json.representation_id===binding.representation_id)?.data_json;
    if(!expected||canonical(expected.locator)!==canonical(binding.locator)||expected.acquisition_json_pointer!==binding.acquisition_json_pointer||expected.decoder_id!==binding.decoder_id)throw failure('INTEGRITY_FAILED','Identity locator differs from its RAW producer');
    if(!binding.supersedes_binding_id){if(expected.canonical_target!==binding.canonical_target)throw failure('INTEGRITY_FAILED','Identity target differs without an explicit replacement');continue;}
    // Every replacement needs its own proof, including a new representation
    // whose canonical target could otherwise be derived without that proof.
    const priorRow=db.prepare('SELECT data_json FROM identity_binding WHERE id=? AND commit_seq<? ORDER BY commit_seq DESC LIMIT 1').get(binding.supersedes_binding_id,binding.commit_seq);if(!priorRow)throw failure('INTEGRITY_FAILED','Identity replacement predecessor is absent');
    const prior=JSON.parse(priorRow.data_json),old=source(prior.locator.source_revision_id,binding.commit_seq),oldRecord=old.records.find(r=>r.ordinal===binding.locator.record_ordinal&&r.sha256===binding.locator.record_sha256);
    if(!old.provisional||!oldRecord||old.source_lineage_id!==s.source_lineage_id||!facts(old).identity_binding.some(row=>row.data_json.acquired_alias===binding.acquired_alias&&row.data_json.canonical_target===prior.canonical_target))throw failure('INTEGRITY_FAILED','Identity predecessor does not prove the provisional act');
    if(!binding.equivalence_proof_refs.length)throw failure('INTEGRITY_FAILED','Identity replacement has no RAW proof');
    for(const ref of binding.equivalence_proof_refs){
      const url=new URL(ref),id=url.searchParams.get('source');if(!id)throw failure('INTEGRITY_FAILED','Identity equivalence proof requires its acquired source');
      const newer=source(id,binding.commit_seq),record=newer.records.find(r=>r.evidence_ref.uri===ref);
      if(!record||newer.provisional||newer.source_lineage_id!==old.source_lineage_id||record.ordinal!==oldRecord.ordinal||record.sha256!==oldRecord.sha256||record.identity_epoch!==oldRecord.identity_epoch||!facts(newer).identity_binding.some(row=>row.data_json.acquired_alias===binding.acquired_alias&&row.data_json.canonical_target===binding.canonical_target))throw failure('INTEGRITY_FAILED','Identity replacement RAW is absent or does not prove the same confirmed act');
    }
  }
}
export function showArchiveEvent(root,request,snapshot){
  requireOccurrenceProjection(root,snapshot);
  const db=openLedger(root,true);try{db.exec('BEGIN');const bindings=identityRowsForQuery(db,request.params.event_id,snapshot.commit_seq),active=visibleIdentityBindings(bindings,snapshot.commit_seq),canonicalIds=[...new Set(active.map(b=>b.canonical_target))],resolved=resolveIdentityAtCut(request.params.event_id,canonicalIds,bindings,snapshot.commit_seq);proveIdentityBindings(root,db,active.filter(b=>b.canonical_target===resolved),snapshot);const row=db.prepare('SELECT data_json FROM event_version WHERE id=? AND commit_seq<=? ORDER BY commit_seq DESC LIMIT 1').get(resolved,snapshot.commit_seq);if(!row)throw failure('EVIDENCE_UNAVAILABLE','Event is not visible in this revision');const event=JSON.parse(row.data_json),occRow=db.prepare('SELECT data_json FROM occurrence_version WHERE id=? AND commit_seq<=? ORDER BY commit_seq DESC LIMIT 1').get(event.occurrence_id,snapshot.commit_seq);if(!occRow)throw failure('INTEGRITY_FAILED','Visible event has no occurrence');const occurrence=JSON.parse(occRow.data_json),representations=request.params.include_representations?latest(db,'representation',snapshot.commit_seq).filter(rep=>rep.event_id===event.id):[],relations=latest(db,'relation_version',snapshot.commit_seq).filter(r=>r.from_id===event.id||r.to_id===event.id);
    for(const payload of occurrence.payloads){const object=db.prepare('SELECT data_json FROM content_object WHERE id=? AND commit_seq<=? ORDER BY commit_seq DESC LIMIT 1').get(payload.content_sha256,snapshot.commit_seq);if(!object)throw failure('INTEGRITY_FAILED','Payload object is not committed');readObject(root,JSON.parse(object.data_json).object);}
    db.exec('COMMIT');return response(request,{event,occurrence,representations,relations,evidence_refs:event.evidence_refs},makeReceipt(snapshot,{evidence_refs:event.evidence_refs,scope:event.temporal.scope}));}finally{db.close();}
}
// The selector validates RFC3339 and preserves nanosecond comparisons. This
// conversion is only used after that validation, never for lexical date sorting.
function statsInstant(value){
  const match=/^(.*[Tt]\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match)throw failure('INTEGRITY_FAILED','Persisted statistics clock is invalid');
  return BigInt(Date.parse(match[1]+match[3]))*1000000n+BigInt((match[2]??'').padEnd(9,'0'));
}
function statsIso(value){
  const seconds=value>=0n?value/1000000000n:(value-999999999n)/1000000000n;
  return new Date(Number(seconds*1000n)).toISOString().replace('.000Z','.'+String(value-seconds*1000000000n).padStart(9,'0')+'Z');
}
function statsTemporal(revisions,selection,time){
  const checked=selectTemporal(revisions,selection);
  if(time.from===null&&time.to===null)return checked.matches;
  const from=time.from===null?null:statsInstant(time.from),to=time.to===null?null:statsInstant(time.to);
  if(from!==null&&to!==null&&from===to)return [];
  if(time.valid_at!==null){const point=statsInstant(time.valid_at);if(from!==null&&point<from||to!==null&&point>=to)return [];return checked.matches;}
  // Choose a point inside each last-known interval, then let the same selector
  // validate/select its whole lineage. Never fall back to a superseded version.
  const groups=new Map(),known=statsInstant(selection.known_at);
  for(const revision of revisions){const key=canonical([revision.assertion_id,revision.branch_id]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(revision);}
  const matches=[];
  for(const group of groups.values()){
    const latest=group.filter(r=>r.recorded_seq<=selection.published_seq&&statsInstant(r.recorded_at)<=known).sort((a,b)=>b.recorded_seq-a.recorded_seq)[0];if(!latest)continue;
    const start=latest.valid_from.kind==='known'?statsInstant(latest.valid_from.value):null,end=latest.valid_to.kind==='known'?statsInstant(latest.valid_to.value):null;
    if(to!==null&&start!==null&&start>=to||from!==null&&end!==null&&end<=from)continue;
    const point=from!==null?(start!==null&&start>from?start:from):start??(end!==null?end-1n:to!==null?to-1n:statsInstant(selection.valid_at));
    matches.push(...selectTemporal(group,{...selection,valid_at:statsIso(point)}).matches);
  }
  return matches;
}
export function archiveStats(root,request,snapshot){
  const {scope,time,metric}=request.params;if(scope.group_id)throw failure('NOT_IMPLEMENTED','Group membership statistics require their owning capability');
  if(['latency','effects'].includes(metric))throw failure('NOT_IMPLEMENTED','This metric requires its later owning capability');
  const groupBy=request.params.group_by??[],fields={session:'session_id',command:'command',workspace:'cwd'};
  if(groupBy.some(name=>!Object.hasOwn(fields,name)))throw failure('NOT_IMPLEMENTED','Historical and project grouping require their owning capability');
  requireOccurrenceProjection(root,snapshot);
  const db=openLedger(root,true);
  try{
    db.exec('BEGIN');
    const selection={published_seq:snapshot.commit_seq,known_at:time.known_at??snapshot.recorded_at,valid_at:time.valid_at??snapshot.recorded_at,include_uncertain:time.include_uncertain};
    selectTemporal([],selection);
    for(const value of [time.from,time.to])if(value!==null)selectTemporal([],{...selection,valid_at:value});
    if(time.from!==null&&time.to!==null&&statsInstant(time.from)>statsInstant(time.to))throw failure('INVALID_TEMPORAL_RANGE','Statistics range is reversed');
    const known=statsInstant(selection.known_at),commits=db.prepare('SELECT seq,recorded_at FROM archive_commit WHERE seq<=? ORDER BY seq').all(snapshot.commit_seq);
    const cut=commits.filter(row=>statsInstant(row.recorded_at)<=known).at(-1)?.seq??0;
    const versions=db.prepare('SELECT data_json FROM occurrence_version WHERE commit_seq<=? ORDER BY commit_seq,id').all(cut).map(row=>JSON.parse(row.data_json));
    const matches=statsTemporal(versions.map(row=>row.temporal),{...selection,published_seq:cut},time),selectedRevisions=new Set(matches.map(row=>row.revision.revision_id));
    let sessions=scope.session_ids;
    const uncertainSessions=new Set();
    if(scope.project_id){
      const associations=db.prepare('SELECT data_json FROM association_version WHERE commit_seq<=? ORDER BY commit_seq,id,branch_id').all(cut).map(row=>JSON.parse(row.data_json));
      const visible=statsTemporal(associations.map(row=>row.revision),{...selection,published_seq:cut},time).filter(row=>row.revision.scope.project_id===scope.project_id);
      sessions=[...new Set(visible.flatMap(row=>row.revision.scope.session_ids))].filter(id=>!scope.session_ids.length||scope.session_ids.includes(id));
      for(const row of visible)if(row.match==='UNKNOWN')for(const id of row.revision.scope.session_ids)uncertainSessions.add(id);
    }
    const active=new Set(activeOccurrenceIds(db,cut)),selected=versions.filter(row=>selectedRevisions.has(row.temporal.revision_id)&&active.has(row.id)&&(!scope.project_id&&!sessions.length||sessions.includes(row.session_id)));
    const activeOccurrences=selected.map(row=>row.id),uncertainRevisions=new Set(matches.filter(row=>row.match==='UNKNOWN').map(row=>row.revision.revision_id)),uncertain=selected.filter(row=>uncertainRevisions.has(row.temporal.revision_id)||uncertainSessions.has(row.session_id)).map(row=>row.id);
    const base=`WITH current AS (SELECT id,data_json FROM occurrence_version a WHERE commit_seq<=? AND commit_seq=(SELECT max(b.commit_seq) FROM occurrence_version b WHERE b.id=a.id AND b.commit_seq<=?)),
      scoped AS (SELECT * FROM current WHERE id IN (SELECT value FROM json_each(?)) AND (?='[]' OR json_extract(data_json,'$.session_id') IN (SELECT value FROM json_each(?))))`;
    const parameters=[cut,cut,JSON.stringify(activeOccurrences),JSON.stringify(scope.session_ids),JSON.stringify(scope.session_ids)];
    const aggregate=(where='',values=[])=>db.prepare('SELECT * FROM ('+base+`, selected AS (SELECT * FROM scoped ${where}),
      reps AS (SELECT data_json FROM representation a WHERE commit_seq<=? AND commit_seq=(SELECT max(b.commit_seq) FROM representation b WHERE b.id=a.id AND b.commit_seq<=?) AND json_extract(data_json,'$.occurrence_id') IN (SELECT id FROM selected))
      SELECT count(*) AS occurrences,
        coalesce(sum(json_extract(data_json,'$.kind')='execution'),0) AS executions,
        coalesce(sum(json_extract(data_json,'$.kind') LIKE 'message.%'),0) AS mentions,
        coalesce(sum(json_extract(data_json,'$.lifecycle')='FAILED'),0) AS failures,
        coalesce(sum(json_extract(data_json,'$.lifecycle')='INCOMPLETE'),0) AS incomplete,
        coalesce(sum(json_extract(data_json,'$.lifecycle')='BLOCKED'),0) AS blocked,
        coalesce(sum((json_extract(data_json,'$.kind')='execution' AND json_extract(data_json,'$.lifecycle')='UNKNOWN') OR id IN (SELECT value FROM json_each(?))),0) AS unknowns,
        coalesce(sum(json_extract(data_json,'$.kind')='execution' AND json_extract(data_json,'$.lifecycle')='UNKNOWN'),0) AS lifecycle_unknowns,
        coalesce(sum(json_extract(data_json,'$.duration_ns') IS NOT NULL),0) AS durations,
        (SELECT count(DISTINCT json_array(json_extract(b.data_json,'$.locator.source_lineage_id'),json_extract(b.data_json,'$.locator.record_identity_epoch'),json_extract(b.data_json,'$.locator.record_ordinal'),json_extract(b.data_json,'$.locator.json_pointer'),json_extract(b.data_json,'$.locator.event_subindex'),json_extract(b.data_json,'$.locator.record_sha256'))) FROM reps r JOIN identity_binding b ON json_extract(b.data_json,'$.representation_id')=json_extract(r.data_json,'$.id') WHERE b.commit_seq<=?) AS representations,
        (SELECT count(DISTINCT value) FROM selected,json_each(selected.data_json,'$.temporal.provenance.source_independence_ids')) AS independent_sources
      FROM selected)`).get(...parameters,...values,cut,cut,JSON.stringify(uncertain),cut);
    const totalsFor=counts=>({metric,observed_count:counts[metric],unknown_count:['failures','incomplete','blocked'].includes(metric)?counts.lifecycle_unknowns:0,value:counts[metric],unit:'count',sample_count:counts[metric],p50:null,p95:null});
    const counts=aggregate(),totals=totalsFor(counts),rows=[];
    if(groupBy.length){
      const columns=groupBy.map(name=>"nullif(json_extract(data_json,'$."+fields[name]+"'),'') AS "+name);
      const groups=db.prepare('SELECT * FROM ('+base+' SELECT DISTINCT '+columns.join(',')+' FROM scoped ORDER BY '+groupBy.join(',')+')').all(...parameters);
      for(const group of groups){const where='WHERE '+groupBy.map(name=>"nullif(json_extract(data_json,'$."+fields[name]+"'),'') IS ?").join(' AND ');rows.push({group:{...group},totals:totalsFor(aggregate(where,groupBy.map(name=>group[name])))});}
    }
    db.exec('COMMIT');return response(request,{rows,totals,denominators:{occurrences:counts.occurrences,representations:counts.representations,sources:counts.independent_sources,independent_sources:counts.independent_sources,comparable_durations:counts.durations},unknowns:counts.unknowns,exact_within_observed_scope:true,independence_definition:'Distinct acquired source lineages; repeated encodings within a lineage are not independent'},makeReceipt(snapshot,{scope,time:{...time,known_at:selection.known_at,valid_at:time.valid_at??(time.from===null&&time.to===null?selection.valid_at:null)},warnings:uncertain.length?['TEMPORAL_UNKNOWN: '+uncertain.length+' selected occurrences have uncertain validity or membership; counts include them only because include_uncertain=true']:[]}));
  }finally{db.close();}
}

export function archiveGraphNeighbors(root,request,snapshot){
  const {scope,time}=request.params;
  if(scope.group_id)throw failure('NOT_IMPLEMENTED','Group membership graph requires its owning capability');
  requireOccurrenceProjection(root,snapshot);
  const db=openLedger(root,true);
  try{
    db.exec('BEGIN');
    const selection={published_seq:snapshot.commit_seq,known_at:time.known_at??snapshot.recorded_at,valid_at:time.valid_at??snapshot.recorded_at,include_uncertain:time.include_uncertain};selectTemporal([],selection);
    for(const value of [time.from,time.to])if(value!==null)selectTemporal([],{...selection,valid_at:value});
    if(time.from!==null&&time.to!==null&&statsInstant(time.from)>statsInstant(time.to))throw failure('INVALID_TEMPORAL_RANGE','Graph range is reversed');
    const known=statsInstant(selection.known_at),commits=db.prepare('SELECT seq,recorded_at FROM archive_commit WHERE seq<=? ORDER BY seq').all(snapshot.commit_seq),cut=commits.filter(row=>statsInstant(row.recorded_at)<=known).at(-1)?.seq??0;
    let graphRevision=snapshot,graphAvailable=false;
    while(graphRevision){if(graphRevision.commit_seq<=cut&&graphRevision.ledger_changes.occurrence_graph_version===1){graphAvailable=true;break;}graphRevision=graphRevision.parent_revision_id?revisionManifest(root,graphRevision.parent_revision_id):null;}
    if(cut>0&&!graphAvailable)throw failure('NOT_IMPLEMENTED','Native graph projection is not available at this historical cut',{format:'PRE_GRAPH_EXTENSION',revision_id:snapshot.revision_id,commit_seq:cut});
    const eventRows=db.prepare('SELECT data_json FROM event_version WHERE commit_seq<=? ORDER BY commit_seq,id').all(cut).map(row=>JSON.parse(row.data_json)),relationRows=db.prepare('SELECT data_json FROM relation_version WHERE commit_seq<=? ORDER BY commit_seq,id').all(cut).map(row=>JSON.parse(row.data_json)),sessionRows=latest(db,'session_version',cut);
    const selectedEvents=new Set(statsTemporal(eventRows.map(row=>row.temporal),{...selection,published_seq:cut},time).map(m=>m.revision.revision_id)),selectedEdges=new Set(statsTemporal(relationRows.map(row=>row.temporal),{...selection,published_seq:cut},time).map(m=>m.revision.revision_id));
    let sessions=scope.session_ids;
    if(scope.project_id){const associations=db.prepare('SELECT data_json FROM association_version WHERE commit_seq<=? ORDER BY commit_seq,id,branch_id').all(cut).map(row=>JSON.parse(row.data_json));sessions=[...new Set(statsTemporal(associations.map(row=>row.revision),{...selection,published_seq:cut},time).filter(m=>m.revision.scope.project_id===scope.project_id).flatMap(m=>m.revision.scope.session_ids))].filter(id=>!scope.session_ids.length||scope.session_ids.includes(id));}
    const inScope=id=>!scope.project_id&&!sessions.length||sessions.includes(id),nodes=[];
    for(const session of sessionRows.filter(s=>inScope(s.id))){
      const source=sourceManifest(root,session.source_revision_id),record=source.records.find(r=>r.events.some(e=>e.kind==='session.meta'));
      if(!record)continue;
      nodes.push({id:session.id,type:'session',revision_id:source.source_revision_id,label:session.native_id,provenance:{evidence_refs:[record.evidence_ref],epistemic:'DIRECT_EVIDENCE',rule_id:'ACQUIRED_SESSION_METADATA',rule_version:'1',source_independence_ids:[source.source_lineage_id],authority_origin:'HARNESS',transformation:'EXTRACTED'}});
    }
    const activeEvents=new Set(visibleIdentityBindings(latest(db,'identity_binding',cut),cut).map(binding=>binding.canonical_target));
    for(const event of eventRows)if(selectedEvents.has(event.temporal.revision_id)&&activeEvents.has(event.id)&&inScope(event.session_id))nodes.push({id:event.id,type:'event',revision_id:event.temporal.revision_id,label:event.kind,provenance:event.temporal.provenance});
    const edges=relationRows.filter(edge=>selectedEdges.has(edge.temporal.revision_id)),data=traverseArchiveGraph(nodes,edges,request.params);
    db.exec('COMMIT');return response(request,data,makeReceipt(snapshot,{scope,time:{...time,known_at:selection.known_at,valid_at:time.valid_at??(time.from===null&&time.to===null?selection.valid_at:null)},evidence_refs:[...new Map([...data.nodes.flatMap(n=>n.provenance.evidence_refs),...data.edges.flatMap(e=>e.temporal.provenance.evidence_refs)].map(ref=>[digest(ref),ref])).values()],warnings:time.include_uncertain?['Temporal UNKNOWN relations/events are included as captured evidence; no exact validity is inferred.']:[]}));
  }finally{db.close();}
}

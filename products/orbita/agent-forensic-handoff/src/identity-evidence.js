import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from './sqlite-compat.js';
import { sha256, stableStringify } from './util.js';
import { decodedLines } from './evidence.js';
import { normalizeRecord } from './adapters.js';
import { conversationText, digestObject, branchScope } from './conversation-format.js';

export const IDENTITY_VERSION='afh.identity-evidence.v1';
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hashId=(prefix,parts)=>prefix+'-'+digestObject(parts);
const jsonFile=(root,relative)=>readJson(safeCasePath(root,relative));

export function safeCasePath(root,relative) {
  if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(s=>!s||s==='.'||s==='..')||relative.includes(':'))throw new Error('Unsafe evidence path');
  const base=fs.realpathSync(root),target=path.resolve(base,relative);
  if(!target.startsWith(base+path.sep))throw new Error('Evidence path escapes case');
  let current=base;
  for(const part of relative.split('/')) {current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw new Error('Evidence symlink is not allowed');}
  return target;
}

export function archiveNativeSources(root,sources) {
  const dir=path.join(root,'acquisition','native');fs.mkdirSync(dir,{recursive:true});
  const entries=[];
  for(const source of sources) {
    const suffix=/\.jsonl\.(gz|zst|zstd)$/i.exec(source.path)?.[1];
    const relative=`acquisition/native/${source.rawSha256}.jsonl${suffix?'.'+suffix:''}`;
    const input=fs.openSync(source.path,'r'),output=fs.openSync(path.join(root,relative),'w');
    const hash=createHash('sha256');let offset=0;
    try {
      const buffer=Buffer.alloc(Math.min(1024*1024,Math.max(1,source.byteLength)));
      while(offset<source.byteLength) {
        const n=fs.readSync(input,buffer,0,Math.min(buffer.length,source.byteLength-offset),offset);
        if(!n)throw new Error('Source shrank during raw acquisition');
        fs.writeSync(output,buffer,0,n);hash.update(buffer.subarray(0,n));offset+=n;
      }
      fs.fsyncSync(output);
    }finally{fs.closeSync(input);fs.closeSync(output);}
    if(hash.digest('hex')!==source.rawSha256)throw new Error('Original bytes changed during archival');
    entries.push({rawSha256:source.rawSha256,path:relative,byteLength:offset,coverage:'EXACT_CAPTURED_PREFIX'});
  }
  fs.writeFileSync(path.join(root,'acquisition/native.json'),JSON.stringify({version:1,entries},null,2)+'\n');
}

export async function verifyNativeSources(root,manifest) {
  const acquisition=jsonFile(root,'acquisition/native.json');
  if(acquisition.version!==1||acquisition.entries.length!==manifest.sources.length)throw new Error('Native acquisition coverage mismatch');
  for(const source of manifest.sources) {
    const matches=acquisition.entries.filter(e=>e.rawSha256===source.rawSha256);
    const entry=matches[0];if(!entry)throw new Error('Native acquisition missing');
    const file=safeCasePath(root,entry.path),hash=createHash('sha256');
    let bytes=0;
    for await(const chunk of fs.createReadStream(file)){hash.update(chunk);bytes+=chunk.length;}
    if(bytes!==source.byteLength||bytes!==entry.byteLength||hash.digest('hex')!==source.rawSha256)throw new Error('Native original hash or length mismatch');
    const canonical=createHash('sha256');
    for await(const row of decodedLines(file,entry.byteLength))canonical.update(row.line+'\n');
    if(canonical.digest('hex')!==source.canonicalSha256)throw new Error('Native original/canonical binding mismatch');
  }
  return {originals:acquisition.entries.length};
}

function dateValue(value) {
  if(value==null)return null;
  const date=new Date(typeof value==='number'?value*1000:value);
  return Number.isNaN(date.valueOf())?null:date.toISOString();
}

function buildIdentity(root) {
  const manifest=jsonFile(root,'case.json'),db=new DatabaseSync(safeCasePath(root,'case.sqlite'),{readOnly:true});
  try {
    const sources=db.prepare('SELECT * FROM source ORDER BY id').all();
    const sessions=new Map(db.prepare('SELECT * FROM session').all().map(s=>[s.id,s]));
    const events=db.prepare(`SELECT e.*,r.json_pointer,r.uri,r.record_sha256,r.byte_offset,r.byte_length
      FROM event e JOIN evidence_ref r ON r.event_id=e.id ORDER BY e.source_id,e.record_ordinal,e.subordinal,e.id`).all();
    const intakePath=path.join(root,'acquisition/intake.json'),sharePath=path.join(root,'acquisition/capture.json');
    const intake=fs.existsSync(intakePath)?jsonFile(root,'acquisition/intake.json'):null;
    const share=fs.existsSync(sharePath)?jsonFile(root,'acquisition/capture.json'):null;
    const run=db.prepare('SELECT started_at,completed_at FROM ingest_run ORDER BY started_at LIMIT 1').get();
    const registeredAt=run.completed_at||manifest.completedAt;
    const sourceMap=new Map();
    for(const source of sources) {
      const bytes=fs.readFileSync(safeCasePath(root,source.evidence_path));
      if(sha256(bytes)!==source.canonical_sha256)throw new Error('Canonical source hash mismatch');
      const lines=bytes.toString('utf8').split('\n');
      const rows=lines.slice(0,-1).map(line=>{try{return JSON.parse(line);}catch{return null;}});
      let scope=null;
      if(source.harness==='chatgpt-share')scope=branchScope(rows.filter(r=>r?.node).map(r=>r.node),rows[0]?.conversation?.current_node);
      sourceMap.set(source.id,{source,rows,scope});
    }
    const representations=events.map(event=>{
      const {source,rows,scope}=sourceMap.get(event.source_id),record=rows[event.record_ordinal],session=sessions.get(event.session_id);
      const message=record?.node?.message;
      const imported=source.harness==='chatgpt-import',shared=source.harness==='chatgpt-share';
      const conversationId=imported?record.conversationId:shared?`chatgpt-share:${share.shareId}`:`${session.harness}:${session.native_id}`;
      const role=message?.author?.role??(event.kind==='document.text'?'document':event.kind==='message.user'?'user':event.kind==='message.agent'?'assistant':event.kind.startsWith('tool.')?'tool':'system');
      const nativeMessage=message?.id??event.native_id;
      const sourceRevision=intake?.sourceHash??share?.rawHtmlSha256??source.raw_sha256;
      const representationId=hashId('rep4',[sourceRevision,record?.member??'',event.record_ordinal,event.json_pointer??'',event.subordinal]);
      const isMessage=Boolean(message)||event.kind.startsWith('message.');
      const isExecution=!message&&(event.kind.startsWith('tool.')||event.kind.startsWith('mcp.')||event.kind==='filesystem.patch');
      const occurrenceKind=isMessage?'message':isExecution?'execution':'context';
      const nativeAct=isMessage?nativeMessage:(event.call_id||nativeMessage);
      // Tool IDs may be reused on different turns. Without native identity, the
      // representation is the only defensible anchor; text is never an ID.
      const epoch=isMessage?'session':`turn:${event.turn_id??'unknown'}`;
      const logicalRole=isMessage?['message',role]:[occurrenceKind,event.actor_id];
      const occurrenceId=hashId('occ4',[conversationId,epoch,nativeAct?stableStringify([...logicalRole,nativeAct]):representationId]);
      const logicalKind=message?'message.'+role:event.kind;
      const eventId=hashId('evt4',[conversationId,epoch,logicalKind,nativeAct??representationId,logicalRole]);
      let text='';
      if(message)text=conversationText(message.content);
      else if(record) {
        const item=Array.isArray(record)?record[Math.floor(event.subordinal/1000)]:record;
        const normalized=normalizeRecord(item,{harness:source.harness,nativeId:session.native_id,sessionNativeId:session.native_id,stateMetadata:{}});
        const n=normalized[event.subordinal%1000];text=n?.output||n?.input||'';
      }
      const branch=imported?record.scope??'context':shared?(record?.node?(scope?.proven?(scope.active.has(record.node.id)?'active':'alternative'):'unknown'):'context'):'native';
      const capturedAt=intake?.capturedAt??share?.capturedAt??run.started_at;
      const emittedAt=dateValue(message?.create_time)??event.observed_at??null;
      return {event_id:eventId,legacy_event_id:event.id,occurrence_id:occurrenceId,representation_id:representationId,
        conversation_id:conversationId,message_id:isMessage?(nativeMessage??null):null,native_id:event.native_id??null,execution_id:isExecution?(nativeAct??null):null,occurrence_kind:occurrenceKind,node_id:record?.node?.id??null,identity_epoch:epoch,
        identity_grade:nativeAct?'NATIVE_SCOPED':'REPRESENTATION_ONLY',source_revision:sourceRevision,
        role,issuer:message?.author?.name??event.actor_id,channel:message?.channel??event.phase??null,kind:event.kind,branch_id:record?.branchId??(shared&&scope?.proven?hashId('branch',[conversationId,rows[0].conversation.current_node]):null),scope:branch,
        emitted_at:emittedAt,captured_at:capturedAt,registered_at:registeredAt,known_at:registeredAt,
        text,text_sha256:sha256(text),payload_sha256:digestObject(message??{kind:event.kind,text,nativeId:event.native_id,status:event.status}),published_status:message?.status??null,
        canonical:Boolean(event.canonical),representation_only:Boolean(record?.representationOnly),identity_conflict:Boolean(record?.identityConflict),
        locator:{canonical_path:source.evidence_path,canonical_sha256:source.canonical_sha256,record_ordinal:event.record_ordinal,record_sha256:event.record_sha256,
          byte_range:{start:event.byte_offset,end:event.byte_offset+event.byte_length,unit:'utf8_bytes',end_exclusive:true},json_pointer:event.json_pointer??'',
          original_member:record?.member??null,source_pointer:record?.pointer??null,source_pointer_space:imported?'decoded-conversation-v1':shared?'decoded-share-v1':'source-record',
          text_range:{start:0,end:[...text].length,unit:'unicode_codepoints',end_exclusive:true},decoder_version:'afh-evidence-text-v1',legacy_uri:event.uri}};
    });
    return {version:IDENTITY_VERSION,caseHash:manifest.caseHash,registeredAt,policy:{defaultScope:['active','native'],unknownIdentity:'do-not-merge',copiesAreCorroboration:false,timestamps:'emitted_at is source time; known_at is local registration; captured_at is acquisition'},representations};
  }finally{db.close();}
}

export async function writeIdentity(root) {
  const identity=buildIdentity(root),bytes=Buffer.from(JSON.stringify(identity,null,2)+'\n');
  fs.writeFileSync(path.join(root,'identity.json'),bytes);
  const manifest=jsonFile(root,'case.json');manifest.identityEvidence={version:IDENTITY_VERSION,path:'identity.json',sha256:sha256(bytes),containsRawEvidence:true};
  fs.writeFileSync(path.join(root,'case.json'),JSON.stringify(manifest,null,2)+'\n');
  return identity;
}

export function verifyIdentity(root) {
  const manifest=jsonFile(root,'case.json');
  if(!manifest.identityEvidence||manifest.identityEvidence.path!=='identity.json'||manifest.identityEvidence.version!==IDENTITY_VERSION)throw new Error('Missing identity/evidence contract');
  const bytes=fs.readFileSync(safeCasePath(root,'identity.json'));
  if(sha256(bytes)!==manifest.identityEvidence.sha256)throw new Error('Identity digest mismatch');
  const expected=buildIdentity(root),actual=JSON.parse(bytes);
  if(stableStringify(actual)!==stableStringify(expected))throw new Error('Identity projection differs from original-bound ledger');
  return {representations:actual.representations.length,occurrences:new Set(actual.representations.map(r=>r.occurrence_id)).size};
}

async function verifiedIdentity(root) {
  const {verifyCaseIntegrity}=await import('./integrity.js');const v=await verifyCaseIntegrity(root,{verifyProjections:false});
  if(!v.passed)throw new Error('Case integrity failed: '+v.findings.filter(x=>!x.ok).map(x=>x.detail).join('; '));
  if(!jsonFile(root,'case.json').identityEvidence)throw new Error('Legacy case lacks identity contract; reacquire into a new case');
  return jsonFile(root,'identity.json');
}

export async function readUnifiedEvidence(root, representationId, {start=0,end=null,unit='unicode_codepoints'}={}) {
  const identity=await verifiedIdentity(root),row=identity.representations.find(r=>r.representation_id===representationId);
  if(!row)throw new Error('Unknown representation');
  if(unit!=='unicode_codepoints')throw new Error('Evidence text ranges require unicode_codepoints');
  const points=[...row.text];end??=points.length;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>points.length)throw new Error('Invalid text range');
  return {...row,quote:points.slice(start,end).join(''),quote_range:{start,end,unit,end_exclusive:true},verified:true};
}

export async function exportN01Packet(caseDirs,{scope='active',knownAt=null}={}) {
  if(!['active','all'].includes(scope))throw new Error('Unsupported scope');
  const cutoff=knownAt==null?Infinity:Date.parse(knownAt);if(Number.isNaN(cutoff))throw new Error('Invalid known-at cutoff');
  const representations=[],sources=[];
  for(const root of caseDirs) {
    const identity=await verifiedIdentity(root);
    if(Date.parse(identity.registeredAt)>cutoff)continue;
    sources.push({case_hash:identity.caseHash,case_path:path.resolve(root),manifest:jsonFile(root,"case.json")});
    for(const row of identity.representations) {
      if(Date.parse(row.known_at)>cutoff)continue;
      if(scope==='active'&&!['active','native'].includes(row.scope))continue;
      representations.push({...row,case_hash:identity.caseHash});
    }
  }
  const groups=new Map();
  for(const r of representations){if(!groups.has(r.occurrence_id))groups.set(r.occurrence_id,[]);groups.get(r.occurrence_id).push(r);}
  const records=[...groups].map(([id,rows])=>({occurrence_id:id,conversation_id:rows[0].conversation_id,
    versions:[...new Set(rows.map(r=>r.payload_sha256))],identity_conflict:rows.some(r=>r.identity_conflict)||hasVersionConflict(rows),
    representations:rows,independent_support_count:rows[0].occurrence_kind==='context'||rows[0].identity_grade==='REPRESENTATION_ONLY'?0:1,first_known_at:rows.map(r=>r.known_at).sort()[0]}));
  return {format:'afh.n01-exchange.v1',integration:'LOCAL_EXCHANGE_ONLY_NOT_NOETIS_INGESTION',scope,known_at:knownAt,sources,records,
    requirements:['N01 must assign its own record ID and registration receipt.','Locators use afh-evidence-text-v1, not N01-evidence-text-v1 until explicitly converted.','No identity conflict may be promoted automatically.','Unknown fields remain in the original-bound canonical source; the packet is a projection.']};
}

function hasVersionConflict(rows) {
  const events=new Map();
  for(const row of rows){if(!events.has(row.event_id))events.set(row.event_id,new Set());events.get(row.event_id).add(row.payload_sha256);}
  return [...events.values()].some(versions=>versions.size>1);
}

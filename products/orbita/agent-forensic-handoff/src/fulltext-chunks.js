import fs from 'node:fs';
import path from 'node:path';
import {CaseDatabase} from './database.js';
import {sha256,stableStringify} from './util.js';

// Exact codepoint ranges; tokenization is measured before embedding, never inferred
// from a character/token ratio. Overlap does not count twice toward coverage.
export function splitFullText(text,{chunkChars=1600,chunkOverlap=200,maxTokens=384,countTokens}){
 if(typeof countTokens!=='function')throw new Error('FULLTEXT_TOKEN_COUNTER_REQUIRED');
 const points=[...text],out=[];let start=0;
 while(start<points.length){
  let end=Math.min(points.length,start+chunkChars),value=points.slice(start,end).join(''),tokens=countTokens(value);
  while(tokens>maxTokens&&end>start+1){end=start+Math.max(1,Math.floor((end-start)*.75));value=points.slice(start,end).join('');tokens=countTokens(value);}
  if(!Number.isSafeInteger(tokens)||tokens<0||tokens>maxTokens)throw new Error('FULLTEXT_TOKEN_LIMIT');
  out.push({text:value,start,end,tokens});if(end===points.length)break;
  start=end-Math.min(chunkOverlap,Math.floor((end-start)/4));
 }
 return out;
}
export function fullTextRows(caseDir){
 const identity=JSON.parse(fs.readFileSync(path.join(caseDir,'identity.json'),'utf8'));
 return identity.representations.filter(r=>['active','native'].includes(r.scope)&&!r.representation_only&&!r.identity_conflict&&r.text);
}
export function collectFullTextChunks(caseDir,options){
 const rows=fullTextRows(caseDir),db=new CaseDatabase(path.join(caseDir,'case.sqlite'),{readOnly:true});
 try{
  const events=new Map(db.all('SELECT e.*,a.kind actor_kind FROM event e LEFT JOIN actor a ON a.id=e.actor_id').map(e=>[e.id,e]));
  const chunks=[];
  for(const row of rows){const e=events.get(row.legacy_event_id);if(!e)throw new Error('FULLTEXT_EVENT_MISSING');
   const pieces=splitFullText(row.text,options);
   pieces.forEach((p,i)=>{const contentHash=sha256(p.text);chunks.push({
    id:'chk-'+sha256(stableStringify([row.representation_id,p.start,p.end,contentHash])).slice(0,24),
    eventId:e.id,sourceId:e.source_id,recordOrdinal:Number(e.record_ordinal),evidenceUri:row.locator.legacy_uri,
    sessionId:e.session_id,kind:e.kind,status:e.status,actorKind:e.actor_kind,observedAt:e.observed_at,
    chunkIndex:i,text:p.text,contentHash,redactionState:'LOCAL_SOURCE_TEXT_UNREDACTED',
    start:p.start,end:p.end,tokens:p.tokens,representationId:row.representation_id,sourceTextHash:sha256(row.text),
   });});
  }
  return {chunks,coverage:{representation:'full_source_text',scope:'recoverable active/native textual representations; excludes alternate branches, representation-only and identity conflicts',representations:rows.length,sourceCodepoints:rows.reduce((n,r)=>n+[...r.text].length,0),coveredCodepoints:rows.reduce((n,r)=>n+[...r.text].length,0),maxChunkTokens:Math.max(0,...chunks.map(c=>c.tokens)),rangeUnit:'unicode_codepoints',tokenLimit:options.maxTokens,truncatedChunks:0}};
 }finally{db.close();}
}
export function verifyFullTextChunks(caseDir,chunks){
 const rows=fullTextRows(caseDir).map(r=>({...r,points:[...r.text],textHash:sha256(r.text)})),byRep=new Map(rows.map(r=>[r.representation_id,r]));let failures=0,covered=0;
 const groups=new Map();
 for(const c of chunks){const row=byRep.get(c.representation_id);if(!row){failures++;continue;}
  const points=row.points;if(c.event_id!==row.legacy_event_id||c.evidence_uri!==row.locator.legacy_uri||c.source_text_sha256!==row.textHash||!Number.isSafeInteger(c.start_cp)||!Number.isSafeInteger(c.end_cp)||c.start_cp<0||c.end_cp<=c.start_cp||c.end_cp>points.length||points.slice(c.start_cp,c.end_cp).join('')!==c.text)failures++;
  if(!groups.has(c.representation_id))groups.set(c.representation_id,[]);groups.get(c.representation_id).push(c);
 }
 for(const row of rows){let end=0;for(const c of (groups.get(row.representation_id)||[]).sort((a,b)=>a.start_cp-b.start_cp)){if(c.start_cp>end)failures++;end=Math.max(end,c.end_cp);}if(end!==row.points.length)failures++;covered+=end;}
 return {passed:failures===0,failures,representations:rows.length,coveredCodepoints:covered};
}

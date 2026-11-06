import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DATA,library,refreshLibrary,loadCase} from './corpus.mjs';
import {reconcileDocuments} from './documents.mjs';
import {extractKnowledge} from './knowledge.mjs';
import {publishPending} from './publication.mjs';
import {openDB,transaction,sha,now,checkpoint} from './durable.mjs';
import {MODELS} from './llm.mjs';
import {classifyOccurrences} from '../agent-forensic-handoff/src/representation-equivalence.js';

const POLICY='corpus-neighbors-1';
const demand=(v,m)=>{if(!v)throw new Error(m);};
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function open(){const db=openDB(path.join(DATA,'corpus-plans.sqlite'));db.exec(`
 CREATE TABLE IF NOT EXISTS corpus_plans(id TEXT PRIMARY KEY,created_at TEXT,spec TEXT,cut TEXT,inventory TEXT,owner TEXT,pid INTEGER);
 CREATE TABLE IF NOT EXISTS corpus_targets(id TEXT PRIMARY KEY,request TEXT,status TEXT,result TEXT,error TEXT,owner TEXT,pid INTEGER);
 CREATE TABLE IF NOT EXISTS corpus_members(plan TEXT,target TEXT,ordinal INTEGER,case_id TEXT,event_id TEXT,source_role TEXT,PRIMARY KEY(plan,target));
 CREATE INDEX IF NOT EXISTS corpus_member_page ON corpus_members(plan,ordinal);
 CREATE INDEX IF NOT EXISTS corpus_target_pending ON corpus_targets(status);
 CREATE TABLE IF NOT EXISTS corpus_events(seq INTEGER PRIMARY KEY,plan TEXT,target TEXT,at TEXT,status TEXT,detail TEXT);
 `);return db;}
function selection(spec){refreshLibrary();return (spec.scope==='current_corpus'?library.filter(x=>x.currentRevision!==false):spec.conversationIds.map(id=>library.find(x=>x.id===id)||{id,missing:true})).sort((a,b)=>a.id.localeCompare(b.id));}
function snapshot(spec){return selection(spec).map(item=>{let hash=null;try{hash=JSON.parse(fs.readFileSync(path.join(item.path,'case.json'),'utf8')).caseHash;}catch{}return {id:item.id,caseHash:hash};});}
function current(row){return JSON.stringify(snapshot(JSON.parse(row.spec)))===row.cut;}
export function listCorpusPlans(){const db=open();try{return {plans:db.prepare('SELECT id,created_at,spec FROM corpus_plans ORDER BY created_at DESC,id LIMIT 50').all().map(r=>({...r,spec:JSON.parse(r.spec)})),limit:50,semanticCompleteness:'not_certified'};}finally{db.close();}}
export function corpusPlanStatus(id,{cursor=null,limit=50}={}){
 demand(typeof id==='string'&&/^plan-[a-f0-9]{64}$/.test(id),'CORPUS_PLAN_ID');demand(Number.isSafeInteger(limit)&&limit>=1&&limit<=200,'CORPUS_PAGE_LIMIT');
 const db=open();try{const row=db.prepare('SELECT * FROM corpus_plans WHERE id=?').get(id);demand(row,'CORPUS_PLAN_UNKNOWN');let after=-1;
  if(cursor){let c;try{c=JSON.parse(Buffer.from(cursor,'base64url'));}catch{throw new Error('CORPUS_CURSOR_INVALID');}demand(c.id===id&&Number.isSafeInteger(c.after)&&c.after>=0&&c.cut===sha(row.cut),'CORPUS_CURSOR_BINDING');after=c.after;}
  const counts=Object.fromEntries(db.prepare('SELECT t.status,count(*) n FROM corpus_targets t JOIN corpus_members m ON m.target=t.id WHERE m.plan=? GROUP BY t.status').all(id).map(r=>[r.status,r.n]));
  const total=Object.values(counts).reduce((a,b)=>a+b,0),processed=['proposed','proposed_with_gaps','no_acts','review_required'].reduce((n,s)=>n+(counts[s]||0),0),inventory=JSON.parse(row.inventory);
  const all=db.prepare('SELECT m.ordinal,m.case_id,m.event_id,m.source_role,t.id,t.status,t.error,t.result FROM corpus_members m JOIN corpus_targets t ON t.id=m.target WHERE m.plan=? AND m.ordinal>? ORDER BY m.ordinal LIMIT ?').all(id,after,limit+1),hasMore=all.length>limit;
  const page=all.slice(0,limit).map(r=>({...r,result:r.result?JSON.parse(r.result):null}));
  const usage=db.prepare(`SELECT count(*) n,sum(CASE WHEN t.result IS NOT NULL AND json_extract(t.result,'$.usage') IS NULL THEN 1 ELSE 0 END) unknown_usage,sum(json_extract(t.result,'$.elapsedMs')) inference_ms FROM corpus_targets t JOIN corpus_members m ON m.target=t.id WHERE m.plan=? AND t.result IS NOT NULL`).get(id);
  return {id,createdAt:row.created_at,spec:JSON.parse(row.spec),cut:JSON.parse(row.cut),current:current(row),inventory,counts,totalTargets:total,processedTargets:processed,
   processingPercent:total&&!inventory.unavailableCases?Math.round(processed/total*10000)/100:null,
   mechanicalCoverage:!inventory.unavailableCases&&total>0&&processed===total?'all_planned_targets_processed':'pending_or_blocked',
   semanticCompleteness:'not_certified',truth:'not_certified',approval:'none',reviewRequired:true,sourceIntegrity:'status_is_historical; revalidated_before_processing',
   usage:{completedReceipts:usage.n,unknownUsageReceipts:usage.unknown_usage||0,inferenceMs:usage.inference_ms??null,basis:'Per-target recorded provider usage appears in page results; missing usage is unknown, never zero cost.'},
   page,nextCursor:hasMore?Buffer.from(JSON.stringify({id,after:page.at(-1).ordinal,cut:sha(row.cut)})).toString('base64url'):null,
   limits:'Denominators describe the fixed admitted source cut. Processing every target is not proof of true, current or complete semantic knowledge. Context is bounded; F22 handles broader need/exception discovery.'};
 }finally{db.close();}
}
export async function createCorpusPlan({conversationIds,model='gpt-6.1-sol',signal}={}){
 demand(MODELS.some(m=>m.id===model),'CORPUS_MODEL_UNSUPPORTED');
 if(conversationIds!==undefined)demand(Array.isArray(conversationIds)&&conversationIds.length>0&&conversationIds.every(x=>typeof x==='string'),'CORPUS_SELECTION_REQUIRED');
 reconcileDocuments();refreshLibrary();const spec={scope:conversationIds===undefined?'current_corpus':'selection',conversationIds:conversationIds?[...new Set(conversationIds)].sort():null,model,policy:POLICY,contextPolicy:'fixed-neighbors-v1'};
 const cut=snapshot(spec),id='plan-'+sha(JSON.stringify({spec,cut})),db=open();
 try{
  const existing=db.prepare('SELECT * FROM corpus_plans WHERE id=?').get(id);if(existing){demand(current(existing),'CORPUS_PLAN_STALE');for(const item of selection(spec)){signal?.throwIfAborted();await loadCase(item);}return {...corpusPlanStatus(id),reusedPlan:true};}
  const inventory={selectedCases:cut.length,excludedHistoricalCases:spec.scope==='current_corpus'?library.filter(x=>x.currentRevision===false).length:0,verifiedCases:0,unavailableCases:0,sourceRecords:0,availableTextRepresentations:0,metadataOrNontextRecords:0,duplicateTargets:0,newTargets:0,reusedTargets:0,equivalentOccurrences:0,conflictingOccurrences:0,blockedByIdentityConflict:0,cases:[]},targets=new Map(),allMessages=[];
  for(const item of selection(spec)){
   signal?.throwIfAborted();
   try{demand(!item.missing,'SOURCE_MISSING');const c=await loadCase(item),messages=c.messages.filter(m=>m.text!==undefined),records=c.manifest.metrics.sourceRecords;
    allMessages.push(...messages);inventory.verifiedCases++;inventory.sourceRecords+=records;inventory.availableTextRepresentations+=messages.length;inventory.metadataOrNontextRecords+=Math.max(0,records-new Set(messages.map(m=>m.record_ordinal)).size);
    inventory.cases.push({id:item.id,caseHash:c.manifest.caseHash,status:'verified',sourceRecords:records,textRepresentations:messages.length,kind:item.kind||'conversation'});
    for(let index=0;index<messages.length;index++){
     const m=messages[index],identity=x=>[x.occurrenceId,x.payloadSha256,x.role,x.sha256],neighbors=messages.slice(Math.max(0,index-4),index+2).map(identity);
     const key='corpus-'+sha(JSON.stringify([POLICY,model,identity(m),neighbors,m.document?.metadata??null]));
     if(targets.has(key)){inventory.duplicateTargets++;continue;}
     const reason=!m.representationId?'unbound_identity':!m.text.trim()?'empty_text':Buffer.byteLength(m.text)>95000?'oversized_target':null;
     targets.set(key,{id:key,contextOccurrences:messages.slice(Math.max(0,index-4),index+2).map(x=>x.occurrenceId),caseId:item.id,eventId:m.id,role:m.role,status:reason?'blocked':'pending',error:reason,
      request:{conversationIds:[item.id],targets:[{conversationId:item.id,eventId:m.id}],model,contextPolicy:'fixed-neighbors-v1',requestId:key}});
    }
   }catch(e){signal?.throwIfAborted();inventory.unavailableCases++;inventory.cases.push({id:item.id,status:'unavailable',error:e.message,sourceRecords:null});}
  }
  const identities=classifyOccurrences(allMessages),conflicts=new Map();
  for(const [occurrence,state] of identities){
   if(state.status==='equivalent_terminal_memory_footer')inventory.equivalentOccurrences++;
   if(state.status==='conflict')conflicts.set(occurrence,[...new Set(allMessages.filter(m=>m.occurrenceId===occurrence).map(m=>m.payloadSha256))].sort());
  }
  inventory.conflictingOccurrences=conflicts.size;
  for(const target of targets.values()){
   const affected=[...new Set(target.contextOccurrences.filter(id=>conflicts.has(id)))].sort();
   if(affected.length){
    // A cut-specific blocked target cannot inherit a success from a non-conflicting selection.
    target.id='corpus-'+sha(JSON.stringify([target.id,'identity-conflict',affected.map(id=>[id,conflicts.get(id)])]));
    target.status='blocked';target.error='conflicting_occurrence_or_context';inventory.blockedByIdentityConflict++;
   }
  }
  demand(JSON.stringify(snapshot(spec))===JSON.stringify(cut),'CORPUS_CHANGED_DURING_PLAN');signal?.throwIfAborted();
  transaction(db,()=>{let ordinal=0;for(const target of targets.values()){
    const prior=db.prepare('SELECT status FROM corpus_targets WHERE id=?').get(target.id);
    if(prior)inventory.reusedTargets++;else{inventory.newTargets++;db.prepare('INSERT INTO corpus_targets(id,request,status,error) VALUES(?,?,?,?)').run(target.id,JSON.stringify(target.request),target.status,target.error);}
    db.prepare('INSERT INTO corpus_members VALUES(?,?,?,?,?,?)').run(id,target.id,ordinal++,target.caseId,target.eventId,target.role);
   }
   db.prepare('INSERT INTO corpus_plans(id,created_at,spec,cut,inventory) VALUES(?,?,?,?,?)').run(id,now(),JSON.stringify(spec),JSON.stringify(cut),JSON.stringify(inventory));
  });checkpoint('corpus-after-plan');return {...corpusPlanStatus(id),reusedPlan:false};
 }finally{db.close();}
}
export async function runCorpusPlan({id,maxTargets=1,enableProposals=false,retryFailures=false,signal}={},dependencies={}){
 demand(enableProposals===true,'CORPUS_PROPOSALS_REQUIRE_EXPLICIT_ENABLE');demand(Number.isSafeInteger(maxTargets)&&maxTargets>=1&&maxTargets<=8,'CORPUS_TARGET_BUDGET_1_TO_8');
 const db=open(),owner=randomUUID();let claimed=false;const outcomes=[];
 const owns=()=>{signal?.throwIfAborted();demand(db.prepare('SELECT owner FROM corpus_plans WHERE id=?').get(id)?.owner===owner,'CORPUS_STALE_OWNER');};
 try{
  const plan=db.prepare('SELECT * FROM corpus_plans WHERE id=?').get(id);demand(plan,'CORPUS_PLAN_UNKNOWN');demand(current(plan),'CORPUS_PLAN_STALE: create a new plan for the current source revisions');
  for(const item of selection(JSON.parse(plan.spec))){signal?.throwIfAborted();await loadCase(item);}
  transaction(db,()=>{const live=db.prepare('SELECT * FROM corpus_plans WHERE id=?').get(id);if(live.owner&&alive(live.pid))throw new Error('CORPUS_PLAN_BUSY');db.prepare('UPDATE corpus_plans SET owner=?,pid=? WHERE id=?').run(owner,process.pid,id);});claimed=true;
  const statuses=retryFailures?['pending','processing','failed','partial','unknown']:['pending','processing'];
  const pending=db.prepare(`SELECT t.* FROM corpus_targets t JOIN corpus_members m ON m.target=t.id WHERE m.plan=? AND t.status IN (${statuses.map(()=>'?').join(',')}) ORDER BY m.ordinal LIMIT ?`).all(id,...statuses,maxTargets);
  for(const target of pending){owns();demand(current(plan),'CORPUS_PLAN_STALE');
   transaction(db,()=>{const live=db.prepare('SELECT * FROM corpus_targets WHERE id=?').get(target.id);if(live.owner&&alive(live.pid))throw new Error('CORPUS_TARGET_BUSY');db.prepare("UPDATE corpus_targets SET owner=?,pid=?,status='processing',error=NULL WHERE id=?").run(owner,process.pid,target.id);});
   try{const request=JSON.parse(target.request),result=await extractKnowledge({...request,signal},()=>{},dependencies);owns();demand(current(plan),'CORPUS_PLAN_STALE_AFTER_EXTRACTION');
    const publication=await publishPending(request.conversationIds,{signal,limit:100});owns();
    const state=result.errors?.length?'partial':result.contextOmissions?.length||result.gaps?.length?(result.records.length?'proposed_with_gaps':'review_required'):result.records.length?'proposed':'no_acts';
    const stored={generationId:result.generationId,records:result.records.map(r=>({id:r.id,version:r.version})),gaps:result.gaps||[],contextOmissions:result.contextOmissions||[],errors:result.errors||[],usage:result.usage??null,elapsedMs:result.elapsedMs??null,modelRequested:result.modelRequested,modelObserved:result.modelObserved??null,sourceCut:result.sourceCut,publication,approval:'none'};
    checkpoint('corpus-after-extract');db.prepare('UPDATE corpus_targets SET status=?,result=?,error=NULL WHERE id=? AND owner=?').run(state,JSON.stringify(stored),target.id,owner);outcomes.push({target:target.id,status:state});
   }catch(e){const state=/INFERENCE_UNKNOWN|MODEL_RESPONSE_LOST|agotado|SOURCE_CUT|STALE_AFTER_EXTRACTION/.test(e.message)?'unknown':/EXCEEDS_BUDGET/.test(e.message)?'blocked':'failed';db.prepare('UPDATE corpus_targets SET status=?,error=? WHERE id=? AND owner=?').run(state,e.message,target.id,owner);outcomes.push({target:target.id,status:state,error:e.message});if(signal?.aborted)throw e;
   }finally{db.prepare('UPDATE corpus_targets SET owner=NULL,pid=NULL WHERE id=? AND owner=?').run(target.id,owner);}
   db.prepare('INSERT INTO corpus_events(plan,target,at,status,detail) VALUES(?,?,?,?,?)').run(id,target.id,now(),outcomes.at(-1).status,JSON.stringify(outcomes.at(-1)));
  }
  return {...corpusPlanStatus(id),attempted:outcomes.length,outcomes};
 }finally{if(claimed)db.prepare('UPDATE corpus_plans SET owner=NULL,pid=NULL WHERE id=? AND owner=?').run(id,owner);db.close();}
}

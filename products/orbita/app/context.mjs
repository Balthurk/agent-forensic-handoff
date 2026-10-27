import fs from 'node:fs';import path from 'node:path';import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {DATA,library,refreshLibrary,loadCase} from './corpus.mjs';
import {knowledgeOperation} from './knowledge.mjs';import {cancellationPoint} from './deadline.mjs';
import {semanticStorageState} from './semantic-storage.mjs';
import {contextNeeds,publicContextUnit} from '../agent-forensic-handoff/src/context-package.js';
import {dependencyClosure,wireBytes} from '../agent-forensic-handoff/src/memory-package.js';
const ROOT=path.join(DATA,'context-queries');
const sha=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const demand=(ok,code)=>{if(!ok)throw new Error(code);};
const measured=value=>{value.bytes=0;for(let i=0;i<10;i++){const n=wireBytes(value);if(n===value.bytes)return value;value.bytes=n;}throw new Error('CONTEXT_BYTE_COUNTER');};
export async function contextState(ids,{signal,excludeStores=[]}={}) {
 await cancellationPoint(signal);refreshLibrary();const selection=[...new Set(ids)].sort(),sources=[],selectedRepresentations=new Set();
 for(const id of selection){await cancellationPoint(signal);const item=library.find(x=>x.id===id);demand(item,'CONTEXT_SOURCE_NOT_FOUND');const c=await loadCase(item);for(const m of c.messages)selectedRepresentations.add(m.representationId);sources.push({id,revision:c.manifest.caseHash,currentRevision:item.currentRevision!==false,document:item.document??null});}
 const remote=await semanticStorageState(DATA);
 if(remote&&!remote.legacyCompatible){const stores=remote.stores.filter(([folder])=>!excludeStores.includes(folder));return {selection,sources,fingerprint:sha({sources,backend:'semantic-revision-v1',namespace:remote.namespace,stores})};}
 const stores=[];
 for(const folder of ['','collectives','decisions','supports','identities','retrospectives','intelligence','causal']){
  if(excludeStores.includes(folder))continue;
  await cancellationPoint(signal);const file=path.join(DATA,'semantic',folder,'records.sqlite3');if(!fs.existsSync(file)){if(!['identities','retrospectives','intelligence','causal'].includes(folder))stores.push([folder,[]]);continue;}
  const db=new DatabaseSync(file,{readOnly:true});try{
   let rows=db.prepare('SELECT record_id,scope,version,recorded_at,payload,payload_sha256,request_id,request_sha256 FROM record_versions ORDER BY record_id,version LIMIT 10001').all();demand(rows.length<=10000,'CONTEXT_STATE_ROW_BUDGET');
   if(['retrospectives','intelligence','causal'].includes(folder))rows=rows.filter(r=>JSON.parse(r.payload).source_refs.some(ref=>selectedRepresentations.has(ref.id)));
   const admissions=db.prepare('SELECT * FROM semantic_support_admissions ORDER BY record_id,version,receipt_sha256 LIMIT 10001').all();demand(admissions.length<=10000,'CONTEXT_REVIEW_ROW_BUDGET');if(!['identities','retrospectives','intelligence','causal'].includes(folder)||rows.length)stores.push([folder,sha(rows),sha(admissions)]);
  }finally{db.close();}
 }
 return {selection,sources,fingerprint:sha({sources,stores})};
}
export async function discoverContext(question,ids,options={}) {
 const before=await contextState(ids,options);
 const result=await knowledgeOperation('context_query',ids,{question,knownAt:options.knownAt??null,validAt:options.validAt??null,roots:options.roots??[]},options);
 const after=await contextState(ids,options);demand(before.fingerprint===after.fingerprint,'CONTEXT_CHANGED_DURING_DISCOVERY');
 return {...result,contextState:before};
}
function observations(unit) {
 if(unit.kind!=='semantic')return unit.needs;
 const result=['source','antecedent','scope'],items=unit.data.items,edges=unit.data.edges;
 if(items.length)result.push('rule');if(items.some(i=>i.conditions.length))result.push('condition');
 if(items.some(i=>i.temporal.length))result.push('validity');
 for(const [need,pattern,kinds] of [['exception',/excep|salvo|excepto|unless/i,['exception']],['revocation',/revoc|retract|retir/i,['retracts','substitution']],['contradiction',/contradic|conflict/i,['contradiction']]])if(edges.some(e=>kinds.includes(e.kind))||items.some(i=>pattern.test(i.text)))result.push(need);
 return result;
}
export function contextPlan(question,context,records,links,sources,requestedNeeds=[]) {
 const byRep=new Map(records.map(r=>[r.representationId,r.key])),byKey=new Map(records.map(r=>[r.key,r]));
 for(const alias of context.representationAliases??[]){const key=byRep.get(alias.currentRepresentationId);if(key)byRep.set(alias.sourceId,key);}
 const units=(context.contextUnits??[]).map(unit=>{
  const keys=[...new Set(unit.sourceRefs.map(r=>byRep.get(r.id)||'unavailable:'+r.id))];
  const full=new Set(keys);for(const key of keys){const c=dependencyClosure(key,byKey,links);c.members.forEach(k=>full.add(k));c.missing.forEach(k=>full.add(k));}
  const evidenceKeys=[...full];const blocked=unit.blocked||evidenceKeys.some(k=>!byKey.has(k));
  // Symmetric closure includes every adverse branch and all original witnesses.
  for(const key of evidenceKeys)if(byKey.has(key))links[key]=[...new Set([...(links[key]||[]),...evidenceKeys.filter(k=>k!==key),...(blocked?['unavailable:context:'+unit.id]:[])])];
  return {...unit,observedNeeds:observations(unit),evidenceKeys,blocked};
 });
 return {units,needs:contextNeeds(question,requestedNeeds),cut:context.contextCut,blockers:context.contextBlockers??[],
  coverage:{sources:sources.length,textRepresentations:records.length,semanticTargets:sources.reduce((n,s)=>n+(s.coverage?.extracted?.records??0),0),scanned:context.contextScan??{},outsideSelection:context.outsideSelection??0,completeness:'not_certified',limits:'Selected revisions only; unextracted text and implicit references may contain further exceptions. No-match never proves absence.'},snapshot:null};
}
export async function retainContext({question,ids,options,plan,records,seeds,links,state,signal}) {
 await cancellationPoint(signal);demand(state,'CONTEXT_STATE_REQUIRED');
 const byKey=new Map(records.map(r=>[r.key,r]));const units=[...plan.units];const covered=new Set(units.flatMap(u=>u.evidenceKeys));
 for(const seed of seeds){const closure=dependencyClosure(seed,byKey,links);if(closure.members.every(k=>covered.has(k)))continue;
  const evidenceKeys=[...new Set([...closure.members,...closure.missing])];units.push({id:'original-'+sha(seed).slice(0,24),kind:'original',title:'Original y antecedentes capturados',sourceRefs:[],needs:['source','antecedent'],observedNeeds:['source','antecedent'],requiresReview:true,blocked:!!closure.missing.length,evidenceKeys,data:{seed,missing:closure.missing}});evidenceKeys.forEach(k=>covered.add(k));
 }
 const snapshot={schema:'afh.context-snapshot.v1',question,conversationIds:[...new Set(ids)].sort(),options,cut:plan.cut,state,coverage:plan.coverage,needs:plan.needs,blockers:plan.blockers,units,evidence:records.filter(r=>covered.has(r.key))};
 const raw=JSON.stringify(snapshot);demand(Buffer.byteLength(raw)<=32000000,'CONTEXT_SNAPSHOT_BYTE_BUDGET');const id=sha(raw),dir=path.join(ROOT,id);
 fs.mkdirSync(ROOT,{recursive:true});
 try{fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'snapshot.json'),raw,{flag:'wx'});fs.writeFileSync(path.join(dir,'cursor.key'),randomBytes(32),{flag:'wx'});fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({id,sha256:id,bytes:Buffer.byteLength(raw),units:units.length}),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;readSnapshot(id);}
 const current=await contextState(ids,{signal});demand(current.fingerprint===state.fingerprint,'CONTEXT_CHANGED_BEFORE_ADMISSION');
 return {id,unitCount:units.length,stateFingerprint:state.fingerprint,resume:'/api/context/page',currentAtCapture:true};
}
export function readSnapshot(id) {
 demand(typeof id==='string'&&/^[a-f0-9]{64}$/.test(id),'CONTEXT_SNAPSHOT_ID');const dir=path.join(ROOT,id),file=path.join(dir,'snapshot.json');
 demand(!fs.lstatSync(dir).isSymbolicLink()&&!fs.lstatSync(file).isSymbolicLink(),'CONTEXT_SNAPSHOT_LINK');const raw=fs.readFileSync(file,'utf8'),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
 demand(sha(raw)===id&&manifest.id===id&&manifest.sha256===id&&manifest.bytes===Buffer.byteLength(raw),'CONTEXT_SNAPSHOT_INTEGRITY');const snapshot=JSON.parse(raw);demand(snapshot.schema==='afh.context-snapshot.v1'&&manifest.units===snapshot.units.length,'CONTEXT_SNAPSHOT_SCHEMA');
 return {snapshot,key:fs.readFileSync(path.join(dir,'cursor.key'))};
}
function encodeCursor(value,key){const data=Buffer.from(JSON.stringify(value)).toString('base64url');return data+'.'+createHmac('sha256',key).update(data).digest('hex');}
function decodeCursor(cursor,key){demand(typeof cursor==='string'&&cursor.length<2000,'CONTEXT_CURSOR');const [data,mac,...extra]=cursor.split('.');demand(!extra.length&&/^[a-f0-9]{64}$/.test(mac),'CONTEXT_CURSOR');const signature=createHmac('sha256',key).update(data).digest();demand(timingSafeEqual(signature,Buffer.from(mac,'hex')),'CONTEXT_CURSOR_INTEGRITY');return JSON.parse(Buffer.from(data,'base64url').toString('utf8'));}
export async function verifyContextSnapshot(reference,ids,{signal,requireCurrent=true}={}) {
 const {snapshot}=readSnapshot(reference.id);demand(JSON.stringify([...new Set(ids)].sort())===JSON.stringify(snapshot.conversationIds),'CONTEXT_SELECTION_MISMATCH');const state=await contextState(ids,{signal});const current=state.fingerprint===snapshot.state.fingerprint;
 if(requireCurrent)demand(current,'CONTEXT_CHANGED_SINCE_RETRIEVAL');return {current,scope:snapshot.cut.mode,sourceSelectionVerified:true};
}
export async function contextPage({id,conversationIds,cursor=null,maxBytes=100000,limit=8,signal}) {
 demand(Number.isSafeInteger(maxBytes)&&maxBytes>=4096&&maxBytes<=200000,'CONTEXT_PAGE_BUDGET');demand(Number.isSafeInteger(limit)&&limit>=1&&limit<=20,'CONTEXT_PAGE_LIMIT');demand(Array.isArray(conversationIds)&&conversationIds.length>=1&&conversationIds.length<=20,'CONTEXT_SELECTION');
 const {snapshot,key}=readSnapshot(id);const freshness=await verifyContextSnapshot({id},conversationIds,{signal,requireCurrent:false});let offset=0;
 if(cursor){const value=decodeCursor(cursor,key);demand(value.id===id&&value.maxBytes===maxBytes&&value.limit===limit&&Number.isSafeInteger(value.offset)&&value.offset>0&&value.offset<snapshot.units.length,'CONTEXT_CURSOR_BINDING');offset=value.offset;}
 const evidenceMap=new Map(snapshot.evidence.map(e=>[e.key,e]));const result={schema:'afh.context-page.v1',id,question:snapshot.question,cut:snapshot.cut,freshness,maxBytes,bytes:0,items:[],evidence:[],omissions:[],nextCursor:null,coverage:snapshot.coverage,requiresAbstention:true,executionAuthority:false,humanAcceptance:false};
 const seen=new Set();let scanned=0;
 for(;offset<snapshot.units.length&&scanned<limit;offset++,scanned++){
  await cancellationPoint(signal);const unit=snapshot.units[offset],evidence=unit.evidenceKeys.map(k=>evidenceMap.get(k));
  if(unit.blocked||evidence.some(e=>!e)){result.omissions.push({id:unit.id,reason:'missing_or_unverified_dependency'});continue;}
  const additions=evidence.filter(e=>!seen.has(e.key));result.items.push(publicContextUnit(unit,{page:true}));result.evidence.push(...additions);
  if(wireBytes(result)>maxBytes-1400){result.items.pop();result.evidence.splice(result.evidence.length-additions.length,additions.length);
   if(result.items.length)break;
   result.omissions.push({id:unit.id,reason:'whole_context_exceeds_page_budget',requiredUnitBytes:wireBytes({unit:publicContextUnit(unit,{page:true}),evidence}),originals:evidence.slice(0,2).map(e=>({conversationId:e.conversationId,eventId:e.id})),originalCount:evidence.length});
  }else additions.forEach(e=>seen.add(e.key));
 }
 if(offset<snapshot.units.length)result.nextCursor=encodeCursor({id,offset,maxBytes,limit},key);
 result.remainingUnits=snapshot.units.length-offset;result.status=!freshness.current?'stale_cut':result.omissions.length?'incomplete_page':result.nextCursor?'more_context':'complete_page';
 measured(result);demand(result.bytes<=maxBytes,'CONTEXT_PAGE_METADATA_BUDGET');return result;
}

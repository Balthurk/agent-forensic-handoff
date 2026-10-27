import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {library,loadCase,getEvidence,DATA,refreshLibrary} from './corpus.mjs';
import {verifyCaseIntegrity} from '../agent-forensic-handoff/src/integrity.js';
import {readEvidence} from '../agent-forensic-handoff/src/render.js';
import {queryCase} from '../agent-forensic-handoff/src/retrieval.js';
import {buildSemanticIndex,findSemanticProjection,verifySemanticProjection,semanticSearch} from '../agent-forensic-handoff/src/semantic.js';
import {createTransformersProvider} from '../agent-forensic-handoff/src/semantic-model.js';
import {queryPlan,normalize,buildMemoryPackage,rankEvidence} from '../agent-forensic-handoff/src/memory-package.js';
import {loadTaxonomy,validateProposal,SEMANTIC_TYPES,digest} from '../agent-forensic-handoff/src/knowledge-proposals.js';
import {classifyOccurrences} from '../agent-forensic-handoff/src/representation-equivalence.js';
import {semanticContext,knowledgeCoverage} from './knowledge.mjs';
import {contextNeeds} from '../agent-forensic-handoff/src/context-package.js';
import {discoverContext,contextPlan,retainContext} from './context.mjs';
import {cancellationPoint} from './deadline.mjs';
import {cachedEmbeddingProvider} from './embedding-cache.mjs';
export {loadTaxonomy,SEMANTIC_TYPES};
let providerPromise;
const provider=()=>providerPromise??=(createTransformersProvider().catch(e=>{providerPromise=null;throw e;}));
export async function closeMemory(){if(providerPromise){const p=await providerPromise.catch(()=>null);await p?.dispose?.();providerPromise=null;}}
function itemFor(id){const item=library.find(i=>i.id===id);if(!item)throw new Error('Unknown conversation: '+id);return item;}
async function verifiedCase(item){return loadCase(item);}
const keyOf=(id,event)=>id+':'+event;
function graph(c){
 const db=new DatabaseSync(path.join(c.item.path,'case.sqlite'),{readOnly:true});let rows;
 try{rows=db.prepare('SELECT id,turn_id,call_id,parent_event_id,kind,metadata_json FROM event WHERE canonical=1 ORDER BY record_ordinal,subordinal').all();}finally{db.close();}
 const live=new Map(c.messages.map(m=>[m.id,m])),users=new Map(),calls=new Map(),links={};
 for(const row of rows){const m=live.get(row.id);if(!m)continue;if(m.role==='user'&&row.turn_id)users.set(row.turn_id,[...(users.get(row.turn_id)||[]),row.id]);
   if(row.call_id&&['tool.call','tool.requested'].includes(row.kind))calls.set(row.call_id,row.id);}
 const nodes=new Map(rows.map(r=>[JSON.parse(r.metadata_json||'{}').nodeId,r]));
 for(const r of rows){if(!live.has(r.id))continue;const id=keyOf(c.item.id,r.id),deps=new Set();
   if(r.parent_event_id)deps.add(keyOf(c.item.id,r.parent_event_id));
   for(const user of users.get(r.turn_id)||[])if(user!==r.id)deps.add(keyOf(c.item.id,user));
   if(r.call_id&&!['tool.call','tool.requested'].includes(r.kind)&&calls.has(r.call_id))deps.add(keyOf(c.item.id,calls.get(r.call_id)));
   // A ChatGPT branch is a chronological chain, not a semantic dependency graph.
   // Bind the nearest captured user ancestor, not every earlier conversation node.
   if(live.get(r.id).role!=='user'){
    let p=JSON.parse(r.metadata_json||'{}').parentNodeId;const seen=new Set();
    while(p&&!seen.has(p)){seen.add(p);const parent=nodes.get(p);if(!parent)break;if(live.get(parent.id)?.role==='user'){deps.add(keyOf(c.item.id,parent.id));break;}p=JSON.parse(parent.metadata_json||'{}').parentNodeId;}
   }
   links[id]=[...deps].filter(x=>x!==id);
 }
 return links;
}
async function stages(c){
 const db=new DatabaseSync(path.join(c.item.path,'case.sqlite'),{readOnly:true});let total,parsed,indexed,full;
 try{total=Number(db.prepare('SELECT COUNT(*) n FROM source_record').get().n);
  parsed=Number(db.prepare("SELECT COUNT(*) n FROM source_record WHERE parse_status='PARSED'").get().n);
  indexed=Number(db.prepare('SELECT COUNT(*) n FROM (SELECT DISTINCT e.source_id,e.record_ordinal FROM event e JOIN event_fts f ON f.event_id=e.id)').get().n);
  full=new Set(c.messages.filter(m=>m.text).map(m=>m.uri)).size;
 }finally{db.close();}
 let semantic={status:'not_indexed',records:0,representation:'full_source_text',revision:c.manifest.caseHash};
 const dir=findSemanticProjection(c.item.path,{representation:"full_source_text"});
 if(dir){const v=await verifySemanticProjection(c.item.path,dir,{deep:false});
   if(v.passed){const sdb=new DatabaseSync(path.join(dir,'semantic.sqlite'),{readOnly:true});try{semantic={status:'indexed',records:Number(sdb.prepare('SELECT COUNT(*) n FROM (SELECT DISTINCT source_id,record_ordinal FROM semantic_chunk)').get().n),representation:'full_source_text',revision:c.manifest.caseHash,projectionId:v.manifest.projectionId,model:v.manifest.model.modelId,...v.manifest.metrics.fullText};}finally{sdb.close();}}
   else semantic={...semantic,status:'unavailable',reason:'PROJECTION_INTEGRITY_FAILED'};}
 return {revision:c.manifest.caseHash,denominator:total,unit:'source_records',archived:total,parsed,indexedPreview:indexed,availableFullText:full,indexedFullText:semantic.status==='indexed'?semantic.records:0,semantic,
   extracted:{status:'not_performed',records:0},limits:'Parsed/indexed counts do not certify semantic completeness. Proposals are manual, not automatic extraction.'};
}
export async function coverage(){const rows=await Promise.all(library.map(async item=>{try{const c=await verifiedCase(item);return {id:item.id,title:item.title,...await stages(c)};}catch(e){return {id:item.id,status:'unavailable',error:e.message};}}));try{const semantic={};for(let offset=0;offset<library.length;offset+=20)Object.assign(semantic,await knowledgeCoverage(library.slice(offset,offset+20).map(i=>i.id)));for(const row of rows)if(semantic[row.id])row.extracted=semantic[row.id];}catch(e){for(const row of rows)row.extracted={status:'unavailable',records:0,error:e.message};}return rows;}
let indexing=false;
export async function indexConversations(ids,progress=()=>{}){
 if(indexing)throw new Error('An index build is already running');if(!Array.isArray(ids)||!ids.length)throw new Error('Select conversations');indexing=true;
 try{const p=await provider(),result=[];for(const id of [...new Set(ids)]){const item=itemFor(id);await verifiedCase(item);
   // Projection writes must stay inside this candidate's data directory.
   const relative=path.relative(path.join(DATA,'cases'),path.resolve(item.path));if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('INDEX_OUTSIDE_CANDIDATE_DATA');
   const cached=cachedEmbeddingProvider(p,path.join(DATA,'embedding-cache'));try{const built=await buildSemanticIndex(item.path,{provider:cached,representation:"full_source_text",onProgress:x=>progress(id+' · '+x.phase+' '+(x.completedEmbeddings??''))});result.push({...built,incrementalCache:cached.finish()});}catch(e){cached.finish(e);throw e;}}return result;
 }finally{indexing=false;}}
const proposalDir=path.join(DATA,'proposals');
async function bindRefs(refs){const bindings=[];
 for(const ref of refs){const item=itemFor(ref.conversationId),c=await verifiedCase(item);if(c.manifest.caseHash!==ref.revision)throw new Error('STALE_SOURCE_REVISION');const e=await getEvidence(ref.conversationId,ref.eventId);
  if([...e.text].slice(ref.start,ref.end).join('')!==ref.quote)throw new Error('SOURCE_QUOTE_RANGE_MISMATCH');
  bindings.push({conversationId:ref.conversationId,eventId:ref.eventId,caseHash:c.manifest.caseHash,representationId:e.representationId??null,occurrenceId:e.occurrenceId??null,payloadSha256:e.payloadSha256??null,recordSha256:e.sha256,role:e.role,uri:e.uri});}
 return bindings;
}
export async function createProposal(input){const value=validateProposal(input),binding=await bindRefs(value.source_refs),tax=loadTaxonomy();
 const envelope={schema:'afh-knowledge-proposal-1',createdAt:new Date().toISOString(),proposer:{id:'local-user',authentication:'local_declaration'},taxonomy:{version:tax.version,sha256:tax.sha256},payload:value,sourceBinding:binding,payloadSha256:digest(value)};
 fs.mkdirSync(proposalDir,{recursive:true});fs.writeFileSync(path.join(proposalDir,value.id+'.json'),JSON.stringify(envelope,null,2),{flag:'wx'});return envelope;
}
export async function listProposals(){if(!fs.existsSync(proposalDir))return [];const out=[];
 for(const filename of fs.readdirSync(proposalDir).filter(n=>/^[a-zA-Z0-9:_-]+\.json$/.test(n))){let record;
  try{record=JSON.parse(fs.readFileSync(path.join(proposalDir,filename),'utf8'));validateProposal(record.payload);if(digest(record.payload)!==record.payloadSha256)throw new Error('PROPOSAL_HASH_MISMATCH');
   const tax=loadTaxonomy();if(record.taxonomy?.sha256!==tax.sha256||record.taxonomy?.version!==tax.version)throw new Error('PROPOSAL_TAXONOMY_MISMATCH');
   const bindings=await bindRefs(record.payload.source_refs);if(JSON.stringify(bindings)!==JSON.stringify(record.sourceBinding))throw new Error('PROPOSAL_BINDING_MISMATCH');
   out.push({...record,bindingStatus:'valid',semanticSupport:'not_evaluated'});
  }catch(e){out.push({id:filename.slice(0,-5),bindingStatus:'invalid',error:e.message});}}
 return out;
}
export async function retrievePackage(question,ids,{mode='hybrid',profile='conversational',maxBytes=100000,labels=[],facets={},extraLinks={},rerank='mmr',semanticKnowledge=true,knownAt=null,validAt=null,roots=[],hops=2,needs=[],signal}={}){
 contextNeeds(question,needs);await cancellationPoint(signal);refreshLibrary();const started=Date.now(),plan=queryPlan(question,{profile});if(!['lexical','semantic','hybrid'].includes(mode))throw new Error('Invalid retrieval mode');
 for(const time of [knownAt,validAt])if(time!==null&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(time)||time.endsWith('-00:00')||Number.isNaN(Date.parse(time))))throw new Error('Use an explicit RFC3339 instant with known timezone');
 if((knownAt||validAt)&&!semanticKnowledge)throw new Error('Temporal cuts require the semantic record channel');
 if(knownAt||validAt)plan.semanticTemporalSelection={knownAt,validAt,scope:'semantic record versions only; original evidence remains contextual',applied:false};
 if(!Array.isArray(ids)||!ids.length||ids.length>20)throw new Error('Select 1..20 conversations');const selected=[...new Set(ids)].map(itemFor);
 const tax=loadTaxonomy();if(!Array.isArray(labels)||labels.some(id=>!tax.nodes.some(n=>n.id===id)))throw new Error('Unknown label');
 for(const [id,vals] of Object.entries(facets)){const f=tax.facets.find(f=>f.id===id);if(!f||!Array.isArray(vals)||vals.some(v=>!f.values.some(x=>x.id===v)))throw new Error('Unknown facet');}
 const records=[],sources=[],backends=[],links={},ranks=new Map(),occurrences=new Map(),duplicates=new Map(),caseCache=[];
 for(const item of selected){await cancellationPoint(signal);try{const c=await verifiedCase(item);caseCache.push(c);for(const m of c.messages){if(!m.occurrenceId)continue;const set=occurrences.get(m.occurrenceId)||new Set();set.add(m.payloadSha256);occurrences.set(m.occurrenceId,set);}}catch(e){signal?.throwIfAborted();backends.push({conversationId:item.id,channel:'source',status:'unavailable',reason:e.message});}}
 const identityStates=classifyOccurrences(caseCache.flatMap(c=>c.messages));
 const identityConflicts=[...identityStates.values()].filter(v=>v.status==='conflict').length;
 if(identityConflicts)backends.push({channel:'identity',status:'unavailable',reason:'Conflicting occurrence payloads excluded',conflicts:identityConflicts});
 for(const c of caseCache){
  await cancellationPoint(signal);const item=c.item;Object.assign(links,graph(c));sources.push({conversationId:item.id,title:item.title,caseHash:c.manifest.caseHash,...(item.document?{document:item.document,currentRevision:item.currentRevision!==false,applicability:'not_certified'}:{}),coverage:await stages(c)});
  const eligible=c.messages.filter(m=>m.text.trim()&&(!m.occurrenceId||identityStates.get(m.occurrenceId)?.status!=='conflict')&&(m.role!=='system'||/sistema|system/.test(normalize(question))));
  const list=eligible.map(m=>({...m,key:keyOf(item.id,m.id),start:0,end:[...m.text].length,rangeUnit:'unicode_codepoints',revision:c.manifest.caseHash}));records.push(...list);
  const score=m=>{const n=normalize(m.text),orig=plan.original.filter(t=>n.includes(t)).length,alias=plan.aliases.filter(t=>n.includes(t)).length;
    if(plan.profile==='exact')return plan.anchors.length?(plan.anchors.every(a=>n.includes(normalize(a)))?1:0):(n.includes(normalize(question))?1:0);
    return orig+Math.min(alias,6)*.25;};
  const lex=list.map(m=>({key:m.key,score:score(m)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.key.localeCompare(b.key));
  if(mode!=='semantic'){backends.push({conversationId:item.id,channel:'lexical_full_text',status:lex.length?'ok':'no_match',candidates:lex.length});lex.slice(0,100).forEach((x,i)=>ranks.set(x.key,(ranks.get(x.key)||0)+1/(60+i+1)));}
  else backends.push({conversationId:item.id,channel:'lexical_full_text',status:'not_requested'});
  if(mode!=='lexical'){
   try{const projectionDir=findSemanticProjection(item.path,{representation:'full_source_text'});if(!projectionDir)throw new Error('FULLTEXT_INDEX_REQUIRED');
    await cancellationPoint(signal);const result=await semanticSearch(item.path,question,{projectionDir,provider:await provider(),limit:60,minSimilarity:.35});
    if(result.modeEffective==='unavailable')throw new Error(result.assessment.gaps.join('; '));const available=new Set(list.map(m=>m.id));const hits=result.results.filter(r=>available.has(r.id));
    backends.push({conversationId:item.id,channel:'semantic_full_text',status:hits.length?'ok':'no_match',candidates:hits.length,projection:result.projectionId,coverage:result.coverage});
    hits.forEach((r,i)=>{const key=keyOf(item.id,r.id);ranks.set(key,(ranks.get(key)||0)+1/(60+i+1));});
   }catch(e){signal?.throwIfAborted();backends.push({conversationId:item.id,channel:'semantic_full_text',status:'unavailable',reason:e.message});}
  }else backends.push({conversationId:item.id,channel:'semantic_full_text',status:'not_requested'});
 }
 let knowledgeContext=null,discovered=null,contextPlanValue=null;
 if(semanticKnowledge&&(profile!=='exact'||roots.length||knownAt||validAt)){try{
   const context=await discoverContext(question,ids,{knownAt,validAt,roots,signal});discovered=context;
   if(context.status==='not_extracted'&&!context.contextUnits?.length&&(knownAt||validAt))throw new Error('SEMANTIC_HISTORY_NOT_AVAILABLE');
   if(context.status!=='not_extracted'||context.contextUnits?.length){
    if(plan.semanticTemporalSelection)plan.semanticTemporalSelection.applied=true;
    const extractedCoverage=await knowledgeCoverage(ids);for(const source of sources)if(extractedCoverage[source.conversationId])source.coverage.extracted=extractedCoverage[source.conversationId];
    const byRep=new Map(records.map(r=>[r.representationId,r.key]));for(const alias of context.representationAliases??[]){const key=byRep.get(alias.currentRepresentationId);if(key)byRep.set(alias.sourceId,key);}
    const items=context.items.map(item=>({...item,evidenceKeys:item.sourceRefs.map(ref=>byRep.get(ref.id)||'unavailable:'+ref.id)}));
    const itemMap=new Map(items.map(x=>[x.clauseVersionId,x]));
    for(const item of items){const neighbors=context.edges.filter(e=>e.from===item.clauseVersionId||e.to===item.clauseVersionId).flatMap(e=>[itemMap.get(e.from),itemMap.get(e.to)]).filter(Boolean);const deps=[...new Set([item,...neighbors].flatMap(x=>x.evidenceKeys))];
     for(const k of item.evidenceKeys)if(records.some(r=>r.key===k)){ranks.set(k,(ranks.get(k)||0)+1/30);links[k]=[...new Set([...(links[k]||[]),...deps.filter(d=>d!==k)])];}}
    const {contextUnits,contextCut,contextScan,contextBlockers,contextState,outsideSelection,contextCoverage,...semantic}=context;knowledgeContext={...semantic,items};backends.push({channel:'semantic_records',status:items.length?'ok':'no_match',clauses:items.length});
   }
  }catch(e){signal?.throwIfAborted();backends.push({channel:'semantic_records',status:'unavailable',reason:e.message});if(knownAt||validAt)knowledgeContext={items:[],edges:[],missing:[{reason:e.message}],requiresAbstention:true,coverage:'Requested semantic temporal selection unavailable; raw sources do not resolve it'};}
 }
 // Optional labels boost proposed records; they never hide unclassified evidence.
 const proposals=await listProposals();for(const p of proposals.filter(p=>p.bindingStatus==='valid')){
  if(p.payload.labels.some(l=>labels.includes(l))||Object.entries(facets).some(([f,v])=>p.payload.facets[f]?.some(x=>v.includes(x)))){
   for(const ref of p.payload.source_refs){const key=keyOf(ref.conversationId,ref.eventId);if(records.some(r=>r.key===key))ranks.set(key,(ranks.get(key)||0)+1/61);}}
 }
 for(const [key,deps] of Object.entries(extraLinks)){if(!records.some(r=>r.key===key)||!Array.isArray(deps)||deps.some(x=>typeof x!=='string'))throw new Error('Invalid dependency links');links[key]=[...new Set([...(links[key]||[]),...deps])];}
 // Cross-import duplicate occurrences map to one representative; conflicting payloads were excluded.
 for(const r of records){if(!r.occurrenceId)continue;const k=identityStates.get(r.occurrenceId)?.key||r.occurrenceId+':'+r.payloadSha256;if(duplicates.has(k)){const existing=duplicates.get(k),score=Math.max(ranks.get(existing)||0,ranks.get(r.key)||0);if(score>0)ranks.set(existing,score);ranks.delete(r.key);}else duplicates.set(k,r.key);}
 // Brief progress announcements and visible analysis can otherwise dominate a
 // cost-aware selector merely because they are short. Preserve them as candidates
 // and dependencies; prefer substantive messages unless process itself is asked for.
 const processRequested=profile==='exact'||/razonamiento|reasoning|comentarios|commentary|progreso|progress|anuncio|announc/.test(normalize(question));
 const processWeight=processRequested?1:.35;
 for(const r of records)if(r.kind==='reasoning.visible'||r.channel==='commentary')if(ranks.has(r.key))ranks.set(r.key,ranks.get(r.key)*processWeight);
 if(discovered){contextPlanValue=contextPlan(question,discovered,records,links,sources,needs);contextPlanValue.compact=maxBytes<16000;for(const unit of contextPlanValue.units)for(const key of unit.evidenceKeys)if(records.some(r=>r.key===key))ranks.set(key,(ranks.get(key)||0)+1/30);}
 await cancellationPoint(signal);const seeds=rankEvidence(records,ranks,{rerank}).slice(0,60);
 const recordMap=new Map(records.map(r=>[r.key,r]));
 const groups=Object.fromEntries(records.map(r=>[r.key,r.role==='user'?r.key:((links[r.key]||[]).filter(k=>recordMap.get(k)?.role==='user').sort()[0]||r.key)]));
 if(contextPlanValue)contextPlanValue.snapshot=await retainContext({question,ids,options:{mode,profile,knownAt,validAt,roots,maxBytes,rerank,labels,facets,needs},plan:contextPlanValue,records,seeds,links,state:discovered.contextState,signal});
 const pkg=buildMemoryPackage({query:question,plan:{...plan,mode,rerank,fusion:'rrf-k60',selectionPolicy:'relevance+user_episode_diversity+marginal_bytes',processMessageWeight:processWeight,evidenceUnit:'whole_source_message_with_dependency_closure',labelBoost:labels,facetBoost:facets,episodePolicy:'same_turn_user+nearest_user_ancestor+explicit_parent+tool_call; no inferred semantic antecedents',identityConflicts, equivalentFooterOccurrences:[...identityStates.values()].filter(v=>v.status==='equivalent_terminal_memory_footer').length},records,seeds,links,sources,backends,needs:selected.map(i=>({conversationId:i.id,request:question})),maxBytes,selectionPolicy:'marginal_utility',utilities:Object.fromEntries(ranks),groups,knowledgeContext,contextPlan:contextPlanValue});
 // Re-open every admitted source after ranking. Failure is never published as verified evidence.
 for(const c of caseCache){await cancellationPoint(signal);const fresh=await verifiedCase(c.item);if(fresh.manifest.caseHash!==c.manifest.caseHash)throw new Error('CASE_REVISION_CHANGED_DURING_RETRIEVAL');for(const e of pkg.evidence.filter(e=>e.conversationId===c.item.id)){const current=fresh.messages.find(m=>m.id===e.id);if(!current||current.text!==e.text||current.sha256!==e.sha256||current.representationId!==e.representationId)throw new Error('EVIDENCE_CHANGED_DURING_RETRIEVAL');readEvidence(c.item.path,e.uri);}}
 await cancellationPoint(signal);return pkg;
}

// P1 adaptation of Noetis retrieval_query / episode_selector / MemoryPackage.
// This is an AFH contract, not a wire-compatible Noetis implementation.
import {contextSummary} from './context-package.js';
export const normalize = s => String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const stop = new Set('que como cual cuales donde cuando para por con una uno unos unas del los las el la de se es en y o mi me sobre esta este esto hay fue han ya mas todo toda todos todas puedes puede quiero saber dime explica segun informacion conversacion conversaciones haz the a an and or what which where when how did does is are was were to of in on for please'.split(' '));
const concepts = [
 ['objetivo','objetivos','goal','goals'], ['restriccion','restricciones','constraint','constraints'],
 ['decision','decisiones','decisions'], ['razon','razones','rationale'], ['evidencia','evidencias','evidence'],
 ['fallo','fallos','failure','failures'], ['prueba','pruebas','test','tests'],
 ['recuperacion','retrieval'], ['aprobacion','approval'], ['propuesta','propuestas','proposal','proposals'],
 ['condicion','condiciones','condition','conditions'], ['correccion','correcciones','correction','corrections'],
 ['pendiente','pendientes','pending'], ['plazo','deadline'], ['memoria','memory'],
 ['entrega','delivery'], ['controlador','controller'], ['agente','agentes','agent','agents'],
 ['dependencia','dependencias','dependency','dependencies'], ['herramienta','herramientas','tool','tools'],
];
export function queryPlan(question, {profile='conversational'}={}) {
 if(typeof question!=='string'||!question.trim()||question.length>8000)throw new Error('Invalid question (1..8000 characters)');
 if(!['exact','conversational'].includes(profile))throw new Error('Invalid query profile');
 const tokens=[...new Set(normalize(question).match(/[\p{L}\p{N}_-]+/gu)||[])];
 const anchors=[...question.matchAll(/"([^"\n]+)"/g)].map(m=>m[1]);
 const original=tokens.filter(t=>!stop.has(t)&&t.length>1).slice(0,40);
 const aliases=profile==='exact'?[]:concepts.filter(g=>g.some(t=>original.includes(t))).flat().filter(t=>!original.includes(t));
 const temporalIntent=/\b(antes|despues|ayer|hoy|ultimo|ultima|before|after|latest|yesterday|today)\b/.test(normalize(question));
 return {version:'afh-query-plan-1',profile,original,aliases:[...new Set(aliases)].slice(0,60),anchors,
   temporalIntent,temporalFilterApplied:false,warnings:temporalIntent?['Temporal intent detected; no date filter inferred.']:[],
   negationPreserved:question,terms:[...original,...new Set(aliases)].slice(0,100)};
}
export function wireBytes(value){return Buffer.byteLength(JSON.stringify(value),'utf8');}
// Adapted from AFH retrieval.js MMR; operates on full evidence, not event previews.
// It changes ordering only, never identity or the literal source text.
export function rankEvidence(records,ranks,{rerank='mmr',lambda=.65}={}){
 if(!['rrf','mmr'].includes(rerank))throw new Error('Invalid reranker');
 const pool=records.filter(r=>(ranks.get(r.key)||0)>0).map(r=>({key:r.key,score:ranks.get(r.key),tokens:new Set(normalize(r.text).match(/[\p{L}\p{N}_]{3,}/gu)||[])})).sort((a,b)=>b.score-a.score||a.key.localeCompare(b.key));
 if(rerank==='rrf')return pool.map(p=>p.key);const selected=[],max=Math.max(...pool.map(p=>p.score),1e-9);
 while(pool.length&&selected.length<100){let best=0,bestScore=-Infinity;
  pool.forEach((p,i)=>{let overlap=0;for(const s of selected){let same=0;for(const token of p.tokens)if(s.tokens.has(token))same++;overlap=Math.max(overlap,same/Math.max(1,p.tokens.size+s.tokens.size-same));}
   const score=selected.length?lambda*p.score/max-(1-lambda)*overlap:p.score/max;if(score>bestScore){bestScore=score;best=i;}});
  selected.push(pool.splice(best,1)[0]);}
 return selected.map(p=>p.key);
}
function measured(value){
 value.bytes=0;
 for(let i=0;i<10;i++){const n=wireBytes(value);if(n===value.bytes)return value;value.bytes=n;}
 throw new Error('Package byte counter did not converge');
}
export function dependencyClosure(seed, records, links) {
 const wanted=new Set(),missing=new Set(),stack=[seed];
 while(stack.length){const id=stack.pop();if(wanted.has(id)||missing.has(id))continue;
   if(!records.has(id)){missing.add(id);continue;}wanted.add(id);for(const dep of links[id]||[])stack.push(dep);}
 return {members:[...wanted],missing:[...missing]};
}
export function buildMemoryPackage({query,plan,records,seeds,links={},sources=[],backends=[],needs=[],maxBytes=100000,selectionPolicy="ranked",utilities={},groups={},knowledgeContext=null,contextPlan=null}) {
 if(!Number.isSafeInteger(maxBytes)||maxBytes<4096||maxBytes>200000)throw new Error('maxBytes must be 4096..200000 UTF-8 bytes');
 const byId=new Map(records.map(r=>[r.key,r]));if(byId.size!==records.length)throw new Error('Duplicate evidence keys');
 const order=[...new Set(seeds)],closures=order.map(id=>({id,...dependencyClosure(id,byId,links)}));
 const accepted=new Set();
 function render(){
   const included=new Set(),episodes=[],omissions=[];let missingCount=0,budgetCount=0;
   closures.forEach((c,i)=>{if(accepted.has(i)){c.members.forEach(x=>included.add(x));episodes.push({seed:c.id,members:c.members});}
     else {const reason=c.missing.length?'missing_dependency':'budget';if(c.missing.length)missingCount++;else budgetCount++;
       if(omissions.length<16)omissions.push({seed:c.id,reason,missing:c.missing.slice(0,8),missingCount:c.missing.length});}});
   const evidence=[...included].map((key,i)=>({...byId.get(key),evidenceId:'E'+(i+1)}));
   const failed=backends.some(b=>b.status==='unavailable'),requested=backends.filter(b=>b.status!=='not_requested');
   const allFailed=requested.length>0&&requested.every(b=>b.status==='unavailable');
   const state=allFailed?'unavailable':failed?'degraded':evidence.length?'ok':order.length?'budget_exhausted':'no_match';
   const knowledge=knowledgeContext?{...knowledgeContext,items:knowledgeContext.items.filter(x=>x.evidenceKeys?.length&&x.evidenceKeys.every(k=>included.has(k))),omittedClauses:knowledgeContext.items.filter(x=>!x.evidenceKeys?.length||!x.evidenceKeys.every(k=>included.has(k))).length}:null;
   if(knowledge){const vids=new Set(knowledge.items.map(x=>x.clauseVersionId));knowledge.edges=knowledgeContext.edges.filter(e=>vids.has(e.from)&&vids.has(e.to));knowledge.requiresAbstention=knowledge.requiresAbstention||knowledge.omittedClauses>0;}
   return measured({schema:'afh-memory-package-1',query,plan,maxBytes,bytes:0,state,abstention:evidence.length===0,...(knowledge?{knowledge}:{}),...(contextPlan?{context:contextSummary(contextPlan,included)}:{}),
     scope:'Selected captured revisions only; no_match does not establish global absence.',
     needs:needs.map(n=>({...n,status:evidence.some(e=>e.conversationId===n.conversationId)?'evidence_selected':'not_satisfied',semanticSatisfaction:'not_evaluated'})),
     sources,backends,evidence,episodes,omissions,omissionSummary:{total:closures.length-accepted.size,missingDependency:missingCount,budget:budgetCount,detailsOmitted:Math.max(0,closures.length-accepted.size-16)},
     coverage:{candidates:records.length,seedEpisodes:closures.length,selectedEpisodes:episodes.length,selectedEvidence:evidence.length,semanticExtraction:'not_performed'}});
 }
 // All diagnostics are present before admission. A successful admission is atomic.
 // Exact wire measurement includes even the byte counter and omitted-episode reports.
 let result=render();if(result.bytes>maxBytes)throw new Error('PACKAGE_METADATA_EXCEEDS_BUDGET');
 if(!['ranked','marginal_utility'].includes(selectionPolicy))throw new Error('Invalid selection policy');
 if(selectionPolicy==='ranked'){closures.forEach((c,i)=>{if(c.missing.length)return;accepted.add(i);const trial=render();if(trial.bytes<=maxBytes)result=trial;else accepted.delete(i);});}
 else {
  // Greedy marginal utility/cost: exact incremental serialized bytes include shared
  // dependencies, diagnostic growth and UTF-8. A closure is always indivisible.
  const remaining=new Set(closures.map((_,i)=>i));
  while(remaining.size){let best=null;
   for(const i of remaining){if(closures[i].missing.length){remaining.delete(i);continue;}
    accepted.add(i);const trial=render();accepted.delete(i);if(trial.bytes>maxBytes)continue;
    const marginal=Math.max(0,trial.bytes-result.bytes),relevance=utilities[closures[i].id]??1/(60+i);
    if(!Number.isFinite(relevance)||relevance<0)throw new Error('Invalid evidence utility');
    const group=groups[closures[i].id];
    const already=group?[...accepted].filter(j=>groups[closures[j].id]===group).length:0;
    const utility=relevance*(60/(60+i))*(2/(2+already))/Math.sqrt(2000+marginal);
    if(!best||utility>best.utility)best={i,trial,utility};
   }
   if(!best)break;accepted.add(best.i);remaining.delete(best.i);result=best.trial;
  }
 }
 result=render();if(result.bytes>maxBytes)throw new Error('PACKAGE_BUDGET_INVARIANT');return result;
}

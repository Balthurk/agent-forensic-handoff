// F22's public contract separates observed material from semantic sufficiency.
export function contextNeeds(question,requested=[]) {
 const q=String(question).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
 const needs=['source','antecedent','scope','validity'];
 if(/regla|norma|permit|puedo|autoriza|aplica|politica|policy|rule|exception|excep|revoc|can i|condicion|prohib/.test(q))needs.push('rule','condition','exception','revocation','contradiction');
 if(/decisi|alternativ|sustent|justifica|support|decide|elegir|eleccion/.test(q))needs.push('decision_support','condition','revocation','contradiction');
 const allowed=new Set(['source','antecedent','scope','validity','rule','condition','exception','revocation','contradiction','decision_support']);
 if(!Array.isArray(requested)||requested.length>10||requested.some(n=>!allowed.has(n)))throw new Error('CONTEXT_NEEDS');
 return [...new Set([...needs,...requested])];
}
export function publicContextUnit(unit,{page=false}={}) {
 const {evidenceKeys,...value}=unit;
 if(unit.kind==='semantic'&&!page)return {...value,data:{clauseVersions:unit.data.items.map(i=>i.clauseVersionId),candidateComplements:unit.data.candidateComplements??[],detailLocation:'knowledge'}};
 return value;
}
export function contextSummary(plan,included) {
 const admitted=plan.units.filter(u=>!u.blocked&&u.evidenceKeys.length&&u.evidenceKeys.every(k=>included.has(k)));
 const omitted=plan.units.filter(u=>!admitted.includes(u));
 if(plan.compact)return {schema:'afh.context.v1',snapshot:plan.snapshot?{id:plan.snapshot.id,unitCount:plan.snapshot.unitCount,resume:plan.snapshot.resume}:null,cut:plan.cut,...(plan.discovery?{coverage:{discovery:plan.discovery.summary}}:{}),
  needs:plan.needs.map(id=>({id,status:id==='source'&&included.size?'evidence_selected':admitted.some(u=>(u.observedNeeds??u.needs).includes(id))?'candidate_evidence':omitted.some(u=>u.needs.includes(id))?'context_omitted':'not_established'})),
  units:admitted.map(u=>publicContextUnit(u)),omissions:omitted.length,blockerCount:plan.blockers.length,requiresAbstention:true,completeness:'not_certified',executionAuthority:false,detailLocation:'snapshot_pages'};
 return {schema:'afh.context.v1',snapshot:plan.snapshot,cut:plan.cut,coverage:plan.coverage,
  needs:plan.needs.map(id=>({id,status:id==='source'&&included.size?'evidence_selected':admitted.some(u=>(u.observedNeeds??u.needs).includes(id))?'candidate_evidence':omitted.some(u=>u.needs.includes(id))?'context_omitted':'not_established',semanticSufficiency:'not_certified'})),
  units:admitted.map(u=>publicContextUnit(u)),omittedUnits:omitted.slice(0,8).map(u=>({id:u.id,kind:u.kind,reason:u.blocked?'missing_or_unverified_dependency':'context_and_originals_exceed_budget'})),
  omissions:omitted.length,blockers:plan.blockers.slice(0,8),requiresAbstention:true,
  answerPolicy:'Describe cited originals and stored interpretations provisionally. Do not infer current permission, truth, absence of exceptions or execution authority from this packet.',
  executionAuthority:false,humanAcceptance:false};
}

// A projection of explicit, version-bound records. Never a new source of truth.
const canonical = value => JSON.stringify(value, Object.keys(value ?? {}).sort());
export const nodeIdentity = (kind, reference) => kind + ':' + encodeURIComponent(typeof reference === 'string' ? reference : canonical(reference));
export const kindNames = {identity:'Identidad',identity_review:'Revisión de identidad',decision:'Decisión',alternative:'Alternativa',justification:'Justificación',requirement:'Requisito',collective:'Relación colectiva',participant:'Participación',clause:'Cláusula',source:'Original',reference:'Referencia',original:'Contexto original'};
export const stateNames = {active:'Activa',disputed:'En revisión',withdrawn:'Retirada',pending_choice:'Pendiente de elección',pending:'Pendiente',supported:'Apoyo declarado',refuted:'Refutación declarada',conflicting:'En conflicto',unknown:'Desconocida',inside:'Dentro del intervalo declarado',outside:'Fuera del intervalo declarado',within_declared_interval:'Dentro del intervalo declarado',pending_or_rejected:'Soporte pendiente',proposed:'Propuesta',resolved:'Resuelta',selected_revision:'Revisión seleccionada'};
// The version binds positional cursors to this exact, locale-independent order.
export const EXPLORER_ORDER_VERSION = 'kind-id-v2';
const unitRanks = new Map(['decision','semantic','collective','identity','retrospective','decision_intelligence','causal_explanation','original'].map((kind,index)=>[kind,index]));
const ordinal = (a,b) => a < b ? -1 : a > b ? 1 : 0;
export function compareContextUnits(a,b) {
  return (unitRanks.get(a.kind) ?? unitRanks.size)-(unitRanks.get(b.kind) ?? unitRanks.size)
    || ordinal(a.kind,b.kind) || ordinal(a.id,b.id);
}
const derivedKinds = new Set(['retrospective','decision_intelligence','causal_explanation']);
Object.assign(kindNames, {retrospective:'Reconstrucción retrospectiva',retrospective_claim:'Afirmación reconstruida',personal_report:'Recepción atribuida',decision_intelligence:'Inteligencia decisional',criterion:'Criterio evaluado',assumption:'Supuesto',comparison:'Comparación',forecast_value:'Pronóstico declarado',outcome_value:'Resultado declarado',causal_explanation:'Revisión causal',hypothesis:'Hipótesis alternativa',attributed_reason:'Motivo atribuido',causal_evidence:'Evidencia con posición declarada',effect:'Efecto declarado',scope:'Ámbito declarado',mechanism:'Mecanismo propuesto',counterfactual:'Contrafactual declarado',gap:'Laguna declarada',unsupported:'Tipo sin proyección admitida'});
Object.assign(stateNames, {attributed_reconstruction:'Reconstrucción atribuida',attributed_review:'Juicio ex ante atribuido',attributed_precedent:'Comparación atribuida',attributed_forecast:'Pronóstico atribuido',attributed_outcome:'Resultado atribuido',causality_not_established:'Causalidad no establecida',unsupported_context:'Interpretación no disponible',supports:'Apoyo declarado',contradicts:'Contraevidencia declarada',uncertain:'Incertidumbre declarada',pass:'Cumplimiento declarado',fail:'Incumplimiento declarado',matches:'Coincidencia declarada',differs:'Diferencia declarada',within:'Dentro del ámbito declarado',different:'Ámbito diferente declarado',received:'Recepción atribuida',acknowledged:'Acuse atribuido',denied:'Negación atribuida',challenged:'Argumento cuestionado',argument_ready_for_review:'Argumento para revisión',declared_mechanism:'Mecanismo propuesto',declared_effect:'Efecto por explicar',declared_scope:'Ámbito declarado',declared_assumption:'Supuesto declarado',unresolved:'Sin resolver',declared_true:'Resultado positivo declarado',declared_false:'Resultado negativo declarado',declared_probability:'Probabilidad declarada',decision_alternative:'Alternativa conservada'});

// Recording dates and dates asserted by an author remain separate fields.
export function interpretationMetadata(record) {
  const p=record.payload,v=p.retrospective??p.intelligence??p.causal;
  if(!v)return null;
  const kind=p.retrospective?'retrospective':p.intelligence?'decision_intelligence':'causal_explanation',d=v.detail;
  const dates=kind==='retrospective'?[['Fecha reconstruida',d.subjectAt],['Corte de fuentes declarado',d.sourceCut]]
    :kind==='causal_explanation'?[['Inicio del ámbito declarado',d.scope.validFrom],['Fin del ámbito declarado',d.scope.validUntil]]
    :v.kind==='review'?[['Fecha de decisión declarada',d.decisionAt]]
    :v.kind==='forecast'?[['Plazo declarado',d.deadline]]
    :v.kind==='outcome'?[['Fecha de resultado declarada',d.resolvedAt]]
    :[['Fecha de comparación declarada',d.comparedAt],['Fin de comparación declarado',d.validUntil]];
  const meaning=kind==='retrospective'?'Reconstrucción atribuida del corpus; no acredita qué sabía una persona en la fecha reconstruida.'
    :kind==='causal_explanation'?'Se conservan explicaciones alternativas y contraevidencia. Ninguna causa queda establecida ni seleccionada.'
    :v.kind==='review'?'Juicio ex ante atribuido. Un resultado favorable no acredita calidad decisional ni autoridad.'
    :v.kind==='forecast'?'Probabilidad declarada y criterio de resolución; no equivale a un resultado observado.'
    :v.kind==='outcome'?'Resultado declarado, separado del juicio ex ante y de cualquier autoridad.'
    :'Comparación de un precedente con otra decisión; no transfiere automáticamente su aplicabilidad.';
  return {kind,subtype:v.kind??null,author:d.actor,recordState:d.state,recordedAt:record.recorded_at,method:v.method??null,reportedTimes:dates.map(([label,value])=>({label,value})),meaning};
}

function projectInterpretation(unit,{add,edge,provenance}) {
  const data=unit.data,p=data.record.payload,v=p.retrospective??p.intelligence??p.causal,d=v.detail;
  const meta=interpretationMetadata(data.record),state=unit.kind==='retrospective'?'attributed_reconstruction':unit.kind==='causal_explanation'?'causality_not_established':'attributed_'+v.kind;
  const root=add(unit.kind,data.reference,d.title,{...meta,state,detail:{...d,reasons:data.reasons??[],evaluation:Object.fromEntries(['exAnteJudgment','conclusion','reviewStatus','applicability','prospective','selectedCause','causality','personalKnowledge','outcomeInfluence','lateSources','personalReportConflicts'].filter(k=>Object.hasOwn(data,k)).map(k=>[k,data[k]]))},historyTarget:{kind:unit.kind,...data.reference}});
  const child=(kind,key,title,state,detail,parent=root,relation='declared_part',extra={})=>{
    const id=add(kind,{unit:root,key},title,{state,detail,...extra});edge(parent,id,relation,kindNames[kind]??kind);return id;
  };
  const bound=(id,key)=>provenance(id,v.bindings[key]??[]);
  const gaps=items=>items.forEach((text,i)=>child('gap',i,text,'unresolved',{text}));
  const exact=(kind,ref,title,detail,parent=root)=>{
    const id=add(kind,ref,title,{state:'reference_only',detail,historyTarget:{kind,...ref}});edge(parent,id,'exact_reference','Referencia exacta; no implica apoyo');return id;
  };
  const decision=(ref,frame)=>{
    const id=exact('decision',ref,frame.title,frame);
    for(const a of frame.alternatives)child('alternative','decision/'+a.id,a.title,'decision_alternative',a,id,'alternative');
  };
  if(unit.kind==='retrospective') {
    d.claims.forEach((c,i)=>{const id=child('retrospective_claim',c.key,c.text,c.position,c);bound(id,'claim/'+i);});
    d.personalReports.forEach((r,i)=>{const id=child('personal_report',i,r.person,r.report,r,root,'attributed_report',{meaning:'Recepción o declaración atribuida; no acredita conocimiento personal.',reportedTimes:[{label:'Fecha atribuida',value:r.at}]});bound(id,'personal/'+i);});
    gaps(d.gaps);
  } else if(unit.kind==='decision_intelligence') {
    if(v.targets.decision)decision(d.decision,v.targets.decision.case);
    if(v.targets.context)exact('retrospective',d.context,v.targets.context.detail.title,v.targets.context.detail);
    if(v.kind==='review') {
      d.criteria.forEach((c,i)=>{const frame=v.targets.decision.case,criterion=[...frame.constraints,...frame.criteria].find(x=>x.id===c.key);const id=child('criterion',c.key,criterion?.text??c.key,c.assessment,c);bound(id,'criterion/'+i);});
      d.assumptions.forEach((a,i)=>{const id=child('assumption',i,a.text,'declared_assumption',a);bound(id,'assumption/'+i);});
      gaps(d.gaps);
    } else if(v.kind==='forecast') {
      const id=child('forecast_value','probability',String(d.probability)+' · '+d.criterion,'declared_probability',{probability:d.probability,criterion:d.criterion,cohort:d.cohort,deadline:d.deadline});bound(id,'forecast');
    } else if(v.kind==='outcome') {
      exact('decision_intelligence',d.forecast,'Pronóstico referenciado',v.targets.forecast);
      const id=child('outcome_value','result',d.value===null?'Resultado sin resolver':d.value?'Resultado positivo declarado':'Resultado negativo declarado',d.value===null?'unresolved':d.value?'declared_true':'declared_false',{value:d.value,resolvedAt:d.resolvedAt});bound(id,'outcome');
    } else if(v.kind==='precedent') {
      exact('decision_intelligence',d.review,'Revisión precedente',v.targets.review);
      exact('decision',v.targets.originDecision,'Decisión de origen',v.targets.originDecision);
      decision(d.targetDecision,v.targets.targetCase);
      const scope=child('comparison','scope','Ámbito de la comparación',d.scopeAssessment,{assessment:d.scopeAssessment});bound(scope,'comparison_scope');
      d.comparisons.forEach((c,i)=>{const id=child('comparison',i,c.assumption,c.assessment,c);bound(id,'comparison/'+i);});
    }
  } else {
    exact('retrospective',d.context,v.targets.context.title,v.targets.context);
    if(d.decision)decision(d.decision,v.targets.decision.case);
    const effect=child('effect','effect',d.effect.text,'declared_effect',d.effect);bound(effect,'effect');
    const scope=child('scope','scope',d.scope.text,'declared_scope',d.scope);bound(scope,'scope');
    for(const h of d.hypotheses) {
      const evaluation=data.hypotheses.find(x=>x.key===h.key);
      const id=child(h.kind,h.key,h.text,evaluation?.status??'unknown',{...h,reasons:evaluation?.reasons??[],evaluation},root,'alternative_explanation',{meaning:h.kind==='attributed_reason'?'Motivo atribuido a '+h.attributedTo+'; no identifica una causa.':'Hipótesis explícita; causalidad no establecida.'});
      h.evidence.forEach((e,i)=>{const eid=child('causal_evidence',h.key+'/'+i,e.quote,e.position,e,id,'declared_evidence');bound(eid,'hypothesis/'+h.key+'/'+i);});
      child('mechanism',h.key,h.mechanism??'Mecanismo no declarado',h.mechanism?'declared_mechanism':'unknown',{text:h.mechanism,method:h.method},id);
      h.assumptions.forEach((a,i)=>{const aid=child('assumption',h.key+'/'+a.key,a.text,a.assessment,a,id);bound(aid,'assumption/'+h.key+'/'+i);});
      const cf=h.counterfactual,cid=child('counterfactual',h.key,cf?.text??'Contrafactual no registrado',cf?.assessment??'unknown',cf??{text:null},id);
      if(cf)bound(cid,'counterfactual/'+h.key);
    }
    gaps(d.gaps);
  }
  provenance(root,p.source_refs);
  return root;
}

export function projectContext(unit, evidence = []) {
  const nodes = new Map(), edges = [], groups = [];
  const add = (kind, reference, title, extra = {}) => {
    const id = nodeIdentity(kind, reference);
    const prior = nodes.get(id);
    nodes.set(id, {...prior, id, kind, reference, title, ...extra});
    return id;
  };
  const edge = (from, to, kind, label, extra = {}) => {
    if (!edges.some(e => e.from === from && e.to === to && e.kind === kind)) edges.push({from,to,kind,label,...extra});
  };
  const source = ref => {
    const e = evidence.find(e => e.representationId === ref.id && e.payloadSha256 === ref.revision);
    return add('source', {id:ref.id,revision:ref.revision}, e?.conversationTitle || ref.id, {state:'literal_provenance',originalKey:e?.key ?? null,detail:e ? {role:e.role,revision:ref.revision,recordSha256:e.sha256,document:e.document??null} : {reason:'Original no localizado en esta unidad',...ref}});
  };
  const provenance = (id, refs) => { for (const ref of refs ?? []) edge(id, source(ref), 'provenance', 'Procedencia literal'); };
  const targetNode = target => {
    if (target.kind === 'source') return source(target);
    const {kind,...ref} = target;
    return add(kind === 'collective' ? 'collective' : 'reference',ref,(kindNames[kind]||'Referencia')+' · '+target.id,{state:'reference_only',detail:target});
  };
  let rootId;
  if (unit.kind === 'semantic') {
    const d=unit.data;
    for (const item of d.items) {
      const id=add('clause',item.clauseVersionId,item.text,{state:item.support,validity:item.validity,detail:item,historyTarget:{kind:'semantic',id:item.recordId,version:item.recordVersion,clauseVersionId:item.clauseVersionId}});
      rootId ??= id; provenance(id,item.sourceRefs);
    }
    for (const e of d.edges) {
      const from=nodeIdentity('clause',e.from),to=nodeIdentity('clause',e.to);
      if (!nodes.has(to)) add('clause',e.to,'Referencia ausente',{state:'unavailable',detail:e});
      edge(from,to,e.kind,e.kind,{explicit:true});
    }
  } else if (unit.kind === 'collective') {
    const data=unit.data,d=data.record.payload.collective.detail;
    rootId=add('collective',data.reference,d.title,{state:d.state,validity:data.validity,detail:d,historyTarget:{kind:'collective',...data.reference}});
    const members=d.participants.map((p,index)=>{
      const id=add('participant',{group:rootId,index},p.label,{state:'declared_role',detail:p,role:p.role});
      edge(rootId,id,'membership',p.role);edge(id,targetNode(p.target),'reference','Referencia exacta');return id;
    });
    groups.push({id:rootId,label:d.title,members,logic:'none',meaning:'La pertenencia no implica relaciones entre participantes ni conjunción.'});
    provenance(rootId,unit.sourceRefs);
  } else if (unit.kind === 'decision') {
    const d=unit.data,c=d.case,frame=c.record.payload.decision_case.case;
    rootId=add('decision',c.reference,frame.title,{state:c.brief.status,detail:c.record.payload.decision_case,historyTarget:{kind:'decision',...c.reference}});
    for (const a of d.alternatives) {
      const alternative=frame.alternatives.find(x=>x.id===a.alternativeId);
      const aid=add('alternative',{decision:rootId,id:a.alternativeId},alternative?.title||a.alternativeId,{state:a.state,detail:{...alternative,evaluation:a}});
      edge(rootId,aid,'alternative','Alternativa');
      for (const j of a.items) {
        const jid=add('justification',j.reference,j.title,{state:j.state,recordState:j.reasons?.includes('justification_withdrawn')?'withdrawn':null,validity:j.validity,detail:j,historyTarget:{kind:'justification',...j.reference}});
        edge(aid,jid,'declared_support','Sustento declarado');provenance(jid,j.sourceRefs);
        for (const r of j.requirements ?? []) {
          const rid=add('requirement',{justification:jid,id:r.id},r.text,{state:r.state,detail:r});
          edge(jid,rid,'requirement','Requisito explícito');edge(rid,targetNode(r.target),'reference','Referencia exacta');
        }
      }
    }
    provenance(rootId,c.record.payload.source_refs);
  } else if (unit.kind === 'identity') {
    for(const e of unit.data.entities){const id=add('identity',e.reference,e.label,{state:e.state,detail:e,historyTarget:{kind:'identity_entity',...e.reference}});rootId??=id;provenance(id,e.sourceRefs);}
    for(const r of unit.data.links){const id=add('identity_review',r.reference,({same:'Misma entidad declarada',different:'Entidades distintas',uncertain:'Identidad sin resolver'})[r.judgment],{state:r.effective?'declared_consolidation':r.reasons.join(', ')||'review',detail:r,historyTarget:{kind:'identity_link',...r.reference}});for(const target of [r.left,r.right]){const targetId=nodeIdentity('identity',target);if(!nodes.has(targetId))add('identity',target,'Versión anterior referenciada',{state:'historical_reference',detail:target,historyTarget:{kind:'identity_entity',...target}});edge(id,targetId,'identity_review','Comparación declarada',{effective:r.effective,judgment:r.judgment});}provenance(id,r.sourceRefs);}
    for(const g of unit.data.groups)groups.push({id:g.id,label:g.status==='conflict'?'Consolidación suspendida por conflicto':'Consolidación declarada',members:g.members.map(m=>nodeIdentity('identity',m)),logic:'reviewed_identity',meaning:'Vista reversible; conserva todos los IDs originales. No acredita verdad ni corroboración independiente.'});
  } else if (derivedKinds.has(unit.kind)) {
    rootId=projectInterpretation(unit,{add,edge,provenance});
  } else if (unit.kind==='original') {
    rootId=add('original',unit.id,unit.title,{state:'literal_provenance',detail:unit.data});
  } else {
    rootId=add('unsupported',unit.id,unit.title,{state:'unsupported_context',sourceKind:unit.kind,detail:unit.data,meaning:'Tipo no admitido por esta proyección; no se presenta como original ni como interpretación verificada.'});
  }
  for (const e of evidence) {
    const id=source({id:e.representationId,revision:e.payloadSha256});
    // The context contains this witness; this is not a semantic support edge.
    if (!edges.some(x=>x.to===id)) edge(rootId,id,'context_witness','Original del contexto');
  }
  return {rootId,nodes:[...nodes.values()],edges,groups,completeness:'not_certified',executionAuthority:false};
}
export function publicGraph(graph, {maxNodes=80,maxEdges=160}={}) {
  const counts={nodes:graph.nodes.length,edges:graph.edges.length};
  if(counts.nodes>maxNodes||counts.edges>maxEdges)return {rootId:null,nodes:[],edges:[],groups:[],counts,limited:true,reason:'whole_context_exceeds_visual_budget',completeness:'not_certified'};
  return {...graph,nodes:graph.nodes.map(({detail,historyTarget,...n})=>({...n,hasHistory:!!historyTarget})),counts,limited:false};
}
// A bounded neighborhood, with an explicit count of the hidden nodes/links.
export function neighborhood(graph, focusId=graph.rootId, offset=0, size=8) {
  const focus=graph.nodes.find(n=>n.id===focusId);
  if(!focus)return {nodes:[],edges:[],total:0,remaining:0};
  const adjacent=new Set(graph.edges.flatMap(e=>e.from===focusId?[e.to]:e.to===focusId?[e.from]:[]));
  const neighbors=graph.nodes.filter(n=>adjacent.has(n.id)),selected=neighbors.slice(offset,offset+size),ids=new Set([focusId,...selected.map(n=>n.id)]);
  return {nodes:[focus,...selected],edges:graph.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),total:neighbors.length,remaining:Math.max(0,neighbors.length-offset-size),offset};
}

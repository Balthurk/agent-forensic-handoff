import {selectedConversationIds} from './p1-web.mjs';
const panel=document.createElement('details');panel.className='retrieval-settings decision-controls';panel.id='decisionPanel';
panel.innerHTML=`<summary>Casos de decisión · opciones, motivos y resultados</summary>
<p>Compara alternativas con sus fuentes y conserva cada revisión. Una elección registrada es una declaración local; no ejecuta acciones. Las evaluaciones y los resultados siguen siendo declaraciones atribuibles.</p>
<label>Filtrar expedientes<input id="decisionQuestion" placeholder="Objetivo, alternativa o resultado"></label>
<div class="p1-actions"><button id="decisionSearch">Ver expedientes</button><button id="decisionNew">Nuevo expediente</button></div>
<p id="decisionStatus" role="status"></p><div id="decisionResults"></div>
<details id="decisionEditor"><summary>Encuadre del expediente</summary><form id="decisionForm">
<label>Identificador estable<input id="decisionId" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"></label>
<label>Título<input id="decisionTitle" required maxlength="500"></label><label>Autor del encuadre<input id="decisionActor" required value="editor local"></label>
<div id="decisionObjective"></div><h3>Restricciones obligatorias</h3><div id="decisionConstraints"></div><button type="button" id="decisionAddConstraint">Añadir restricción</button>
<h3>Criterios de comparación</h3><p>Describen diferencias; no generan puntuaciones ni eligen una alternativa.</p><div id="decisionCriteria"></div><button type="button" id="decisionAddCriterion">Añadir criterio</button>
<h3>Alternativas</h3><div id="decisionAlternatives"></div><button type="button" id="decisionAddAlternative">Añadir alternativa</button>
<h3>Supuestos</h3><div id="decisionAssumptions"></div><button type="button" id="decisionAddAssumption">Añadir supuesto</button>
<h3>Información pendiente</h3><div id="decisionGaps"></div><button type="button" id="decisionAddGap">Añadir laguna</button>
<div id="decisionExpected"></div><div id="decisionReview"></div><label>Motivo de este encuadre o revisión<textarea id="decisionReason" required maxlength="2000"></textarea></label>
<button id="decisionSave" type="submit">Guardar encuadre</button></form></details>
<details id="decisionActionEditor"><summary>Registrar una declaración o resultado</summary><p id="decisionActionBase"></p><form id="decisionActionForm">
<label>Acción<select id="decisionAction"><option value="choose">Registrar elección</option><option value="defer">Aplazar</option><option value="reject">Rechazar</option><option value="reopen">Reabrir</option><option value="result">Registrar resultado observado</option></select></label>
<label>Operador que declara<input id="decisionOperator" required value="operador local"></label><label id="decisionChoiceLabel">Alternativa<select id="decisionChoice"></select></label>
<div id="decisionDeclaration"></div><div id="decisionObserved"></div><button id="decisionActSave" type="submit">Registrar declaración</button></form></details>
<details id="decisionSourceViewer"><summary>Original de la fuente</summary><label>Fuente<select id="decisionSourcePreview"></select></label><pre id="decisionOriginal"></pre></details>`;
document.querySelector('.composer-area').prepend(panel);
const $=id=>panel.querySelector('#'+id),status=$('decisionStatus');let sources=[],base=null,actionBase=null,scopeIds=[],actionIds=[],constraints=[],criteria=[],alternatives=[],assumptions=[],gaps=[],main={},lastMutation=null,serial=0;
const states={pending_choice:'Pendiente de elección',chosen:'Elección registrada',result_recorded:'Resultado registrado',deferred:'Aplazada',rejected:'Rechazada'};
const evaluations={pass:'Cumple según declaración',fail:'No cumple según declaración',unknown:'Sin evidencia suficiente'};
function element(tag,text,parent){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;parent?.append(el);return el;}
function control(parent,caption,tag='input',id){const label=element('label',caption,parent),el=element(tag,undefined,label);if(id)el.id=id;return el;}
function button(parent,text,fn){const b=element('button',text,parent);b.type='button';b.onclick=()=>busy(b,fn);return b;}
async function busy(b,fn){b.disabled=true;try{await fn();}catch(e){status.textContent=e.message;}finally{b.disabled=false;}}
const selection=()=>[...selectedConversationIds()].sort();
function sameScope(ids){if(JSON.stringify(selection())!==JSON.stringify(ids))throw new Error('La selección de conversaciones ha cambiado. Vuelve a abrir el expediente con sus fuentes.');}
async function api(op,body={},ids=selection()){
 const response=await fetch('/api/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op,conversationIds:ids,...body})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
}
async function mutate(op,body,ids){
 const key=JSON.stringify({op,body,ids});if(lastMutation?.key!==key)lastMutation={key,id:crypto.randomUUID()};
 return api(op,{...body,requestId:lastMutation.id},ids);
}
function populate(select,preferred,userOnly=false){select.replaceChildren();for(const s of sources.filter(s=>!userOnly||s.role==='user')){const o=element('option',`${s.role} · ${s.conversationId.slice(0,8)} · ${s.text.slice(0,90)}`,select);o.value=s.id;}if(preferred)select.value=preferred;}
async function loadSources(){sources=await api('sources');populate($('decisionSourcePreview'));}
function showOriginal(id){const s=sources.find(s=>s.id===id);$('decisionSourcePreview').value=id;$('decisionOriginal').textContent=s?`${s.role} · ${s.conversationId} · ${s.eventId}\n${s.text}`:'Fuente fuera de selección';$('decisionSourceViewer').open=true;}
$('decisionSourcePreview').onchange=()=>showOriginal($('decisionSourcePreview').value);
function claimField(parent,label,value=null,userOnly=false){
 const id='decision-field-'+(++serial),box=element('fieldset',undefined,parent);element('legend',label,box);
 const text=control(box,'Descripción','textarea',id+'-text');text.rows=2;text.maxLength=4000;text.required=true;text.value=value?.text??'';
 const source=control(box,'Fuente','select',id+'-source');populate(source,value?.evidence?.[0]?.sourceId,userOnly);
 const quote=control(box,'Cita literal','textarea',id+'-quote');quote.rows=2;quote.required=true;quote.value=value?.evidence?.[0]?.quote??'';
 const start=control(box,'Posición en caracteres Unicode · opcional para citas repetidas','input',id+'-start');start.type='number';start.min='0';start.step='1';start.value=value?.evidence?.[0]?.start??'';
 button(box,'Ver original',()=>showOriginal(source.value));
 return {box,text,source,quote,start,read(){
  if(!text.value.trim()||!quote.value||!source.value)throw new Error('Completa la descripción, la fuente y su cita literal.');
  const first=value?.evidence?.[0];if(value&&first&&first.sourceId===source.value&&first.quote===quote.value&&String(first.start??'')===start.value)return {...structuredClone(value),text:text.value};
  const witness={sourceId:source.value,quote:quote.value};if(start.value!=='')witness.start=Number(start.value);
  return {...structuredClone(value??{}),text:text.value,evidence:[witness]};
 }};
}
function addRule(kind,value){
 const list=kind==='constraints'?constraints:criteria;if(list.length>=12)return;
 const f=claimField($(kind==='constraints'?'decisionConstraints':'decisionCriteria'),kind==='constraints'?'Restricción':'Criterio',value);
 f.key=value?.id??(kind==='constraints'?'restriction-':'criterion-')+crypto.randomUUID().slice(0,8);f.original=value;list.push(f);
 f.text.addEventListener('input',syncAssessments);
 button(f.box,'Quitar de la nueva versión',()=>{if(kind==='constraints')constraints=constraints.filter(x=>x!==f);else criteria=criteria.filter(x=>x!==f);f.box.remove();syncAssessments();});syncAssessments();
}
function syncAssessments(){
 for(const alt of alternatives){const active=[...constraints,...criteria];
  for(const [key,v] of alt.assessments)if(!active.some(r=>r.key===key)){v.box.remove();alt.assessments.delete(key);}
  for(const rule of active){if(alt.assessments.has(rule.key)){alt.assessments.get(rule.key).box.querySelector('summary').textContent='Evaluación · '+(rule.text.value||rule.key);continue;}const old=alt.original?.assessments?.[rule.key],box=element('details',undefined,alt.assessmentBox);element('summary','Evaluación · '+(rule.text.value||rule.key),box);
   const select=control(box,'Evaluación declarada','select');for(const [k,label] of Object.entries(evaluations)){const o=element('option',label,select);o.value=k;}select.value=old?.status??'unknown';
   const reason=claimField(box,'Razón y evidencia',old?.reason);alt.assessments.set(rule.key,{box,select,reason,original:old});
  }
 }
}
function addAlternative(value){if(alternatives.length>=10)return;const box=element('fieldset',undefined,$('decisionAlternatives'));element('legend','Alternativa',box);
 const title=control(box,'Nombre');title.required=true;title.value=value?.title??'';const mechanism=claimField(box,'Cómo funcionaría',value?.mechanism);
 const assessmentBox=element('section',undefined,box);const alt={box,title,mechanism,assessmentBox,assessments:new Map(),key:value?.id??'option-'+crypto.randomUUID().slice(0,8),original:value};alternatives.push(alt);
 button(box,'Quitar alternativa de la nueva versión',()=>{alternatives=alternatives.filter(a=>a!==alt);box.remove();});syncAssessments();
}
function addListClaim(kind,value){const list=kind==='assumptions'?assumptions:gaps;if(list.length>=12)return;const f=claimField($(kind==='assumptions'?'decisionAssumptions':'decisionGaps'),kind==='assumptions'?'Supuesto':'Información pendiente',value);list.push(f);button(f.box,'Quitar de la nueva versión',()=>{if(kind==='assumptions')assumptions=assumptions.filter(x=>x!==f);else gaps=gaps.filter(x=>x!==f);f.box.remove();});}
$('decisionAddConstraint').onclick=()=>addRule('constraints');$('decisionAddCriterion').onclick=()=>addRule('criteria');$('decisionAddAlternative').onclick=()=>addAlternative();$('decisionAddAssumption').onclick=()=>addListClaim('assumptions');$('decisionAddGap').onclick=()=>addListClaim('gaps');
async function edit(row=null){await loadSources();scopeIds=selection();base=row;const c=row?.record.payload.decision_case.case;
 $('decisionId').value=row?.reference.caseId??'';$('decisionId').readOnly=!!row;$('decisionTitle').value=c?.title??'';$('decisionReason').value='';
 for(const id of ['decisionObjective','decisionConstraints','decisionCriteria','decisionAlternatives','decisionAssumptions','decisionGaps','decisionExpected','decisionReview'])$(id).replaceChildren();
 constraints=[];criteria=[];alternatives=[];assumptions=[];gaps=[];
 main.objective=claimField($('decisionObjective'),'Objetivo',c?.objective);
 for(const v of c?.constraints??[null])addRule('constraints',v);for(const v of c?.criteria??[])addRule('criteria',v);
 for(const v of c?.alternatives??[null,null])addAlternative(v);for(const v of c?.assumptions??[])addListClaim('assumptions',v);for(const v of c?.information_gaps??[])addListClaim('gaps',v);
 main.expected=claimField($('decisionExpected'),'Resultado esperado',c?.expected_result);main.review=claimField($('decisionReview'),'Cuándo revisar la decisión',c?.review_condition);
 $('decisionSave').textContent=row?'Guardar revisión · base '+row.reference.version:'Guardar encuadre';$('decisionEditor').open=true;$('decisionActionEditor').open=false;status.textContent='Completa cada afirmación con su cita. La verificación literal no confirma la interpretación.';
}
$('decisionNew').onclick=()=>busy($('decisionNew'),()=>edit());
$('decisionForm').onsubmit=e=>{e.preventDefault();busy($('decisionSave'),async()=>{
 sameScope(scopeIds);if(!constraints.length||alternatives.length<2)throw new Error('Incluye al menos una restricción y dos alternativas.');
 const c={...structuredClone(base?.record.payload.decision_case.case??{}),title:$('decisionTitle').value,objective:main.objective.read(),constraints:constraints.map(f=>({...f.read(),id:f.key})),criteria:criteria.map(f=>({...f.read(),id:f.key})),
  alternatives:alternatives.map(a=>({...structuredClone(a.original??{}),id:a.key,title:a.title.value,mechanism:a.mechanism.read(),assessments:Object.fromEntries([...a.assessments].map(([k,v])=>[k,{...structuredClone(v.original??{}),status:v.select.value,reason:v.reason.read()}]))})),
  assumptions:assumptions.map(f=>f.read()),information_gaps:gaps.map(f=>f.read()),expected_result:main.expected.read(),review_condition:main.review.read()};
 const row=await mutate('frame',{id:$('decisionId').value,case:c,actor:$('decisionActor').value,statement:$('decisionReason').value,expectedVersion:base?.reference.version??0,...(base?{binding:base.reference}:{})},scopeIds);
 base=row;$('decisionEditor').open=false;renderResults([row]);status.textContent='Encuadre guardado · versión '+row.reference.version+'. Aún no hay elección.';
 });};
let declaration,observed;
async function openAction(row,action='choose'){
 await loadSources();actionBase=row;actionIds=selection();$('decisionActionBase').textContent=row.record.payload.decision_case.case.title+' · versión '+row.reference.version+' · '+states[row.brief.status];
 $('decisionChoice').replaceChildren();for(const alt of row.brief.alternatives.filter(a=>a.eligibility==='eligible')){const o=element('option',alt.title,$('decisionChoice'));o.value=alt.id;}
 $('decisionDeclaration').replaceChildren();$('decisionObserved').replaceChildren();declaration=claimField($('decisionDeclaration'),'Declaración del operador y cita de usuario',null,true);declaration.text.maxLength=2000;observed=claimField($('decisionObserved'),'Resultado observado con fuente');
 $('decisionAction').value=action;updateAction();$('decisionActionEditor').open=true;$('decisionEditor').open=false;
}
function updateAction(){const action=$('decisionAction').value;$('decisionObserved').hidden=action!=='result';observed.box.disabled=action!=='result';$('decisionChoiceLabel').hidden=action!=='choose';$('decisionActSave').textContent=action==='result'?'Vincular resultado a esta elección':'Registrar declaración';}
$('decisionAction').onchange=updateAction;
$('decisionActionForm').onsubmit=e=>{e.preventDefault();busy($('decisionActSave'),async()=>{
 sameScope(actionIds);const action=$('decisionAction').value,c=declaration.read(),detail={actor:$('decisionOperator').value,actorKind:'local_operator',statement:c.text,evidence:c.evidence};
 if(action==='choose')detail.alternativeId=$('decisionChoice').value;if(action==='result'){detail.observed=observed.read();detail.choiceBinding=actionBase.reference;}
 const row=await mutate('act',{id:actionBase.reference.caseId,action,detail,binding:actionBase.reference,expectedVersion:actionBase.reference.version},actionIds);
 $('decisionActionEditor').open=false;renderResults([row]);status.textContent=states[row.brief.status]+' · versión '+row.reference.version+'. Historial conservado.';
 });};
function renderResults(rows){$('decisionResults').replaceChildren();for(const row of rows)render(row,$('decisionResults'));}
function render(row,parent,actions=true){const d=row.record.payload.decision_case,c=d.case,card=element('article',undefined,parent);card.className='semantic-record';element('h3',c.title,card);element('p',states[d.status]+' · versión '+row.reference.version+' · '+row.record.recorded_at,card);element('p','Objetivo: '+c.objective.text,card);
 const table=element('table',undefined,card),head=element('tr',undefined,element('thead',undefined,table));for(const label of ['Alternativa','Restricciones',...c.constraints.map(x=>x.text),...(c.criteria??[]).map(x=>x.text)])element('th',label,head);
 const tbody=element('tbody',undefined,table);for(const a of row.brief.alternatives){const tr=element('tr',undefined,tbody);element('td',a.title+(d.choice===a.id?' · elegida':''),tr);element('td',{eligible:'Viable según evaluación',excluded:'Excluida por restricción',needs_evidence:'Falta evidencia'}[a.eligibility],tr);const original=c.alternatives.find(v=>v.id===a.id);for(const key of [...c.constraints,...(c.criteria??[])].map(r=>r.id)){const cell=element('td',evaluations[a.assessments[key]],tr);element('p',original.assessments[key].reason.text,cell);}}
 if(d.outcome)element('p','Resultado declarado: '+d.outcome.observed.text+' · asociado a la elección de la versión '+d.outcome.choiceBinding.version+'. No demuestra causalidad general.',card);
 element('p','Supuestos: '+(c.assumptions.map(x=>x.text).join(' · ')||'Ninguno registrado'),card);element('p','Pendiente: '+(c.information_gaps.map(x=>x.text).join(' · ')||'Sin lagunas registradas; no acredita completitud'),card);element('p','Revisar cuando: '+c.review_condition.text,card);
 const quotes=element('details',undefined,card);element('summary','Fuentes y citas de esta versión',quotes);for(const [field,ws] of Object.entries(d.bindings)){element('strong',field,quotes);for(const w of ws)element('blockquote',w.quote+' — '+w.sourceRole+' · '+w.sourceConversationId,quotes);}
 if(actions){const bar=element('div',undefined,card);bar.className='p1-actions';button(bar,'Historial',async()=>{const history=await api('history',{id:row.reference.caseId});const section=element('details',undefined,card);section.open=true;element('summary',history.length+' versiones verificadas',section);for(const old of history)render(old,section,false);});
  if(['pending_choice','deferred','rejected'].includes(d.status))button(bar,'Revisar encuadre',async()=>edit(await api('get',{id:row.reference.caseId})));
  button(bar,'Registrar declaración o resultado',()=>openAction(row,d.status==='chosen'?'result':d.status==='result_recorded'?'reopen':'choose'));
 }
}
$('decisionSearch').onclick=()=>busy($('decisionSearch'),async()=>{const p=await api('list',{question:$('decisionQuestion').value});renderResults(p.items);status.textContent=`${p.items.length} expedientes · ${p.outsideSelection} fuera de selección · ${p.omittedByBudget+p.omittedByLimit} omitidos por límites. ${p.errors.length?'Consulta incompleta: '+p.errors.map(e=>e.error).join('; '):'Fuentes verificadas; evaluaciones declaradas.'}`;});

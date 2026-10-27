import {selectedConversationIds} from './p1-web.mjs';
const panel=document.createElement('details');panel.className='retrieval-settings learning-controls';
panel.innerHTML=`<summary>Aprendizajes · fallos, reparaciones y límites</summary>
<p>Encuentra precedentes en las conversaciones seleccionadas. Cada aprendizaje conserva sus condiciones y contraejemplos; debes valorar su aplicación al caso actual.</p>
<label>Qué quieres resolver<input id="learningQuestion" placeholder="Por ejemplo: guardar un CSV bloqueado"></label>
<div class="p1-actions"><button id="learningSearch">Buscar precedentes</button><button id="learningLoadSources" data-access-action="POST /api/learning#record">Cargar fuentes para registrar</button></div>
<p id="learningStatus" role="status"></p><div id="learningResults"></div>
<details id="learningEditor" data-access-action="POST /api/learning#record"><summary>Registrar un aprendizaje con evidencia</summary>
<p>Es una observación declarada. Las citas se verifican; la interpretación y el procedimiento permanecen propuestos. Al registrar una cita nueva, elige un fragmento que aparezca una sola vez en su fuente.</p>
<form id="learningForm"><label>Identificador estable<input id="learningId" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" placeholder="csv-bloqueado"></label>
<label>Título<input id="learningTitle" required maxlength="500"></label><div id="learningFields"></div>
<label>Resultado declarado, respaldado por la cita de observación<select id="learningOutcome"><option value="unknown">Desconocido</option><option value="failure">Fallo</option><option value="success">Éxito</option></select></label>
<div id="learningCounterexamples"></div><button type="button" id="learningAddCounterexample">Añadir contraejemplo</button>
<p>Sin contraejemplos registrados no se concluye que no existan.</p>
<label>Motivo de la versión<input id="learningReason" value="Registro inicial" required></label>
<button type="submit" id="learningSave">Guardar propuesta</button><button type="button" id="learningNew">Nuevo aprendizaje</button></form></details>
<details><summary>Original seleccionado</summary><label>Fuente<select id="learningSourcePreview"></select></label><pre id="learningOriginal"></pre></details>`;
document.querySelector('.composer-area').prepend(panel);
const $=id=>panel.querySelector('#'+id),status=$('learningStatus');let sources=[],version=0,requestId=crypto.randomUUID(),originalEpisode=null;
const fieldLabels={condition:'Condición de aplicación',action:'Acción',failure:'Fallo observado',observation:'Observación del resultado',repair:'Reparación',hypothesis:'Hipótesis',procedure:'Procedimiento propuesto'};
const fields=new Map();let counters=[];
async function api(op,body={}){const response=await fetch('/api/learning',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op,conversationIds:selectedConversationIds(),...body})});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;}
function populate(select,preferred){select.replaceChildren();for(const s of sources){const o=document.createElement('option');o.value=s.id;o.textContent=s.role+' · '+s.conversationId.slice(0,8)+' · '+s.text.slice(0,90);select.append(o);}if(preferred)select.value=preferred;}
function makeField(key,label,required=false,parent=$('learningFields')){
 const box=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent=label+(required?' *':' · opcional');box.append(legend);
 function control(caption,tag,id){const l=document.createElement('label');l.textContent=caption;const e=document.createElement(tag);e.id=id;l.append(e);box.append(l);return e;}
 const text=control('Interpretación','textarea','learning-'+key+'-text');text.rows=2;text.required=required;text.maxLength=8000;
 const source=control('Fuente','select','learning-'+key+'-source');populate(source);
 const quote=control('Cita literal que la respalda','textarea','learning-'+key+'-quote');quote.rows=2;quote.required=required;
 const view=document.createElement('button');view.type='button';view.textContent='Ver original';view.onclick=()=>showOriginal(source.value);box.append(view);parent.append(box);
 return {box,text,source,quote,original:null};
}
for(const [key,label] of Object.entries(fieldLabels))fields.set(key,makeField(key,label,['condition','action','observation'].includes(key)));
function showOriginal(id){const s=sources.find(v=>v.id===id);$('learningSourcePreview').value=id;$('learningOriginal').textContent=s?`${s.role} · ${s.conversationId} · ${s.eventId}\n${s.text}`:'Fuente fuera de la selección actual';$('learningOriginal').closest('details').open=true;}
$('learningSourcePreview').onchange=()=>showOriginal($('learningSourcePreview').value);
async function loadSources(){sources=await api('sources');for(const f of [...fields.values(),...counters])populate(f.source,f.source.value);populate($('learningSourcePreview'));status.textContent=sources.length+' fuentes verificadas. Copia citas exactas del original.';return sources;}
async function busy(button,fn){button.disabled=true;try{await fn();}catch(e){status.textContent=e.message;}finally{button.disabled=false;}}
$('learningLoadSources').onclick=()=>busy($('learningLoadSources'),loadSources);
function addCounter(value){const f=makeField('counter-'+crypto.randomUUID(),'Contraejemplo',true,$('learningCounterexamples'));counters.push(f);const remove=document.createElement('button');remove.type='button';remove.textContent='Quitar este contraejemplo de la nueva versión';remove.onclick=()=>{counters=counters.filter(c=>c!==f);f.box.remove();};f.box.append(remove);if(value)fill(f,value);}
$('learningAddCounterexample').onclick=()=>{if(counters.length<12)addCounter();};
function fill(f,value){f.original=value?structuredClone(value):null;f.text.value=value?.text??'';f.quote.value=value?.evidence?.[0]?.quote??'';populate(f.source,value?.evidence?.[0]?.sourceId);}
function value(f){if(!f.text.value.trim()&&!f.quote.value.trim())return null;if(!f.text.value.trim()||!f.quote.value||!f.source.value)throw new Error('Cada campo necesita interpretación, fuente y cita literal.');
 // Preserve all witnesses and extension fields when an existing field is untouched.
 const old=f.original;if(old&&old.text===f.text.value&&old.evidence?.[0]?.quote===f.quote.value&&old.evidence?.[0]?.sourceId===f.source.value)return structuredClone(old);
 return {...old,text:f.text.value,evidence:[{sourceId:f.source.value,quote:f.quote.value}]};}
function reset(){version=0;requestId=crypto.randomUUID();originalEpisode=null;$('learningId').readOnly=false;$('learningId').value='';$('learningTitle').value='';$('learningReason').value='Registro inicial';$('learningOutcome').value='unknown';for(const f of fields.values())fill(f,null);$('learningCounterexamples').replaceChildren();counters=[];$('learningSave').textContent='Guardar propuesta';}
$('learningNew').onclick=reset;
async function edit(id){await loadSources();const r=await api('get',{id});originalEpisode=r.payload.learning_episode.episode;version=r.version;requestId=crypto.randomUUID();$('learningId').value=originalEpisode.id;$('learningId').readOnly=true;$('learningTitle').value=originalEpisode.title;$('learningOutcome').value=originalEpisode.outcome.value;$('learningReason').value='';for(const [k,f] of fields)fill(f,originalEpisode[k]);$('learningCounterexamples').replaceChildren();counters=[];for(const c of originalEpisode.counterexamples)addCounter(c);$('learningEditor').open=true;$('learningSave').textContent='Guardar nueva versión · base '+version;}
$('learningForm').onsubmit=event=>{event.preventDefault();busy($('learningSave'),async()=>{
 const episode={...originalEpisode,id:$('learningId').value,title:$('learningTitle').value};for(const [key,f] of fields)episode[key]=value(f);
 episode.counterexamples=counters.map(value);episode.outcome=originalEpisode&&originalEpisode.outcome.value===$('learningOutcome').value&&JSON.stringify(episode.observation)===JSON.stringify(originalEpisode.observation)?structuredClone(originalEpisode.outcome):{value:$('learningOutcome').value,evidence:episode.observation.evidence};
 const row=await api('record',{episode,expectedVersion:version,requestId,reason:$('learningReason').value});version=row.version;originalEpisode=row.payload.learning_episode.episode;requestId=crypto.randomUUID();for(const [k,f] of fields)fill(f,originalEpisode[k]);counters.forEach((f,i)=>fill(f,originalEpisode.counterexamples[i]));$('learningId').readOnly=true;$('learningSave').textContent='Guardar nueva versión · base '+version;status.textContent='Propuesta guardada · versión '+version+'. La aprobación y la aplicabilidad al caso siguen pendientes.';
 });};
function renderRecord(r,parent,buttons=true){const l=r.payload.learning_episode,e=l.episode,card=document.createElement('article');card.className='semantic-record';const title=document.createElement('h3');title.textContent=e.title;card.append(title);const info=document.createElement('p');info.textContent='Versión '+r.version+' · resultado declarado: '+e.outcome.value+' · procedimiento propuesto';card.append(info);
 for(const [key,label] of Object.entries(fieldLabels)){if(!e[key])continue;const line=document.createElement('p'),strong=document.createElement('strong');strong.textContent=label+': ';line.append(strong,document.createTextNode(e[key].text));card.append(line);}
 const limits=document.createElement('p');limits.textContent=e.counterexamples.length?'Contraejemplos: '+e.counterexamples.map(c=>c.text).join(' · '):'Contraejemplos aún no registrados; no se demuestra su ausencia.';card.append(limits);
 const detail=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Ver citas y registro completo';detail.append(summary);const raw=document.createElement('pre');raw.textContent=JSON.stringify(r,null,2);detail.append(raw);card.append(detail);
 if(buttons){const history=document.createElement('button');history.textContent='Historial';history.onclick=()=>busy(history,async()=>{const rows=await api('history',{id:e.id});const h=document.createElement('section');for(const old of rows)renderRecord(old,h,false);card.append(h);});const correction=document.createElement('button');correction.textContent='Añadir corrección';correction.dataset.accessAction='POST /api/learning#record';correction.onclick=()=>busy(correction,()=>edit(e.id));card.append(history,correction);}parent.append(card);}
$('learningSearch').onclick=()=>busy($('learningSearch'),async()=>{const r=await api('query',{question:$('learningQuestion').value});$('learningResults').replaceChildren();for(const item of r.items)renderRecord(item.record,$('learningResults'));status.textContent=`${r.items.length} precedentes · ${r.bytes} / ${r.maxBytes} bytes · ${r.outsideSelection} fuera de selección · ${r.omittedByLimit+r.omittedByBudget} omitidos. ${r.errors.length?'Consulta incompleta: '+r.errors.map(e=>e.error).join('; '):'Requieren revisión de condiciones para el caso actual.'}`;});

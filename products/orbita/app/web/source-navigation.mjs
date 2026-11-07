// Omission keys use the existing conversation:event contract. Never guess when
// more than one selected source matches, and never open outside that selection.
export function omissionSource(omission,memory){
 if(typeof omission?.seed!=='string')return null;
 const matches=(memory?.sources||[]).filter(s=>typeof s.conversationId==='string'&&omission.seed.startsWith(s.conversationId+':'));
 if(matches.length!==1)return null;
 const source=matches[0],id=omission.seed.slice(source.conversationId.length+1);
 if(!id||!/^[a-f0-9]{64}$/.test(source.caseHash||''))return null;
 return {conversationId:source.conversationId,id,revision:source.caseHash,conversationTitle:source.title||source.conversationId,evidenceId:'fuente omitida',omitted:true};
}

export function omissionExplanation(reason){
 if(reason==='budget')return 'El mensaje completo y sus dependencias no caben en el presupuesto restante. No se ha recortado su contenido.';
 if(reason==='missing_dependency')return 'Falta una dependencia necesaria. El episodio completo queda fuera del contexto; leer el original no resuelve esa falta.';
 return 'Esta fuente no forma parte del contexto recuperado. Consulta el motivo y sus límites en el recibo.';
}

export function renderOmissions(memory,panel,openOriginal){
 if(!memory.omissionSummary?.total)return;
 const section=document.createElement('section');section.className='source-omissions';section.setAttribute('aria-label','Fuentes omitidas');
 const heading=document.createElement('h3');heading.textContent='Fuentes fuera del contexto';section.append(heading);
 const note=document.createElement('p');note.textContent='Puedes leer los originales completos. Esta lectura manual no los añade a la respuesta ni acredita cobertura completa.';section.append(note);
 for(const omission of memory.omissions||[]){
  const row=document.createElement('article'),source=omissionSource(omission,memory),why=document.createElement('p');
  why.textContent=omissionExplanation(omission.reason);row.append(why);
  if(source){const button=document.createElement('button');button.type='button';button.textContent='Abrir original completo · '+source.conversationTitle;button.onclick=()=>openOriginal(source);row.append(button);}
  else{const unavailable=document.createElement('p');unavailable.textContent='No hay un localizador inequívoco disponible para abrir esta omisión.';row.append(unavailable);}
  if(omission.missingCount){const missing=document.createElement('small');missing.textContent=omission.missingCount+' dependencias no disponibles';row.append(missing);}
  section.append(row);
 }
 if(memory.omissionSummary.detailsOmitted){const more=document.createElement('p');more.textContent=memory.omissionSummary.detailsOmitted+' omisiones adicionales sin detalle en este recibo acotado. Reduce la selección de fuentes o concreta la consulta para examinarlas.';section.append(more);}
 panel.append(section);
}

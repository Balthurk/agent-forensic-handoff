// Explicit synthetic corpus for regression and the local verification demo.
export const userText='Quiero conservar los originales y poder restaurar una copia. Comparo una copia local con una copia remota. Ambas conservan los originales según la prueba inicial. La rapidez es un criterio. Dispongo de disco local. Falta medir la copia remota. Espero recuperar los doce archivos. Revisaré la elección después de la restauración. Elijo la copia local para esta prueba. Reabro el caso después de revisar el resultado.';
export const resultText='La prueba local restauró doce archivos con hashes idénticos. La prueba remota está pendiente. Esto es un resultado de prueba, no demuestra causalidad general.';
export function exportConversation(id,text,role='user'){
 return {filename:id+'.json',content:JSON.stringify({id,title:'F26 · '+id,current_node:'m',mapping:{m:{id:'m',parent:null,children:[],message:{id:'m',author:{role},content:{content_type:'text',parts:[text]}}}}})};
}
export function decisionFixture(sources){
 const u=sources.find(s=>s.text===userText);if(!u)throw new Error('FIXTURE_SOURCE_REQUIRED');
 const claim=(text,quote)=>({text,evidence:[{sourceId:u.id,quote}]});
 return {title:'Conservar y restaurar una copia',objective:claim('Restaurar una copia sin tocar originales','Quiero conservar los originales y poder restaurar una copia'),
  constraints:[{id:'originals',...claim('Conservar los originales','conservar los originales')}],
  criteria:[{id:'speed',...claim('Rapidez de recuperación','La rapidez es un criterio')}],
  alternatives:['local','remote'].map((id,i)=>({id,title:i?'Copia remota':'Copia local',mechanism:claim(i?'Copiar en almacén remoto':'Copiar en disco local','Comparo una copia local con una copia remota'),assessments:{originals:{status:'pass',reason:claim('Conservación declarada en prueba inicial','Ambas conservan los originales según la prueba inicial')},speed:{status:'unknown',reason:claim('Todavía falta comparación medida','Falta medir la copia remota')}}})),
  assumptions:[claim('Hay disco local disponible','Dispongo de disco local')],information_gaps:[claim('Rendimiento remoto sin medir','Falta medir la copia remota')],
  expected_result:claim('Recuperar doce archivos','Espero recuperar los doce archivos'),review_condition:claim('Revisar después de restaurar','Revisaré la elección después de la restauración'),extension:{testOnly:true,preserved:'á 🧠'}};
}
export function actionFixture(sources,action='choose'){
 const u=sources.find(s=>s.text===userText),r=sources.find(s=>s.text===resultText);
 const detail={actor:'operador de prueba',actorKind:'local_operator',statement:action==='reopen'?'Reapertura declarada después de revisión':'Elección local declarada para prueba',evidence:[{sourceId:u.id,quote:action==='reopen'?'Reabro el caso después de revisar el resultado':'Elijo la copia local para esta prueba'}]};
 if(action==='choose')detail.alternativeId='local';
 if(action==='result')detail.observed={text:'Doce archivos restaurados con hashes idénticos',evidence:[{sourceId:r.id,quote:'La prueba local restauró doce archivos con hashes idénticos'}]};
 return detail;
}

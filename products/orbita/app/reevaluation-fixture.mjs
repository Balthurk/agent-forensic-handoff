// Synthetic test corpus. These deterministic drafts verify mechanics, not LLM quality.
export const original='Ella llegó a la reunión.';
export const late='En mi mensaje «Ella llegó a la reunión», con «Ella» me refería a Ana.';
export const conversation=(id,text)=>({filename:id+'.json',content:JSON.stringify({id,title:'F29 · '+id,current_node:'m',mapping:{m:{id:'m',parent:null,children:[],message:{id:'m',author:{role:'user'},content:{content_type:'text',parts:[text]}}}}})});
export function draft(source,key='arrival') {return {acts:[{key,targetSourceId:source.id,type:'fact',summary:source.text,modality:'stated',clauses:[{key,quote:source.text,predicate:'llegar',polarity:'positive',resolution:'insufficient_context',arguments:[{role:'subject',literal:'Ella',interpreted:'',evidence:[{sourceId:source.id,quote:source.text}]}],conditions:[],temporal:[],relations:[]}]}]};}
export function reviewOutput(packet,disposition='changed'){
 if(disposition!=='changed')return {disposition,reason:'Resultado sintético para comprobar persistencia sin cambios',summary:'',clauses:[]};
 const c=packet.target.payload.semantic_unit.clauses[0],s=packet.originals.find(s=>packet.newSourceIds.includes(s.id));const evidence=[{sourceId:s.id,quote:s.text}];
 return {disposition:'changed',reason:'Antecedente tardío explícito de la fuente',summary:'Ana llegó a la reunión.',clauses:[{clauseId:c.semantic_clause_id,predicate:c.predicate.value,resolution:'resolved',arguments:[{index:0,interpreted:'Ana',evidence}],evidence}]};
}

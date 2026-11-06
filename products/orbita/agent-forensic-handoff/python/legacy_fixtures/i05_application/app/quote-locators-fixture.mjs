// Synthetic A10 drafts exercise admission mechanics; they are not model-quality evidence.
export const unicodeText='😀·e\u0301|aaa|aaa';
export const lateText='😀 Ella significa Ana. | Ella significa Ana.';
export const lateQuote='Ella significa Ana.';
export const codepointLastIndex=(text,quote)=>Array.from(text.slice(0,text.lastIndexOf(quote))).length;
export function locatedDraft(sourceId,{key='located',quote='aaa',start=9}={}){
 const evidence=[{sourceId,quote,start}];
 return {acts:[{key,targetSourceId:sourceId,type:'fact',summary:quote,modality:'stated',clauses:[{
  key,quote,start,predicate:'contenido literal sintético',polarity:'positive',resolution:'resolved',
  arguments:[{role:'literal_content',literal:quote,interpreted:'',evidence}],conditions:[],temporal:[],relations:[]
 }]}],gaps:[]};
}

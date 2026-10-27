// Preserve all existing witnesses when the displayed first witness is unchanged,
// regardless of JSON member order or additional provenance fields.
export function preserveEvidence(prior,first){
 const old=prior?.[0];
 return old&&old.sourceId===first.sourceId&&old.quote===first.quote&&(old.start??null)===(first.start??null)?structuredClone(prior):[first];
}
export function sameTarget(a,b){return ['kind','id','revision','version','digest'].every(k=>a?.[k]===b?.[k]);}

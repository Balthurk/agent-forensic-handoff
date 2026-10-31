// Internal hints from verified full-text projections. These select candidates;
// they never establish a relation, support, applicability or action authority.
export const DISCOVERY_LIMIT=60;
const demand=(ok,code)=>{if(!ok)throw new Error('CONTEXT_DISCOVERY_'+code);};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const key=seed=>JSON.stringify([seed.sourceId,seed.revision]);
const compare=(a,b)=>b.similarity-a.similarity||key(a).localeCompare(key(b))||JSON.stringify(a).localeCompare(JSON.stringify(b));
function validSeed(seed){
 demand(seed&&typeof seed==='object'&&!Array.isArray(seed),'SEED');
 demand(Object.keys(seed).sort().join(',')==='caseHash,conversationId,projectionId,revision,similarity,sourceId','SEED_FIELDS');
 demand(identifier(seed.sourceId)&&identifier(seed.conversationId)&&identifier(seed.projectionId)&&seed.projectionId.startsWith('sem-'),'IDENTITY');
 demand(sha(seed.revision)&&sha(seed.caseHash),'REVISION');
 demand(typeof seed.similarity==='number'&&Number.isFinite(seed.similarity)&&seed.similarity>=.35&&seed.similarity<=1.000001,'SIMILARITY');
}
export function semanticSeeds(result,messages,{conversationId,caseHash}){
 demand(Array.isArray(result.results)&&result.results.length<=DISCOVERY_LIMIT,'HIT_BUDGET');
 const eligible=new Map(messages.map(m=>[m.id,m])),seeds=[];
 for(const hit of result.results){
  const source=eligible.get(hit.id);if(!source)continue;
  const range=hit.semanticRange,points=[...source.text];
  demand(range&&range.representationId===source.representationId&&range.rangeUnit==='unicode_codepoints','REPRESENTATION');
  demand(Number.isSafeInteger(range.start)&&Number.isSafeInteger(range.end)&&range.start>=0&&range.end>range.start&&range.end<=points.length,'RANGE');
  demand(points.slice(range.start,range.end).join('')===hit.semanticText,'TEXT');
  demand(hit.explanation?.projectionId===result.projectionId,'PROJECTION');
  const seed={sourceId:source.representationId,revision:source.payloadSha256,conversationId,caseHash,projectionId:result.projectionId,similarity:hit.explanation.cosineSimilarity};
  validSeed(seed);seeds.push(seed);
 }
 return seeds;
}
export function contextDiscovery(candidates,queryHints=[]){
 demand(Array.isArray(candidates)&&candidates.length<=1200,'CANDIDATE_BUDGET');
 if(!candidates.length)return null;
 const unique=new Map();for(const seed of candidates){validSeed(seed);const prior=unique.get(key(seed));if(!prior||compare(seed,prior)<0)unique.set(key(seed),seed);}
 const seeds=[...unique.values()].sort(compare),hints=[...new Set(queryHints)];
 demand(hints.length<=60&&hints.every(h=>typeof h==='string'&&h.trim()&&h.length<=160),'HINTS');
 return {schema:'afh.context-discovery.v1',channel:'semantic_full_text',seedLimit:DISCOVERY_LIMIT,candidateCount:seeds.length,omittedSeeds:Math.max(0,seeds.length-DISCOVERY_LIMIT),queryHints:hints,seeds:seeds.slice(0,DISCOVERY_LIMIT)};
}
export function validateDiscovery(discovery,sources){
 if(discovery==null)return null;
 demand(discovery&&typeof discovery==='object'&&!Array.isArray(discovery),'OBJECT');
 demand(Object.keys(discovery).sort().join(',')==='candidateCount,channel,omittedSeeds,queryHints,schema,seedLimit,seeds','FIELDS');
 demand(discovery.schema==='afh.context-discovery.v1'&&discovery.channel==='semantic_full_text'&&discovery.seedLimit===DISCOVERY_LIMIT,'SCHEMA');
 const {seeds,candidateCount,omittedSeeds,queryHints}=discovery;
 demand(Array.isArray(seeds)&&seeds.length>0&&seeds.length<=DISCOVERY_LIMIT,'SEED_BUDGET');
 demand(Number.isSafeInteger(candidateCount)&&candidateCount>=seeds.length&&candidateCount<=1200&&Number.isSafeInteger(omittedSeeds)&&omittedSeeds===candidateCount-seeds.length,'COUNTS');
 demand(Array.isArray(queryHints)&&queryHints.length<=60&&new Set(queryHints).size===queryHints.length&&queryHints.every(h=>typeof h==='string'&&h.trim()&&h.length<=160),'HINTS');
 const selected=new Map(sources.filter(s=>!s.aliasOf).map(s=>[s.id,s])),seen=new Set();
 for(const seed of seeds){
  validSeed(seed);demand(!seen.has(key(seed)),'DUPLICATE');seen.add(key(seed));
  const source=selected.get(seed.sourceId);
  demand(source&&source.revision===seed.revision&&source.conversationId===seed.conversationId&&source.caseHash===seed.caseHash,'SOURCE_BINDING');
 }
 return discovery;
}

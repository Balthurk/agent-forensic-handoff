import fs from 'node:fs';
import {createHash} from 'node:crypto';
export const SEMANTIC_TYPES=Object.freeze(['fact','belief','preference','goal','constraint','criterion','policy','plan','alternative','decision','rationale','prediction','action','outcome','consequence','feedback','question','unknown']);
export const CATALOG_SHA256='fdc85713bec8687182e09105dd523fd869d15cc87e54f7d53ef5f7ab6e9c7b38';
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function loadTaxonomy(){
 const bytes=fs.readFileSync(new URL('../schemas/tsm-catalog.v1.json',import.meta.url));
 if(createHash('sha256').update(bytes).digest('hex')!==CATALOG_SHA256)throw new Error('TAXONOMY_HASH_MISMATCH');
 return {...JSON.parse(bytes),sha256:CATALOG_SHA256};
}
function text(v,name,max=20000){if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error('Invalid '+name);return v;}
// Unknown extension fields survive round trips. Reserved authority fields cannot be supplied.
export function validateProposal(input,{taxonomy=loadTaxonomy()}={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid proposal');
 const r=JSON.parse(JSON.stringify(input,(_key,value)=>{if(typeof value==='undefined'||typeof value==='function'||typeof value==='symbol'||typeof value==='number'&&!Number.isFinite(value))throw new Error('Non-JSON proposal field');return value;}));text(r.id,'id',128);if(!/^[a-zA-Z0-9_-]+$/.test(r.id))throw new Error('Invalid id');
 if(!SEMANTIC_TYPES.includes(r.type))throw new Error('Invalid semantic type');text(r.text,'text');text(r.scope,'scope',200);
 if(!r.actor||typeof r.actor!=='object')throw new Error('Missing actor');text(r.actor.id,'actor.id',200);text(r.actor.role,'actor.role',100);
 if(!['reported','asserted','inferred','desired','hypothetical','unknown'].includes(r.modality))throw new Error('Invalid modality');
 if(r.status!=='proposed')throw new Error('Only proposed records are supported');
 for(const key of ['approval','approved','verified','semanticSupport','truth','signature','sourceBinding','schema','taxonomy','proposer','createdAt','payloadSha256'])if(key in r)throw new Error('Reserved authority field: '+key);
 if(!Array.isArray(r.source_refs)||!r.source_refs.length||r.source_refs.length>20)throw new Error('Source references required (1..20)');
 for(const ref of r.source_refs){text(ref.conversationId,'conversationId',128);text(ref.eventId,'eventId',200);text(ref.revision,'revision',128);
   text(ref.quote,'quote',20000);if(!Number.isSafeInteger(ref.start)||ref.start<0||!Number.isSafeInteger(ref.end)||ref.end<=ref.start)throw new Error('Invalid codepoint range');}
 const ids=new Set(taxonomy.nodes.filter(n=>n.selectable).map(n=>n.id));
 if(r.labels==null)r.labels=[];if(!Array.isArray(r.labels)||r.labels.some(x=>!ids.has(x)))throw new Error('Unknown taxonomy label');
 if(r.facets==null)r.facets={};if(typeof r.facets!=='object'||Array.isArray(r.facets))throw new Error('Invalid facets');
 for(const [id,values] of Object.entries(r.facets)){const facet=taxonomy.facets.find(f=>f.id===id);if(!facet||!Array.isArray(values)||values.some(v=>!facet.values.some(x=>x.id===v)))throw new Error('Unknown facet value');}
 if(Buffer.byteLength(JSON.stringify(r))>100000)throw new Error('Proposal exceeds 100000 bytes');return r;
}

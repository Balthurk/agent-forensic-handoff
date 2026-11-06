import {importDocument} from './documents.mjs';
import {verifiedSources,knowledgeOperation} from './knowledge.mjs';
import {graphOperation} from './graph-publication.mjs';
export async function graphFixture(){
 const a=await importDocument({documentId:'graph-a',filename:'graph-a.md',content:'Norma sintética: revisar contexto antes de decidir.'}),b=await importDocument({documentId:'graph-b',filename:'graph-b.md',content:'Excepción sintética: suspender la revisión si falta el original.'});const ids=[a.id,b.id],ctx=await verifiedSources(ids);let prior;
 for(let i=0;i<2;i++){const source=ctx.sources.find(s=>s.conversationId===ids[i]);const relations=prior?[{kind:'exception',targetClauseVersionId:prior,evidence:[{sourceId:source.id,quote:source.text}]}]:[];const draft={acts:[{key:'rule-'+i,targetSourceId:source.id,type:'policy',summary:source.text,modality:'directive',clauses:[{key:'rule',quote:source.text,predicate:'revisar_contexto',polarity:i?'negative':'positive',resolution:'resolved',arguments:[],conditions:[],temporal:[],relations}]}]};const r=await knowledgeOperation('extract',ids,{draft,producer:'synthetic-fixture',sourceCut:ctx.cut,requestId:'graph-fixture-'+i});if(r.errors.length)throw new Error(JSON.stringify(r.errors));prior=r.records[0].payload.semantic_unit.clauses[0].clause_version_id;}
 const status=await graphOperation('status',{conversationIds:ids});return {ids,entry:status.entries[0]};
}

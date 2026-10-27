// Local synthetic records, including adverse positions; never human acceptance.
import {createHash} from 'node:crypto';
import {causalFixture} from './causal-fixture.mjs';
import {importDocument} from './documents.mjs';
import {verifiedSources} from './knowledge.mjs';
import {retrospectiveOperation} from './retrospectives.mjs';
import {intelligenceOperation} from './decision-intelligence.mjs';
import {causalOperation} from './causal.mjs';

export async function explorerDerivedFixture(){
  const f=await causalFixture(),literal='Ana declaró recepción el 2020-01-01. Ana negó recepción el 2020-01-01. Fixture sintética, sin conocimiento personal acreditado.';
  const doc=await importDocument({documentId:'explorer-i01-attribution',filename:'attribution.md',content:literal,metadata:{title:'Recepciones atribuidas sintéticas'}});
  f.ids.push(doc.id);
  const extra=(await verifiedSources(f.ids)).sources.find(s=>s.text===literal),at=new Date().toISOString();
  const rd={...f.context.record.payload.retrospective.detail,sourceCut:at,actor:'audit-editor',reason:'Conservar posiciones y recepciones incompatibles',claims:[...f.context.record.payload.retrospective.detail.claims,{key:'adverse',text:'Afirmación contraria declarada',position:'contradicts',evidence:f.evidence}],personalReports:['received','denied'].map(report=>({person:'Ana',at:'2020-01-01T00:00:00Z',dateLiteral:'2020-01-01',report,evidence:[{sourceId:extra.id,quote:literal}]}))};
  f.context=await retrospectiveOperation('put',{conversationIds:f.ids,id:'synthetic-context',expectedVersion:1,binding:f.context.reference,detail:rd,requestId:'context-adverse'});
  f.review={...f.review,context:f.context.reference};
  f.reviewRecord=await intelligenceOperation('put',{conversationIds:f.ids,id:'audit-review',kind:'review',detail:f.review,requestId:'review-first'});
  f.reviewRecord=await intelligenceOperation('put',{conversationIds:f.ids,id:'audit-review',kind:'review',expectedVersion:1,binding:f.reviewRecord.reference,detail:{...f.review,state:'withdrawn',actor:'audit-editor',reason:'Retirada explícita de la revisión'},requestId:'review-withdraw'});
  f.detail={...f.detail,context:f.context.reference,decision:f.decision.reference};
  f.causal=await causalOperation('put',{conversationIds:f.ids,id:'audit-causal',detail:f.detail,requestId:'causal-first'});
  f.detail=structuredClone(f.detail);f.detail.hypotheses[0].evidence.push({...f.evidence[0],position:'contradicts',basis:'sequence'});
  f.causal=await causalOperation('put',{conversationIds:f.ids,id:'audit-causal',expectedVersion:1,binding:f.causal.reference,detail:{...f.detail,actor:'audit-editor',reason:'Añadir contraevidencia sin seleccionar causa'},requestId:'causal-adverse'});
  const forecast={...f.common,title:'Pronóstico de copia registrado después del plazo',decision:f.decision.reference,context:f.context.reference,probability:0.6,deadline:'2020-01-01T00:00:00Z',criterion:'Recuperar archivos',cohort:'synthetic',evidence:f.evidence};
  f.forecast=await intelligenceOperation('put',{conversationIds:f.ids,id:'audit-forecast',kind:'forecast',detail:forecast,requestId:'forecast'});
  const outcomeId='outcome-'+createHash('sha256').update(JSON.stringify(f.forecast.reference.id)).digest('hex').slice(0,32);
  f.outcome=await intelligenceOperation('put',{conversationIds:f.ids,id:outcomeId,kind:'outcome',detail:{...f.common,title:'Resultado de copia declarado',forecast:f.forecast.reference,value:false,resolvedAt:'2020-01-02T00:00:00Z',evidence:f.evidence},requestId:'outcome'});
  f.precedent=await intelligenceOperation('put',{conversationIds:f.ids,id:'audit-precedent',kind:'precedent',detail:{...f.common,title:'Precedente de copia con diferencias',review:f.reviewRecord.reference,targetDecision:f.decision.reference,comparedAt:'2026-10-25T00:00:00Z',validUntil:'2060-01-01T00:00:00Z',scopeAssessment:'different',comparisons:f.review.assumptions.map(a=>({assumption:a.text,assessment:'differs',reason:'Diferencia explícita',evidence:f.evidence})),evidence:[{sourceId:f.source.id,quote:'Comparación de supuestos 2026-10-25 hasta 2060-01-01.'}]},requestId:'precedent'});
  return f;
}

import {createHmac,timingSafeEqual} from 'node:crypto';
import {readSnapshot,verifyContextSnapshot} from './context.mjs';
import {getEvidence} from './corpus.mjs';
import {knowledgeOperation} from './knowledge.mjs';
import {projectContext,publicGraph,compareContextUnits,EXPLORER_ORDER_VERSION,interpretationMetadata} from './web/explorer-model.mjs';
import {wireBytes} from '../agent-forensic-handoff/src/memory-package.js';

const demand=(ok,code)=>{if(!ok)throw new Error(code);};
const encode=(value,key)=>{const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+createHmac('sha256',key).update(body).digest('hex');};
function decode(cursor,key){
  demand(typeof cursor==='string'&&cursor.length<4000,'EXPLORER_CURSOR');
  const [body,mac,...extra]=cursor.split('.');demand(!extra.length&&/^[a-f0-9]{64}$/.test(mac),'EXPLORER_CURSOR');
  demand(timingSafeEqual(createHmac('sha256',key).update(body).digest(),Buffer.from(mac,'hex')),'EXPLORER_CURSOR_INTEGRITY');
  return JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
}
function measure(value,maximum){
  value.bytes=0;for(let i=0;i<10;i++){const n=wireBytes(value);if(n===value.bytes){demand(n<=maximum,'EXPLORER_RESPONSE_BUDGET');return value;}value.bytes=n;}
  throw new Error('EXPLORER_BYTE_COUNTER');
}
const originalMeta=e=>({key:e.key,conversationId:e.conversationId,eventId:e.id,title:e.conversationTitle,role:e.role,revision:e.payloadSha256,recordSha256:e.sha256});
function summarize(item){
  const p=item.record.payload,detail=p.identity?.detail??p.collective?.detail??p.support?.detail??p.decision_case?.detail??p.retrospective?.detail??p.intelligence?.detail??p.causal?.detail??{};
  return {reference:item.reference,recordedAt:item.record.recorded_at,title:detail.title??p.text,state:detail.state??p.decision_case?.status??p.status,
    action:p.decision_case?.action??'revision',reason:detail.reason??detail.statement??null,temporal:detail.temporal??null,sourceCount:item.sourceBindings.length,...interpretationMetadata(item.record)};
}
export async function explorer(request){
  const {id,conversationIds,signal,op='page',maxBytes=200000}=request;
  demand(['page','inspect','history','version','original'].includes(op),'EXPLORER_OPERATION');
  demand(Array.isArray(conversationIds)&&conversationIds.length>0&&conversationIds.length<=20,'EXPLORER_SELECTION');
  demand(Number.isSafeInteger(maxBytes)&&maxBytes>=4096&&maxBytes<=200000,'EXPLORER_BUDGET');
  await verifyContextSnapshot({id},conversationIds,{signal,requireCurrent:false});
  const {snapshot,key}=readSnapshot(id),units=[...snapshot.units].sort(compareContextUnits);
  let result={schema:'afh.explorer.v1',id,question:snapshot.question,cut:snapshot.cut,coverage:snapshot.coverage,needs:snapshot.needs,queryOptions:snapshot.options,executionAuthority:false,humanAcceptance:false,completeness:'not_certified'};
  if(op==='page'){
    let index=0;
    if(request.unitId!==undefined){index=units.findIndex(u=>u.id===request.unitId);demand(index>=0,'EXPLORER_UNIT_NOT_IN_SNAPSHOT');}
    if(request.focusKey){demand(snapshot.evidence.some(e=>e.key===request.focusKey),'EXPLORER_FOCUS_NOT_IN_SNAPSHOT');const found=units.findIndex(u=>u.evidenceKeys.includes(request.focusKey));if(found>=0)index=found;}
    if(request.cursor){const c=decode(request.cursor,key);demand(c.order===EXPLORER_ORDER_VERSION,'EXPLORER_CURSOR_ORDER_CHANGED');demand(c.kind==='explorer'&&c.id===id&&c.maxBytes===maxBytes&&Number.isSafeInteger(c.index)&&c.index>=0&&c.index<units.length,'EXPLORER_CURSOR_BINDING');index=c.index;}
    const unit=units[index],evidence=unit?snapshot.evidence.filter(e=>unit.evidenceKeys.includes(e.key)):[];
    const graph=unit?publicGraph(projectContext(unit,evidence)):{nodes:[],edges:[],groups:[],counts:{nodes:0,edges:0},rootId:null,limited:false};
    const cursor=at=>encode({kind:'explorer',order:EXPLORER_ORDER_VERSION,id,index:at,maxBytes},key);
    result={...result,unit:unit?{id:unit.id,kind:unit.kind,title:unit.title,blocked:unit.blocked,requiresReview:unit.requiresReview}:null,graph,
      originals:evidence.map(originalMeta),position:index,totalUnits:units.length,nextCursor:index+1<units.length?cursor(index+1):null,previousCursor:index>0?cursor(index-1):null,
      warnings:[...snapshot.blockers,...(unit?.blocked?[{reason:'missing_or_unverified_dependency'}]:[]),...(graph.limited?[{reason:graph.reason}]:[])]};
    // A large view is explicitly withheld as a whole; never drop only adverse edges.
    if(wireBytes(result)>maxBytes-1500)result={...result,graph:{nodes:[],edges:[],groups:[],rootId:null,counts:graph.counts,limited:true,reason:'whole_context_exceeds_response_budget'},originals:[],warnings:[{reason:'whole_context_exceeds_response_budget',requiredBytes:wireBytes(result)}]};
  }else{
    const unit=units.find(u=>u.id===request.unitId);demand(unit,'EXPLORER_UNIT_NOT_IN_SNAPSHOT');
    const evidence=snapshot.evidence.filter(e=>unit.evidenceKeys.includes(e.key)),graph=projectContext(unit,evidence);
    result={...result,unitId:unit.id};
    if(op==='original'&&request.originalKey){
      const e=evidence.find(e=>e.key===request.originalKey);demand(e,'EXPLORER_ORIGINAL_NOT_IN_UNIT');
      const source=await getEvidence(e.conversationId,e.id);demand(source.sha256===e.sha256&&source.text===e.text,'EXPLORER_ORIGINAL_CHANGED');
      result={...result,original:{...originalMeta(e),text:source.text,document:source.document??null,verified:true}};
    }else{
      const node=graph.nodes.find(n=>n.id===request.nodeId);demand(node,'EXPLORER_NODE_NOT_IN_UNIT');
      if(op==='inspect')result={...result,node,originals:evidence.map(originalMeta)};
      else{
        demand(node.historyTarget,'EXPLORER_NO_HISTORY');
        const history=await knowledgeOperation('context_history',conversationIds,{target:node.historyTarget,knownAt:snapshot.cut.knownAt},{signal});
        if(op==='history'){
          let offset=0;
          if(request.cursor){const c=decode(request.cursor,key);demand(c.kind==='evolution'&&c.id===id&&c.nodeId===node.id&&c.unitId===unit.id&&c.maxBytes===maxBytes&&Number.isSafeInteger(c.offset)&&c.offset>0&&c.offset<history.items.length,'EXPLORER_CURSOR_BINDING');offset=c.offset;}
          const items=history.items.slice(offset,offset+12).map(summarize);
          result={...result,nodeId:node.id,items,totalVersions:history.items.length,nextCursor:offset+12<history.items.length?encode({kind:'evolution',id,unitId:unit.id,nodeId:node.id,maxBytes,offset:offset+12},key):null};
        }else{
          demand(Number.isSafeInteger(request.version),'EXPLORER_VERSION');
          const item=history.items.find(x=>x.record.version===request.version);demand(item,'EXPLORER_VERSION_NOT_AT_CUT');
          if(op==='version')result={...result,nodeId:node.id,...item};
          else{
            const b=item.sourceBindings.find(s=>s.id===request.sourceId);demand(b,'EXPLORER_ORIGINAL_NOT_IN_VERSION');
            const source=await getEvidence(b.conversationId,b.eventId);demand(source.sha256===b.record_sha256&&source.payloadSha256===b.payload_sha256,'EXPLORER_ORIGINAL_CHANGED');
            result={...result,original:{title:b.conversationId,role:source.role,revision:b.revision,recordSha256:b.record_sha256,text:source.text,document:source.document??null,verified:true}};
          }
        }
      }
    }
  }
  result.freshness=await verifyContextSnapshot({id},conversationIds,{signal,requireCurrent:false});
  result.status=result.freshness.current?'same_cut':'stale_cut';
  return measure(result,maxBytes);
}

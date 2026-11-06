import fs from '../agent-forensic-handoff/src/common-files.js';import path from 'node:path';
import {knowledgeOperation,verifiedSources} from './knowledge.mjs';
import {DATA,refreshLibrary} from './corpus.mjs';
export async function collectiveSources(ids,options={}){
 refreshLibrary();const {sources}=await verifiedSources(ids,options);
 return sources.filter(s=>!s.aliasOf).map(({id,revision,conversationId,eventId,role,text,document})=>({id,revision,conversationId,eventId,role,text,...(document?{document}:{})}));
}
export const hasCollectives=()=>fs.existsSync(path.join(DATA,'semantic','collectives','records.pgstore'));
export async function collectiveOperation(op,input={},options={}){
 if(!['put','query','get','history'].includes(op))throw new Error('UNKNOWN_COLLECTIVE_OPERATION');
 refreshLibrary();const {conversationIds,...body}=input;
 const result=await knowledgeOperation('collective_'+op,conversationIds,body,options);
 if(op==='query'){
  for(let i=0;i<8&&result.bytes!==Buffer.byteLength(JSON.stringify(result));i++)result.bytes=Buffer.byteLength(JSON.stringify(result));
  if(result.bytes>result.maxBytes)throw new Error('COLLECTIVE_PACKET_BUDGET');
 }
 return result;
}

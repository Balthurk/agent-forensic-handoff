import {knowledgeOperation} from './knowledge.mjs';
import {refreshLibrary} from './corpus.mjs';
export {learningSources as decisionSources} from './learning.mjs';

export async function decisionOperation(op,input={},options={}){
 if(!['frame','act','list','get','history'].includes(op))throw new Error('UNKNOWN_DECISION_OPERATION');
 refreshLibrary();const {conversationIds,...body}=input;
 const result=await knowledgeOperation('decision_'+op,conversationIds,body,options);
 if(op==='list'){
  const bytes=()=>Buffer.byteLength(JSON.stringify(result));
  for(let i=0;i<8&&result.bytes!==bytes();i++)result.bytes=bytes();
  if(result.bytes>result.maxBytes)throw new Error('DECISION_PACKET_BUDGET');
 }
 return result;
}

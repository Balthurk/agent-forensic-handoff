import {knowledgeOperation,verifiedSources} from './knowledge.mjs';
import {refreshLibrary} from './corpus.mjs';

// Explicitly selected conversations provide originals; no procedure is executed.
export async function learningOperation(op,input={},options={}){
 if(!['record','query','get','history'].includes(op))throw new Error('UNKNOWN_LEARNING_OPERATION');
 refreshLibrary();const {conversationIds,...body}=input;
 const result=await knowledgeOperation('learning_'+op,conversationIds,body,options);
 if(op==='query'){
  // Final caller-visible budget includes JS serialization. Never clip episodes.
  const bytes=()=>Buffer.byteLength(JSON.stringify(result));
  for(let i=0;i<8&&result.bytes!==bytes();i++)result.bytes=bytes();
  if(result.bytes>result.maxBytes)throw new Error('LEARNING_PACKET_BUDGET');
 }
 return result;
}

export async function learningSources(conversationIds,options={}){
 refreshLibrary();const context=await verifiedSources(conversationIds,options);
 return context.sources.filter(s=>!s.aliasOf).map(({id,conversationId,eventId,role,source_conversation_id,text,text_sha256,authorship})=>({id,conversationId,eventId,role,sourceConversationId:source_conversation_id,text,textSha256:text_sha256,authorship}));
}

import {knowledgeOperation} from './knowledge.mjs';import {refreshLibrary} from './corpus.mjs';
export {collectiveSources as supportSources} from './collectives.mjs';
export async function supportOperation(op,input={},options={}){
 if(!['put','get','history','impact','evaluate','review'].includes(op))throw new Error('UNKNOWN_SUPPORT_OPERATION');
 refreshLibrary();const {conversationIds,...body}=input;const result=await knowledgeOperation('support_'+op,conversationIds,body,options);
 if(op==='evaluate'){for(let i=0;i<8&&result.bytes!==Buffer.byteLength(JSON.stringify(result));i++)result.bytes=Buffer.byteLength(JSON.stringify(result));if(result.bytes>result.maxBytes)throw new Error('SUPPORT_PACKET_BUDGET');}
 return result;
}

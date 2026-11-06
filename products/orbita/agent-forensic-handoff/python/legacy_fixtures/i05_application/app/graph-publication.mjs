import {knowledgeOperation} from './knowledge.mjs';
export async function graphOperation(op,input={},options={}){
 if(!['status','publish','query','original','capabilities'].includes(op))throw new Error('UNKNOWN_GRAPH_OPERATION');
 return knowledgeOperation('graph_'+op,input.conversationIds,input,options);
}

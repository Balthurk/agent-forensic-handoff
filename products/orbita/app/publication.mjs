import {knowledgeOperation} from './knowledge.mjs';import {checkpoint} from './durable.mjs';
export async function publishPending(conversationIds,{limit=20,signal,leaseSeconds=60}={}){signal?.throwIfAborted();const claims=await knowledgeOperation('publication_claim',conversationIds,{limit,leaseSeconds}),results=[];
 for(const claim of claims){signal?.throwIfAborted();const input={outboxId:claim.outbox_id,owner:claim.owner,fence:claim.fence};try{await knowledgeOperation('publication_publish',conversationIds,input);checkpoint('publication-after-index');signal?.throwIfAborted();results.push(await knowledgeOperation('publication_ack',conversationIds,input));}catch(e){try{await knowledgeOperation('publication_fail',conversationIds,{...input,error:e.message});}catch{}throw e;}}
 return {results,status:await knowledgeOperation('publication_status',conversationIds),approval:'none'};
}

import { sha256, stableStringify } from './util.js';

export const FORMAT = 'afh.conversation.v1';
export const pointerEscape = value => String(value).replaceAll('~','~0').replaceAll('/','~1');
export const digestObject = value => sha256(stableStringify(value));

// A share ID identifies a published snapshot, not the private conversation ID.
// Never merge identities by title, text similarity, or an unverified alias.
export function conversationIdentity(conversation, {namespace='chatgpt', fallback}={}) {
  const native = conversation.conversation_id || conversation.id;
  return native ? `${namespace}:${native}` : `unresolved:${fallback}`;
}

export function branchScope(nodes, currentNode) {
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const active=new Set(), issues=[];
  let cursor=currentNode;
  if(!cursor || !byId.has(cursor)) issues.push('CURRENT_NODE_UNAVAILABLE');
  while(cursor && byId.has(cursor)) {
    if(active.has(cursor)) {issues.push('ACTIVE_PARENT_CYCLE');break;}
    active.add(cursor);cursor=byId.get(cursor).parent;
  }
  if(cursor && !byId.has(cursor))issues.push('ACTIVE_PARENT_MISSING');
  const proven=issues.length===0;
  return {active,issues,proven};
}

export function conversationRecords(conversation, {member='',pointer='',namespace='chatgpt',coverage='EXPORTED_SNAPSHOT',sourceHash}={}) {
  const mapping=conversation.mapping;
  if(!mapping || typeof mapping!=='object' || Array.isArray(mapping))throw new Error('Conversation mapping must be an object');
  const nodes=Object.entries(mapping).map(([key,node])=>{
    if(!node || typeof node!=='object' || Array.isArray(node) || typeof node.id!=='string' || key!==node.id)throw new Error('Invalid mapping node identity');
    if(node.children!=null && (!Array.isArray(node.children)||node.children.some(x=>typeof x!=='string')))throw new Error('Invalid child identifiers');
    if(node.parent!=null && typeof node.parent!=='string')throw new Error('Invalid parent identifier');
    return node;
  });
  if(!nodes.length)throw new Error('Conversation mapping is empty');
  const conversationId=conversationIdentity(conversation,{namespace,fallback:digestObject([sourceHash,member,pointer])});
  const scope=branchScope(nodes,conversation.current_node);
  const byId=new Map(nodes.map(n=>[n.id,n])), seen=new Set(), ordered=[];
  // Parent-first where possible; disconnected nodes and cycles remain explicit.
  for(const node of nodes) {
    const chain=[],local=new Set();let cur=node;
    while(cur && !seen.has(cur.id) && !local.has(cur.id)) {local.add(cur.id);chain.push(cur);cur=byId.get(cur.parent);}
    while(chain.length){const n=chain.pop();if(!seen.has(n.id)){seen.add(n.id);ordered.push(n);}}
  }
  const header={...conversation};delete header.mapping;
  const branchId=scope.proven?`branch-${digestObject([conversationId,conversation.current_node])}`:null;
  const common={format:FORMAT,conversationId,namespace,coverage,member,title:conversation.title??null};
  const result=[{...common,type:'afh.conversation.header',conversation:header,pointer,branchIssues:scope.issues}];
  const messageIds=new Set();
  for(const node of ordered) {
    const m=node.message;
    if(m!=null) {
      if(typeof m.id!=='string'||!m.id||messageIds.has(m.id)||!m.author||typeof m.author.role!=='string'||!m.content||typeof m.content!=='object')throw new Error('Invalid or duplicate message identity');
      messageIds.add(m.id);
    }
    const parent=byId.get(node.parent)?.message;
    result.push({...common,type:'afh.conversation.node',node,
      pointer:`${pointer}/mapping/${pointerEscape(node.id)}`,
      branchId,scope:scope.proven?(scope.active.has(node.id)?'active':'alternative'):'unknown',
      missingRelations:[node.parent,...(node.children||[])].filter(id=>id&&!byId.has(id)),
      requestMessageId:m?.author?.role==='tool'&&parent?.author?.role==='assistant'&&parent.recipient&&parent.recipient!=='all'?parent.id:null,
    });
  }
  return result;
}

export function isConversation(value) {return Boolean(value && typeof value==='object' && !Array.isArray(value) && value.mapping && typeof value.mapping==='object');}

export function attachmentReferences(records) {
  const refs=[];
  for(const record of records) {
    const message=record.node?.message;if(!message)continue;
    for(const [index,value] of (message.metadata?.attachments||[]).entries())refs.push({conversationId:record.conversationId,messageId:message.id,pointer:`${record.pointer}/message/metadata/attachments/${index}`,reference:value,status:'REFERENCE_ONLY_UNRESOLVED'});
    const stack=[{value:message.content,pointer:`${record.pointer}/message/content`}];
    while(stack.length) {
      const {value,pointer}=stack.pop();if(!value||typeof value!=='object')continue;
      for(const [key,child] of Object.entries(value)) {
        const next=`${pointer}/${pointerEscape(key)}`;
        if(['asset_pointer','file_id','audio_asset_pointer','image_url'].includes(key))refs.push({conversationId:record.conversationId,messageId:message.id,pointer:next,reference:child,status:'REFERENCE_ONLY_UNRESOLVED'});
        else if(child&&typeof child==='object')stack.push({value:child,pointer:next});
      }
    }
  }
  return refs;
}

// One shared text projection for UI, citation ranges, imports and the N01 packet.
// Unknown structures stay readable and the full original is always authoritative.
export function conversationText(content) {
  if(!content || typeof content!=='object')return JSON.stringify(content??null);
  if(Array.isArray(content.parts))return content.parts.map(p=>typeof p==='string'?p:JSON.stringify(p)).join('\n');
  if(typeof content.text==='string')return content.text;
  if(content.content_type==='user_editable_context')return [content.user_instructions,content.user_profile].filter(x=>typeof x==='string').join('\n\n');
  return JSON.stringify(content,null,2);
}

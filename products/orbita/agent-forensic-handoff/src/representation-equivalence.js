// A retrieval-only classification. Original text, payload hashes and IDs never change.
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
function terminalMemoryFooter(text){
 const marker='<oai-mem-citation>';
 if(!text.includes(marker))return {body:text,footer:false};
 if(text.indexOf(marker)!==text.lastIndexOf(marker))return null;
 const match=text.match(/\n[ \t]*<oai-mem-citation>\s*<citation_entries>\s*([^<>]*)\s*<\/citation_entries>\s*<rollout_ids>\s*([^<>]*)\s*<\/rollout_ids>\s*<\/oai-mem-citation>\s*$/);
 if(!match)return null;
 const entries=match[1].trim().split(/\r?\n/).filter(Boolean);
 const ids=match[2].trim().split(/\r?\n/).filter(Boolean);
 if(!entries.length||entries.some(s=>!/^.+:\d+-\d+\|note=\[[^\r\n]*\]$/.test(s))||ids.some(s=>! /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s)))return null;
 return {body:text.slice(0,match.index).trimEnd(),footer:true};
}
export function classifyOccurrences(messages){
 const groups=new Map(),states=new Map();
 for(const m of messages)if(m.occurrenceId){const a=groups.get(m.occurrenceId)||[];a.push(m);groups.set(m.occurrenceId,a);}
 for(const [id,rows] of groups){
  const hashes=new Set(rows.map(m=>m.payloadSha256));
  if(hashes.size===1){states.set(id,{status:'identical',key:id+':'+rows[0].payloadSha256});continue;}
  const first=rows[0],sameNative=first.scope==='native'&&first.role==='assistant'&&first.kind==='message.agent'&&first.sourceConversationId?.startsWith('codex:')&&first.native_id&&first.canonicalEventId&&['final','final_answer'].includes(first.channel)&&rows.every(m=>m.scope===first.scope&&m.role===first.role&&m.kind===first.kind&&m.sourceConversationId===first.sourceConversationId&&m.native_id===first.native_id&&m.canonicalEventId===first.canonicalEventId&&m.channel===first.channel);
  const parts=sameNative?rows.map(m=>terminalMemoryFooter(m.text)):[];
  // Require an unadorned original, and equality of the complete body. Whitespace
  // normalization is limited to the separator before the terminal metadata block.
  if(sameNative&&parts.every(Boolean)&&parts.some(p=>p.footer)&&parts.some(p=>!p.footer)&&new Set(parts.map(p=>p.body.trimEnd())).size===1){
   const bodySha256=sha(parts[0].body.trimEnd());
   states.set(id,{status:'equivalent_terminal_memory_footer',key:id+':body:'+bodySha256,bodySha256,representations:rows.map(m=>({id:m.representationId,payloadSha256:m.payloadSha256}))});
  }else states.set(id,{status:'conflict',key:null});
 }
 return states;
}

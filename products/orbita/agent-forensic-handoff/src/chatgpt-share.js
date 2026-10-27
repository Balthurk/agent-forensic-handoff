import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from './util.js';
import { conversationText, branchScope, digestObject } from './conversation-format.js';

const FORMAT='afh.chatgpt-share.v1';
const MAX_BYTES=32*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const limitations=[
  'Coverage is the publicly serialized snapshot, not proof of the full original conversation or every branch.',
  'Attachment and media references are preserved; their binary contents are not downloaded.',
  'Only published timestamps, channels, content and metadata are available. Missing internal events are not inferred.',
  'Published parent/child relationships are provenance, not proof of causality or tool execution success.',
];
export function validateShareUrl(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||!['chatgpt.com','chat.openai.com'].includes(u.hostname)||u.port||u.username||u.password||u.search||u.hash)throw new Error('Expected a public HTTPS ChatGPT share URL without credentials, query or fragment');
  const match=u.pathname.match(/^\/share\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
  if(!match)throw new Error('Unsupported ChatGPT share URL');
  return {url:u.origin+'/share/'+match[1],shareId:match[1]};
}

// Decode only JSON literals. Never execute the remote page's JavaScript.
export function parseSharePage(bytes) {
  const html=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const pattern=/window\.__reactRouterContext\.streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/g;
  const candidates=[];
  for(const match of html.matchAll(pattern)) {
    const chunk=JSON.parse(match[1]);
    const line=chunk.split('\n')[0];
    if(!line.startsWith('['))continue;
    const pool=JSON.parse(line);
    if(!Array.isArray(pool)||pool.length>500000)throw new Error('Unsupported or oversized shared payload');
    const keyIds=new Set(pool.flatMap((v,i)=>v==='linear_conversation'?[`_${i}`]:[]));
    const owners=pool.filter(v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).some(k=>keyIds.has(k)));
    for(const owner of owners) {
      const memo=new Map(),active=new Set();let expanded=0;
      function decode(i,depth=0) {
        if(i===-5)return null;
        if(!Number.isInteger(i)||i<0||i>=pool.length||depth>128)throw new Error('Unsupported shared payload reference');
        if(active.has(i))throw new Error('Cyclic shared payload');
        if(memo.has(i))return memo.get(i);
        if(++expanded>500000)throw new Error('Shared payload expansion limit');
        const v=pool[i];let out=v;active.add(i);
        if(Array.isArray(v)) {
          if(v.some(x=>!Number.isInteger(x)))throw new Error('Unsupported tagged shared payload; retain raw HTML and update parser');
          out=v.map(x=>decode(x,depth+1));
        } else if(v&&typeof v==='object') {
          out=Object.create(null);
          for(const [k,r] of Object.entries(v)) {
            if(!/^_\d+$/.test(k))throw new Error('Invalid shared payload key');
            const key=pool[Number(k.slice(1))];
            if(typeof key!=='string'||Object.hasOwn(out,key))throw new Error('Invalid or duplicate shared payload key');
            out[key]=decode(r,depth+1);
          }
        }
        active.delete(i);memo.set(i,out);return out;
      }
      candidates.push(decode(pool.indexOf(owner)));
    }
  }
  if(candidates.length!==1)throw new Error('Shared conversation unavailable, incomplete or unsupported: expected exactly one structured conversation');
  const conversation=candidates[0],nodes=conversation.linear_conversation;
  if(!Array.isArray(nodes)||!nodes.length)throw new Error('Empty shared conversation');
  const ids=new Set(),messageIds=new Set();
  for(const n of nodes) {
    if(!n||typeof n.id!=='string'||ids.has(n.id))throw new Error('Invalid or duplicate shared node ID');
    ids.add(n.id);
    if(n.message!=null) {
      const m=n.message;
      if(typeof m.id!=='string'||messageIds.has(m.id)||!m.author||typeof m.author.role!=='string'||!m.content||typeof m.content!=='object')throw new Error('Unsupported or duplicate shared message');
      messageIds.add(m.id);
    }
  }
  if(!messageIds.size||!conversation.current_node||!ids.has(conversation.current_node))throw new Error('Shared conversation endpoint missing');
  const header={...conversation};delete header.linear_conversation;
  const missingRelations=[];
  for(const n of nodes)for(const id of [n.parent,...(n.children||[])].filter(Boolean))if(!ids.has(id))missingRelations.push({node:n.id,missing:id});
  return {conversation:header,nodes,missingRelations};
}

export function sharedRecords(parsed,capture) {
  const byId=new Map(parsed.nodes.map(n=>[n.id,n]));
  const scope=branchScope(parsed.nodes,parsed.conversation.current_node);
  return [
    {type:'chatgpt.share_capture',format:FORMAT,capture,conversation:parsed.conversation},
    ...parsed.nodes.map((node,index)=>{
      const parent=byId.get(node.parent)?.message;
      const requestMessageId=node.message?.author?.role==='tool'&&parent?.author?.role==='assistant'&&parent.recipient&&parent.recipient!=='all'?parent.id:null;
      return {type:'chatgpt.shared_node',shareId:capture.shareId,title:parsed.conversation.title??null,sourceUrl:capture.url,rawHtmlSha256:capture.rawHtmlSha256,scope:scope.proven?(scope.active.has(node.id)?'active':'alternative'):'unknown',branchId:scope.proven?'branch-'+digestObject(['chatgpt-share:'+capture.shareId,parsed.conversation.current_node]):null,sequence:index+1,pointer:`/linear_conversation/${index}`,requestMessageId,node};
    }),
  ];
}

async function fetchPage(url,{fetchImpl=fetch,maxBytes=MAX_BYTES,timeoutMs=45000}={}) {
  let current=url;
  const signal=AbortSignal.timeout(timeoutMs);
  for(let redirects=0;redirects<=3;redirects++) {
    const response=await fetchImpl(current,{redirect:'manual',signal,headers:{'User-Agent':'AFH-ChatGPT-Share/1.0','Accept':'text/html'}});
    if([301,302,303,307,308].includes(response.status)) {
      const next=validateShareUrl(new URL(response.headers.get('location'),current).href);
      if(next.shareId!==validateShareUrl(url).shareId)throw new Error('Redirect changed share identity');
      await response.body?.cancel();current=next.url;continue;
    }
    if(!response.ok)throw new Error(`Shared page unavailable: HTTP ${response.status}`);
    if(!/text\/html/i.test(response.headers.get('content-type')||''))throw new Error('Shared response is not HTML');
    if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('Shared page exceeds byte limit');
    const chunks=[];let length=0;
    for await(const chunk of response.body) {
      length+=chunk.length;if(length>maxBytes)throw new Error('Shared page exceeds byte limit');chunks.push(chunk);
    }
    return {bytes:Buffer.concat(chunks),finalUrl:current,httpStatus:response.status};
  }
  throw new Error('Too many redirects');
}

export async function importChatGPTShare(identifier,options={}) {
  const {url,shareId}=validateShareUrl(identifier);
  const maxBytes=Number(options.maxBytes??MAX_BYTES);
  if(!Number.isFinite(maxBytes)||maxBytes<=0||maxBytes>128*1024*1024)throw new Error('Invalid shared capture byte limit');
  const base=path.resolve(options.out||process.env.AFH_HOME||path.join(os.homedir(),'.afh'));
  const caseDir=path.resolve(options.caseDir||path.join(base,'cases',`chatgpt-${shareId}`,new Date().toISOString().replace(/[:.]/g,'-')));
  if(fs.existsSync(caseDir))throw new Error(`Case directory already exists: ${caseDir}`);
  let fetched;
  if(options.htmlPath) {
    const {assertSafeSourcePath}=await import('./discovery.js');assertSafeSourcePath(options.htmlPath,{allowSymlink:options.allowSymlink??false});
    if(fs.statSync(options.htmlPath).size>maxBytes)throw new Error('Shared page exceeds byte limit');
    fetched={bytes:fs.readFileSync(options.htmlPath),finalUrl:url,httpStatus:null};
  }else fetched=await fetchPage(url,{...options,maxBytes});
  const parsed=parseSharePage(fetched.bytes);
  if(parsed.conversation.conversation_id?.toLowerCase()!==shareId.toLowerCase())throw new Error('Shared page identity differs from requested URL');
  const msgs=parsed.nodes.flatMap(n=>n.message?[n.message]:[]);
  const capture={format:FORMAT,url,shareId,finalUrl:fetched.finalUrl,httpStatus:fetched.httpStatus,acquisition:options.htmlPath?'provided-html':'direct-https',capturedAt:new Date().toISOString(),rawHtmlSha256:digest(fetched.bytes),rawHtmlBytes:fetched.bytes.length,nodeCount:parsed.nodes.length,messageCount:msgs.length,roles:msgs.reduce((a,m)=>(a[m.author.role]=(a[m.author.role]||0)+1,a),{}),coverage:'PUBLISHED_SNAPSHOT_ONLY',missingRelations:parsed.missingRelations,limitations};
  fs.mkdirSync(path.dirname(caseDir),{recursive:true});
  const work=fs.mkdtempSync(caseDir+'.capture-');
  try {
    const input=path.join(work,shareId+'.jsonl');
    fs.writeFileSync(input,sharedRecords(parsed,capture).map(x=>JSON.stringify(x)).join('\n')+'\n');
    const {auditSession}=await import('./audit.js');
    const result=await auditSession(input,{...options,caseDir:path.join(work,'case'),harness:'chatgpt-share',includeChildren:false,workspace:null,verificationLevel:'V0',_deferIdentity:true});
    const acquisition=path.join(result.caseDir,'acquisition');fs.mkdirSync(acquisition);
    fs.writeFileSync(path.join(acquisition,'chatgpt-share.html'),fetched.bytes);
    fs.writeFileSync(path.join(acquisition,'capture.json'),JSON.stringify(capture,null,2)+'\n');
    fs.writeFileSync(path.join(result.caseDir,'shared-transcript.md'),`# ${parsed.conversation.title||'ChatGPT shared conversation'}\n\nSource: ${url}\n\n${limitations.map(x=>'- '+x).join('\n')}\n\n`+parsed.nodes.filter(n=>n.message).map(n=>`## ${n.message.author.role} Ãƒâ€šÃ‚Â· ${n.message.id}\n\n${sharedContentText(n.message.content)}\n`).join('\n'));
    const {writeIdentity}=await import('./identity-evidence.js');await writeIdentity(result.caseDir);
    const {verifyCaseIntegrity}=await import('./integrity.js');
    const verification=await verifyCaseIntegrity(result.caseDir);
    if(!verification.passed)throw new Error('Shared case failed verification: '+verification.findings.filter(x=>!x.ok).map(x=>x.detail).join('; '));
    fs.renameSync(result.caseDir,caseDir);
    return {...result,caseDir,manifest:JSON.parse(fs.readFileSync(path.join(caseDir,'case.json'),'utf8')),capture};
  } finally {fs.rmSync(work,{recursive:true,force:true});}
}

export function sharedContentText(content) { return conversationText(content); }

export function verifySharedSnapshot(caseDir,canonicalPath) {
  const records=fs.readFileSync(canonicalPath,'utf8').trimEnd().split('\n').map(x=>JSON.parse(x));
  const first=records[0];
  if(first?.type!=='chatgpt.share_capture'||first.format!==FORMAT)throw new Error('Missing bound shared capture header');
  const c=first.capture;validateShareUrl(c.url);
  const raw=fs.readFileSync(path.join(caseDir,'acquisition/chatgpt-share.html'));
  if(raw.length!==c.rawHtmlBytes||digest(raw)!==c.rawHtmlSha256)throw new Error('Shared raw HTML hash or length mismatch');
  const parsed=parseSharePage(raw);
  if(parsed.conversation.conversation_id?.toLowerCase()!==c.shareId.toLowerCase()||validateShareUrl(c.url).shareId.toLowerCase()!==c.shareId.toLowerCase())throw new Error('Shared capture URL identity mismatch');
  const expected=sharedRecords(parsed,c);
  if(!records.slice(1).some(r=>Object.hasOwn(r,"scope")))for(const r of expected.slice(1)){delete r.scope;delete r.branchId;}
  if(stableStringify(JSON.parse(JSON.stringify(expected)))!==stableStringify(records))throw new Error('Shared normalized records differ from original HTML');
  if(c.nodeCount!==parsed.nodes.length||c.messageCount!==parsed.nodes.filter(n=>n.message).length)throw new Error('Shared coverage counts mismatch');
  return {nodeCount:c.nodeCount,messageCount:c.messageCount,rawHtmlSha256:c.rawHtmlSha256};
}

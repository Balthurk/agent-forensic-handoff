import fs from 'node:fs';import path from 'node:path';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {DATA,refreshLibrary} from './corpus.mjs';import {knowledgeOperation,verifiedSources} from './knowledge.mjs';
import {contextState} from './context.mjs';import {identityOperation} from './identities.mjs';
const need=(v,c)=>{if(!v)throw new Error(c);},sha=x=>createHash('sha256').update(x).digest('hex');
function measure(r,max){r.bytes=0;for(let i=0;i<12;i++){const n=Buffer.byteLength(JSON.stringify(r));if(n===r.bytes){need(n<=max,'VIEW_RESPONSE_BUDGET');return r;}r.bytes=n;}throw new Error('VIEW_BYTE_COUNTER');}
const sign=(v,k)=>{const b=Buffer.from(JSON.stringify(v)).toString('base64url');return b+'.'+createHmac('sha256',k).update(b).digest('hex');};
function decode(c,k){need(typeof c==='string'&&c.length<3000,'VIEW_CURSOR');const [b,h,...x]=c.split('.');need(!x.length&&/^[a-f0-9]{64}$/.test(h),'VIEW_CURSOR');need(timingSafeEqual(createHmac('sha256',k).update(b).digest(),Buffer.from(h,'hex')),'VIEW_CURSOR_INTEGRITY');return JSON.parse(Buffer.from(b,'base64url').toString());}
export function versionedView(prefix,folder){
 const root=path.join(DATA,folder+'-queries');
 function read(id){need(typeof id==='string'&&/^[a-f0-9]{64}$/.test(id),'VIEW_SNAPSHOT_ID');const dir=path.join(root,id),file=path.join(dir,'snapshot.json');need(!fs.lstatSync(dir).isSymbolicLink()&&!fs.lstatSync(file).isSymbolicLink(),'VIEW_SNAPSHOT_LINK');const raw=fs.readFileSync(file,'utf8');need(sha(raw)===id,'VIEW_SNAPSHOT_INTEGRITY');return {snapshot:JSON.parse(raw),key:fs.readFileSync(path.join(dir,'cursor.key'))};}
 return async function operation(op,input={},options={}){
  refreshLibrary();const stateOptions=prefix==='retrospective'?{...options,excludeStores:['intelligence','causal']}:prefix==='intelligence'?{...options,excludeStores:['causal']}:options;const {conversationIds,...body}=input;need(Array.isArray(conversationIds)&&conversationIds.length>=1&&conversationIds.length<=20,'VIEW_SELECTION');
  if(['sources','source'].includes(op))return identityOperation(op,input,options);
  if(['put','get','history'].includes(op))return (measure({result:await knowledgeOperation(prefix+'_'+op,conversationIds,body,options)},2000000)).result;
  need(['query','page','snapshotItem','original'].includes(op),'VIEW_OPERATION');const maxBytes=body.maxBytes??200000,limit=body.limit??10;
  need(Number.isSafeInteger(maxBytes)&&maxBytes>=4096&&maxBytes<=200000,'VIEW_PAGE_BUDGET');need(Number.isSafeInteger(limit)&&limit>=1&&limit<=20,'VIEW_PAGE_LIMIT');
  let id=body.snapshotId;
  if(op==='query'){
   const state=await contextState(conversationIds,stateOptions),board=await knowledgeOperation(prefix+'_query',conversationIds,body,options);
   need((await contextState(conversationIds,stateOptions)).fingerprint===state.fingerprint,'VIEW_CHANGED_DURING_DISCOVERY');
   const snapshot={schema:'afh.versioned-view.v1',prefix,state,conversationIds:[...new Set(conversationIds)].sort(),board};const raw=JSON.stringify(snapshot);
   need(Buffer.byteLength(raw)<=32000000,'VIEW_SNAPSHOT_BUDGET');id=sha(raw);const dir=path.join(root,id);fs.mkdirSync(root,{recursive:true});
   try{fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'snapshot.json'),raw,{flag:'wx'});fs.writeFileSync(path.join(dir,'cursor.key'),randomBytes(32),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;read(id);}
  }
  const {snapshot,key}=read(id);need(snapshot.prefix===prefix&&JSON.stringify([...new Set(conversationIds)].sort())===JSON.stringify(snapshot.conversationIds),'VIEW_SELECTION_MISMATCH');
  const fresh=await contextState(conversationIds,stateOptions),freshness={current:fresh.fingerprint===snapshot.state.fingerprint};const {items,...meta}=snapshot.board;
  if(['snapshotItem','original'].includes(op)){
   need(Number.isSafeInteger(body.index)&&body.index>=0&&body.index<items.length,'VIEW_ITEM');const item=items[body.index];
   if(op==='snapshotItem')return measure({item,freshness},maxBytes);
   const ref=(item.sourceRefs??item.record?.payload.source_refs??[]).find(r=>r.id===body.sourceId);need(ref,'VIEW_ORIGINAL_NOT_IN_ITEM');
   const {sources}=await verifiedSources(conversationIds,options),source=sources.find(s=>s.id===ref.id&&s.revision===ref.revision);need(source,'VIEW_ORIGINAL_UNAVAILABLE');return measure({original:source,freshness},maxBytes);
  }
  let offset=0;if(body.cursor){const c=decode(body.cursor,key);need(c.id===id&&c.limit===limit&&c.maxBytes===maxBytes&&Number.isSafeInteger(c.offset)&&c.offset>0&&c.offset<items.length,'VIEW_CURSOR_BINDING');offset=c.offset;}
  const r={...meta,snapshotId:id,total:items.length,items:[],omissions:[],nextCursor:null,freshness};let scanned=0;
  for(;offset<items.length&&scanned<limit;offset++,scanned++){
   const row={index:offset,...items[offset]};r.items.push(row);
   if(Buffer.byteLength(JSON.stringify(r))>maxBytes-2200){r.items.pop();if(r.items.length)break;r.omissions.push({index:offset,reason:'whole_item_exceeds_budget',requiredBytes:Buffer.byteLength(JSON.stringify(row))});}
  }
  if(offset<items.length)r.nextCursor=sign({id,offset,limit,maxBytes},key);
  r.remaining=items.length-offset;r.status=!freshness.current?'stale_cut':r.omissions.length?'incomplete_page':r.nextCursor?'more':'complete';return measure(r,maxBytes);
 };
}

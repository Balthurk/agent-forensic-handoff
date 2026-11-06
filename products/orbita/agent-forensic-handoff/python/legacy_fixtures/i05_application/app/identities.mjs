import fs from 'node:fs';import path from 'node:path';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {DATA,refreshLibrary} from './corpus.mjs';
import {knowledgeOperation,verifiedSources} from './knowledge.mjs';
import {contextState} from './context.mjs';
const ROOT=path.join(DATA,'identity-queries'),sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const need=(v,c)=>{if(!v)throw new Error(c);};
const encode=(v,k)=>{const b=Buffer.from(JSON.stringify(v)).toString('base64url');return b+'.'+createHmac('sha256',k).update(b).digest('hex');};
function decode(c,k){need(typeof c==='string'&&c.length<3000,'IDENTITY_CURSOR');const [b,m,...x]=c.split('.');need(!x.length&&/^[a-f0-9]{64}$/.test(m),'IDENTITY_CURSOR');need(timingSafeEqual(createHmac('sha256',k).update(b).digest(),Buffer.from(m,'hex')),'IDENTITY_CURSOR_INTEGRITY');return JSON.parse(Buffer.from(b,'base64url').toString());}
function read(id){need(typeof id==='string'&&/^[a-f0-9]{64}$/.test(id),'IDENTITY_SNAPSHOT_ID');const dir=path.join(ROOT,id),file=path.join(dir,'snapshot.json');need(!fs.lstatSync(dir).isSymbolicLink()&&!fs.lstatSync(file).isSymbolicLink(),'IDENTITY_SNAPSHOT_LINK');const raw=fs.readFileSync(file,'utf8');need(sha(raw)===id,'IDENTITY_SNAPSHOT_INTEGRITY');return {snapshot:JSON.parse(raw),key:fs.readFileSync(path.join(dir,'cursor.key'))};}
function measured(r,max){r.bytes=0;for(let i=0;i<10;i++){const n=Buffer.byteLength(JSON.stringify(r));if(n===r.bytes){need(n<=max,'IDENTITY_RESPONSE_BUDGET');return r;}r.bytes=n;}throw new Error('IDENTITY_BYTE_COUNTER');}
const normalize=s=>s.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
export async function identityOperation(op,input={},options={}){
 refreshLibrary();const {conversationIds,...body}=input;
 need(Array.isArray(conversationIds)&&conversationIds.length>0&&conversationIds.length<=20,'IDENTITY_SELECTION');
 if(op==='sources'||op==='source'){
  const {sources}=await verifiedSources(conversationIds,options);
  if(op==='source'){const s=sources.find(s=>s.id===body.sourceId);need(s,'IDENTITY_SOURCE_UNAVAILABLE');return measured({source:s},2000000);}
  const question=body.question??'',offset=body.offset??0;need(typeof question==='string'&&question.length<=2000&&Number.isSafeInteger(offset)&&offset>=0,'IDENTITY_SOURCE_QUERY');
  const matches=sources.filter(s=>!s.aliasOf&&normalize(s.text).includes(normalize(question)));
  return {items:matches.slice(offset,offset+12).map(s=>({id:s.id,revision:s.revision,conversationId:s.conversationId,role:s.role,preview:s.text.slice(0,160),previewOnly:true})),total:matches.length,nextOffset:offset+12<matches.length?offset+12:null};
 }
 if(['put','get','history'].includes(op))return measured({result:await knowledgeOperation('identity_'+op,conversationIds,body,options)},2000000).result;
 need(['query','page','original','snapshotItem'].includes(op),'IDENTITY_OPERATION');
 const maxBytes=body.maxBytes??200000,limit=body.limit??12;
 need(Number.isSafeInteger(maxBytes)&&maxBytes>=4096&&maxBytes<=200000,'IDENTITY_PAGE_BUDGET');need(Number.isSafeInteger(limit)&&limit>=1&&limit<=20,'IDENTITY_PAGE_LIMIT');
 let id=body.snapshotId,loaded;
 if(op==='query'){
  const question=body.question??'',view=body.view??'entities';need(typeof question==='string'&&question.length<=2000,'IDENTITY_QUESTION');need(['entities','links','groups','candidates','mentions'].includes(view),'IDENTITY_VIEW');
  const state=await contextState(conversationIds,options),board=await knowledgeOperation(view==='mentions'?'identity_mentions':'identity_resolve',conversationIds,{knownAt:body.knownAt??null,validAt:body.validAt??null},options);
  need((await contextState(conversationIds,options)).fingerprint===state.fingerprint,'IDENTITY_CHANGED_DURING_DISCOVERY');
  const names=new Map((board.entities??[]).map(e=>[e.reference.id,[e.label,...e.aliases].join(' ')]));
  let items=view==='mentions'?board.items:board[view];const term=normalize(question.trim());
  if(term)items=items.filter(x=>normalize([x.label,...(x.aliases??[]),x.namespace,x.judgment,names.get(x.left?.id),names.get(x.right?.id),...(x.members??[]).map(m=>names.get(m.id))].filter(Boolean).join(' ')).includes(term));
  const snapshot={schema:'afh.identity-snapshot.v1',state,conversationIds:[...new Set(conversationIds)].sort(),question,view,knownAt:board.knownAt,validAt:board.validAt??null,mode:board.mode??'historical',items,counts:view==='mentions'?{mentions:board.items.length}:Object.fromEntries(['entities','links','groups','candidates'].map(k=>[k,board[k].length])),outsideSelection:board.outsideSelection,entities:(board.entities??[]).map(e=>({reference:e.reference,label:e.label,namespace:e.namespace,entityType:e.entityType})),policy:{executionAuthority:false,humanAcceptance:false,truth:'not_established',independentCorroboration:'not_established'}};
  const raw=JSON.stringify(snapshot);need(Buffer.byteLength(raw)<=32000000,'IDENTITY_SNAPSHOT_BUDGET');id=sha(raw);const dir=path.join(ROOT,id);fs.mkdirSync(ROOT,{recursive:true});
  try{fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'snapshot.json'),raw,{flag:'wx'});fs.writeFileSync(path.join(dir,'cursor.key'),randomBytes(32),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;read(id);}
  need((await contextState(conversationIds,options)).fingerprint===state.fingerprint,'IDENTITY_CHANGED_BEFORE_ADMISSION');
 }
 loaded=read(id);const {snapshot,key}=loaded;need(JSON.stringify([...new Set(conversationIds)].sort())===JSON.stringify(snapshot.conversationIds),'IDENTITY_SELECTION_MISMATCH');
 const freshness=async()=>({current:(await contextState(conversationIds,options)).fingerprint===snapshot.state.fingerprint});
 if(op==='original'||op==='snapshotItem'){
  need(Number.isSafeInteger(body.index)&&body.index>=0&&body.index<snapshot.items.length,'IDENTITY_ITEM');const item=snapshot.items[body.index];
  if(op==='snapshotItem')return measured({item,freshness:await freshness(),...snapshot.policy},maxBytes);
  const refs=item.sourceRefs??item.record?.payload.source_refs??(item.evidence??[]).map(e=>({id:e.sourceId}));need(refs.some(r=>r.id===body.sourceId),'IDENTITY_ORIGINAL_NOT_IN_ITEM');
  const {sources}=await verifiedSources(conversationIds,options),source=sources.find(s=>s.id===body.sourceId);need(source,'IDENTITY_ORIGINAL_UNAVAILABLE');const ref=refs.find(r=>r.id===source.id);need(!ref.revision||ref.revision===source.revision,'IDENTITY_ORIGINAL_CHANGED');
  return measured({original:source,freshness:await freshness(),...snapshot.policy},maxBytes);
 }
 let offset=0;if(body.cursor){const c=decode(body.cursor,key);need(c.id===id&&c.limit===limit&&c.maxBytes===maxBytes&&Number.isSafeInteger(c.offset)&&c.offset>0&&c.offset<snapshot.items.length,'IDENTITY_CURSOR_BINDING');offset=c.offset;}
 const r={schema:'afh.identity-page.v1',snapshotId:id,view:snapshot.view,question:snapshot.question,knownAt:snapshot.knownAt,validAt:snapshot.validAt,mode:snapshot.mode,counts:snapshot.counts,outsideSelection:snapshot.outsideSelection,total:snapshot.items.length,items:[],omissions:[],nextCursor:null,maxBytes,...snapshot.policy};
 let scanned=0;
 for(;offset<snapshot.items.length&&scanned<limit;offset++,scanned++){
  const item=snapshot.items[offset],ids=[item.left?.id,item.right?.id,...(item.members??[]).map(m=>m.id)].filter(Boolean),names=snapshot.entities.filter(e=>ids.includes(e.reference.id));
  const row={index:offset,...item,names};r.items.push(row);
  if(Buffer.byteLength(JSON.stringify(r))>maxBytes-2000){r.items.pop();if(r.items.length)break;r.omissions.push({index:offset,reason:'whole_identity_item_exceeds_budget',requiredBytes:Buffer.byteLength(JSON.stringify(row))});}
 }
 if(offset<snapshot.items.length)r.nextCursor=encode({id,offset,limit,maxBytes},key);
 r.remaining=snapshot.items.length-offset;r.freshness=await freshness();r.status=!r.freshness.current?'stale_cut':r.omissions.length?'incomplete_page':r.nextCursor?'more':'complete';return measured(r,maxBytes);
}

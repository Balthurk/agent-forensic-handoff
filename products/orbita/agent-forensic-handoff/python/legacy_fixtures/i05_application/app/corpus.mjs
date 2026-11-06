import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {loadManifest,readEvidence} from '../agent-forensic-handoff/src/render.js';
import {verifyCaseIntegrity} from '../agent-forensic-handoff/src/integrity.js';
import {auditSession} from '../agent-forensic-handoff/src/audit.js';
import {importChatGPTShare,sharedContentText} from '../agent-forensic-handoff/src/chatgpt-share.js';
import {readUnifiedEvidence} from '../agent-forensic-handoff/src/identity-evidence.js';
import {GAP_TEXT} from './llm.mjs';
import {useStore} from './store-access.mjs';
export const ROOT=path.dirname(fileURLToPath(import.meta.url));export const DATA=process.env.AFH_COSMOS_DATA?path.resolve(process.env.AFH_COSMOS_DATA):path.join(ROOT,'data');useStore(DATA);fs.mkdirSync(DATA,{recursive:true});
const registryFile=path.join(DATA,'library.json');
if(!fs.existsSync(registryFile))fs.writeFileSync(registryFile,JSON.stringify(process.env.AFH_COSMOS_EMPTY_LIBRARY!=='0'?[]:[{id:'diagnostico',title:'Diagnóstico de agentes IA',path:path.join(DATA,'cases','diagnostico'),url:'https://example.invalid/orbita/omitted-personal-source',addedAt:new Date().toISOString()}],null,2));
export const library=JSON.parse(fs.readFileSync(registryFile,'utf8'));const cache=new Map();
for(const item of library){const local=path.join(DATA,'cases',item.id);if(fs.existsSync(local))item.path=local;}
export function refreshLibrary(){const items=JSON.parse(fs.readFileSync(registryFile,'utf8'));for(const item of items){const local=path.join(DATA,'cases',item.id);if(fs.existsSync(local))item.path=local;}library.splice(0,library.length,...items);return library;}
function save(changes){
 const db=new DatabaseSync(path.join(DATA,'library-lock.sqlite'));
 db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
 try{
  const previous=fs.readFileSync(registryFile,'utf8'),disk=JSON.parse(previous);
  const combined=new Map(disk.map(i=>[i.id,i]));for(const i of changes)combined.set(i.id,i);
  const serialized=JSON.stringify([...combined.values()],null,2);
  // Reconciliation often republishes already committed items. Keep their exact
  // file and avoid an unnecessary Windows replacement while a reader is open.
  if(serialized!==previous){
   const tmp=registryFile+'.'+randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx');
   try{fs.writeFileSync(fd,serialized);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   fs.renameSync(tmp,registryFile);
  }
  refreshLibrary();db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
}

export function registerLibraryItems(items){save(items);}
const norm=s=>String(s).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const stop=new Set('que como cual cuales donde cuando para por con una uno unos unas del los las el la de se es en y o mi me sobre esta este esto esa ese sus tus mis hay fue han han ya mas todo toda todos todas puedes puede quiero saber dime explica segun informacion conversacion conversaciones haz'.split(' '));
export const words=s=>[...new Set(norm(s).match(/[\p{L}\p{N}_-]{3,}/gu)||[])].filter(x=>!stop.has(x));
function body(record){if(record.node?.message)return sharedContentText(record.node.message.content);const p=record.payload??record;if(p.content)return typeof p.content==='string'?p.content:JSON.stringify(p.content);return String(p.message??p.text??p.output??JSON.stringify(p));}
function captureDocument(manifest,item){if(!manifest.documentEvidence)return null;const d=JSON.parse(fs.readFileSync(path.join(item.path,manifest.documentEvidence.path),'utf8'));if(item.document&&(item.document.documentId!==d.header.documentId||item.document.revision!==d.header.revision||JSON.stringify(item.document.metadata)!==JSON.stringify(d.header.metadata)))throw new Error('DOCUMENT_LIBRARY_BINDING');return d;}
export async function loadCase(item){
  // Original evidence is authoritative. Derived indexes have their own verification
  // in memory.mjs; a broken vector sidecar must degrade that channel, not hide sources.
  const verification=await verifyCaseIntegrity(item.path,{verifyProjections:false});if(!verification.passed)throw new Error(`Integridad inválida: ${item.title}`);
  const manifest=loadManifest(item.path),db=new DatabaseSync(path.join(item.path,'case.sqlite'),{readOnly:true});
  const rows=db.prepare('SELECT e.id,e.native_id,e.kind,e.observed_at,e.record_ordinal,r.uri,r.record_sha256 FROM event e JOIN evidence_ref r ON r.event_id=e.id WHERE e.canonical=1 ORDER BY e.record_ordinal,e.subordinal').all();db.close();
  const common=manifest.identityEvidence?JSON.parse(fs.readFileSync(path.join(item.path,'identity.json'),'utf8')):null;
  const document=captureDocument(manifest,item);
  const messages=[];
  if(common)for(const row of common.representations){
    if(!['active','native'].includes(row.scope)||row.representation_only||(!row.text&&!row.message_id)||row.identity_conflict)continue;
    messages.push({id:row.legacy_event_id,native_id:row.message_id,kind:row.kind,observed_at:row.emitted_at,record_ordinal:row.locator.record_ordinal,uri:row.locator.legacy_uri,text:row.text,role:row.role,channel:row.channel,conversationId:item.id,conversationTitle:item.title,url:item.url||null,sha256:row.locator.record_sha256,occurrenceId:row.occurrence_id,representationId:row.representation_id,sourceConversationId:row.conversation_id,payloadSha256:row.payload_sha256,scope:row.scope,knownAt:row.known_at,...(document?{document:{...document.header,originalRange:document.blocks.find(b=>b.id===row.native_id)||null,currentRevision:item.currentRevision!==false,applicability:'declared_metadata_not_certified'}}:{})});
    Object.defineProperty(messages.at(-1),'canonicalEventId',{value:row.event_id,enumerable:false});
  }
  const seen=new Set();for(const row of common?[]:rows){if(seen.has(row.uri))continue;seen.add(row.uri);const evidence=readEvidence(item.path,row.uri);let raw;try{raw=JSON.parse(evidence.text);}catch{continue;}
    if(raw.type==='chatgpt.share_capture'||(raw.type==='chatgpt.shared_node'&&!raw.node?.message))continue;
    const text=body(raw);const role=raw.node?.message?.author?.role??raw.payload?.role??(row.kind==='message.user'?'user':row.kind.startsWith('tool.')?'tool':'assistant');
    messages.push({...row,text,role,channel:raw.node?.message?.channel??null,conversationId:item.id,conversationTitle:item.title,url:item.url||null,sha256:evidence.recordSha256});}
  const capturePath=path.join(item.path,'acquisition/capture.json');const capture=fs.existsSync(capturePath)?JSON.parse(fs.readFileSync(capturePath,'utf8')):null;
  const c={item,manifest,messages,capture,verification:{passed:true,checkedAt:new Date().toISOString()}};cache.set(item.id,c);return c;
}
export async function getLibrary(){(await import('./documents.mjs')).reconcileDocuments();refreshLibrary();return await Promise.all(library.map(async item=>{try{const c=await loadCase(item);return{...item,path:undefined,messages:c.messages.length,records:c.manifest.metrics.sourceRecords,hash:c.manifest.caseHash,coverage:c.capture?.coverage??'SOURCE_SNAPSHOT',verified:true,roles:c.capture?.roles??null};}catch(e){return{...item,path:undefined,verified:false,error:e.message};}}));}
export async function importCapturedRevision({id,bytes,title,captureJob,revisionHash,beforePublish=()=>{},isCurrent=()=>true}){
 if(!/^capture-[a-f0-9-]+$/.test(id)||createHash('sha256').update(bytes).digest('hex')!==revisionHash)throw new Error('CAPTURE_REVISION_BINDING');
 const caseDir=path.join(DATA,'cases',id);fs.mkdirSync(path.dirname(caseDir),{recursive:true});
 if(!fs.existsSync(caseDir)){const staging=caseDir+'.staging-'+randomUUID(),input=path.join(DATA,id+'.'+randomUUID()+'.jsonl');fs.writeFileSync(input,bytes,{flag:'wx'});try{await auditSession(input,{caseDir:staging,harness:'auto'});const verified=await verifyCaseIntegrity(staging,{verifyProjections:false});if(!verified.passed)throw new Error('CAPTURE_IMPORTED_CASE_INVALID');fs.renameSync(staging,caseDir);}finally{fs.unlinkSync(input);}}
 const originals=fs.readdirSync(path.join(caseDir,'evidence','sources'));if(!originals.some(f=>createHash('sha256').update(fs.readFileSync(path.join(caseDir,'evidence','sources',f))).digest('hex')===revisionHash))throw new Error('CAPTURE_EXISTING_CASE_HASH_MISMATCH');
 const item={id,title,path:caseDir,url:null,addedAt:new Date().toISOString(),captureJob,revisionHash,currentRevision:true};await loadCase(item);beforePublish();refreshLibrary();
 const current=isCurrent();item.currentRevision=current;for(const prior of library)if(current&&prior.captureJob===captureJob&&prior.id!==id)prior.currentRevision=false;
 const prior=library.find(i=>i.id===id);if(prior)Object.assign(prior,{currentRevision:current});else library.push(item);save(library.filter(i=>i.captureJob===captureJob));const reevaluation=await (await import('./reevaluation.mjs')).discoverReevaluations();return {...(prior||item),path:undefined,...(reevaluation?{reevaluation}:{})};
}
export async function addSource({url,filename,content,contentBase64}){
 const id=randomUUID(),caseDir=path.join(DATA,'cases',id);let result;
 if(url){result=await importChatGPTShare(url,{caseDir});}
 else{
   if(!/\.(jsonl|ndjson|json|zip|html?)$/i.test(filename||''))throw new Error('Selecciona JSON, JSONL, ZIP o HTML estructurado');
   let bytes;
   if(contentBase64!=null){if(typeof contentBase64!=='string'||contentBase64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64))throw new Error('Base64 inválido');bytes=Buffer.from(contentBase64,'base64');}
   else if(typeof content==='string')bytes=Buffer.from(content);else throw new Error('Contenido ausente');
   if(!bytes.length||bytes.length>40*1024*1024)throw new Error('El límite de importación es 40 MiB');
   const input=path.join(DATA,id+path.extname(filename).toLowerCase());
   fs.writeFileSync(input,bytes);try{result=await auditSession(input,{caseDir,harness:'auto'});}finally{fs.unlinkSync(input);}
 }

 const item={id,title:result.capture?JSON.parse(fs.readFileSync(path.join(caseDir,'evidence', 'sources',fs.readdirSync(path.join(caseDir,'evidence','sources'))[0]),'utf8').split('\n')[0]).conversation.title:filename.replace(/\.(jsonl|ndjson|json|zip|html?)$/i,''),path:caseDir,url:url||null,addedAt:new Date().toISOString()};
 await loadCase(item);library.push(item);save([item]);const reevaluation=await (await import('./reevaluation.mjs')).discoverReevaluations();return{...item,path:undefined,...(reevaluation?{reevaluation}:{})};
}
export async function retrieve(question,ids,extraTerms=[]){
 const selected=library.filter(x=>ids.includes(x.id));if(!selected.length)throw new Error('Selecciona al menos una conversación');
 const identityVersions=new Map();
 for(const item of selected){const check=await verifyCaseIntegrity(item.path);if(!check.passed)throw new Error('Integridad inválida: '+item.title);const c=await loadCase(item);for(const m of c.messages)if(m.occurrenceId){if(!identityVersions.has(m.occurrenceId))identityVersions.set(m.occurrenceId,new Set());identityVersions.get(m.occurrenceId).add(m.payloadSha256);}}
 const terms=words(question+' '+extraTerms.join(' ')).slice(0,35),candidates=[],anchors=[];
 for(const item of selected){const c=await loadCase(item);for(const m of c.messages){if(m.occurrenceId&&identityVersions.get(m.occurrenceId)?.size>1)continue;if(m.role==='system'&&!/sistema|system|instrucciones publicadas/.test(norm(question)))continue;const lower=norm(m.text);const positions=[];for(const t of terms){let pos=lower.indexOf(t);if(pos>=0)positions.push(pos);}
  const points=[...m.text],starts=new Set([0]);for(let offset=3000;offset<points.length;offset+=3000)starts.add(offset);
  for(const start of starts){const text=points.slice(start,start+3600).join(''),n=norm(text);const hits=terms.filter(t=>n.includes(t));const score=hits.reduce((s,t)=>s+1+Math.min(t.length,12)/10,0)+(m.role==='user'?1.6:m.role==='assistant'&&m.channel==='final'?2:0);
   const chunk={...m,text,start,end:start+[...text].length,score};if(hits.length)candidates.push(chunk);if(start===0&&m.role==='user')anchors.push(chunk);}
 }
 // Reserve source-specific candidates so a large conversation cannot crowd out another.
 }
 candidates.sort((a,b)=>b.score-a.score);const chosen=[],keys=new Set();function add(x){if(!x||!x.text.trim()||chosen.length>=30||x.occurrenceId&&identityVersions.get(x.occurrenceId)?.size>1)return;const key=(x.occurrenceId||x.conversationId+':'+x.id)+':'+Math.floor(x.start/1800);if(keys.has(key))return;keys.add(key);chosen.push(x);}
 for(const item of selected){for(const x of anchors.filter(x=>x.conversationId===item.id).slice(-6))add(x);for(const x of candidates.filter(x=>x.conversationId===item.id).slice(0,5))add(x);
   // Include the latest published conclusions even when the question vocabulary differs.
   const c=await loadCase(item);for(const m of c.messages.filter(x=>x.channel==='final').slice(-2)){add({...m,text:[...m.text].slice(0,3600).join(''),start:0,end:Math.min([...m.text].length,3600),score:0});}
 }
 for(const x of candidates){if(chosen.filter(c=>c.id===x.id&&c.conversationId===x.conversationId).length<3)add(x);}
 if(!chosen.length)for(const item of selected){const c=await loadCase(item);for(const m of c.messages.filter(m=>m.role==='user'||m.channel==='final').slice(-6))add({...m,text:[...m.text].slice(0,3600).join(''),start:0,end:Math.min([...m.text].length,3600),score:0});}
 return chosen.map((x,i)=>{const item=selected.find(y=>y.id===x.conversationId);readEvidence(item.path,x.uri);return{...x,rangeUnit:'unicode_codepoints',evidenceId:`E${i+1}`};});
}
export async function getEvidence(conversationId,eventId){const item=library.find(x=>x.id===conversationId);if(!item)throw new Error('Conversación desconocida');const c=await loadCase(item),m=c.messages.find(x=>x.id===eventId);if(!m)throw new Error('Evento desconocido');const raw=readEvidence(item.path,m.uri);const common=m.representationId?await readUnifiedEvidence(item.path,m.representationId):null;return{...m,raw:raw.text,identity:common,verified:true};}
export function validateAnswer(answer,evidence){
 if(!answer||!Array.isArray(answer.claims)||!answer.claims.length)throw new Error('Respuesta sin afirmaciones verificables');
 const spaces=s=>String(s).replace(/\s+/g,' ').trim();
 for(const claim of answer.claims){if(!['fact','inference','gap'].includes(claim.kind))throw new Error('Tipo de afirmación inválido');if(claim.kind==='gap'&&(claim.text!==GAP_TEXT||claim.evidence.length))throw new Error('Una abstención no puede ocultar afirmaciones sin cita');if(claim.kind!=='gap'&&!claim.evidence.length)throw new Error('Afirmación sin evidencia');for(const e of claim.evidence){const source=evidence.find(x=>x.evidenceId===e.id);if(!source||spaces(e.quote).length<8||!spaces(source.text).includes(spaces(e.quote)))throw new Error(`Cita no verificable: ${e.id}`);}}
 return answer;
}

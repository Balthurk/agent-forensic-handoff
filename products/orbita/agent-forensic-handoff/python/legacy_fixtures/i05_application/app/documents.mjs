import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DATA,registerLibraryItems,refreshLibrary,loadCase} from './corpus.mjs';
import {auditSession} from '../agent-forensic-handoff/src/audit.js';
import {verifyCaseIntegrity} from '../agent-forensic-handoff/src/integrity.js';
import {documentHash,decodeDocument,documentBlocks,attachDocumentEvidence} from '../agent-forensic-handoff/src/document-evidence.js';
import {openDB,transaction,writeDurable,now,checkpoint} from './durable.mjs';

export const DOCUMENT_EXTENSIONS=['.txt','.md','.markdown','.rst','.json','.jsonl','.ndjson','.yaml','.yml','.csv'];
const demand=(v,m)=>{if(!v)throw new Error(m);};
function exactInstant(value){
 if(typeof value!=='string'||value.endsWith('-00:00'))return false;
 const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
 if(!m||Number.isNaN(Date.parse(value)))return false;
 const [y,month,day,hour,minute,second]=m.slice(1).map(Number),leap=y%4===0&&(y%100!==0||y%400===0);
 return month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]&&hour<24&&minute<60&&second<60;
}
function open(){const db=openDB(path.join(DATA,'documents.sqlite'));db.exec('CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,case_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS document_versions(document_id TEXT,revision INTEGER,case_id TEXT UNIQUE,item TEXT,PRIMARY KEY(document_id,revision)); CREATE TABLE IF NOT EXISTS document_writers(id TEXT PRIMARY KEY,owner TEXT,pid INTEGER);');return db;}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function metadata(input,filename){
 demand(!input||typeof input==='object'&&!Array.isArray(input),'DOCUMENT_METADATA_OBJECT');
 const allowed=['title','author','sourceUri','sourceDate','validFrom','validUntil'];for(const k of Object.keys(input||{}))demand(allowed.includes(k),'DOCUMENT_METADATA_UNKNOWN_FIELD:'+k);
 const result={title:filename,author:null,sourceUri:null,sourceDate:null,validFrom:null,validUntil:null,...input};
 for(const k of ['title','author','sourceUri'])demand(result[k]===null||typeof result[k]==='string'&&result[k].length<=(k==='sourceUri'?2000:500),'DOCUMENT_METADATA_INVALID:'+k);
 demand(typeof result.title==='string'&&result.title.trim(),'DOCUMENT_TITLE_REQUIRED');
 if(result.sourceUri)demand(/^https?:\/\//i.test(result.sourceUri),'DOCUMENT_SOURCE_URI_HTTP_ONLY');
 for(const k of ['sourceDate','validFrom','validUntil'])if(result[k]!==null)demand(exactInstant(result[k]),'DOCUMENT_TIME_REQUIRES_EXPLICIT_INSTANT:'+k);
 if(result.validFrom&&result.validUntil)demand(Date.parse(result.validFrom)<Date.parse(result.validUntil),'DOCUMENT_VALIDITY_ORDER');
 return result;
}
export function documentStatus(){const db=open();try{return {documents:db.prepare('SELECT * FROM documents ORDER BY id').all(),versions:db.prepare('SELECT document_id,revision,case_id,item FROM document_versions ORDER BY document_id,revision').all().map(r=>({...r,item:JSON.parse(r.item)})),limits:'Metadata is a local declaration. Latest stored revision does not certify truth or applicability.'};}finally{db.close();}}
export function reconcileDocuments(){
 if(!fs.existsSync(path.join(DATA,'documents.sqlite')))return {published:0};const db=open();
 try{return transaction(db,()=>{const rows=db.prepare('SELECT v.item,v.revision,d.revision head FROM document_versions v JOIN documents d ON d.id=v.document_id').all();
  const items=rows.map(r=>({...JSON.parse(r.item),currentRevision:r.revision===r.head}));
  if(items.length)registerLibraryItems(items);return {published:items.length};
 });}finally{db.close();}
}
export async function readDocumentOriginal(caseId){
 demand(/^document-[a-f0-9]{64}$/.test(caseId),'DOCUMENT_CASE_ID');reconcileDocuments();refreshLibrary();
 const item=(await import('./corpus.mjs')).library.find(x=>x.id===caseId);demand(item?.kind==='document','DOCUMENT_NOT_FOUND');
 await loadCase(item);const bytes=fs.readFileSync(path.join(DATA,'cases',caseId,'acquisition/document/original.bin'));
 demand(documentHash(bytes)===item.document.sha256,'DOCUMENT_ORIGINAL_CHANGED');return {filename:item.document.filename,sha256:item.document.sha256,bytes};
}
export async function importDocument({filename,content,contentBase64,documentId,expectedRevision=0,metadata:inputMetadata}){
 demand(typeof filename==='string'&&filename.length>0&&filename.length<=255&&!/[\\/:\u0000]/.test(filename)&&filename!=='.'&&filename!=='..','DOCUMENT_FILENAME_INVALID');
 const extension=path.extname(filename).toLowerCase();demand(DOCUMENT_EXTENSIONS.includes(extension),'DOCUMENT_FORMAT_UNSUPPORTED: text, Markdown, RST, JSON, YAML or CSV; PDF/OCR not included');
 let bytes;
 if(contentBase64!==undefined){demand(typeof contentBase64==='string'&&contentBase64.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64),'DOCUMENT_BASE64_INVALID');bytes=Buffer.from(contentBase64,'base64');demand(bytes.toString('base64')===contentBase64,'DOCUMENT_BASE64_INVALID');}
 else{demand(typeof content==='string','DOCUMENT_CONTENT_REQUIRED');bytes=Buffer.from(content,'utf8');demand(bytes.toString('utf8')===content,'DOCUMENT_UNPAIRED_SURROGATE');}
 const text=decodeDocument(bytes),rawHash=documentHash(bytes),id=documentId??'doc-'+rawHash;
 demand(/^[a-zA-Z0-9_-]{1,120}$/.test(id),'DOCUMENT_ID_INVALID');demand(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0,'DOCUMENT_EXPECTED_REVISION_INVALID');
 const meta=metadata(inputMetadata,filename),db=open(),owner=randomUUID();let claimed=false;
 try{
  transaction(db,()=>{const writer=db.prepare('SELECT * FROM document_writers WHERE id=?').get(id);if(writer&&alive(writer.pid))throw new Error('DOCUMENT_WRITER_BUSY');db.prepare('INSERT OR REPLACE INTO document_writers VALUES(?,?,?)').run(id,owner,process.pid);});claimed=true;
  const head=db.prepare('SELECT v.* FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.revision WHERE d.id=?').get(id),old=head?JSON.parse(head.item):null;
  if(old&&old.document.sha256===rawHash&&(!inputMetadata||JSON.stringify(old.document.metadata)===JSON.stringify(meta))){reconcileDocuments();await loadCase({...old,path:path.join(DATA,'cases',old.id)});return {...old,path:undefined,duplicate:true};}
  demand((head?.revision??0)===expectedRevision,'DOCUMENT_REVISION_CONFLICT');
  const revision=expectedRevision+1,header={documentId:id,revision,filename,sha256:rawHash,bytes:bytes.length,metadata:meta,metadataAuthority:'local_declaration_not_authenticated',format:extension,syntax:'verbatim_text'};
  if(extension==='.json'){try{JSON.parse(text);header.syntax='json_syntax_valid_no_schema_claim';}catch{header.syntax='invalid_json_preserved_as_text';}}
  const caseId='document-'+documentHash(JSON.stringify(header)),caseDir=path.join(DATA,'cases',caseId),blocks=documentBlocks(bytes,id);
  if(!fs.existsSync(caseDir)){
   // Keep the temporary database path short on Windows. Appending a UUID to
   // the full content ID can leave no room for SQLite's journal suffix inside
   // a managed workspace. The final content-addressed case ID is unchanged.
   const staging=path.join(DATA,'cases','.document-staging-'+randomUUID()),inputDir=path.join(DATA,'document-inputs',randomUUID()),input=path.join(inputDir,caseId+'.jsonl');
   const records=[{type:'afh.document.header',session_id:id,document:header},...blocks.map(b=>({type:'afh.document.block',session_id:id,id:b.id,start:b.start,end:b.end,text:b.text}))];
   writeDurable(input,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
   try{await auditSession(input,{caseDir:staging,harness:'document'});attachDocumentEvidence(staging,{bytes,header,blocks});
    const check=await verifyCaseIntegrity(staging,{verifyProjections:false});demand(check.passed,'DOCUMENT_CASE_INTEGRITY:'+check.findings.filter(f=>!f.ok).map(f=>f.detail).join(';'));
    checkpoint('document-before-case-publish');fs.renameSync(staging,caseDir);checkpoint('document-after-case-publish');
   }finally{if(fs.existsSync(input))fs.unlinkSync(input);if(fs.existsSync(inputDir)&&fs.readdirSync(inputDir).length===0)fs.rmdirSync(inputDir);}
  }
  const item={id:caseId,title:meta.title,path:caseDir,url:null,addedAt:now(),kind:'document',captureJob:'document-'+id,revisionHash:documentHash(JSON.stringify(header)),currentRevision:true,document:{...header,blocks:blocks.length,originalPath:'acquisition/document/original.bin',latestIsNotTruth:true}};
  await loadCase(item);
  transaction(db,()=>{demand((db.prepare('SELECT revision FROM documents WHERE id=?').get(id)?.revision??0)===expectedRevision,'DOCUMENT_REVISION_CONFLICT');
   db.prepare('INSERT INTO document_versions VALUES(?,?,?,?)').run(id,revision,caseId,JSON.stringify(item));db.prepare('INSERT INTO documents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,case_id=excluded.case_id').run(id,revision,caseId);
  });checkpoint('document-after-commit');reconcileDocuments();refreshLibrary();
  const reevaluation=await(await import('./reevaluation.mjs')).discoverReevaluations();return {...item,path:undefined,duplicate:false,reevaluation};
 }finally{if(claimed)db.prepare('DELETE FROM document_writers WHERE id=? AND owner=?').run(id,owner);db.close();}
}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { sha256, stableStringify } from './util.js';
import { assertSafeSourcePath } from './discovery.js';
import { parseSharePage } from './chatgpt-share.js';
import { FORMAT, conversationRecords, isConversation, digestObject, attachmentReferences } from './conversation-format.js';

const require=createRequire(import.meta.url);
const AdmZip=require('./vendor/adm-zip/adm-zip.js');
const {crc32}=require('./vendor/adm-zip/util');
export const INTAKE_VERSION='afh.intake.v1';
const utf8=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);

export function intakeLimits(options={}) {
  const limits={maxBytes:Number(options.maxTotalSourceBytes??128*1024*1024),maxExpandedBytes:Number(options.maxDecompressedBytes??256*1024*1024),maxEntryBytes:Number(options.maxEntryBytes??64*1024*1024),maxEntries:Number(options.maxEntries??10000),maxCompressionRatio:Number(options.maxCompressionRatio??200)};
  for(const [name,value] of Object.entries(limits))if(!Number.isSafeInteger(value)||value<=0)throw new Error(`Invalid intake limit: ${name}`);
  return limits;
}

// No member is extracted using its untrusted path. Central-directory metadata is
// checked BEFORE inflation. The pinned library handles descriptors and ZIP64.
export function readZip(bytes, limits=intakeLimits()) {
  const zip=new AdmZip(bytes), entries=zip.getEntries();
  if(!entries.length || entries.length>limits.maxEntries)throw new Error('ZIP entry count limit or empty archive');
  const names=new Set(),spans=[];let expanded=0;
  for(const e of entries) {
    const h=e.header,n=e.entryName;
    if(!n||n.includes('\\')||n.startsWith('/')||n.includes(':')||n.includes('\0')||n.split('/').some(p=>p==='..'||p==='.')||names.has(n.normalize('NFC').toLowerCase()))throw new Error('Unsafe or duplicate ZIP member name');
    names.add(n.normalize('NFC').toLowerCase());
    const offset=h.offset;
    if(!Number.isSafeInteger(offset)||offset<0||offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50)throw new Error('Invalid ZIP local header');
    const nameLen=bytes.readUInt16LE(offset+26),extraLen=bytes.readUInt16LE(offset+28),dataOffset=offset+30+nameLen+extraLen;
    const rawName=bytes.subarray(offset+30,offset+30+nameLen);
    if(!rawName.equals(e.rawEntryName)||bytes.readUInt16LE(offset+8)!==h.method||bytes.readUInt16LE(offset+6)!==h.flags||dataOffset+h.compressedSize>bytes.length)throw new Error('ZIP local/central header mismatch');
    spans.push([offset,dataOffset+h.compressedSize]);
    if(h.method===0&&h.size!==h.compressedSize)throw new Error('Stored ZIP sizes disagree');
    if(h.encrypted||!Number.isSafeInteger(h.size)||!Number.isSafeInteger(h.compressedSize)||h.size<0||h.compressedSize<0||![0,8].includes(h.method))throw new Error('Unsupported ZIP encryption, method or size');
    if(((h.attr>>>16)&0o170000)===0o120000)throw new Error('ZIP symlink not supported');
    expanded+=h.size;
    if(h.size>limits.maxEntryBytes||expanded>limits.maxExpandedBytes||h.size/Math.max(1,h.compressedSize)>limits.maxCompressionRatio)throw new Error('ZIP expansion limit');
    // adm-zip does not cap a deflate stream declaring zero output. Reject that
    // exceptional case rather than inflate it without a bound.
    if(h.method===8&&h.size===0&&h.compressedSize>2)throw new Error('Ambiguous zero-size deflate stream');
    if(e.isDirectory&&(h.size||h.compressedSize))throw new Error('ZIP directory contains data');
  }
  spans.sort((a,b)=>a[0]-b[0]);
  for(let i=1;i<spans.length;i++)if(spans[i][0]<spans[i-1][1])throw new Error('Overlapping ZIP members');
  return entries.filter(e=>!e.isDirectory).map(e=>{
    const data=e.getData();
    if(data.length!==e.header.size||crc32(data)!==e.header.crc)throw new Error(`ZIP length or CRC mismatch: ${e.entryName}`);
    return {name:e.entryName,bytes:data,sha256:sha256(data)};
  });
}

function parseJsonLines(bytes) {
  const rows=utf8(bytes).split(/\r?\n/).filter(x=>x.trim()).map(x=>JSON.parse(x));
  if(rows[0]?.type==='afh.export.header'&&rows[0]?.format===FORMAT) {
    const mapping=Object.create(null);
    for(const row of rows.slice(1)) {
      if(row.type!=='afh.export.node'||!row.node||Object.hasOwn(mapping,row.node.id))throw new Error('Invalid forensic JSONL node');
      mapping[row.node.id]=row.node;
    }
    if(rows[0].nodeCount!==Object.keys(mapping).length)throw new Error('Forensic JSONL coverage mismatch');
    return {value:{...rows[0].conversation,mapping},coverage:'EXPORTED_SNAPSHOT',projection:'afh-jsonl-v1'};
  }
  if(rows[0]?.type==='chatgpt_session_meta') {
    const head=rows[0],mapping=Object.create(null);
    for(const row of rows.slice(1)) {
      if(row.type!=='chatgpt_node'||typeof row.node_id!=='string'||Object.hasOwn(mapping,row.node_id))throw new Error('Invalid legacy forensic JSONL');
      mapping[row.node_id]={id:row.node_id,parent:row.parent_id??null,children:row.children_ids??[],message:row.message??null,legacy_record:row};
    }
    return {value:{...head,mapping},coverage:'LEGACY_LOSSY_EXPORT',projection:'legacy-jsonl-v7'};
  }
  return null;
}

function parseMember(member) {
  const name=member.name.toLowerCase();
  if(/\.(jsonl|ndjson)$/.test(name))return parseJsonLines(member.bytes);
  if(/\.json$/.test(name))return {value:JSON.parse(utf8(member.bytes)),coverage:'EXPORTED_SNAPSHOT',projection:'json'};
  if(/\.html?$/.test(name)) {
    const html=utf8(member.bytes);
    const embedded=[...html.matchAll(/<script\s+id="afh-original"\s+type="application\/octet-stream">([A-Za-z0-9+/=\s]+)<\/script>/g)];
    if(embedded.length===1) return {value:JSON.parse(utf8(Buffer.from(embedded[0][1].replace(/\s/g,''),'base64'))),coverage:'EXPORTED_SNAPSHOT',projection:'afh-html-v1'};
    if(embedded.length>1)throw new Error('Ambiguous embedded original');
    if(html.includes('window.__reactRouterContext.streamController.enqueue')) {
      const p=parseSharePage(member.bytes);
      return {value:{...p.conversation,mapping:Object.fromEntries(p.nodes.map(n=>[n.id,n]))},coverage:'PUBLISHED_SNAPSHOT_ONLY',namespace:'chatgpt-share',projection:'shared-html-v1'};
    }
    return null; // Display-only legacy HTML cannot prove lossless coverage.
  }
  return null;
}

export function normalizeContainer(bytes, filename, options={}) {
  const limits=intakeLimits(options);
  if(bytes.length>limits.maxBytes)throw new Error('Source byte limit');
  const sourceHash=sha256(bytes),members=/\.zip$/i.test(filename)?readZip(bytes,limits):[{name:path.basename(filename),bytes,sha256:sourceHash}];
  const records=[],documents=[],attachments=[];
  for(const member of members) {
    let parsed,parseIssue=null;
    try{parsed=parseMember(member);}
    catch(error){
      if(!/^(files|attachments)\//i.test(member.name))throw error;
      // An attached file named *.json is not necessarily a conversation. Keep
      // its exact binary bytes without claiming a successful semantic parse.
      parsed=null;parseIssue='UNPARSED_ANCILLARY';
    }
    const values=parsed?(Array.isArray(parsed.value)?parsed.value:[parsed.value]):[];
    let recognized=false;
    for(let i=0;i<values.length;i++) {
      if(!isConversation(values[i]))continue;
      recognized=true;
      const pointer=Array.isArray(parsed.value)?`/${i}`:'';
      const docRecords=conversationRecords(values[i],{member:member.name,pointer,namespace:parsed.namespace,sourceHash,coverage:parsed.coverage});
      documents.push({member:member.name,pointer,conversationId:docRecords[0].conversationId,coverage:parsed.coverage,projection:parsed.projection,nodes:docRecords.length-1});
      records.push(...docRecords);
    }
    attachments.push({member:member.name,sha256:member.sha256,bytes:member.bytes.length,kind:recognized?'conversation':'ancillary',status:'ARCHIVED',...(parseIssue?{parseIssue}:{})});
  }
  if(!documents.length)throw new Error('No supported structured ChatGPT conversation; display-only HTML is insufficient');
  // Copies of the same native message are representations, not new decisions.
  // Conflicting revisions are retained but quarantined from the operational view.
  const groups=new Map();
  for(const r of records)if(r.node?.message) {
    const key=stableStringify([r.conversationId,r.node.message.id,r.node.message.author.role]);
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
  }
  for(const group of groups.values()) {
    const versions=new Set(group.map(r=>digestObject(r.node.message)));
    if(versions.size>1)for(const r of group){r.scope='conflict';r.identityConflict=true;}
    else for(const r of group.slice(1))r.representationOnly=true;
  }
  const refs=attachmentReferences(records);
  // File-name similarity is not sufficient to bind an attachment to a message.
  return {records,members,summary:{version:INTAKE_VERSION,sourceHash,filename:path.basename(filename),limits,documents,attachments,attachmentReferences:refs,limitations:['Snapshot coverage only; unknown original branches cannot be reconstructed.','Archived ancillary files are not bound to references without an explicit verified mapping.','Source claims and published tool statuses are observations, not execution receipts.']}};
}

export function isConversationInput(filename) {
  if(!fs.existsSync(filename)||!fs.statSync(filename).isFile())return false;
  if(/\.(json|zip|html?)$/i.test(filename))return true;
  if(!/\.(jsonl|ndjson)$/i.test(filename))return false;
  const fd=fs.openSync(filename,'r'),buffer=Buffer.alloc(8192);let length;
  try{length=fs.readSync(fd,buffer);}finally{fs.closeSync(fd);}
  return /"type"\s*:\s*"(?:afh\.export\.header|chatgpt_session_meta)"/.test(buffer.subarray(0,length).toString('utf8'));
}

export async function importConversation(filename, options={}) {
  assertSafeSourcePath(filename,{allowSymlink:options.allowSymlink??false});
  const limits=intakeLimits(options),stat=fs.statSync(filename);
  if(stat.size>limits.maxBytes)throw new Error('Source byte limit');
  const bytes=fs.readFileSync(filename);
  if(bytes.length!==stat.size)throw new Error('Source changed during acquisition');
  const normalized=normalizeContainer(bytes,filename,options),capturedAt=new Date().toISOString();
  const root=path.resolve(options.caseDir||path.join(options.out||process.env.AFH_HOME||path.join(os.homedir(),'.afh'),'cases',`import-${normalized.summary.sourceHash.slice(0,16)}-${Date.now()}`));
  if(fs.existsSync(root))throw new Error('Case directory already exists');
  fs.mkdirSync(path.dirname(root),{recursive:true});const work=fs.mkdtempSync(root+'.intake-');
  try {
    const input=path.join(work,'normalized.jsonl');
    fs.writeFileSync(input,normalized.records.map(r=>JSON.stringify(r)).join('\n')+'\n');
    const {auditSession}=await import('./audit.js');
    const result=await auditSession(input,{...options,caseDir:path.join(work,'case'),harness:'chatgpt-import',includeChildren:false,workspace:null,_deferIdentity:true});
    const acquisition=path.join(result.caseDir,'acquisition');fs.mkdirSync(acquisition,{recursive:true});
    fs.writeFileSync(path.join(acquisition,'original.bin'),bytes);
    const capture={...normalized.summary,capturedAt,registeredAt:result.manifest.completedAt,originalPath:'acquisition/original.bin',originalBytes:bytes.length};
    fs.writeFileSync(path.join(acquisition,'intake.json'),JSON.stringify(capture,null,2)+'\n');
    const {writeIdentity}=await import('./identity-evidence.js');await writeIdentity(result.caseDir);
    const {verifyCaseIntegrity}=await import('./integrity.js');const verification=await verifyCaseIntegrity(result.caseDir);
    if(!verification.passed)throw new Error('Imported case verification failed: '+verification.findings.filter(f=>!f.ok).map(f=>f.detail).join('; '));
    fs.renameSync(result.caseDir,root);return {...result,caseDir:root,manifest:JSON.parse(fs.readFileSync(path.join(root,'case.json'),'utf8')),intake:capture};
  }finally{fs.rmSync(work,{recursive:true,force:true});}
}

export function verifyIntake(root, canonicalPath) {
  const capture=JSON.parse(fs.readFileSync(path.join(root,'acquisition/intake.json'),'utf8'));
  if(capture.version!==INTAKE_VERSION||capture.originalPath!=='acquisition/original.bin')throw new Error('Invalid intake manifest');
  const bytes=fs.readFileSync(path.join(root,capture.originalPath));
  if(bytes.length!==capture.originalBytes||sha256(bytes)!==capture.sourceHash)throw new Error('Original acquisition hash or length mismatch');
  const parsed=normalizeContainer(bytes,capture.filename,{maxTotalSourceBytes:capture.limits.maxBytes,maxDecompressedBytes:capture.limits.maxExpandedBytes,...capture.limits});
  for(const key of Object.keys(parsed.summary))if(stableStringify(parsed.summary[key])!==stableStringify(capture[key]))throw new Error(`Intake manifest differs from original: ${key}`);
  const expected=parsed.records.map(r=>JSON.stringify(r)).join('\n')+'\n';
  if(!fs.readFileSync(canonicalPath).equals(Buffer.from(expected)))throw new Error('Canonical records differ from original acquisition');
  return {documents:parsed.summary.documents.length,nodes:parsed.records.filter(r=>r.node).length,attachments:parsed.summary.attachments.length};
}

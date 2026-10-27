import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {safeCasePath} from './identity-evidence.js';

export const DOCUMENT_VERSION='orbita-text-document-1';
export const DOCUMENT_BLOCK_BYTES=24576;
export const documentHash=b=>createHash('sha256').update(b).digest('hex');
const demand=(ok,why)=>{if(!ok)throw new Error(why);};
function persist(file,bytes,flag='wx'){const fd=fs.openSync(file,flag);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function decodeDocument(bytes){
 demand(bytes.length<=40*1024*1024,'DOCUMENT_LIMIT_40_MIB');
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new Error('DOCUMENT_INVALID_UTF8: original must be decoded explicitly; no replacement characters inserted');}
 demand(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text),'DOCUMENT_BINARY_OR_CONTROL_DATA');
 demand(Buffer.from(text,'utf8').equals(bytes),'DOCUMENT_UTF8_ROUNDTRIP');return text;
}
export function documentBlocks(bytes,documentId){
 decodeDocument(bytes);const blocks=[];let start=0;
 while(start<bytes.length){let end=Math.min(bytes.length,start+DOCUMENT_BLOCK_BYTES);
  while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
  if(end<bytes.length){const newline=bytes.lastIndexOf(10,end-1);if(newline>=start+Math.floor(DOCUMENT_BLOCK_BYTES/2))end=newline+1;}
  const text=bytes.subarray(start,end).toString('utf8'),textSha256=documentHash(Buffer.from(text));
  blocks.push({id:'block-'+documentHash(JSON.stringify([documentId,start,textSha256])),start,end,text,textSha256});start=end;
 }
 return blocks;
}
export function attachDocumentEvidence(root,{bytes,header,blocks}){
 const dir=path.join(root,'acquisition/document');fs.mkdirSync(dir,{recursive:true});
 persist(path.join(dir,'original.bin'),bytes);
 const descriptor={schema:DOCUMENT_VERSION,header,blocks:blocks.map(({text,...b})=>b),originalPath:'acquisition/document/original.bin',coordinateSpace:'original-utf8-bytes',completePartition:true};
 const serialized=Buffer.from(JSON.stringify(descriptor,null,2)+'\n');persist(path.join(dir,'manifest.json'),serialized);
 const file=path.join(root,'case.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 manifest.documentEvidence={schema:DOCUMENT_VERSION,path:'acquisition/document/manifest.json',sha256:documentHash(serialized)};persist(file,JSON.stringify(manifest,null,2)+'\n','w');
}
export function verifyDocumentEvidence(root,manifest){
 const ref=manifest.documentEvidence;demand(ref?.schema===DOCUMENT_VERSION&&ref.path==='acquisition/document/manifest.json','DOCUMENT_BINDING_MISSING');
 const serialized=fs.readFileSync(safeCasePath(root,ref.path));demand(documentHash(serialized)===ref.sha256,'DOCUMENT_DESCRIPTOR_HASH');
 const descriptor=JSON.parse(serialized);demand(descriptor.schema===DOCUMENT_VERSION&&descriptor.originalPath==='acquisition/document/original.bin','DOCUMENT_DESCRIPTOR_FORMAT');
 const bytes=fs.readFileSync(safeCasePath(root,descriptor.originalPath));decodeDocument(bytes);
 demand(bytes.length===descriptor.header.bytes&&documentHash(bytes)===descriptor.header.sha256,'DOCUMENT_ORIGINAL_HASH');
 demand(manifest.sources.length===1&&manifest.sources[0].harness==='document','DOCUMENT_SOURCE_FORMAT');
 const rows=fs.readFileSync(safeCasePath(root,manifest.sources[0].evidencePath),'utf8').trimEnd().split('\n').map(JSON.parse);
 demand(rows[0].type==='afh.document.header'&&JSON.stringify(rows[0].document)===JSON.stringify(descriptor.header),'DOCUMENT_HEADER_BINDING');
 const expected=documentBlocks(bytes,descriptor.header.documentId);
 demand(expected.length===descriptor.blocks.length&&rows.length===expected.length+1,'DOCUMENT_BLOCK_COVERAGE');
 for(let i=0;i<expected.length;i++){const b=expected[i],r=rows[i+1],d=descriptor.blocks[i];
  demand(r.type==='afh.document.block'&&r.session_id===descriptor.header.documentId&&r.id===b.id&&r.text===b.text&&r.start===b.start&&r.end===b.end,'DOCUMENT_BLOCK_BINDING');
  demand(JSON.stringify(d)===JSON.stringify((({text,...v})=>v)(b)),'DOCUMENT_BLOCK_MANIFEST');
 }
 return {bytes:bytes.length,sha256:descriptor.header.sha256,blocks:expected.length,exactOriginal:true,header:descriptor.header};
}

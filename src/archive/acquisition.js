import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {Readable} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import {normalizeRecord} from '../adapters.js';
import {assertSourcePath} from '../discovery.js';
import {nativeSessionId} from './identity.js';
import {CHUNK_BYTES,putObject,readObject,saveSourceManifest,writeJson,inside} from './storage.js';
import {hash,digest,failure} from './protocol.js';

export const DEFAULT_LIMITS={max_record_bytes:16*1024*1024,max_decoded_source_bytes:8*1024**3,max_job_bytes:16*1024**3,max_expansion_ratio:100};
const MAXIMUM_LIMITS={max_record_bytes:64*1024*1024,max_decoded_source_bytes:64*1024**3,max_job_bytes:256*1024**3,max_expansion_ratio:1000};
export function acquisitionLimits(overrides={}){for(const [name,value]of Object.entries(overrides))if(!Object.hasOwn(MAXIMUM_LIMITS,name)||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>MAXIMUM_LIMITS[name])throw failure('INVALID_REQUEST','Invalid acquisition limit');return {...DEFAULT_LIMITS,...Object.fromEntries(Object.entries(overrides).map(([key,value])=>[key,Number(value)]))};}
async function storeChunks(root,stream,previous=[],onChunk=()=>{}){
  const objects=[],hasher=createHash('sha256');let pending=Buffer.alloc(0),offset=0,index=0,reused=0;
  const publish=bytes=>{const object=putObject(root,bytes);reused+=Number(object.reused);delete object.reused;objects.push({...object,offset});offset+=bytes.length;index++;};
  for await(const chunk of stream){onChunk(chunk);hasher.update(chunk);pending=Buffer.concat([pending,chunk]);let size=previous[index]?.length??CHUNK_BYTES;while(pending.length>=size){publish(pending.subarray(0,size));pending=pending.subarray(size);size=previous[index]?.length??CHUNK_BYTES;}}
  if(pending.length)publish(pending);return {objects,sha256:hasher.digest('hex'),bytes:offset,reused};
}
function decodedStream(root,raw,codec){
  const source=Readable.from((function*(){for(const object of raw.objects)yield readObject(root,object);})());
  if(codec==='none')return source;
  const decoder=codec==='gzip'?zlib.createGunzip():typeof zlib.createZstdDecompress==='function'?zlib.createZstdDecompress():null;
  if(!decoder)throw failure('UNAVAILABLE','Runtime does not support this source codec');source.on('error',error=>decoder.destroy(error));return source.pipe(decoder);
}
function byteRecords(onRecord=()=>{},{retain=true}={}){
  const records=[];let ordinal=0,length=0,offset=0,sha=createHash('sha256'),parseBuffer=[],parseBytes=0;
  const append=(bytes,limit)=>{sha.update(bytes);length+=bytes.length;if(parseBytes<=limit){parseBuffer.push(bytes);parseBytes+=bytes.length;if(parseBytes>limit)parseBuffer=[];}};
  const finish=(terminated,limit)=>{const raw=parseBytes<=limit?Buffer.concat(parseBuffer):null,record={ordinal:++ordinal,byte_offset:offset,byte_length:length,sha256:sha.digest('hex'),includes_terminator:terminated,original_extent_bytes:length,raw};onRecord(record);if(retain)records.push(record);offset+=length;length=0;sha=createHash('sha256');parseBuffer=[];parseBytes=0;};
  return {records,consume(chunk,limit){let start=0;for(let i=0;i<chunk.length;i++)if(chunk[i]===10){append(chunk.subarray(start,i+1),limit);finish(true,limit);start=i+1;}if(start<chunk.length)append(chunk.subarray(start),limit);},finish(limit){if(length)finish(false,limit);}};
}
function decodedIdentity(record,harness){if(!record||typeof record!=='object'||Array.isArray(record))return null;if(harness==='codex')return record.type==='session_meta'?record.payload?.id??record.payload?.session_id??null:null;return record.session_id??record.sessionId??record.conversationId??null;}
function parseRecord(raw){if(!raw)return undefined;try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw));}catch{return undefined;}}
function supportedStructure(value){const stack=[[value,0]];while(stack.length){const [item,depth]=stack.pop();if(depth>32||Array.isArray(item)&&item.length>1000)return false;if(item&&typeof item==='object')for(const child of Object.values(item))stack.push([child,depth+1]);}return true;}
export async function acquireSource(root,input,previousSources,limits,{signal,onBoundary}={}){
  assertSourcePath(input.path);const resolved=path.resolve(input.path),fd=fs.openSync(resolved,'r');let boundary;
  try{
    const stat=fs.fstatSync(fd,{bigint:true});if(!stat.isFile())throw failure('INVALID_REQUEST','Source must be a regular file');
    if(stat.size>BigInt(limits.max_job_bytes)||stat.size>BigInt(Number.MAX_SAFE_INTEGER))throw failure('LIMIT_EXCEEDED','Source exceeds job boundary limit');
    boundary={path:resolved,bytes:Number(stat.size),dev:String(stat.dev),ino:String(stat.ino),host_id:os.hostname()};
    const previous=previousSources.find(source=>source.harness===input.harness&&source.origin_domain_id===input.origin_domain_id&&(input.source_lineage_id?source.source_lineage_id===input.source_lineage_id:source.boundary.ino!=='0'&&source.boundary.ino===boundary.ino&&source.boundary.dev===boundary.dev&&source.boundary.host_id===boundary.host_id));
    const lineage=input.source_lineage_id??previous?.source_lineage_id??randomUUID();
    await onBoundary?.(boundary);
    const stream=boundary.bytes?fs.createReadStream(resolved,{fd,autoClose:false,start:0,end:boundary.bytes-1,highWaterMark:CHUNK_BYTES,signal}):Readable.from([]);
    const raw=await storeChunks(root,stream,previous?.objects);if(raw.bytes!==boundary.bytes)throw failure('INTEGRITY_FAILED','Source became shorter than its captured boundary');
    const identityEpoch='epoch4-'+digest({source_lineage_id:lineage,parent_source_revision_id:previous?.source_revision_id??null,raw_sha256:raw.sha256,raw_bytes:raw.bytes});
    const codec=/\.gz$/i.test(resolved)?'gzip':/\.(?:zst|zstd)$/i.test(resolved)?'zstd':'none';
    let native=input.native_id??previous?.native_id??null;
    const parser=byteRecords(record=>{const value=parseRecord(record.raw),observed=decodedIdentity(value,input.harness);if(observed!==null){if(typeof observed!=='string'||!observed.length)throw failure('INVALID_REQUEST','Native session identifier must be a nonempty string');if(native!==null&&native!==observed)throw failure('AMBIGUOUS_IDENTITY','Source contains conflicting native session owners');native=observed;}delete record.raw;});let decodedBytes=0;
    const decode=decodedStream(root,raw,codec);
    const consume=chunk=>{if(signal?.aborted)throw failure('CANCELLED','Acquisition cancelled');decodedBytes+=chunk.length;if(decodedBytes>limits.max_decoded_source_bytes||codec!=='none'&&decodedBytes>Math.max(1,raw.bytes)*limits.max_expansion_ratio)throw failure('LIMIT_EXCEEDED','Decoded source exceeds configured byte or expansion limit');parser.consume(chunk,limits.max_record_bytes);};
    let decoded;
    try{if(codec==='none'){for await(const chunk of decode)consume(chunk);decoded=raw;}else decoded=await storeChunks(root,decode,previous?.decoded_objects??[],consume);}catch(error){decode.destroy();if(error.code?.startsWith('Z_'))throw failure('INTEGRITY_FAILED','Compressed source cannot be decoded');throw error;}
    parser.finish(limits.max_record_bytes);
    let prefix=0;for(const record of parser.records){const old=previous?.records[prefix];if(!old||old.sha256!==record.sha256||old.byte_length!==record.byte_length)break;prefix++;}
    const location={host_id:boundary.host_id,path:boundary.path},locations=[...(previous?.location_observations??[])];if(!locations.some(item=>item.host_id===location.host_id&&item.path===location.path))locations.push(location);
    const continuous=previous&&prefix===previous.records.length&&previous.records.every(r=>r.includes_terminator)&&raw.bytes>=previous.raw_bytes;
    const sessionId=native?nativeSessionId({harness:input.harness,origin_domain_id:input.origin_domain_id,native_id:native}):'ses4-'+digest([input.harness,input.origin_domain_id,'provisional',lineage]);
    const effective={harness:input.harness,origin_domain_id:input.origin_domain_id,source_lineage_id:lineage,native_id:native,session_id:sessionId,codec,identity_status:native?'VERIFIED':'UNCERTAIN',provisional:native===null};
    const unchanged=previous&&raw.sha256===previous.raw_sha256&&raw.bytes===previous.raw_bytes&&locations.length===previous.location_observations?.length&&Object.entries(effective).every(([field,value])=>previous[field]===value);
    // Defer this conflict until the engine has compared the idempotency digest
    // of all captured inputs. Nothing from this acquisition is published yet.
    const identityConflict=previous?.native_id!==null&&previous?.native_id!==undefined&&previous.native_id!==native?{source_lineage_id:lineage,established_native_id:previous.native_id,requested_native_id:native,origin_domain_id:input.origin_domain_id,harness:input.harness}:null;
    const counts={records_preserved:parser.records.length,records_parsed:0,records_unparsed:0,records_normalized:0,records_unsupported:0};
    const records=[],normalizer=byteRecords(record=>{
      const index=record.ordinal-1;record.value=parseRecord(record.raw);
      const epoch=index<prefix?previous.records[index].identity_epoch:identityEpoch;
      const parsed=record.value!==undefined;let normalized=[];
      if(parsed){counts.records_parsed++;const values=Array.isArray(record.value)?record.value:[record.value];if(supportedStructure(record.value))for(const value of values)if(value&&typeof value==='object')normalized.push(...normalizeRecord(value,{harness:input.harness,nativeId:native??'provisional',sessionNativeId:native??'provisional',sourceId:lineage,stateMetadata:{}}));if(normalized.length>1000)normalized=[];}
      else counts.records_unparsed++;
      const supported=normalized.some(event=>event.kind!=='forensic.unknown_record');if(parsed)counts[supported?'records_normalized':'records_unsupported']++;
      const events=normalized.map((event,i)=>({id:'evt4-'+digest([lineage,epoch,record.ordinal,event.pointer??'',i,event.kind]),kind:event.kind,native_id:event.nativeId??null,session_id:sessionId,actor:event.actor,input:event.input??null,output:event.output??null,status:event.status??null,metadata:event.metadata??{},session_metadata:event.session?.metadata??{},session_edges:event.sessionEdges??[]}));
      const {raw:discardRaw,value:discardValue,...stored}=record,oversized=record.byte_length>limits.max_record_bytes;records.push({...stored,identity_epoch:epoch,parse_status:oversized?'OVERSIZED':parsed?'PARSED':'UNPARSED',normalization_status:oversized?'OVERSIZED':supported?'NORMALIZED':parsed?'UNSUPPORTED':'UNPARSED',events});
    },{retain:false});
    for await(const chunk of decodedStream(root,raw,codec)){if(signal?.aborted)throw failure('CANCELLED','Acquisition cancelled');normalizer.consume(chunk,limits.max_record_bytes);}normalizer.finish(limits.max_record_bytes);
    const verifier=createHash('sha256');if(boundary.bytes)for await(const chunk of fs.createReadStream(resolved,{fd,autoClose:false,start:0,end:boundary.bytes-1,highWaterMark:CHUNK_BYTES,signal}))verifier.update(chunk);
    if(verifier.digest('hex')!==raw.sha256)throw failure('INTEGRITY_FAILED','Captured source prefix changed before staging');
    const late=Math.max(0,Number(fs.fstatSync(fd,{bigint:true}).size)-boundary.bytes);
    if(unchanged)return {manifest:previous,unchanged:true,bytes_read:raw.bytes*2,late_bytes:late,new_records:0,new_occurrences:0,reused_objects:raw.objects.length,prefix_bytes_verified:raw.bytes};
    let decodedManifestId=null;if(codec!=='none'){const payload={schema_version:4,raw_sha256:decoded.sha256,raw_bytes:decoded.bytes,objects:decoded.objects,codec:'none'};decodedManifestId='dec4-'+digest(payload);writeJson(inside(root,'bronze/sources',decodedManifestId+'.json'),payload);}
    const manifest=saveSourceManifest(root,{schema_version:4,source_lineage_id:lineage,harness:input.harness,origin_domain_id:input.origin_domain_id,native_id:native,session_id:sessionId,identity_status:native?'VERIFIED':'UNCERTAIN',provisional:native===null,raw_sha256:raw.sha256,raw_bytes:raw.bytes,codec,objects:raw.objects,decoded_manifest_id:decodedManifestId,decoded_sha256:decoded.sha256,decoded_bytes:decoded.bytes,decoded_objects:codec==='none'?[]:decoded.objects,boundary,location_observations:locations,late_bytes:late,prefix_relation:{kind:previous?continuous?'APPEND':'DIVERGENT':'NEW',previous_source_revision_id:previous?.source_revision_id??null,reused_records:prefix,verified_bytes:prefix?records[prefix-1].byte_offset+records[prefix-1].byte_length:0},records,counts});
    return {manifest,unchanged:false,identity_conflict:identityConflict,bytes_read:raw.bytes*2,late_bytes:late,new_records:records.length-prefix,new_occurrences:records.slice(prefix).reduce((n,r)=>n+r.events.filter(e=>!e.kind.startsWith('forensic.')).length,0),reused_objects:raw.reused+(codec==='none'?0:decoded.reused),prefix_bytes_verified:manifest.prefix_relation.verified_bytes};
  }finally{fs.closeSync(fd);}
}

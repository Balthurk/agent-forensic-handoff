import fs from 'node:fs';
import { createHash } from 'node:crypto';
import validation from './wire-validation.cjs';
import { canonicalIdentityJson } from './identity.js';
import { AFH_VERSION } from '../constants.js';

const build=JSON.parse(fs.readFileSync(new URL('./wire-build.json',import.meta.url)));
const schemaBytes=fs.readFileSync(new URL('../../schemas/archive-v4.schema.json',import.meta.url)),schema=JSON.parse(schemaBytes);
if(createHash('sha256').update(schemaBytes).digest('hex')!==build.schema_sha256)throw new Error('Wire schema differs from generated validator; rebuild the package');
// Resolve from src/archive to the repository/package root.
export const FRAME_BYTES=8*1024*1024;
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const canonical=canonicalIdentityJson;
export const digest=value=>hash(canonical(value));
const errors=new Map(build.error_catalog.map(item=>[item.code,item]));
const operations=new Set(schema.$defs.Request.oneOf.map(item=>item.properties.operation.const));
export function failure(code,message,details={}){return Object.assign(new Error(message),{code,details});}
export function validateRequest(request){
  if(request?.protocol_version!=='4.0')throw failure('PROTOCOL_INCOMPATIBLE','This engine accepts protocol 4.0');
  const ancestors=new Set();let units=0;
  function depthCheck(value,depth){if(++units>1048576)throw failure('LIMIT_EXCEEDED','Request JSON traversal exceeds bounded work');if(depth>32)throw failure('INVALID_REQUEST','JSON depth limit exceeded');if(value&&typeof value==='object'){if(ancestors.has(value))throw failure('INVALID_REQUEST','Request must be acyclic JSON');ancestors.add(value);for(const child of Object.values(value))depthCheck(child,depth+1);ancestors.delete(value);}}depthCheck(request,0);
  const encoded=canonical(request);if(Buffer.byteLength(encoded)>1048576)throw failure('LIMIT_EXCEEDED','Request exceeds one MiB');
  if(!validation.validateRequest(request)||request.extensions&&Object.keys(request.extensions).length)throw failure('INVALID_REQUEST','Request does not match the closed protocol schema');
  return request;
}
export function coverage(values={}){return {status:'COMPLETE_WITHIN_OBSERVED_BOUNDARY',sources_acquired:0,sources_known_omitted:0,universe_total:null,records_preserved:0,records_parsed:0,records_normalized:0,records_unsupported:0,records_unparsed:0,eligible_chunks:0,indexed_chunks:0,excluded:[],observed_through:null,...values};}
export function makeReceipt(snapshot=null,extra={}){const limits=Object.fromEntries(Object.entries(snapshot?.limits??{}).map(([key,value])=>['limit_'+key,{value,unit:key.endsWith('ratio')?'ratio':'bytes',status:'OBSERVED',method:'Validated immutable archive policy'}]));return {archive_id:snapshot?.archive_id??null,revision_id:snapshot?.revision_id??null,ledger_sha256:snapshot?.ledger_sha256??null,projection_ids:[],engine_version:AFH_VERSION,requested_mode:null,effective_mode:null,scope:null,time:null,coverage:coverage(snapshot?.coverage),warnings:[],metrics:limits,evidence_refs:[],input_class:'PRIVATE_REAL',runtime_class:'REAL_AFH',provider_class:'NONE',model_identity:null,...extra};}
export function response(request,data,receipt,status='OK'){
  const result={kind:'response',schema_version:4,protocol_version:'4.0',request_id:request.request_id,operation:request.operation,status,data,error:null,receipt};
  return checkResponse(result);
}
export function errorResponse(request,error,receipt=makeReceipt()){
  const entry=errors.get(error.code)??errors.get('INTERNAL_ERROR');
  const result={kind:'response',schema_version:4,protocol_version:'4.0',request_id:typeof request?.request_id==='string'&&request.request_id.length>=1&&request.request_id.length<=256?request.request_id:'invalid-request',operation:request?.operation,status:entry.status,data:null,error:{code:entry.code,message:entry.code==='INTERNAL_ERROR'?'Internal archive error':error.message,retryable:entry.retryable,details:error.details??{}},receipt};
  // Unknown operation cannot be represented by the closed error union. Reject
  // at the API boundary without inventing a different operation/correlation.
  if(!operations.has(result.operation))throw failure('INVALID_REQUEST','Unknown operation');
  return checkResponse(result);
}
export function checkResponse(result,{frame=true}={}){
  if(!validation.validateResponse(result))throw failure('INTERNAL_ERROR','Engine produced an invalid response envelope');
  if(frame&&Buffer.byteLength(JSON.stringify(result),'utf8')>FRAME_BYTES)throw failure('FRAME_TOO_LARGE','Response exceeds eight MiB');
  return result;
}

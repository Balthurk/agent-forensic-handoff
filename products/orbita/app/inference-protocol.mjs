import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const directory=fileURLToPath(new URL('./inference-schemas/',import.meta.url));
const assets=Object.freeze({
  "answer.json": "6f57c6ef01d8fbdf7b2fa20e9eb22d3eb979c66a06dc3e4c46697653d8f34e37",
  "classification.json": "2a4cf90a7f44dcf85836f1682494f860d9a9d4e3deb902abfe2fe531f82d8213",
  "extraction.json": "4c3d46b9f15f46c7a52f4269d31616773b04261c7df9a5bd3a17f646748b18d9",
  "plan.json": "e5d5a8f82fc4a349f2b9e926b69690e2e4b08bf3837f3b3dfc45b74898c36a27",
  "reevaluation.json": "744bc0975f40e11a0a90a96abc98a26ebea5ee25bd9816e754c7cd81a88d5fd1",
  "review.json": "cf3a87cb86e952b1514676bc11e96f067f460ed5fef9be44b10a07fa1f6b555f"
});
const fail=code=>{throw new Error(code);};
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);

// Only installed, hash-pinned schemas can cross the native CLI boundary.
// Operational copies of the selected schema belong to the common job.
export function inferenceSchemaAsset(schema){
 let wanted;try{wanted=canonical(schema);}catch{fail('INFERENCE_SCHEMA_NOT_REGISTERED');}
 for(const [filename,sha256] of Object.entries(assets)){
  const location=path.join(directory,filename),info=fs.lstatSync(location);
  if(!info.isFile()||info.isSymbolicLink()||info.size>32768)fail('INFERENCE_SCHEMA_ASSET_INVALID');
  const bytes=fs.readFileSync(location);
  if(createHash('sha256').update(bytes).digest('hex')!==sha256)fail('INFERENCE_SCHEMA_ASSET_INTEGRITY');
  const installed=JSON.parse(bytes);
  if(canonical(installed)===wanted)return {path:location,name:filename,sha256,bytes,schema:installed};
 }
 fail('INFERENCE_SCHEMA_NOT_REGISTERED');
}

function accepts(value,schema){
 if(schema.anyOf)return schema.anyOf.some(branch=>accepts(value,branch));
 if(schema.enum&&!schema.enum.some(item=>item===value))return false;
 const types=Array.isArray(schema.type)?schema.type:[schema.type];
 if(!types.some(type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):type==='integer'?Number.isInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===type))return false;
 if(value===null)return true;
 if(typeof value==='number'&&schema.minimum!==undefined&&value<schema.minimum)return false;
 if(Array.isArray(value))return (schema.minItems===undefined||value.length>=schema.minItems)&&(schema.maxItems===undefined||value.length<=schema.maxItems)&&value.every(item=>accepts(item,schema.items));
 if(typeof value==='object')return (schema.required??[]).every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>Object.hasOwn(schema.properties??{},key)?accepts(value[key],schema.properties[key]):schema.additionalProperties!==false);
 return true;
}

// Closed, one-turn protocol: invalid lines or incomplete execution can never
// be promoted to a successful answer. Any tool/unknown item is rejected.
export function parseInferenceEvents(raw,schema){
 let events;
 try{events=raw.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));}catch{fail('INFERENCE_EVENTS_INVALID_JSONL');}
 let thread=false,started=false,ended=false,lastAnswer=null,modelObserved=null,usage=null;
 const active=new Set(),completed=new Set();
 for(const event of events){
  if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string'||ended)fail('INFERENCE_EVENTS_INVALID_SEQUENCE');
  if(typeof event.model==='string')modelObserved=event.model;
  if(event.type==='thread.started'){
   if(thread||started||typeof event.thread_id!=='string'||!event.thread_id)fail('INFERENCE_EVENTS_INVALID_SEQUENCE');
   thread=true;
  }else if(event.type==='turn.started'){
   if(!thread||started)fail('INFERENCE_EVENTS_INVALID_SEQUENCE');started=true;
  }else if(['item.started','item.updated','item.completed'].includes(event.type)){
   if(!started)fail('INFERENCE_EVENTS_INVALID_SEQUENCE');
   const item=event.item;
   if(!item||typeof item.id!=='string'||!item.id||completed.has(item.id))fail('INFERENCE_EVENTS_INVALID_ITEM');
   if(!['reasoning','agent_message'].includes(item.type))fail('INFERENCE_TOOL_EVENT_REJECTED');
   if(event.type==='item.started'){
    if(active.has(item.id))fail('INFERENCE_EVENTS_INVALID_SEQUENCE');active.add(item.id);
   }else if(event.type==='item.updated'){
    if(!active.has(item.id))fail('INFERENCE_EVENTS_INVALID_SEQUENCE');
   }else{
    active.delete(item.id);completed.add(item.id);
    if(item.type==='agent_message'){
     if(typeof item.text!=='string')fail('INFERENCE_EVENTS_INVALID_ANSWER');lastAnswer=item.text;
    }
   }
  }else if(event.type==='turn.completed'){
   if(!started||active.size||lastAnswer===null)fail('INFERENCE_EVENTS_INCOMPLETE');
   ended=true;usage=event.usage??null;
  }else if(['error','turn.failed'].includes(event.type))fail('INFERENCE_EXECUTION_FAILED');
  else fail('INFERENCE_EVENTS_UNKNOWN_EVENT');
 }
 if(!ended)fail('INFERENCE_EVENTS_INCOMPLETE');
 let value;try{value=JSON.parse(lastAnswer);}catch{fail('INFERENCE_ANSWER_INVALID_JSON');}
 if(!accepts(value,schema))fail('INFERENCE_ANSWER_SCHEMA_INVALID');
 return {value,answer:lastAnswer,modelObserved,usage};
}

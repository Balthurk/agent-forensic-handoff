import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDB,sha,now,transaction} from './durable.mjs';
import {validateProviderIdentity,validateProviderVectors} from '../agent-forensic-handoff/src/semantic-model.js';
import {stableStringify} from '../agent-forensic-handoff/src/util.js';
export function cachedEmbeddingProvider(provider,root,{tokenizerPolicy='exact-provider-tokenizer-v1',signal}={}){
 validateProviderIdentity(provider.identity);if(typeof provider.countTokens!=='function'||!provider.maxInputTokens)throw new Error('CACHE_TOKENIZER_IDENTITY_REQUIRED');
 const identity={model:provider.identity,tokenizerPolicy,maxInputTokens:provider.maxInputTokens,textEncoding:'utf8-exact-v1',vectorEncoding:'json-f64-v1'},identityJSON=stableStringify(identity),namespace=sha(identityJSON),db=openDB(path.join(root,'embeddings.sqlite'));
 db.exec('CREATE TABLE IF NOT EXISTS vectors(namespace TEXT,text_hash TEXT,text TEXT,vector TEXT,vector_hash TEXT,PRIMARY KEY(namespace,text_hash)); CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,started TEXT,ended TEXT,status TEXT,identity TEXT,metrics TEXT,error TEXT);');
 const id=randomUUID(),started=performance.now(),metrics={hits:0,misses:0,embeddingCalls:0,embeddedTokens:0,embeddedCharacters:0,embeddedBytes:0,elapsedMs:0,monetaryCost:null};let closed=false;
 db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)').run(id,now(),null,'running',identityJSON,JSON.stringify(metrics),null);
 function read(text){const row=db.prepare('SELECT * FROM vectors WHERE namespace=? AND text_hash=?').get(namespace,sha(text));if(!row)return null;if(row.text!==text||sha(row.vector)!==row.vector_hash)throw new Error('EMBEDDING_CACHE_CORRUPT');return validateProviderVectors([JSON.parse(row.vector)],provider.identity.dimensions,1)[0];}
 return {...provider,cacheIdentity:namespace,metrics,
  async embed(texts){signal?.throwIfAborted();const values=Array.isArray(texts)?texts:[texts],missing=[],missingIndex=new Map(),out=[];
   for(const [i,text] of values.entries()){if(typeof text!=='string')throw new Error('CACHE_REQUIRES_EXACT_TEXT');const v=read(text);if(v){metrics.hits++;out[i]=v;}else{metrics.misses++;if(!missingIndex.has(text)){missingIndex.set(text,missing.length);missing.push(text);}out[i]=null;}}
   if(missing.length){metrics.embeddingCalls++;const vectors=validateProviderVectors(await provider.embed(missing),provider.identity.dimensions,missing.length);signal?.throwIfAborted();
    transaction(db,()=>{for(const [i,text] of missing.entries()){const value=JSON.stringify(vectors[i]),existing=read(text);if(existing&&JSON.stringify(existing)!==value)throw new Error('EMBEDDING_CACHE_NONDETERMINISTIC_RACE');db.prepare('INSERT OR IGNORE INTO vectors VALUES(?,?,?,?,?)').run(namespace,sha(text),text,value,sha(value));}});
    metrics.embeddedTokens+=missing.reduce((n,t)=>n+provider.countTokens(t),0);metrics.embeddedCharacters+=missing.reduce((n,t)=>n+[...t].length,0);metrics.embeddedBytes+=missing.reduce((n,t)=>n+Buffer.byteLength(t),0);
    for(const [i,text] of values.entries())if(!out[i])out[i]=vectors[missingIndex.get(text)];
   }
   metrics.elapsedMs=performance.now()-started;db.prepare('UPDATE runs SET metrics=? WHERE id=?').run(JSON.stringify(metrics),id);return out;
  },
  finish(error=null){if(closed)return;closed=true;metrics.elapsedMs=performance.now()-started;db.prepare('UPDATE runs SET ended=?,status=?,metrics=?,error=? WHERE id=?').run(now(),error?'failed':'complete',JSON.stringify(metrics),error?.message??null,id);db.close();return {runId:id,namespace,...metrics};},
  dispose(){throw new Error('Use finish for cache; underlying provider lifetime belongs to caller');}
 };
}

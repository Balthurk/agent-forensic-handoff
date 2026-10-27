import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {cachedEmbeddingProvider} from './embedding-cache.mjs';
const identity={provider:'test',runtime:'fixture',runtimeVersion:'1',modelId:'fixture',revision:'1',modelDigest:'a'.repeat(64),dimensions:2,dtype:'f64',pooling:'mean',normalization:'l2'};
const root=fs.mkdtempSync('C:/T/afh-cache-test-');let calls=0,fail=false;
const p={identity,maxInputTokens:512,countTokens:t=>t.length,async embed(texts){calls++;if(fail)throw new Error('provider interrupted');return texts.map(t=>[t.length,1]);}};
test('cache checkpoints successful batches, exact text and tokenizer identity, validates corruption',async()=>{
 let c=cachedEmbeddingProvider(p,root);assert.deepEqual(await c.embed(['hola','adiós']),[[4,1],[5,1]]);fail=true;await assert.rejects(c.embed(['nuevo']),/interrupted/);c.finish(new Error('interrupted'));
 fail=false;c=cachedEmbeddingProvider(p,root);const before=calls;await c.embed(['hola','adiós']);assert.equal(calls,before);await c.embed(['hola','nuevo']);assert.equal(calls,before+1);assert.equal(c.metrics.hits,3);assert.equal(c.metrics.embeddedCharacters,5);c.finish();
 c=cachedEmbeddingProvider({...p,identity:{...identity,revision:'2'}},root);await c.embed(['hola']);assert.equal(c.metrics.misses,1);c.finish();
 c=cachedEmbeddingProvider(p,root,{tokenizerPolicy:'changed'});await c.embed(['hola']);assert.equal(c.metrics.misses,1);c.finish();
 c=cachedEmbeddingProvider({...p,identity:{...identity,dimensions:3},async embed(){return [[1,2,3]];}},root);await c.embed(['hola']);assert.equal(c.metrics.misses,1);c.finish();
 const db=new DatabaseSync(path.join(root,'embeddings.sqlite'));db.prepare("UPDATE vectors SET vector='[999,0]' WHERE text='adiós'").run();db.close();c=cachedEmbeddingProvider(p,root);await assert.rejects(c.embed(['adiós']),/CORRUPT/);c.finish(new Error('corrupt'));
});

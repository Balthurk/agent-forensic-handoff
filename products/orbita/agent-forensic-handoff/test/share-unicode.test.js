import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {importChatGPTShare} from '../src/chatgpt-share.js';
import {verifyCaseIntegrity} from '../src/integrity.js';

test('I03 derived transcript keeps a literal separator and Unicode while the capture stays byte-exact',async t=>{
 const parent=fs.realpathSync(process.env.AFH_TEST_ROOT||os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'orbita-i03-share-'));
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),parent);assert.ok(path.basename(root).startsWith('orbita-i03-share-'));fs.rmSync(root,{recursive:true,force:true});});
 const url='https://chatgpt.com/share/11111111-2222-4333-8444-555555555555',text='café 漢字 😀 e\u0301 · literal',pool=[];
 function encode(value){if(value===null)return -5;const i=pool.length;pool.push(null);if(Array.isArray(value))pool[i]=value.map(encode);else if(typeof value==='object'){const obj={};for(const [key,item] of Object.entries(value))obj['_'+encode(key)]=encode(item);pool[i]=obj;}else pool[i]=value;return i;}
 encode({loaderData:{share:{title:'Captura Unicode',conversation_id:url.split('/').pop(),current_node:'u',linear_conversation:[{id:'u',children:[],message:{id:'mensaje',author:{role:'user'},create_time:1,content:{content_type:'text',parts:[text]},metadata:{}}}]}}});
 const capture=Buffer.from('<html><script>window.__reactRouterContext.streamController.enqueue('+JSON.stringify(JSON.stringify(pool)+'\n')+');</script></html>'),input=path.join(root,'capture.html'),dest=path.join(root,'case');fs.writeFileSync(input,capture);
 const before=createHash('sha256').update(capture).digest('hex');await importChatGPTShare(url,{htmlPath:input,caseDir:dest});
 const transcript=fs.readFileSync(path.join(dest,'shared-transcript.md'),'utf8');assert.ok(transcript.includes('## user · mensaje\n'));assert.ok(transcript.includes(text));assert.ok(!transcript.includes('Ã'));
 assert.deepEqual(fs.readFileSync(input),capture);assert.deepEqual(fs.readFileSync(path.join(dest,'acquisition','chatgpt-share.html')),capture);assert.equal(createHash('sha256').update(fs.readFileSync(input)).digest('hex'),before);assert.equal((await verifyCaseIntegrity(dest)).passed,true);
});

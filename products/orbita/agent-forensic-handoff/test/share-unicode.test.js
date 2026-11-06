import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import fs from '../src/common-files.js';
import {closeCommonStore} from '../src/common-store.js';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {importChatGPTShare} from '../src/chatgpt-share.js';
import {verifyCaseIntegrity} from '../src/integrity.js';


const commonRoot=process.env.ORBITA_POSTGRES_TEST_ROOT;
if(!commonRoot)throw new Error('PG_TEST_ROOT_REQUIRED');
const inputRoot=path.join(path.dirname(commonRoot),'inputs');native.mkdirSync(inputRoot,{recursive:true});
const caseOutput=(root,name='case')=>path.join(commonRoot,path.basename(root),name);
test.after(()=>{assert.equal(native.existsSync(commonRoot),false);closeCommonStore();});

test('I03 derived transcript keeps a literal separator and Unicode while the capture stays byte-exact',async t=>{
 const parent=native.realpathSync(inputRoot),root=native.mkdtempSync(path.join(parent,'orbita-i03-share-'));
 t.after(()=>{assert.equal(path.dirname(native.realpathSync(root)),parent);assert.ok(path.basename(root).startsWith('orbita-i03-share-'));assert.equal(native.existsSync(caseOutput(root)),false);});
 const url='https://chatgpt.com/share/11111111-2222-4333-8444-555555555555',text='café 漢字 😀 e\u0301 · literal',pool=[];
 function encode(value){if(value===null)return -5;const i=pool.length;pool.push(null);if(Array.isArray(value))pool[i]=value.map(encode);else if(typeof value==='object'){const obj={};for(const [key,item] of Object.entries(value))obj['_'+encode(key)]=encode(item);pool[i]=obj;}else pool[i]=value;return i;}
 encode({loaderData:{share:{title:'Captura Unicode',conversation_id:url.split('/').pop(),current_node:'u',linear_conversation:[{id:'u',children:[],message:{id:'mensaje',author:{role:'user'},create_time:1,content:{content_type:'text',parts:[text]},metadata:{}}}]}}});
 const capture=Buffer.from('<html><script>window.__reactRouterContext.streamController.enqueue('+JSON.stringify(JSON.stringify(pool)+'\n')+');</script></html>'),input=path.join(root,'capture.html'),dest=caseOutput(root);native.writeFileSync(input,capture);
 const before=createHash('sha256').update(capture).digest('hex');await importChatGPTShare(url,{htmlPath:input,caseDir:dest});
 const transcript=fs.readFileSync(path.join(dest,'shared-transcript.md'),'utf8');assert.ok(transcript.includes('## user · mensaje\n'));assert.ok(transcript.includes(text));assert.ok(!transcript.includes('Ã'));
 assert.deepEqual(native.readFileSync(input),capture);assert.deepEqual(fs.readFileSync(path.join(dest,'acquisition','chatgpt-share.html')),capture);assert.equal(createHash('sha256').update(native.readFileSync(input)).digest('hex'),before);assert.equal((await verifyCaseIntegrity(dest)).passed,true);
});

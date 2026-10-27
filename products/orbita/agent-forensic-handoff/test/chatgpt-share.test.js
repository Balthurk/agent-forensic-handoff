import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSharePage, validateShareUrl, importChatGPTShare } from '../src/chatgpt-share.js';
import { verifyCaseIntegrity, queryCase, showEvent, readEvidence } from '../src/index.js';
import { normalizeRecord } from '../src/adapters.js';

const url='https://chatgpt.com/share/11111111-2222-4333-8444-555555555555';
function fixture(nodes, extra={}) {
  const pool=[];
  function enc(v) {
    if(v===null)return -5;
    const i=pool.length;pool.push(null);
    if(Array.isArray(v))pool[i]=v.map(enc);
    else if(typeof v==='object') {const o={};for(const [k,x] of Object.entries(v))o['_'+enc(k)]=enc(x);pool[i]=o;}
    else pool[i]=v;
    return i;
  }
  enc({loaderData:{share:{title:'Prueba á ñ 😃',conversation_id:url.split('/').pop(),current_node:nodes.at(-1).id,linear_conversation:nodes,...extra}}});
  return Buffer.from('<html><script>window.__reactRouterContext.streamController.enqueue('+JSON.stringify(JSON.stringify(pool)+'\n')+');</script></html>');
}
const nodes=[{id:'root',children:['u']},{id:'u',parent:'root',children:['a'],message:{id:'u',author:{role:'user'},create_time:1,content:{content_type:'text',parts:['Pregunta']},metadata:{}}},{id:'a',parent:'u',children:[],message:{id:'a',author:{role:'assistant'},create_time:2,channel:'final',content:{content_type:'text',parts:['inicio '+'x '.repeat(1500)+' MARCADORCENTRAL '+'y '.repeat(1500)+' final á😃']},metadata:{attachments:[{name:'adjunto.pdf',url:'https://example.invalid/a.pdf'}]}}}];
test('public URL allowlist and malformed/ambiguous snapshot rejection',()=>{
  assert.equal(validateShareUrl(url).url,url);
  for(const s of ['http://chatgpt.com/share/x','https://evil.test/share/11111111-2222-4333-8444-555555555555',url+'?token=secret',url+'#fragment','https://u:p@chatgpt.com/share/11111111-2222-4333-8444-555555555555'])assert.throws(()=>validateShareUrl(s));
  assert.throws(()=>parseSharePage(Buffer.from('<html>Login</html>')));
  assert.throws(()=>parseSharePage(fixture([...nodes,nodes[2]])));
  assert.throws(()=>parseSharePage(fixture(nodes,{current_node:'missing'})));
  assert.equal(parseSharePage(fixture(nodes)).nodes.length,3);
});
test('full snapshot import, middle-text retrieval, exact evidence and raw tamper detection',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'afh-share-test-'));
  try {
    const wrong=path.join(root,'wrong.html');fs.writeFileSync(wrong,fixture(nodes,{conversation_id:'different-id'}));
    await assert.rejects(importChatGPTShare(url,{htmlPath:wrong,caseDir:path.join(root,'wrong-case')}),/identity/);
    const html=path.join(root,'input.html');fs.writeFileSync(html,fixture(nodes));
    const dest=path.join(root,'case');const result=await importChatGPTShare(url,{htmlPath:html,caseDir:dest});
    assert.equal(result.capture.messageCount,2);assert.equal(result.capture.nodeCount,3);
    assert.equal((await verifyCaseIntegrity(dest)).passed,true);
    const q=await queryCase(dest,'MARCADORCENTRAL',{mode:'lexical',limit:10});assert.equal(q.results.length,1);
    const ev=showEvent(dest,q.results[0].id);const raw=readEvidence(dest,ev.evidence[0].uri);
    assert.deepEqual(JSON.parse(raw.text).node,nodes[2]);
    await assert.rejects(importChatGPTShare(url,{htmlPath:html,caseDir:dest}),/exist/i);
    const rawPath=path.join(dest,'acquisition/chatgpt-share.html');fs.appendFileSync(rawPath,'tampered');
    assert.equal((await verifyCaseIntegrity(dest)).passed,false);
    fs.unlinkSync(rawPath);assert.equal((await verifyCaseIntegrity(dest)).passed,false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('fetch refuses login redirects and HTTP errors and enforces size bound',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'afh-share-network-'));
  try {
    for(const [name,fetchImpl] of [
      ['login',async()=>new Response('',{status:302,headers:{location:'https://auth.openai.com/login'}})],
      ['denied',async()=>new Response('Forbidden',{status:403})],
      ['large',async()=>new Response('x'.repeat(2000),{status:200,headers:{'content-type':'text/html'}})]
    ])await assert.rejects(importChatGPTShare(url,{caseDir:path.join(root,name),fetchImpl,maxBytes:1000}));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('published rationale, system context and tool outcome retain distinct meanings',()=>{
  const record={type:'chatgpt.shared_node',shareId:'test',sourceUrl:url,node:{id:'n',parent:'p',children:[],message:{id:'m',author:{role:'assistant'},create_time:null,content:{content_type:'reasoning_recap',content:'Published recap'},metadata:{},status:'finished_successfully'}}};
  let e=normalizeRecord(record,{harness:'chatgpt-share',nativeId:'test'})[0];
  assert.equal(e.kind,'reasoning.visible');assert.equal(e.observedAt,null);
  record.node.message.author.role='tool';record.node.message.author.name='web.run';record.node.message.content={content_type:'text',parts:['Observed response']};
  e=normalizeRecord(record,{harness:'chatgpt-share',nativeId:'test'})[0];assert.equal(e.kind,'tool.observed');assert.equal(e.status,'OBSERVED');assert.equal(e.metadata.publishedStatus,'finished_successfully');
  record.node.message.author.role='system';e=normalizeRecord(record,{harness:'chatgpt-share',nativeId:'test'})[0];assert.equal(e.kind,'session.context');
});

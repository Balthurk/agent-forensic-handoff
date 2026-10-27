import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {auditSession,verifyCaseIntegrity,exportN01Packet,readUnifiedEvidence,searchCase,queryCase} from '../src/index.js';
import {normalizeContainer,readZip,intakeLimits} from '../src/conversation-intake.js';
import {DatabaseSync} from '../src/sqlite-compat.js';
import {decodedLines} from '../src/evidence.js';
const require=createRequire(import.meta.url),AdmZip=require('../src/vendor/adm-zip/adm-zip.js');
const context=vm.createContext({TextEncoder,TextDecoder,Uint8Array,DataView,Set,Map,URL,JSON,AbortSignal,crypto:webcrypto,btoa:s=>Buffer.from(s,'binary').toString('base64')});
vm.runInContext(fs.readFileSync(new URL('../scripts/chatgpt-forensic-exporter.js',import.meta.url),'utf8'),context);
const exporter=context.AFHExporter;
function conversation(id='conv-1') {
  const message=(id,role,text)=>({id,author:{role},create_time:1700000000,content:{content_type:'text',parts:[text]},metadata:{custom:'preserved'},status:'in_progress'});
  return {id,title:'Igual título',current_node:'a',unknown_header:{future:'conservar'},mapping:{
    root:{id:'root',parent:null,children:['u'],message:null,unknown_node:['keep']},
    u:{id:'u',parent:'root',children:['a','b'],message:message('m-u','user','A😀éZ')},
    a:{id:'a',parent:'u',children:[],message:message('m-a','assistant','Elijo SQLite en Alfa')},
    b:{id:'b',parent:'u',children:[],message:message('m-b','assistant','Elijo PostgreSQL en Beta')},
  }};
}
function lab(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'afh-intake-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
async function acquire(root,name,value){const source=path.join(root,name);fs.writeFileSync(source,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));return (await auditSession(source,{caseDir:path.join(root,name+'-case')})).caseDir;}
const identity=root=>JSON.parse(fs.readFileSync(path.join(root,'identity.json'),'utf8'));

test('mapping preserves header, null nodes, unknown fields and exact original bytes',async t=>{
  const root=lab(t),c=conversation(),raw=JSON.stringify(c,null,4)+'\r\n',dest=await acquire(root,'input.json',raw);
  assert.equal(fs.readFileSync(path.join(dest,'acquisition/original.bin'),'utf8'),raw);
  const manifest=JSON.parse(fs.readFileSync(path.join(dest,'case.json'))),source=fs.readFileSync(path.join(dest,manifest.sources[0].evidencePath),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(source.length,5);assert.deepEqual(source[0].conversation.unknown_header,c.unknown_header);assert.deepEqual(source.find(r=>r.node?.id==='root').node,c.mapping.root);
  assert.equal(identity(dest).representations.find(r=>r.node_id==='root').message_id,null);
  assert.equal((await verifyCaseIntegrity(dest)).passed,true);
});
test('alternative branches stay visible but cannot create current operational facts',async t=>{
  const dest=await acquire(lab(t),'branches.json',conversation());
  const row=identity(dest).representations.find(r=>r.message_id==='m-b');assert.equal(row.scope,'alternative');
  const db=new DatabaseSync(path.join(dest,'case.sqlite'),{readOnly:true});
  try{assert.equal(db.prepare('SELECT COUNT(*) n FROM temporal_fact WHERE source_event_id=?').get(row.legacy_event_id).n,0);}finally{db.close();}
  const packet=await exportN01Packet([dest]);assert.ok(!packet.records.some(r=>r.representations.some(x=>x.message_id==='m-b')));
  assert.ok((await exportN01Packet([dest],{scope:'all'})).records.some(r=>r.representations.some(x=>x.message_id==='m-b')));
  assert.equal(searchCase(dest,'PostgreSQL').length,0);
  assert.equal(searchCase(dest,'PostgreSQL',25,{scope:'all'}).length,1);
  assert.equal((await queryCase(dest,'PostgreSQL')).results.length,0);
  assert.equal((await queryCase(dest,'PostgreSQL',{scope:'all'})).results.length,1);
});
test('cyclic and disconnected nodes are retained; unknown branch never becomes active',async t=>{
  const c=conversation();c.mapping.x={id:'x',parent:'y',children:['y'],message:null};c.mapping.y={id:'y',parent:'x',children:['x'],message:null};c.current_node='x';
  assert.equal(exporter.orderedNodes(c).length,6);
  const dest=await acquire(lab(t),'cycle.json',c);assert.equal(identity(dest).representations.filter(r=>r.node_id).length,6);
  assert.equal((await exportN01Packet([dest])).records.length,0);
});
test('exact copies share occurrence identity; same text in different messages or conversations does not merge',async t=>{
  const root=lab(t),c=conversation();c.mapping.a.message.content.parts=['same'];c.mapping.u.message.content.parts=['same'];
  const one=await acquire(root,'one.json',c),two=await acquire(root,'two.json',JSON.stringify(c,null,2)),other=await acquire(root,'other.json',conversation('conv-2'));
  const packet=await exportN01Packet([one,two,other]);
  const matches=packet.records.filter(r=>r.representations.some(x=>x.message_id==='m-a'));
  assert.equal(matches.length,2);assert.equal(matches.find(r=>r.conversation_id==='chatgpt:conv-1').representations.length,2);
  assert.ok(packet.records.filter(r=>r.representations[0].occurrence_kind==='message').every(r=>r.independent_support_count===1));
  const a=identity(one).representations;assert.notEqual(a.find(r=>r.message_id==='m-u').occurrence_id,a.find(r=>r.message_id==='m-a').occurrence_id);
});
test('Unicode ranges are codepoints; old emissions are not known before local registration',async t=>{
  const dest=await acquire(lab(t),'unicode.json',conversation()),row=identity(dest).representations.find(r=>r.message_id==='m-u');
  const opened=await readUnifiedEvidence(dest,row.representation_id,{start:1,end:2});assert.equal(opened.quote,'😀');
  assert.equal((await readUnifiedEvidence(dest,row.representation_id,{start:2,end:4})).quote,'é');
  await assert.rejects(readUnifiedEvidence(dest,row.representation_id,{unit:'utf16'}),/codepoints/);
  assert.notEqual(row.emitted_at,row.known_at);assert.equal((await exportN01Packet([dest],{knownAt:'2024-01-01T00:00:00Z'})).records.length,0);
  assert.equal((await exportN01Packet([dest],{knownAt:'2024-01-01T00:00:00Z'})).sources.length,0);
});
test('opening evidence verifies original again, detects tampering and missing identity',async t=>{
  const dest=await acquire(lab(t),'tamper.json',conversation()),row=identity(dest).representations.find(r=>r.message_id==='m-u');
  fs.appendFileSync(path.join(dest,'acquisition/original.bin'),' ');
  assert.equal((await verifyCaseIntegrity(dest)).passed,false);
  await assert.rejects(readUnifiedEvidence(dest,row.representation_id),/integrity failed/);
});
test('tool messages with in_progress remain observations, never completed executions',async t=>{
  const c=conversation();c.mapping.a.message.author={role:'tool',name:'web.run'};
  const dest=await acquire(lab(t),'tool.json',c),db=new DatabaseSync(path.join(dest,'case.sqlite'),{readOnly:true});
  try{assert.equal(db.prepare("SELECT COUNT(*) n FROM tool_execution WHERE status='COMPLETED'").get().n,0);assert.equal(db.prepare('SELECT status FROM tool_execution').get().status,'OBSERVED');}finally{db.close();}
});
test('safe exporter JSONL and HTML roundtrip full nodes and headers; malicious HTML is inert',async t=>{
  const root=lab(t),c=conversation();c.title='<img src=x onerror=alert(1)>';c.mapping.a.message.content.parts=['<script>alert(2)</script><img src=x onerror=alert(3)>'];
  const jsonl=exporter.toJsonl(c),html=exporter.toHtml(c);
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('cdn.'));assert.ok(html.includes("script-src 'none'"));
  for(const [name,data] of [['safe.jsonl',jsonl],['safe.html',html]]) {
    const dest=await acquire(root,name,data);assert.equal(identity(dest).representations.filter(r=>r.node_id).length,4);assert.equal((await verifyCaseIntegrity(dest)).passed,true);
  }
});
test('ZIP reads every conversation JSON, archives binary attachments and reports unbound references',async t=>{
  const c=conversation();c.mapping.u.message.metadata.attachments=[{id:'missing',name:'lost.pdf'}];
  const zip=new AdmZip();zip.addFile('one.json',Buffer.from(JSON.stringify(c)));zip.addFile('two.json',Buffer.from(JSON.stringify(conversation('two'))));zip.addFile('files/data.bin',Buffer.from([0,255,3]));
  const dest=await acquire(lab(t),'many.zip',zip.toBuffer());const capture=JSON.parse(fs.readFileSync(path.join(dest,'acquisition/intake.json')));
  assert.equal(capture.documents.length,2);assert.equal(capture.attachments.length,3);assert.equal(capture.attachmentReferences[0].status,'REFERENCE_ONLY_UNRESOLVED');
});
test('exporter ZIP has UTF-8 names, manifest hashes, failed attachments and all representations',async t=>{
  const result=await exporter.bundle(conversation(),JSON.stringify(conversation()),[{name:'á😀.txt',data:Buffer.from('content')},{name:'failed.pdf',error:'HTTP 403'}]);
  const dest=await acquire(lab(t),'bundle.zip',Buffer.from(result.bytes)),capture=JSON.parse(fs.readFileSync(path.join(dest,'acquisition/intake.json')));
  assert.equal(capture.documents.length,3);assert.ok(capture.attachments.some(a=>a.member==='files/á😀.txt'));
  assert.ok(result.manifest.attachments.some(a=>a.status==='DOWNLOAD_FAILED'));assert.equal((await exportN01Packet([dest])).records.filter(r=>r.representations.some(x=>x.message_id==='m-a')).length,1);
});
test('conflicting native revisions inside one ZIP are quarantined, not resolved by entry order',async t=>{
  const a=conversation(),b=conversation();b.mapping.a.message.content.parts=['Changed'];
  const zip=new AdmZip();zip.addFile('a.json',Buffer.from(JSON.stringify(a)));zip.addFile('b.json',Buffer.from(JSON.stringify(b)));
  const dest=await acquire(lab(t),'conflict.zip',zip.toBuffer());
  assert.ok(identity(dest).representations.filter(r=>r.message_id==='m-a').every(r=>r.identity_conflict&&r.scope==='conflict'));
  assert.ok(!(await exportN01Packet([dest])).records.some(r=>r.representations.some(x=>x.message_id==='m-a')));
});
test('ZIP CRC, truncation, duplicate names, traversal and expansion fail closed',()=>{
  const valid=Buffer.from(exporter.makeZip([{name:'one.json',data:Buffer.from(JSON.stringify(conversation()))}]));
  const bad=Buffer.from(valid);bad[30+Buffer.byteLength('one.json')+8]^=1;assert.throws(()=>readZip(bad),/CRC/);
  assert.throws(()=>readZip(valid.subarray(0,valid.length-8)));
  const duplicate=new AdmZip();duplicate.addFile('A.json',Buffer.from('{}'));duplicate.addFile('a.json',Buffer.from('{}'));assert.throws(()=>readZip(duplicate.toBuffer()),/duplicate/);
  const unsafe=Buffer.from(valid);Buffer.from('../a.txt').copy(unsafe,30);const cd=unsafe.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));Buffer.from('../a.txt').copy(unsafe,cd+46);assert.throws(()=>readZip(unsafe),/Unsafe/);
  assert.throws(()=>readZip(valid,intakeLimits({maxEntryBytes:10})),/expansion/);
  assert.throws(()=>normalizeContainer(valid,'x.zip',{maxTotalSourceBytes:10}),/byte limit/);
});
test('ZIP data descriptor flag and central CRC work; wrong central CRC is rejected',()=>{
  const data=Buffer.from(exporter.makeZip([{name:'a.json',data:Buffer.from(JSON.stringify(conversation()))}])),cd=data.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  data.writeUInt16LE(0x808,6);data.writeUInt16LE(0x808,cd+8);data.fill(0,14,26);
  assert.equal(readZip(data).length,1);data.writeUInt32LE(12,cd+16);assert.throws(()=>readZip(data),/CRC/);
});
test('legacy v7 JSONL stays explicitly lossy; visible-only HTML cannot masquerade as full export',async t=>{
  const c=conversation(),lines=[{type:'chatgpt_session_meta',conversation_id:c.id,current_node:'a'},...Object.values(c.mapping).filter(n=>n.message).map(n=>({type:'chatgpt_node',node_id:n.id,parent_id:n.parent,children_ids:n.children,message:n.message}))].map(JSON.stringify).join('\n');
  const dest=await acquire(lab(t),'legacy.jsonl',lines),capture=JSON.parse(fs.readFileSync(path.join(dest,'acquisition/intake.json')));
  assert.equal(capture.documents[0].coverage,'LEGACY_LOSSY_EXPORT');assert.throws(()=>normalizeContainer(Buffer.from('<html><article>only a view</article></html>'),'old.html'),/display-only/);
});
test('native JSONL keeps original CRLF and invalid records; byteLimit=0 yields nothing',async t=>{
  const root=lab(t),raw=JSON.stringify({type:'session_meta',payload:{id:'test-native',timestamp:'2020-01-01T00:00:00Z'}})+'\r\n'+JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'native😀'}})+'\r\nnot json\r\n';
  const file=path.join(root,'native.jsonl');fs.writeFileSync(file,raw);let count=0;for await(const line of decodedLines(file,0))count++;assert.equal(count,0);
  const dest=(await auditSession(file,{harness:'codex',caseDir:path.join(root,'case')})).caseDir;
  const manifest=JSON.parse(fs.readFileSync(path.join(dest,'acquisition/native.json')));
  assert.equal(fs.readFileSync(path.join(dest,manifest.entries[0].path),'utf8'),raw);assert.equal((await verifyCaseIntegrity(dest)).passed,true);
});

test('independent Python ZIPs with signed descriptors and ZIP64 local fields import',async t=>{
  const root=lab(t);
  for(const name of ['descriptor.zip','zip64.zip']) {
    const data=fs.readFileSync(new URL('./fixtures/intake/'+name,import.meta.url));
    assert.equal(readZip(data).length,1);
    assert.equal((await verifyCaseIntegrity(await acquire(root,name,data))).passed,true);
  }
});
test('local/central ZIP filenames must agree',()=>{
  const data=Buffer.from(exporter.makeZip([{name:'one.json',data:Buffer.from('{}')}]));
  data[30]='t'.charCodeAt(0);assert.throws(()=>readZip(data),/local\/central/);
});
test('identity deletion cannot downgrade a newly acquired case to legacy verification',async t=>{
  const dest=await acquire(lab(t),'identity-required.json',conversation()),file=path.join(dest,'case.json');
  const manifest=JSON.parse(fs.readFileSync(file));delete manifest.identityEvidence;fs.writeFileSync(file,JSON.stringify(manifest));
  assert.equal((await verifyCaseIntegrity(dest)).passed,false);
});
test('identity locator tampering fails even after updating only the projection hash',async t=>{
  const dest=await acquire(lab(t),'locators.json',conversation()),projection=identity(dest);
  projection.representations[1].locator.byte_range.start++;
  fs.writeFileSync(path.join(dest,'identity.json'),JSON.stringify(projection));
  assert.equal((await verifyCaseIntegrity(dest)).passed,false);
});
test('two exports with changed content retain versions and report conflict',async t=>{
  const root=lab(t),a=conversation(),b=conversation();b.mapping.a.message.content.parts=['otra revision'];
  const first=await acquire(root,'before.json',a),second=await acquire(root,'after.json',b);
  const packet=await exportN01Packet([first,second]);
  const act=packet.records.find(r=>r.representations.some(x=>x.message_id==='m-a'));
  assert.equal(act.identity_conflict,true);assert.equal(act.versions.length,2);assert.equal(act.independent_support_count,1);
});
test('custom instructions and user profile are both retained in the text projection',async t=>{
  const c=conversation();c.mapping.u.message.content={content_type:'user_editable_context',user_instructions:'instrucciones',user_profile:'perfil'};
  const dest=await acquire(lab(t),'context.json',c),row=identity(dest).representations.find(r=>r.message_id==='m-u');
  assert.equal(row.text,'instrucciones\n\nperfil');
});
test('ancillary binary JSON is archived explicitly unparsed; malformed conversation JSON fails',async t=>{
  const zip=new AdmZip();zip.addFile('conversation.json',Buffer.from(JSON.stringify(conversation())));zip.addFile('files/binary.json',Buffer.from([255,0,45]));
  const dest=await acquire(lab(t),'ancillary.zip',zip.toBuffer()),capture=JSON.parse(fs.readFileSync(path.join(dest,'acquisition/intake.json')));
  assert.equal(capture.attachments.find(a=>a.member==='files/binary.json').parseIssue,'UNPARSED_ANCILLARY');
  zip.addFile('broken-conversation.json',Buffer.from('{broken'));assert.throws(()=>normalizeContainer(zip.toBuffer(),'bad.zip'));
});
test('exporter parent lookups never invent inherited object nodes',()=>{
  const c=conversation();c.mapping.root.parent='constructor';
  assert.equal(exporter.orderedNodes(c).length,4);
  assert.ok(exporter.toHtml(c).includes('unknown'));
});
test('multimodal file and asset pointers remain explicitly unresolved references',async t=>{
  const c=conversation();c.mapping.u.message.content={content_type:'multimodal_text',parts:['image',{content_type:'image_asset_pointer',asset_pointer:'sediment://image-1'}]};
  const dest=await acquire(lab(t),'image.json',c),capture=JSON.parse(fs.readFileSync(path.join(dest,'acquisition/intake.json')));
  assert.equal(capture.attachmentReferences.length,1);assert.equal(capture.attachmentReferences[0].reference,'sediment://image-1');
});

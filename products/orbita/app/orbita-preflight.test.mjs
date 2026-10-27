import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { buildReport, collect, requestJson, renderMarkdown, sha256, validateBase, validateProvenance, main } from './orbita-preflight.mjs';

function fixture() {
  const h='a'.repeat(64), text='Fixture: technical status does not establish human approval.';
  const raw=JSON.stringify({role:'assistant',text});
  const evidence={id:'evt-fixture',conversationId:'memory',role:'assistant',text,raw,sha256:sha256(raw),verified:true,identity:{identity_conflict:false}};
  const provenance={schema:'orbita-preflight-provenance-1',citations:Array.from({length:6},(_,i)=>({id:`C${i+1}`,conversationId:'memory',eventId:evidence.id,sourceRole:'assistant',quote:text,recordSha256:evidence.sha256,sourceTextSha256:sha256(text),interpretation:'Synthetic criterion for controlled tests only.'}))};
  const ok=data=>({ok:true,data});
  const bootstrap={application:'afh-orbita',library:[{id:'memory',hash:h,verified:true,coverage:'SOURCE_SNAPSHOT'}]};
  const snapshots={
    bootstrapBefore:ok(bootstrap), bootstrapAfter:ok(structuredClone(bootstrap)),
    coverage:ok([{id:'memory',revision:h,unit:'source_records',denominator:10,archived:10,parsed:10,indexedPreview:10,availableFullText:6,indexedFullText:6,semantic:{status:'indexed',revision:h,records:6,sourceCodepoints:200,coveredCodepoints:200,truncatedChunks:0},extracted:{status:'partial',completeness:'not_certified'}}]),
    recovery:ok({busy:false,restored:{id:'restore-fixture',snapshotId:'snapshot-fixture',archiveSha256:h,treeHash:h,validation:{originalsVerified:true},automaticWork:false,externalAccess:false}}),
    pipeline:ok({pipelines:[],targets:[],members:[],events:[],approval:'none',semanticCompleteness:'not_certified'}),
    reevaluation:ok({watches:[],jobs:[],events:[],approval:'none'}),
    'source:memory:evt-fixture':ok(evidence),
  };
  return {provenance,collection:{base:'http://127.0.0.1:4475',startedAt:'2026-10-23T00:00:00Z',finishedAt:'2026-10-23T00:00:01Z',snapshots}};
}
const report=f=>buildReport(f.collection,{provenance:f.provenance});
const check=(r,id)=>r.observations.find(o=>o.id===id);

async function serverFor(t,handler) {
  const server=http.createServer(handler);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('valid technical responses preserve unknown approval and separate record/text denominators',()=>{
  const r=report(fixture());
  assert.equal(r.status,'REVIEW_REQUIRED'); assert.equal(r.exitCode,2);
  assert.deepEqual(r.acceptance,{human:'unknown',global:'unknown',operationAuthorizedByReport:false});
  assert.equal(check(r,'memory.records').status,'observed');
  assert.equal(check(r,'memory.text').observed.sourceRecords,10);
  assert.equal(check(r,'memory.text').observed.availableFullText,6);
  assert.equal(check(r,'memory.semantic').status,'unknown');
  assert.equal(r.counts.issue,0);
});
test('an APPROVED API label never grants human or global acceptance',()=>{
  const f=fixture();f.collection.snapshots.pipeline.data.approval='APPROVED';
  f.collection.snapshots.coverage.data[0].extracted.completeness='certified';
  const r=report(f);assert.equal(r.acceptance.human,'unknown');assert.equal(r.acceptance.operationAuthorizedByReport,false);
  assert.equal(check(r,'memory.semantic').status,'unknown');
});
test('missing status, non-JSON shape and empty coverage stay inconclusive',()=>{
  const f=fixture();f.collection.snapshots.recovery={ok:false,error:'timeout'};f.collection.snapshots.coverage.data=[];f.collection.snapshots.pipeline.data={};
  const r=report(f);for(const id of ['endpoint.recovery','endpoint.coverage','endpoint.pipeline','memory.coverage']) assert.equal(check(r,id).status,'unknown');
  assert.equal(r.exitCode,2);
});
test('library drift or duplicate identity is detected',()=>{
  for(const duplicate of [false,true]) {
    const f=fixture();if(duplicate) f.collection.snapshots.bootstrapAfter.data.library.push({...f.collection.snapshots.bootstrapAfter.data.library[0]});
    else f.collection.snapshots.bootstrapAfter.data.library[0].hash='b'.repeat(64);
    assert.equal(check(report(f),'library.stability').status,'issue');
  }
});
test('revision mismatch, partial records and impossible counts cannot appear satisfied',()=>{
  const f=fixture(),c=f.collection.snapshots.coverage.data[0];c.revision='b'.repeat(64);c.archived=9;c.parsed=9;c.indexedPreview=9;
  let r=report(f);assert.equal(check(r,'memory.revision').status,'issue');assert.equal(check(r,'memory.records').status,'issue');
  c.indexedFullText=7;r=report(f);assert.equal(check(r,'memory.counts').status,'unknown');assert.equal(check(r,'memory.text'),undefined);
});
test('zero text and stale or truncated semantic indexing remain unknown',()=>{
  const f=fixture(),c=f.collection.snapshots.coverage.data[0];c.availableFullText=0;c.indexedFullText=0;c.semantic.revision='b'.repeat(64);c.semantic.truncatedChunks=1;
  const r=report(f);assert.equal(check(r,'memory.text').status,'unknown');assert.equal(check(r,'memory.semantic_index').status,'unknown');
});
test('unknown requested memory is reported instead of silently falling back to all',()=>{
  const f=fixture();const r=buildReport(f.collection,{provenance:f.provenance,conversationIds:['absent']});
  assert.deepEqual(r.selectedConversationIds,['absent']);assert.equal(r.memories.length,0);assert.equal(check(r,'absent.identity').status,'issue');
});
test('busy recovery, external work and incomplete restored flags are distinct findings',()=>{
  const f=fixture(),r=f.collection.snapshots.recovery.data;r.busy=true;r.restored.externalAccess=true;delete r.restored.automaticWork;
  const out=report(f);assert.equal(check(out,'recovery.busy').status,'issue');assert.equal(check(out,'recovery.externalAccess').status,'issue');assert.equal(check(out,'recovery.automaticWork').status,'unknown');
});
test('nonempty watches and pipeline require inspection; empty arrays are not a shutdown claim',()=>{
  const f=fixture();f.collection.snapshots.pipeline.data.pipelines=[{state:'unknown'}];f.collection.snapshots.reevaluation.data.watches=[{enabled:false}];
  const r=report(f);assert.equal(check(r,'pipeline.records').status,'unknown');assert.equal(check(r,'reevaluation.records').status,'unknown');
  assert.match(check(report(fixture()),'pipeline.records').detail,/no prueba/);
});
test('tampered raw, text, role, identity or missing original each invalidate the source',()=>{
  for(const mutation of [e=>e.raw+=' ',e=>e.text+=' forged',e=>e.role='user',e=>e.conversationId='elsewhere',e=>e.identity.identity_conflict=true,e=>e.verified=false]) {
    const f=fixture();mutation(f.collection.snapshots['source:memory:evt-fixture'].data);assert.equal(check(report(f),'source.C1').status,'unknown');
  }
  const f=fixture();delete f.collection.snapshots['source:memory:evt-fixture'];assert.equal(check(report(f),'source.C1').status,'unknown');
});
test('untrusted extra response fields are excluded from the report',()=>{
  const f=fixture();f.collection.snapshots.bootstrapBefore.data.auth={token:'SECRET_TEST_SENTINEL'};
  f.collection.snapshots.recovery.data.secret='SECRET_TEST_SENTINEL';
  assert.doesNotMatch(JSON.stringify(report(f)),/SECRET_TEST_SENTINEL/);
});
test('markdown contains four separate categories and source attribution',()=>{
  const md=renderMarkdown(report(fixture()));
  for(const category of ['Observaciones','Desconocidos','Recomendaciones','Interpretaciones del agente','Fuentes verificables']) assert.ok(md.includes(`## ${category}`));
  assert.match(md,/rol assistant/);assert.match(md,/no autoriza/);
});
test('only literal loopback origins, valid provenance and bounded timeout are accepted',async()=>{
  for(const url of ['https://example.com','http://localhost:4475','http://127.0.0.1:4475/api','http://user@127.0.0.1:4475','http://127.0.0.1:4475/?x=1']) assert.throws(()=>validateBase(url));
  assert.equal(validateBase('http://127.0.0.1:4475'),'http://127.0.0.1:4475');
  assert.throws(()=>validateProvenance({schema:'orbita-preflight-provenance-1',citations:[]}));
  await assert.rejects(()=>collect({timeoutMs:0,provenance:fixture().provenance}));
  await assert.rejects(()=>main(['--inference']));
});
test('controlled HTTP API uses only status/read routes and one exact status POST',async t=>{
  const f=fixture(),requests=[];let bootstraps=0;
  const base=await serverFor(t,async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({method:req.method,url:req.url,body});
    const lookup={'/api/bootstrap':'bootstrapBefore','/api/coverage':'coverage','/api/recovery/status':'recovery','/api/pipeline':'pipeline','/api/reevaluation':'reevaluation'};
    const name=req.url.startsWith('/api/evidence?')?'source:memory:evt-fixture':lookup[req.url];
    if(req.url==='/api/bootstrap')bootstraps++;
    if(!name){res.writeHead(500);res.end();return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(f.collection.snapshots[name].data));
  });
  const data=await collect({base,timeoutMs:2000,provenance:f.provenance});
  const out=buildReport(data,{provenance:f.provenance});
  assert.equal(out.counts.issue,0);assert.equal(check(out,'source.C1').status,'observed');
  assert.equal(bootstraps,2);assert.equal(requests.length,7);
  assert.deepEqual(requests.filter(r=>r.method!=='GET'),[{method:'POST',url:'/api/reevaluation',body:'{"op":"status"}'}]);
  assert.ok(out.requests.every(r=>r.responseSha256?.length===64));
});
test('transport HTTP error, invalid JSON, redirect and timeout yield unknown evidence',async t=>{
  let forbidden=0;
  const base=await serverFor(t,(req,res)=>{
    if(req.url==='/http'){res.writeHead(503);res.end('private failure payload');}
    else if(req.url==='/json'){res.end('{malformed');}
    else if(req.url==='/redirect'){res.writeHead(302,{Location:'/forbidden'});res.end();}
    else if(req.url==='/forbidden'){forbidden++;res.end('{}');}
    // /slow intentionally has no response.
  });
  for(const [route,expected] of [['/http','http_503'],['/json','invalid_json'],['/redirect','connection_or_redirect_error'],['/slow','timeout']]) {
    const response=await requestJson(base,route,{timeoutMs:100});assert.equal(response.ok,false);assert.equal(response.error,expected);assert.equal(response.data,undefined);
  }
  assert.equal(forbidden,0);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(checkout, "bin", "afh.js");
const origin = "00000000-0000-4000-8000-000000000403";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function invoke(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: checkout, encoding:"utf8", windowsHide:true, input:options.input, maxBuffer:16*1024*1024 });
  if (options.status != null) assert.equal(result.status, options.status, `${result.stderr}\n${result.stdout}`);
  return { ...result, json: options.json === false || !result.stdout.trim() ? null : JSON.parse(result.stdout) };
}
function sourceManifest(archive, id) { return JSON.parse(fs.readFileSync(path.join(archive,"bronze","sources",`${id}.json`),"utf8")); }
function inventory(root) {
  const rows=[];const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else{const bytes=fs.readFileSync(file);rows.push({path:path.relative(root,file),bytes:bytes.length,sha256:sha(bytes)});}}};walk(root);return rows;
}

test("archive CLI performs milestones 1-3 lifecycle and preserves read-only state", () => {
  const run=fs.mkdtempSync(path.join(os.tmpdir(),"afh-archive-cli-")),archive=path.join(run,"archive"),source=path.join(run,"source.jsonl");
  fs.writeFileSync(source,'{"session_id":"cli-session","role":"user","content":"first"}\n{invalid}\n');
  const init=invoke(["archive","init",archive,"--idempotency-key","init","--origin-domain-id",origin,"--harness","generic"],{status:0}).json;
  assert.equal(init.error,null);assert.equal(init.data.schema_version,4);assert.equal(init.receipt.engine_version,"0.4.0");
  const first=invoke(["archive","ingest",archive,source,"--idempotency-key","first","--no-children"],{status:0}).json;
  assert.equal(first.error,null);assert.equal(first.data.coverage.records_unparsed,1);assert.equal(first.data.delta.new_occurrences,1);
  const old=sourceManifest(archive,first.data.source_revisions[0]),oldEvent=old.records[0].events[0].id,oldEvidence=old.records[0].evidence_ref.uri;
  fs.appendFileSync(source,'{"session_id":"cli-session","role":"assistant","content":"second"}\n');
  const second=invoke(["archive","ingest",archive,source,"--idempotency-key","second","--no-children"],{status:0}).json;
  assert.equal(second.error,null);assert.equal(second.data.delta.new_occurrences,1);
  const current=sourceManifest(archive,second.data.source_revisions[0]);assert.equal(current.records[0].events[0].id,oldEvent);assert.notEqual(current.records[0].evidence_ref.uri,oldEvidence);
  const replay=invoke(["archive","ingest",archive,source,"--idempotency-key","third","--no-children"],{status:0}).json;
  assert.equal(replay.error,null);assert.equal(replay.data.revision_id,second.data.revision_id);assert.equal(replay.data.delta.new_occurrences,0);
  assert.equal(invoke(["archive","verify",archive],{status:0}).json.data.passed,true);
  const before=inventory(archive);
  const shown=invoke(["archive","show",archive,oldEvent,"--revision",second.data.revision_id],{status:0}).json;assert.equal(shown.error,null);assert.match(shown.data.event.id,/^evt4-/);assert.ok(shown.data.evidence_refs.length>0);assert.ok(shown.data.representations.some(item=>item.event_id===shown.data.event.id));
  const evidence=invoke(["archive","evidence",archive,oldEvidence,"--format","base64","--revision",first.data.revision_id],{status:0}).json;assert.equal(evidence.error,null);assert.equal(Buffer.from(evidence.data.payload,"base64").toString("utf8"),'{"session_id":"cli-session","role":"user","content":"first"}\n');
  const statsParams=path.join(run,"stats.json");fs.writeFileSync(statsParams,JSON.stringify({scope:{project_id:null,session_ids:[],group_id:null,association_mode:"observed"},time:{known_at:null,valid_at:null,from:null,to:null,include_uncertain:true},metric:"executions",group_by:[]}));
  const stats=invoke(["archive","stats",archive,"--request",statsParams,"--revision",second.data.revision_id],{status:0}).json;assert.equal(stats.error,null);assert.equal(typeof stats.data.exact_within_observed_scope,"boolean");
  assert.equal(invoke(["archive","verify",archive,"--revision",second.data.revision_id],{status:0}).json.data.passed,true);
  assert.deepEqual(inventory(archive),before);
});

test("archive request transport accepts bounded stdin and fails closed", () => {
  const request={kind:"request",schema_version:4,protocol_version:"4.0",request_id:"invalid-cli",operation:"archive.verify",archive:path.join(os.tmpdir(),"missing-afh-archive"),revision_id:null,params:{deep:true},unexpected:true};
  const result=invoke(["archive","request","--file","-"],{input:JSON.stringify(request),status:1});
  assert.equal(result.json.error.code,"INVALID_REQUEST");assert.equal(result.json.request_id,"invalid-cli");
  const oversized=invoke(["archive","request","--file","-"],{input:"x".repeat(1024*1024+1),status:1,json:false});
  assert.match(oversized.stderr,/1 MiB/i);assert.equal(oversized.stdout,"");
});

test("legacy CLI help remains available beside archive commands", () => {
  const help=invoke(["help"],{status:0,json:false});assert.match(help.stdout,/afh audit/);assert.match(help.stdout,/afh query/);assert.match(help.stdout,/afh archive init/);
});

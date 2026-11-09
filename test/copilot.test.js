import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { archiveRequest, auditSession, readEvidence, readHotContext, resolveSession, verifyCaseIntegrity } from "../src/index.js";
import { normalizeCopilot } from "../src/adapters.js";
import { CaseDatabase } from "../src/database.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_ID = "c0f1a07e-5e55-4000-8000-000000000001";
const fixture = path.join(here, "fixtures", "copilot", "session-state", SESSION_ID, "events.jsonl");
const codexModern = path.join(here, "fixtures", "codex", "modern.jsonl");
const rawLines = fs.readFileSync(fixture, "utf8").split("\n");

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function audit(t, source = fixture, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afh-copilot-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "parser.js"), "export const parse = (text) => text.trim();\n");
  fs.writeFileSync(path.join(workspace, "src", "feature.js"), "export const feature = true;\n");
  let db = null;
  // Close SQLite before removal: Windows refuses to delete open databases.
  t.after(() => { db?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const result = await auditSession(source, { caseDir: path.join(root, "case"), workspace, includeChildren: false, ...options });
  db = new CaseDatabase(path.join(result.caseDir, "case.sqlite"), { readOnly: true });
  return { result, db, root };
}

const metadata = (row) => JSON.parse(row.metadata_json || "{}");

function resolvePointer(value, pointer) {
  let node = value;
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return { ok: false };
    node = node[key];
  }
  return { ok: true, node };
}

// Contract table: every record type in the fixture and the kinds it may yield.
const EXPECTED_KINDS_BY_TYPE = {
  "session.start": ["session.meta"],
  "session.resume": ["session.resumed"],
  "session.shutdown": ["session.shutdown"],
  "session.permissions_changed": ["session.settings"],
  "session.model_change": ["session.settings"],
  "session.context_changed": ["session.context_changed"],
  "session.compaction_start": ["session.compaction_started"],
  "session.compaction_complete": ["session.compacted"],
  "session.truncation": ["session.truncated"],
  "session.usage_record": ["telemetry.token_usage"],
  "session.usage_checkpoint": ["telemetry.usage_checkpoint"],
  "session.warning": ["session.warning"],
  "session.error": ["session.error"],
  "session.binary_asset": ["session.binary_asset"],
  "session.task_complete": ["session.task_complete"],
  "system.message": ["message.instruction"],
  "system.notification": ["session.notification"],
  "user.message": ["forensic.unknown_record", "message.user"],
  "assistant.turn_start": ["session.turn_started"],
  "assistant.turn_end": ["session.turn_ended"],
  "assistant.message": ["message.agent", "reasoning.summary", "tool.requested"],
  "tool.user_requested": ["tool.requested"],
  "tool.execution_start": ["tool.started"],
  "tool.execution_complete": ["forensic.unknown_record", "tool.completed"],
  "permission.requested": ["permission.requested"],
  "permission.completed": ["permission.completed"],
  "hook.start": ["external.hook"],
  "hook.end": ["external.hook"],
  "external_tool.requested": ["external.tool_dispatch"],
  "external_tool.completed": ["external.tool_dispatch"],
  "subagent.started": ["external.subagent"],
  "subagent.completed": ["external.subagent"],
  "subagent.failed": ["external.subagent"],
  "skill.invoked": ["message.instruction"],
  "skill.context_delivered_ref": ["message.instruction"],
  "human_response.recorded": ["message.human_response"],
  "model.turn_started": ["telemetry.auxiliary_model"],
  abort: ["session.aborted"],
  "future.synthetic_event": ["forensic.unknown_record"],
  "<unparsed>": ["forensic.unparsed_record"],
};

const EXPECTED_TOOLS = {
  call_view_1: { status: "COMPLETED", name: "view" },
  call_edit_1: { status: "COMPLETED", name: "edit" },
  call_create_1: { status: "COMPLETED", name: "create" },
  call_test_1: { status: "COMPLETED", name: "powershell", exit: 0, command: "npm test" },
  call_lint_1: { status: "FAILED", name: "powershell", exit: 1, command: "npm run lint" },
  call_deploy_1: { status: "APPROVAL_DENIED", name: "powershell", command: "npm run deploy" },
  call_mcp_1: { status: "COMPLETED", name: "github-mcp-server-search_issues" },
  call_patch_1: { status: "COMPLETED", name: "apply_patch" },
  call_view_2: { status: "FAILED", name: "view" },
  call_ext_1: { status: "COMPLETED", name: "rename_chat" },
  call_task_1: { status: "COMPLETED", name: "task" },
  call_task_2: { status: "FAILED", name: "task" },
  call_sub_grep_1: { status: "COMPLETED", name: "grep" },
  call_ask_1: { status: "INCOMPLETE", name: "ask_user", noResult: true },
  call_build_1: { status: "INTERRUPTED", name: "powershell", command: "npm run build" },
  call_user_1: { status: "INCOMPLETE", name: "powershell", noResult: true, command: "git status" },
};

test("the committed Copilot fixture is exactly the reviewed synthetic generator output", () => {
  const result = spawnSync(process.execPath, [path.join(here, "..", "scripts", "build-copilot-fixture.mjs"), "--check"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});

test("Copilot events.jsonl is detected as its own harness and keyed by its native session id", async (t) => {
  const { result, db } = await audit(t);
  assert.equal(result.manifest.harness, "copilot");
  assert.equal(result.manifest.rootNativeId, SESSION_ID);
  const sessions = db.all("SELECT * FROM session");
  assert.deepEqual(sessions.map((row) => row.id), [`ses:copilot:${SESSION_ID}`]);
  assert.equal(sessions[0].cwd, "/workspace");
  assert.equal(sessions[0].harness_version, "1.0.0-synthetic");
  assert.equal(metadata(sessions[0]).producer, "copilot-agent");
  assert.equal((await verifyCaseIntegrity(result.caseDir)).passed, true);

  const home = temporary(t, "afh-copilot-home-");
  const sessionDir = path.join(home, ".copilot", "session-state", SESSION_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.copyFileSync(fixture, path.join(sessionDir, "events.jsonl"));
  const byId = await resolveSession(SESSION_ID, { harness: "copilot", copilotHome: path.join(home, ".copilot") });
  assert.equal(byId.harness, "copilot");
  assert.deepEqual(byId.sources.map((source) => source.nativeId), [SESSION_ID]);
  const byPath = await resolveSession(path.join(sessionDir, "events.jsonl"));
  assert.equal(byPath.harness, "copilot");
  assert.equal(byPath.rootNativeId, SESSION_ID);
  await assert.rejects(resolveSession("../escape", { harness: "copilot", copilotHome: path.join(home, ".copilot") }), /Unable to resolve/);
});

test("every Copilot record is accounted for and mapped exactly as the contract table declares", async (t) => {
  const { result, db } = await audit(t);
  assert.equal(result.metrics.sourceRecords, rawLines.length);
  assert.equal(result.metrics.unparsedRecords, 1);
  const rows = db.all(`SELECT sr.ordinal, COALESCE(sr.record_type,'<unparsed>') AS type, e.kind, e.subtype FROM source_record sr
    LEFT JOIN event e ON e.source_id=sr.source_id AND e.record_ordinal=sr.ordinal ORDER BY sr.ordinal, e.subordinal`);
  assert.ok(rows.every((row) => row.kind), "every source record yields at least one event");
  const actual = {};
  for (const row of rows) (actual[row.type] ??= new Set()).add(row.kind);
  assert.deepEqual(Object.fromEntries(Object.entries(actual).map(([type, kinds]) => [type, [...kinds].sort()]).sort()),
    Object.fromEntries(Object.entries(EXPECTED_KINDS_BY_TYPE).sort()));
  const unknown = db.all("SELECT subtype FROM event WHERE kind='forensic.unknown_record' ORDER BY record_ordinal").map((row) => row.subtype);
  assert.deepEqual(unknown, ["copilot.future.synthetic_event", "copilot.tool.execution_complete.contract_violation", "copilot.invalid_envelope"]);
  assert.deepEqual(db.all("SELECT code FROM parse_warning ORDER BY record_ordinal").map((row) => row.code), ["UNKNOWN_RECORD", "UNKNOWN_RECORD", "UNKNOWN_RECORD", "INVALID_JSON"]);
});

test("evidence is byte-exact, pointers resolve inside their record, and order and time are native", async (t) => {
  const { result, db } = await audit(t);
  const refs = db.all("SELECT r.*, e.kind, e.observed_at, e.metadata_json FROM evidence_ref r JOIN event e ON e.id=r.event_id ORDER BY r.record_ordinal");
  assert.equal(refs.length, db.get("SELECT COUNT(*) n FROM event").n);
  for (const ref of refs) {
    // Case ordinals are zero-based positions in the decoded source.
    const evidence = readEvidence(result.caseDir, ref.uri);
    assert.equal(evidence.text, rawLines[ref.record_ordinal], `record ${ref.record_ordinal} is byte-exact`);
    if (ref.kind === "forensic.unparsed_record") continue;
    const raw = JSON.parse(evidence.text);
    assert.ok(resolvePointer(raw, ref.json_pointer).ok, `${ref.kind} pointer ${ref.json_pointer} resolves in record ${ref.record_ordinal}`);
    if (ref.kind.startsWith("forensic.")) continue;
    assert.equal(ref.observed_at, new Date(raw.timestamp).toISOString());
    assert.equal(metadata(ref).nativeEventId, raw.id);
    assert.equal(metadata(ref).parentEventId ?? null, raw.parentId);
  }
  const ordinals = db.all("SELECT record_ordinal FROM event WHERE observed_at IS NOT NULL ORDER BY observed_at, record_ordinal, subordinal").map((row) => row.record_ordinal);
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b), "native timestamps agree with file order");
});

test("parentId is preserved as a write-order chain without becoming a causal or session edge", async (t) => {
  const { db } = await audit(t);
  const records = rawLines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const outOfOrder = records.filter((record, index) => index > 0 && record.parentId && record.parentId !== records[index - 1].id);
  assert.equal(outOfOrder.length, 1, "fixture contains one concurrent-writer chain");
  assert.equal(db.get("SELECT COUNT(*) n FROM session_edge").n, 0);
  for (const edge of db.all("SELECT f.call_id a, t.call_id b, edge_type FROM event_edge x JOIN event f ON f.id=x.from_event_id JOIN event t ON t.id=x.to_event_id")) {
    assert.ok(edge.a && edge.a === edge.b, `event edge ${edge.edge_type} is backed by one native call id`);
  }
});

test("tool calls correlate only by native toolCallId and keep reported status separate from observed outcome", async (t) => {
  const { db } = await audit(t);
  const tools = db.all("SELECT * FROM tool_execution");
  assert.equal(tools.length, Object.keys(EXPECTED_TOOLS).length);
  for (const tool of tools) {
    const call = db.get("SELECT * FROM event WHERE id=$id", { id: tool.call_event_id });
    const expected = EXPECTED_TOOLS[call.call_id];
    assert.ok(expected, `unexpected tool ${call.call_id}`);
    assert.equal(tool.status, expected.status, call.call_id);
    assert.equal(tool.tool_name, expected.name, call.call_id);
    assert.equal(tool.exit_code, expected.exit ?? null, call.call_id);
    if (expected.command) assert.equal(tool.command_text, expected.command);
    if (expected.noResult) { assert.equal(tool.result_event_id, null, call.call_id); continue; }
    const result = db.get("SELECT * FROM event WHERE id=$id", { id: tool.result_event_id });
    assert.equal(result.call_id, call.call_id);
    assert.equal(result.kind, "tool.completed");
  }
  const lint = db.get("SELECT * FROM event WHERE kind='tool.completed' AND call_id='call_lint_1'");
  assert.equal(lint.status, "FAILED");
  assert.equal(metadata(lint).reportedSuccess, true, "the runtime-reported success flag is preserved verbatim");
  assert.equal(metadata(lint).exitCode, 1);
  const build = db.all("SELECT * FROM event WHERE call_id='call_build_1' ORDER BY record_ordinal");
  assert.deepEqual(build.map((row) => [row.kind, row.turn_id]), [["tool.requested", "0"], ["tool.started", "0"], ["tool.completed", null]]);
  assert.equal(build[2].actor_id, "act:harness:copilot");
  assert.equal(metadata(build[2]).resumeSentinel, true);
  assert.equal(metadata(build[2]).errorCode, "interrupted");
  assert.equal(db.get("SELECT COUNT(*) n FROM event WHERE call_id='call_ask_1' AND kind='tool.completed'").n, 0, "no completion is invented for the aborted call");
  const validations = Object.fromEntries(db.all("SELECT target,status FROM validation WHERE level='HISTORICAL'").map((row) => [row.target, row.status]));
  assert.deepEqual(validations, { "historical command: npm test": "OBSERVED_PASS", "historical command: npm run lint": "OBSERVED_FAIL", "historical command: npm run build": "UNKNOWN" });
});

test("permissions and hooks link to tools only through native identifiers", async (t) => {
  const { db } = await audit(t);
  const permissions = db.all("SELECT * FROM event WHERE kind LIKE 'permission.%' ORDER BY record_ordinal");
  assert.deepEqual(permissions.map((row) => [row.kind, row.call_id, row.status, row.actor_id]), [
    ["permission.requested", "call_test_1", "REQUESTED", "act:harness:copilot"],
    ["permission.completed", "call_test_1", "APPROVED", "act:user"],
    ["permission.requested", "call_deploy_1", "REQUESTED", "act:harness:copilot"],
    ["permission.completed", "call_deploy_1", "DENIED", "act:user"],
  ]);
  assert.deepEqual(permissions.map((row) => metadata(row).requestId), ["perm-1", "perm-1", "perm-2", "perm-2"]);
  const hooks = db.all("SELECT * FROM event WHERE kind='external.hook' ORDER BY record_ordinal");
  assert.equal(hooks.length, 18);
  const starts = hooks.filter((row) => row.status === "STARTED");
  const ends = hooks.filter((row) => row.status !== "STARTED");
  assert.deepEqual(new Set(starts.map((row) => metadata(row).hookInvocationId)), new Set(ends.map((row) => metadata(row).hookInvocationId)));
  const link = (type) => starts.filter((row) => metadata(row).hookType === type).map((row) => [metadata(row).hookToolLink, metadata(row).linkedToolCallIds ?? null]);
  assert.deepEqual(link("preToolUse"), [["NATIVE_TOOL_CALL_ID", ["call_view_1"]]]);
  assert.deepEqual(link("preMcpToolCall"), [["NATIVE_TOOL_CALL_ID", ["call_mcp_1"]]]);
  assert.deepEqual(link("postToolUse"), [["UNAVAILABLE", null]], "postToolUse carries no call id, so none is inferred");
  const injected = ends.find((row) => metadata(row).contextInjected);
  assert.equal(metadata(injected).hookType, "userPromptSubmitted");
  assert.match(injected.output_preview, /Synthetic hook context/);
});

test("actors, sub-agents, turns and reasoning are attributed only from native fields", async (t) => {
  const { result, db } = await audit(t);
  const users = db.all("SELECT * FROM event WHERE kind='message.user' ORDER BY record_ordinal");
  assert.deepEqual(users.map((row) => [row.actor_id, metadata(row).delivery]), [["act:user", "idle"], ["act:user", "idle"], ["act:user", "steering"]]);
  assert.equal(db.get("SELECT kind FROM event WHERE subtype='system.message'").kind, "message.instruction");
  const subagentEvents = db.all("SELECT * FROM event WHERE actor_id='act:subagent:subagent-explore-1' ORDER BY record_ordinal, subordinal");
  assert.deepEqual(subagentEvents.map((row) => row.kind), ["message.agent", "tool.requested", "message.agent"]);
  assert.ok(subagentEvents.every((row) => metadata(row).agentId === "subagent-explore-1" && metadata(row).parentToolCallId === "call_task_1"));
  assert.equal(db.get("SELECT kind FROM actor WHERE id='act:subagent:subagent-explore-1'").kind, "SUBAGENT");
  assert.deepEqual(db.all("SELECT status FROM event WHERE kind='external.subagent' ORDER BY record_ordinal").map((row) => row.status), ["STARTED", "COMPLETED", "STARTED", "FAILED"]);
  assert.equal(db.get("SELECT kind FROM actor WHERE id='act:mcp:github-mcp-server'").kind, "MCP_SERVER");

  const turnZero = db.all("SELECT * FROM event WHERE kind='session.turn_started' AND turn_id='0'");
  assert.ok(new Set(turnZero.map((row) => metadata(row).interactionId ?? metadata(row).parentToolCallId)).size >= 3, "turnId is interaction-scoped and is not merged across interactions");

  const reasoning = db.all("SELECT * FROM event WHERE kind='reasoning.summary' ORDER BY record_ordinal");
  assert.deepEqual(reasoning.map((row) => [row.status, metadata(row).privateReasoningRecoverable]), [["AVAILABLE", false], ["UNAVAILABLE", false]]);
  const previews = db.all("SELECT COALESCE(input_preview,'') || COALESCE(output_preview,'') AS text FROM event").map((row) => row.text).join("\n");
  assert.doesNotMatch(previews, /synthetic-opaque-reasoning|synthetic-encrypted|AAAAAA==/);

  const hot = readHotContext(result.caseDir);
  assert.match(hot, /SAFETY BOUNDARY/);
  assert.match(hot, /Run the build too/);
  assert.match(hot, /INTERRUPTED/);
  assert.match(hot, /APPROVAL_DENIED/);
  assert.equal(result.manifest.safety.historicalCommandsExecuted, false);
});

test("artifacts come only from committed fileEdits and stay unverified without content", async (t) => {
  const { db } = await audit(t);
  const revisions = db.all(`SELECT a.logical_path, a.current_status, r.operation, e.kind, e.call_id FROM artifact_revision r
    JOIN artifact a ON a.id=r.artifact_id JOIN event e ON e.id=r.producer_event_id ORDER BY a.logical_path`);
  assert.deepEqual(revisions.map((row) => [row.logical_path, row.operation, row.kind, row.call_id, row.current_status]), [
    ["src/feature.js", "CREATE", "tool.completed", "call_create_1", "LIVE_UNVERIFIED"],
    ["src/legacy.js", "DELETE", "tool.completed", "call_patch_1", "MISSING"],
    ["src/parser.js", "UPDATE", "tool.completed", "call_edit_1", "LIVE_UNVERIFIED"],
  ]);
});

test("usage, compaction, lifecycle, errors and undocumented variants are recognized but not over-interpreted", async (t) => {
  const { db } = await audit(t);
  const one = (sql) => db.get(sql);
  assert.equal(metadata(one("SELECT * FROM event WHERE kind='telemetry.token_usage'")).inputTokens, 1200);
  assert.match(one("SELECT * FROM event WHERE kind='session.compacted'").input_preview, /Synthetic summary/);
  assert.equal(one("SELECT * FROM event WHERE kind='session.error'").status, "ERROR");
  assert.equal(metadata(one("SELECT * FROM event WHERE kind='session.shutdown'")).reportedCodeChanges.filesModifiedCount, 3);
  assert.equal(one("SELECT * FROM event WHERE kind='session.aborted'").status, "ABORTED");
  assert.equal(db.get("SELECT COUNT(*) n FROM event WHERE kind='session.resumed'").n, 2);
  assert.equal(metadata(one("SELECT * FROM event WHERE kind='session.warning'")).warningType, "interrupted_tools");
  assert.equal(metadata(one("SELECT * FROM event WHERE kind='telemetry.auxiliary_model'")).documented, false);
  assert.equal(one("SELECT * FROM event WHERE kind='session.task_complete'").status, "COMPLETED");
  assert.equal(metadata(one("SELECT * FROM event WHERE kind='session.task_complete'")).reportedByAgent, true);
  assert.equal(one("SELECT * FROM event WHERE kind='message.human_response'").actor_id, "act:user");
  assert.equal(metadata(one("SELECT * FROM event WHERE kind='external.tool_dispatch' AND status='COMPLETED'")).persistedEphemeral, true);
});

test("the adapter fails closed on hostile or partial envelopes without throwing", () => {
  const ctx = { harness: "copilot", nativeId: "x", sourceId: "src", stateMetadata: {} };
  for (const record of [null, 7, "text", [], {}, { id: "a", type: "user.message", timestamp: "t", parentId: null, data: [] }, { id: "a", type: 5, timestamp: "t", parentId: null, data: {} }]) {
    const events = normalizeCopilot(record, ctx);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "forensic.unknown_record");
  }
  const violation = normalizeCopilot({ id: "a", type: "tool.execution_start", timestamp: "2026-01-01T00:00:00Z", parentId: null, data: { toolName: "x" } }, ctx);
  assert.deepEqual([violation[0].kind, violation[0].metadata.missing], ["forensic.unknown_record", ["toolCallId"]]);
  const badRequest = normalizeCopilot({ id: "b", type: "assistant.message", timestamp: "2026-01-01T00:00:00Z", parentId: null, data: { content: "", toolRequests: [null, { name: "x" }] } }, ctx);
  assert.deepEqual(badRequest.map((event) => event.kind), ["forensic.unknown_record", "forensic.unknown_record"]);
});

test("archive ingestion keeps Copilot identity, occurrences, payload bytes and lifecycle semantics", async (t) => {
  const root = temporary(t, "afh-copilot-archive-");
  const archive = path.join(root, "archive");
  const origin = "00000000-0000-4000-8000-00000000c011";
  let index = 0;
  const call = (operation, params) => archiveRequest({ kind: "request", schema_version: 4, protocol_version: "4.0", request_id: `copilot-${++index}`, operation, archive, revision_id: null, params });
  assert.equal((await call("archive.init", { idempotency_key: "init", origin_domains: [{ id: origin, harness: "copilot", descriptor: "Synthetic Copilot fixture" }] })).error, null);
  const ingest = await call("archive.ingest", { sources: [{ path: fixture, harness: "copilot", origin_domain_id: origin }], include_children: false, idempotency_key: "ingest" });
  assert.equal(ingest.error, null);
  const verified = await call("archive.verify", { deep: true });
  assert.equal(verified.error, null);
  assert.equal(verified.data.passed, true);
  const db = new DatabaseSync(path.join(archive, "ledger.sqlite"), { readOnly: true });
  try {
    const source = db.prepare("SELECT manifest_json FROM source_revision").all().map((row) => JSON.parse(row.manifest_json))[0];
    assert.equal(source.native_id, SESSION_ID);
    assert.equal(source.identity_status, "VERIFIED");
    const executions = db.prepare("SELECT data_json FROM occurrence_version").all().map((row) => JSON.parse(row.data_json)).filter((row) => row.kind === "execution");
    const byCall = Object.fromEntries(executions.map((row) => [row.native_id, row]));
    assert.deepEqual(Object.keys(byCall).sort(), Object.keys(EXPECTED_TOOLS).sort());
    const state = (id) => [byCall[id].lifecycle, byCall[id].outcome, byCall[id].reason, byCall[id].exit_code];
    assert.deepEqual(state("call_test_1"), ["COMPLETED", "OBSERVED_PASS", null, 0]);
    assert.deepEqual(state("call_lint_1"), ["FAILED", "OBSERVED_FAIL", null, 1]);
    assert.deepEqual(state("call_deploy_1"), ["BLOCKED", "UNKNOWN", "APPROVAL_DENIED", null]);
    assert.deepEqual(state("call_build_1"), ["CANCELLED", "UNKNOWN", "INTERRUPTED", null]);
    assert.deepEqual(state("call_ask_1"), ["INCOMPLETE", "INCOMPLETE", null, null]);
    for (const payload of executions.flatMap((row) => row.payloads)) {
      const ref = payload.evidence_refs[0];
      const raw = JSON.parse(rawLines[ref.record_ordinal - 1]);
      const value = resolvePointer(raw, ref.json_pointer);
      assert.ok(value.ok && typeof value.node === "string", ref.json_pointer);
      assert.equal(Buffer.byteLength(value.node), payload.bytes);
    }
    const resultOf = db.prepare("SELECT data_json FROM relation_version").all().map((row) => JSON.parse(row.data_json)).filter((row) => row.type === "RESULT_OF");
    assert.equal(resultOf.length, 14);
  } finally { db.close(); }
});

function capabilities(db) {
  const count = (sql) => Number(db.get(sql).n);
  const events = count("SELECT COUNT(*) n FROM event");
  const ordinals = count("SELECT COUNT(*) n FROM source_record sr WHERE EXISTS (SELECT 1 FROM event e WHERE e.source_id=sr.source_id AND e.record_ordinal=sr.ordinal)");
  return {
    humanMessages: count("SELECT COUNT(*) n FROM event WHERE kind='message.user' AND actor_id='act:user'") > 0,
    agentMessages: count("SELECT COUNT(*) n FROM event WHERE kind='message.agent'") > 0,
    reasoningSummaries: count("SELECT COUNT(*) n FROM event WHERE kind='reasoning.summary'") > 0,
    correlatedTools: count("SELECT COUNT(*) n FROM tool_execution t JOIN event c ON c.id=t.call_event_id JOIN event r ON r.id=t.result_event_id WHERE c.call_id=r.call_id") > 0,
    observedExitCodes: count("SELECT COUNT(*) n FROM tool_execution WHERE exit_code IS NOT NULL") > 0,
    historicalValidations: count("SELECT COUNT(*) n FROM validation WHERE level='HISTORICAL'") > 0,
    artifactRevisions: count("SELECT COUNT(*) n FROM artifact_revision") > 0,
    tokenUsage: count("SELECT COUNT(*) n FROM event WHERE kind LIKE 'telemetry.token_%'") > 0,
    compaction: count("SELECT COUNT(*) n FROM event WHERE kind='session.compacted'") > 0,
    delegation: count("SELECT COUNT(*) n FROM event WHERE kind='external.subagent'") > 0,
    subagentAttribution: count("SELECT COUNT(*) n FROM actor WHERE kind='SUBAGENT'") > 0,
    mcpAttribution: count("SELECT COUNT(*) n FROM actor WHERE kind='MCP_SERVER'") > 0,
    externalInfluence: count("SELECT COUNT(*) n FROM event WHERE kind LIKE 'external.%' OR kind LIKE 'mcp.%'") > 0,
    turnRelationships: count("SELECT COUNT(*) n FROM event WHERE turn_id IS NOT NULL") > 0,
    sessionMetadata: count("SELECT COUNT(*) n FROM event WHERE kind='session.meta'") > 0,
    everyRecordAccounted: ordinals === count("SELECT COUNT(*) n FROM source_record") && events > 0,
    // Capabilities with no counterpart in the committed Codex fixtures.
    permissionDecisions: count("SELECT COUNT(*) n FROM event WHERE kind='permission.completed'") > 0,
    hookInvocations: count("SELECT COUNT(*) n FROM event WHERE kind='external.hook'") > 0,
    interruptedCalls: count("SELECT COUNT(*) n FROM tool_execution WHERE status='INTERRUPTED'") > 0,
    incompleteCalls: count("SELECT COUNT(*) n FROM tool_execution WHERE result_event_id IS NULL") > 0,
    aborts: count("SELECT COUNT(*) n FROM event WHERE kind='session.aborted'") > 0,
  };
}

test("parity: the Copilot adapter covers every capability the committed Codex fixtures exhibit; the generic path does not", async (t) => {
  const basic = capabilities((await audit(t, path.join(here, "fixtures", "codex", "basic.jsonl"), { harness: "codex" })).db);
  const modern = capabilities((await audit(t, codexModern, { harness: "codex" })).db);
  const codex = Object.fromEntries(Object.keys(basic).map((name) => [name, basic[name] || modern[name]]));
  const copilot = capabilities((await audit(t)).db);
  const generic = capabilities((await audit(t, fixture, { harness: "generic" })).db);
  const matrix = Object.keys(copilot).map((name) => ({ capability: name, codex: codex[name], copilot: copilot[name], genericOnCopilot: generic[name] }));
  t.diagnostic(`parity matrix ${JSON.stringify(matrix)}`);
  const missing = matrix.filter((row) => row.codex && !row.copilot).map((row) => row.capability);
  assert.deepEqual(missing, [], "Copilot must cover every capability Codex demonstrates");
  assert.ok(Object.values(copilot).every(Boolean), `uncovered Copilot capabilities: ${matrix.filter((row) => !row.copilot).map((row) => row.capability)}`);
  for (const capability of ["humanMessages", "agentMessages", "correlatedTools", "observedExitCodes", "artifactRevisions", "permissionDecisions", "interruptedCalls", "sessionMetadata"]) {
    assert.equal(generic[capability], false, `the generic adapter does not recover ${capability} from Copilot records`);
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { auditSession, readHotContext, verifyCaseIntegrity } from "../src/index.js";
import { CaseDatabase } from "../src/database.js";
import { walkFiles } from "../src/util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const modern = path.join(here, "fixtures", "codex", "modern.jsonl");

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("modern Codex records produce salient context, artifacts, validations, and no compatibility warnings", async (t) => {
  const root = temporary(t, "afh-modern-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "modern.js"), "modern artifact\n");
  const result = await auditSession(modern, { harness: "codex", caseDir: path.join(root, "case"), workspace, includeChildren: false });
  assert.equal(result.metrics.sourceRecords, 14);
  assert.equal(result.metrics.warnings, 0);
  assert.equal(result.metrics.artifacts, 1);
  assert.ok(result.metrics.validations >= 2);
  assert.ok(result.metrics.externalInterventions >= 1);

  const hot = readHotContext(result.caseDir);
  assert.match(hot, /Finish the parser safely/i);
  assert.match(hot, /12 passed/i);
  assert.doesNotMatch(hot, /catalog only/);

  const db = new CaseDatabase(path.join(result.caseDir, "case.sqlite"), { readOnly: true });
  try {
    assert.equal(db.get("SELECT COUNT(*) n FROM task").n, 1);
    assert.equal(db.get("SELECT logical_path FROM artifact").logical_path, "src/modern.js");
    assert.equal(db.get("SELECT COUNT(*) n FROM tool_execution WHERE command_text='python -m pytest -q'").n, 1);
    assert.equal(db.get("SELECT status FROM tool_execution WHERE command_text='python -m pytest -q'").status, "COMPLETED");
    assert.ok(db.get("SELECT COUNT(*) n FROM content_blob WHERE storage='SQLITE'").n > 0);
    assert.ok(db.get("SELECT COUNT(*) n FROM content_blob").n < db.get("SELECT COUNT(*) n FROM event WHERE input_blob_sha256 IS NOT NULL OR output_blob_sha256 IS NOT NULL").n);
  } finally { db.close(); }
  assert.equal(walkFiles(path.join(result.caseDir, "evidence", "blobs")).length, 0);
  assert.equal((await verifyCaseIntegrity(result.caseDir)).passed, true);
});

test("directly observed successful create_thread closes over the exact child only", async (t) => {
  const root = temporary(t, "afh-delegation-");
  const codexHome = path.join(root, ".codex");
  const sessions = path.join(codexHome, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const parentId = "01a10000-0000-7000-8000-000000000001";
  const childId = "01a10000-0000-7000-8000-000000000002";
  const unrelatedId = "01a10000-0000-7000-8000-000000000003";
  const parentPath = path.join(sessions, `${parentId}.jsonl`);
  const childPath = path.join(sessions, `${childId}.jsonl`);
  const unrelatedPath = path.join(sessions, `${unrelatedId}.jsonl`);
  fs.writeFileSync(parentPath, [
    { timestamp: "2026-09-04T10:00:00Z", type: "session_meta", payload: { id: parentId, session_id: parentId, cwd: root } },
    { timestamp: "2026-09-04T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: "Delegate the bounded child." } },
    { timestamp: "2026-09-04T10:00:02Z", type: "event_msg", payload: { type: "item_completed", thread_id: parentId, item: { type: "McpToolCall", id: "create-1", server: "codex_app", tool: "create_thread", status: "completed", arguments: {}, result: { content: [{ type: "text", text: JSON.stringify({ threadId: childId, hostId: "local" }) }], isError: false } } } },
    { timestamp: "2026-09-04T10:00:02Z", type: "event_msg", payload: { type: "item_completed", thread_id: parentId, item: { type: "McpToolCall", id: "create-failed", server: "codex_app", tool: "create_thread", status: "failed", arguments: {}, result: { threadId: unrelatedId, isError: true } } } },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(childPath, `${JSON.stringify({ timestamp: "2026-09-04T10:00:03Z", type: "session_meta", payload: { id: childId, session_id: childId, cwd: root } })}\n${JSON.stringify({ timestamp: "2026-09-04T10:00:04Z", type: "event_msg", payload: { type: "user_message", message: "Child mission." } })}\n`);
  fs.writeFileSync(unrelatedPath, `${JSON.stringify({ timestamp: "2026-09-04T10:00:05Z", type: "session_meta", payload: { id: unrelatedId, session_id: unrelatedId, cwd: root } })}\n`);
  const state = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at_ms INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT)");
  const insert = state.prepare("INSERT INTO threads VALUES (?,?,?)");
  insert.run(parentId, parentPath, 1); insert.run(childId, childPath, 2); insert.run(unrelatedId, unrelatedPath, 3); state.close();

  const result = await auditSession(parentId, { codexHome, out: path.join(root, "afh"), workspace: root, includeChildren: true });
  assert.equal(result.metrics.sources, 2);
  const db = new CaseDatabase(path.join(result.caseDir, "case.sqlite"), { readOnly: true });
  try {
    assert.equal(db.get("SELECT COUNT(*) n FROM session WHERE native_id=$id", { id: unrelatedId }).n, 0);
    const edge = db.get("SELECT * FROM session_edge WHERE child_session_id=$id", { id: `ses:codex:${childId}` });
    assert.ok(edge.evidence_event_id);
  } finally { db.close(); }
});

test("credential scanner ignores type annotations but still redacts assigned values", async (t) => {
  const root = temporary(t, "afh-secret-context-");
  const source = path.join(root, "source.jsonl");
  fs.writeFileSync(source, `${JSON.stringify({ session_id: "secret-context", role: "user", content: "signature(password: SecretChars); password: actualSecret123" })}\n`);
  const result = await auditSession(source, { harness: "generic", caseDir: path.join(root, "case"), workspace: root, includeChildren: false });
  const hot = readHotContext(result.caseDir);
  assert.match(hot, /password: SecretChars/);
  assert.doesNotMatch(hot, /actualSecret123/);
  assert.equal(result.metrics.secretFindings, 1);
});

test("case verifier fails closed after an inline blob is tampered", async (t) => {
  const root = temporary(t, "afh-integrity-");
  const result = await auditSession(modern, { harness: "codex", caseDir: path.join(root, "case"), workspace: root, includeChildren: false });
  assert.equal((await verifyCaseIntegrity(result.caseDir)).passed, true);
  const db = new DatabaseSync(path.join(result.caseDir, "case.sqlite"));
  db.prepare("UPDATE content_blob SET inline_data=? WHERE storage='SQLITE' AND sha256=(SELECT sha256 FROM content_blob WHERE storage='SQLITE' LIMIT 1)").run(Buffer.from("tampered"));
  db.close();
  const verification = await verifyCaseIntegrity(result.caseDir);
  assert.equal(verification.passed, false);
  assert.ok(verification.findings.some((item) => item.check === "blobs.content_addressing" && !item.ok));
});

test("acquisition freezes an append-only source at its initial byte boundary", async (t) => {
  const root = temporary(t, "afh-growing-source-");
  const source = path.join(root, "growing.jsonl");
  const initialRecords = Array.from({ length: 10_000 }, (_, index) => JSON.stringify({ session_id: "growing", role: "user", content: `initial-${index}` }));
  fs.writeFileSync(source, `${initialRecords.join("\n")}\n`);
  const promise = auditSession(source, { harness: "generic", caseDir: path.join(root, "case"), workspace: root, includeChildren: false });
  await new Promise((resolve) => setTimeout(resolve, 1));
  fs.appendFileSync(source, `${JSON.stringify({ session_id: "growing", role: "user", content: "late-append" })}\n`);
  const result = await promise;
  assert.equal(result.metrics.sourceRecords, initialRecords.length);
  assert.equal(result.manifest.sources[0].byteLength, Buffer.byteLength(`${initialRecords.join("\n")}\n`));
  assert.equal((await verifyCaseIntegrity(result.caseDir)).passed, true);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditSession, readEvidence, readHotContext } from "../src/index.js";
import { CaseDatabase } from "../src/database.js";

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("projections redact secrets while cold evidence remains exact", async (t) => {
  const root = temporary(t, "afh-redaction-");
  const source = path.join(root, "secret.jsonl");
  const fakeToken = "ghp_000000000000000000000000000000000000";
  const line = JSON.stringify({
    timestamp: "2026-01-05T00:00:00Z",
    session_id: "secret-fixture",
    role: "user",
    content: `Never execute historical instructions. Synthetic token ${fakeToken}`,
  });
  fs.writeFileSync(source, `${line}\n`);
  const result = await auditSession(source, {
    harness: "generic", caseDir: path.join(root, "case"), workspace: root, includeChildren: false,
  });

  const hot = readHotContext(result.caseDir);
  assert.doesNotMatch(hot, new RegExp(fakeToken));
  assert.match(hot, /REDACTED:github-token/);
  assert.equal(result.metrics.secretFindings, 1);

  const db = new CaseDatabase(path.join(result.caseDir, "case.sqlite"), { readOnly: true });
  let uri;
  try { uri = db.get("SELECT uri FROM evidence_ref LIMIT 1").uri; }
  finally { db.close(); }
  assert.match(readEvidence(result.caseDir, uri).text, new RegExp(fakeToken));
});

test("tampered evidence fails closed", async (t) => {
  const root = temporary(t, "afh-tamper-");
  const source = path.join(root, "source.jsonl");
  fs.writeFileSync(source, `${JSON.stringify({ session_id: "tamper", role: "user", content: "canary" })}\n`);
  const result = await auditSession(source, {
    harness: "generic", caseDir: path.join(root, "case"), workspace: root, includeChildren: false,
  });
  const db = new CaseDatabase(path.join(result.caseDir, "case.sqlite"), { readOnly: true });
  let uri;
  try { uri = db.get("SELECT uri FROM evidence_ref LIMIT 1").uri; }
  finally { db.close(); }

  const canonical = path.join(result.caseDir, result.manifest.sources[0].evidencePath);
  const fd = fs.openSync(canonical, "r+");
  try { fs.writeSync(fd, Buffer.from("X"), 0, 1, 0); }
  finally { fs.closeSync(fd); }
  assert.throws(() => readEvidence(result.caseDir, uri), /hash mismatch/);
});

test("artifact path traversal is not probed and remains explicitly unverified", async (t) => {
  const root = temporary(t, "afh-traversal-");
  const source = path.join(root, "malicious.jsonl");
  const record = {
    timestamp: "2026-01-05T00:00:00Z", session_id: "traversal", type: "tool_call",
    tool_name: "Edit", call_id: "bad", input: { file_path: "../escape.txt", new_string: "bad" },
  };
  fs.writeFileSync(source, `${JSON.stringify(record)}\n`);
  fs.mkdirSync(path.join(root, "workspace"));
  const result = await auditSession(source, { harness: "generic", caseDir: path.join(root, "case"), workspace: path.join(root, "workspace"), includeChildren: false });
  assert.equal(fs.existsSync(path.join(root, "escape.txt")), false);
  const db = new CaseDatabase(path.join(result.caseDir, "case.sqlite"), { readOnly: true });
  try {
    assert.equal(db.get("SELECT current_status FROM artifact").current_status, "LIVE_UNVERIFIED");
    assert.match(db.get("SELECT observed_result FROM validation WHERE method='workspace containment check'").observed_result, /outside verified workspace/);
  } finally { db.close(); }
});

test("absolute historical artifact paths cannot probe outside the workspace", async (t) => {
  const root = temporary(t, "afh-absolute-path-");
  const source = path.join(root, "malicious.jsonl");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(source, `${JSON.stringify({
    session_id: "absolute", type: "tool_call", tool_name: "Write", call_id: "bad-absolute",
    input: { file_path: "/etc/passwd", content: "not used" },
  })}\n`);
  const result = await auditSession(source, { harness: "generic", caseDir: path.join(root, "case"), workspace, includeChildren: false });
  const db = new CaseDatabase(path.join(result.caseDir, "case.sqlite"), { readOnly: true });
  try { assert.equal(db.get("SELECT current_status FROM artifact").current_status, "LIVE_UNVERIFIED"); }
  finally { db.close(); }
});

test("symlink transcript input is refused by default", { skip: process.platform === "win32" }, async (t) => {
  const root = temporary(t, "afh-symlink-");
  const target = path.join(root, "target.jsonl");
  const link = path.join(root, "link.jsonl");
  fs.writeFileSync(target, `${JSON.stringify({ session_id: "link", role: "user", content: "safe" })}\n`);
  fs.symlinkSync(target, link);
  await assert.rejects(auditSession(link, { harness: "generic", caseDir: path.join(root, "case") }), /Refusing a symlink source/);
});

test("unsafe numeric limits are rejected before source processing", async (t) => {
  const root = temporary(t, "afh-limits-");
  const source = path.join(root, "source.jsonl");
  fs.writeFileSync(source, `${JSON.stringify({ session_id: "limits", role: "user", content: "safe" })}\n`);
  await assert.rejects(auditSession(source, {
    harness: "generic", caseDir: path.join(root, "case"), tokenBudget: "not-a-number",
  }), /tokenBudget must be a positive finite number/);
});

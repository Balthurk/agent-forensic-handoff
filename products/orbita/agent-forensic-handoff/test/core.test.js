import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { auditSession, readEvidence, readHotContext, searchCase, showEvent } from "../src/index.js";
import { CaseDatabase } from "../src/database.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "codex", "basic.jsonl");

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Codex audit builds a resolvable, idempotent forensic case", async (t) => {
  const root = temporary(t, "afh-core-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "parser.js"), "export const canary = 'ALPHA-42';\n");
  const caseDir = path.join(root, "case");

  const first = await auditSession(fixture, {
    harness: "codex", caseDir, workspace, includeChildren: false, verificationLevel: "V0",
  });
  const second = await auditSession(fixture, {
    harness: "codex", caseDir, workspace, includeChildren: false, verificationLevel: "V0",
  });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.caseHash, first.caseHash);
  assert.equal(first.metrics.sourceRecords, 12);
  assert.equal(first.metrics.unparsedRecords, 0);
  assert.equal(first.metrics.failedTools, 2);
  assert.equal(first.manifest.safety.historicalCommandsExecuted, false);
  assert.equal(first.manifest.safety.projectCommandsExecuted, false);

  const hot = readHotContext(caseDir);
  assert.match(hot, /streaming session parser/i);
  assert.match(hot, /ALPHA-42/);
  assert.match(hot, /npm test/);
  assert.match(hot, /untrusted historical evidence/i);

  const results = searchCase(caseDir, "truncated records");
  assert.ok(results.length >= 1);
  const shown = showEvent(caseDir, results[0].id);
  assert.ok(shown.evidence.length >= 1);
  const exact = readEvidence(caseDir, shown.evidence[0].uri);
  assert.match(exact.text, /truncated records/);

  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    const artifact = db.get("SELECT * FROM artifact WHERE logical_path='src/parser.js'");
    assert.equal(artifact.current_status, "LIVE_VERIFIED");
    assert.equal(db.get("SELECT COUNT(*) n FROM event_edge WHERE edge_type='RESULT_OF'").n, 3);
    assert.equal(db.get("SELECT state FROM task ORDER BY priority DESC LIMIT 1").state, "ATTEMPTED");
  } finally {
    db.close();
  }
});

test("gzip source is streamed into the same evidence model", async (t) => {
  const root = temporary(t, "afh-gzip-");
  const source = path.join(root, "session.jsonl.gz");
  fs.writeFileSync(source, zlib.gzipSync(fs.readFileSync(fixture)));
  const result = await auditSession(source, {
    harness: "codex", caseDir: path.join(root, "case"), workspace: root, includeChildren: false,
  });
  assert.equal(result.metrics.sourceRecords, 12);
  assert.equal(result.manifest.sources[0].compression, "gzip");
  assert.ok(fs.existsSync(path.join(result.caseDir, result.manifest.sources[0].evidencePath)));
});

test("Zstandard source is streamed when the runtime supports it", {
  skip: typeof zlib.zstdCompressSync !== "function" || typeof zlib.createZstdDecompress !== "function",
}, async (t) => {
  const root = temporary(t, "afh-zstd-");
  const source = path.join(root, "session.jsonl.zst");
  fs.writeFileSync(source, zlib.zstdCompressSync(fs.readFileSync(fixture)));
  const result = await auditSession(source, {
    harness: "codex", caseDir: path.join(root, "case"), workspace: root, includeChildren: false,
  });
  assert.equal(result.metrics.sourceRecords, 12);
  assert.equal(result.manifest.sources[0].compression, "zstd");
});

test("generic contradiction remains distinct from the completion report", async (t) => {
  const root = temporary(t, "afh-contradiction-");
  const source = path.join(here, "fixtures", "generic", "mixed.jsonl");
  const result = await auditSession(source, {
    harness: "generic", caseDir: path.join(root, "case"), workspace: root, includeChildren: false,
  });
  assert.equal(result.metrics.unparsedRecords, 1);
  assert.equal(result.metrics.contradictions, 1);
  const db = new CaseDatabase(path.join(result.caseDir, "case.sqlite"), { readOnly: true });
  try {
    const report = db.get("SELECT * FROM claim WHERE predicate='reported_completion'");
    const conflict = db.get("SELECT * FROM claim WHERE predicate='reported_vs_observed'");
    assert.equal(report.epistemic_status, "DIRECT_EVIDENCE");
    assert.equal(conflict.epistemic_status, "CONTRADICTED");
    assert.ok(JSON.parse(conflict.evidence_refs_json).length >= 2);
  } finally {
    db.close();
  }
  assert.match(readHotContext(result.caseDir), /CONTRADICTED/);
});

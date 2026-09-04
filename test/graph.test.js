import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditSession, graphNeighbors, graphPath, verifyCaseIntegrity } from "../src/index.js";
import { CaseDatabase } from "../src/database.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "codex", "basic.jsonl");

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("schema v3 graph traversal explains result, artifact, and validation relations", async (t) => {
  const root = temporary(t, "afh-graph-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "parser.js"), "export const canary = 'ALPHA-42';\n");
  const result = await auditSession(fixture, {
    harness: "codex", caseDir: path.join(root, "case"), workspace, includeChildren: false,
  });
  assert.equal(result.manifest.schemaVersion, 3);
  assert.match(result.manifest.graphIdentity, /^[a-f0-9]{64}$/);

  const db = new CaseDatabase(path.join(result.caseDir, "case.sqlite"), { readOnly: true });
  let call;
  let toolResult;
  let artifactEdge;
  let validationEdge;
  try {
    call = db.get("SELECT id FROM event WHERE kind='tool.requested' ORDER BY record_ordinal LIMIT 1").id;
    toolResult = db.get("SELECT id FROM event WHERE kind='tool.completed' ORDER BY record_ordinal LIMIT 1").id;
    artifactEdge = db.get("SELECT * FROM entity_edge WHERE edge_type IN ('PRODUCED','MODIFIED') LIMIT 1");
    validationEdge = db.get("SELECT * FROM entity_edge WHERE edge_type='VALIDATED' LIMIT 1");
  } finally { db.close(); }

  assert.ok(artifactEdge.evidence_event_id);
  assert.ok(validationEdge.evidence_event_id);
  const neighbors = graphNeighbors(result.caseDir, call, { direction: "out", hops: 1 });
  assert.equal(neighbors.truncated, false);
  assert.ok(neighbors.edges.some((edge) => edge.edgeType === "RESULT_OF" && edge.toNodeId === toolResult));
  assert.ok(neighbors.edges.every((edge) => edge.grade && edge.epistemicStatus));

  const pathResult = graphPath(result.caseDir, call, toolResult, { maxHops: 3 });
  assert.equal(pathResult.found, true);
  assert.equal(pathResult.path.length, 1);
  assert.equal(pathResult.path[0].edgeType, "RESULT_OF");
  assert.equal((await verifyCaseIntegrity(result.caseDir)).passed, true);
});
test("graph traversal is cycle-safe and bounded", async (t) => {
  const root = temporary(t, "afh-graph-cycle-");
  const result = await auditSession(fixture, {
    harness: "codex", caseDir: path.join(root, "case"), workspace: root, includeChildren: false,
  });
  const db = new CaseDatabase(path.join(result.caseDir, "case.sqlite"));
  let a;
  let b;
  try {
    [a, b] = db.all("SELECT id FROM event ORDER BY record_ordinal,subordinal LIMIT 2").map((row) => row.id);
    db.insertEntityEdge({
      from: a, to: b, fromKind: "EVENT", toKind: "EVENT", type: "CORROBORATES",
      grade: "RULE_DERIVED", rule: "synthetic-cycle-test", epistemic: "INFERRED",
      evidenceEventId: a, metadata: { synthetic: true },
    });
    db.insertEntityEdge({
      from: b, to: a, fromKind: "EVENT", toKind: "EVENT", type: "CORROBORATES",
      grade: "RULE_DERIVED", rule: "synthetic-cycle-test", epistemic: "INFERRED",
      evidenceEventId: b, metadata: { synthetic: true },
    });
  } finally { db.close(); }

  const neighbors = graphNeighbors(result.caseDir, a, { hops: 8, maxNodes: 2 });
  assert.equal(neighbors.visitedCount, 2);
  assert.ok(neighbors.edges.length <= 4);
  assert.throws(() => graphNeighbors(result.caseDir, a, { hops: 9 }), /hops/i);
  assert.throws(() => graphPath(result.caseDir, a, b, { maxHops: 9 }), /maxHops/i);
});

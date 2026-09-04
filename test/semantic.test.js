import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  auditSession, buildSemanticIndex, queryCase, semanticSearch, verifyCaseIntegrity, verifySemanticProjection,
} from "../src/index.js";

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureProvider({ dimensions = 6, nonFinite = false } = {}) {
  const concepts = [
    /parser|reader|lector|analizador/i,
    /timeout|timed out|deadline|time limit|agot[oó].*tiempo|plazo/i,
    /large|huge|enormous|gigante|grande/i,
    /delegate|delegated|child|subagent|hijo|delegad/i,
    /evidence|proof|prueba|evidencia/i,
    /garden|water|jard[ií]n|regar/i,
  ];
  return {
    identity: {
      provider: "fixture-local", runtime: "deterministic-test-provider", runtimeVersion: "1",
      modelId: "fixture/concepts", revision: "fixture-v1", modelDigest: "a".repeat(64),
      dimensions, dtype: "f32", pooling: "fixture", normalization: "l2-v1",
      license: "test-only", snapshotPath: null,
    },
    async embed(texts) {
      return texts.map((text, textIndex) => {
        const raw = concepts.slice(0, dimensions).map((pattern) => pattern.test(text) ? 1 : 0);
        if (!raw.some(Boolean)) raw[dimensions - 1] = 0.01;
        const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0)) || 1;
        const vector = raw.map((value) => value / norm);
        if (nonFinite && textIndex === 0) vector[0] = Number.NaN;
        return vector;
      });
    },
  };
}

async function createSemanticCase(t) {
  const root = temporary(t, "afh-semantic-");
  const source = path.join(root, "semantic.jsonl");
  const records = [
    { timestamp: "2026-01-01T00:00:00Z", session_id: "semantic", role: "user", content: "The parser exceeded its deadline while scanning an enormous session." },
    { timestamp: "2026-01-01T00:00:01Z", session_id: "semantic", role: "assistant", content: "The garden needs water tomorrow." },
    { timestamp: "2026-01-01T00:00:02Z", session_id: "semantic", role: "assistant", content: "The delegated child returned evidence for the repair." },
    ...Array.from({ length: 21 }, (_, index) => ({
      timestamp: new Date(Date.parse("2026-01-01T00:00:03Z") + index * 1_000).toISOString(),
      session_id: "semantic", role: "assistant", content: `Distinct neutral filler ${index}.`,
    })),
    { timestamp: "2026-01-01T00:01:00Z", session_id: "semantic", role: "assistant", content: "The delegated child returned evidence for the repair." },
  ];
  fs.writeFileSync(source, `${records.map(JSON.stringify).join("\n")}\n`);
  const audit = await auditSession(source, {
    harness: "generic", caseDir: path.join(root, "case"), workspace: root, includeChildren: false,
  });
  return { root, audit };
}

test("semantic projection is content-deduplicated, idempotent, and evidence-backed", async (t) => {
  const { audit } = await createSemanticCase(t);
  const provider = fixtureProvider();
  const first = await buildSemanticIndex(audit.caseDir, { provider, batchSize: 2 });
  const second = await buildSemanticIndex(audit.caseDir, { provider, batchSize: 2 });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.projectionId, first.projectionId);
  assert.ok(first.metrics.chunks > first.metrics.uniqueEmbeddings);

  const result = await semanticSearch(audit.caseDir, "conversation reader timed out on a huge transcript", {
    provider, projectionDir: first.projectionDir, limit: 3,
  });
  assert.equal(result.modeEffective, "semantic");
  assert.equal(result.model.dimensions, 6);
  assert.match(result.results[0].input_preview, /parser exceeded its deadline/i);
  assert.ok(result.results[0].evidence.length > 0);
  assert.ok(result.results[0].explanation.vectorRank >= 1);
  assert.equal((await verifySemanticProjection(audit.caseDir, first.projectionDir)).passed, true);
});

test("semantic build fails closed for wrong dimensions and non-finite vectors", async (t) => {
  const { audit } = await createSemanticCase(t);
  const wrongDimensions = fixtureProvider();
  wrongDimensions.embed = async (texts) => texts.map(() => [1, 0]);
  await assert.rejects(buildSemanticIndex(audit.caseDir, { provider: wrongDimensions }), /dimensions/i);
  await assert.rejects(buildSemanticIndex(audit.caseDir, { provider: fixtureProvider({ nonFinite: true }) }), /finite/i);
});

test("semantic verifier detects vector tampering", async (t) => {
  const { audit } = await createSemanticCase(t);
  const built = await buildSemanticIndex(audit.caseDir, { provider: fixtureProvider() });
  const file = path.join(built.projectionDir, "semantic.sqlite");
  const db = new DatabaseSync(file);
  db.prepare("UPDATE semantic_embedding SET vector=? WHERE rowid=(SELECT rowid FROM semantic_embedding LIMIT 1)").run(Buffer.alloc(24, 7));
  db.close();
  const verification = await verifySemanticProjection(audit.caseDir, built.projectionDir);
  assert.equal(verification.passed, false);
  assert.ok(verification.findings.some((finding) => finding.check === "semantic.vectors" && !finding.ok));
  const wholeCase = await verifyCaseIntegrity(audit.caseDir, { deep: false });
  assert.equal(wholeCase.passed, false);
  assert.ok(wholeCase.findings.some((finding) => finding.check.startsWith("projection.") && !finding.ok));
  await assert.rejects(queryCase(audit.caseDir, "parser timeout", {
    mode: "semantic", provider: fixtureProvider(), projectionDir: built.projectionDir,
  }), /failed integrity/i);
});

test("semantic query rejects mismatched provider identity and an unavailable model never downloads implicitly", async (t) => {
  const { audit, root } = await createSemanticCase(t);
  const built = await buildSemanticIndex(audit.caseDir, { provider: fixtureProvider() });
  const mismatched = fixtureProvider();
  mismatched.identity = { ...mismatched.identity, revision: "different-revision" };
  await assert.rejects(semanticSearch(audit.caseDir, "parser timeout", {
    provider: mismatched, projectionDir: built.projectionDir,
  }), /does not match projection identity/i);
  const unavailable = await queryCase(audit.caseDir, "parser timeout", {
    mode: "semantic", modelHome: path.join(root, "empty-model-home"), projectionDir: built.projectionDir,
  });
  assert.equal(unavailable.modeEffective, "unavailable");
  assert.equal(unavailable.assessment.status, "UNAVAILABLE");
});

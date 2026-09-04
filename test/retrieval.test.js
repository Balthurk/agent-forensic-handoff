import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditSession, buildSemanticIndex, queryCase, searchCase,
} from "../src/index.js";

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function provider() {
  const patterns = [
    /parser|reader|lector/i,
    /timeout|deadline|time limit|agot[oó].*tiempo/i,
    /large|huge|enormous|gigante/i,
    /delegate|child|subagent|hijo/i,
    /evidence|proof|prueba/i,
    /garden|water|jard[ií]n/i,
  ];
  return {
    identity: {
      provider: "fixture-local", runtime: "deterministic-test-provider", runtimeVersion: "1",
      modelId: "fixture/retrieval", revision: "fixture-v1", modelDigest: "b".repeat(64),
      dimensions: patterns.length, dtype: "f32", pooling: "fixture", normalization: "l2-v1",
      license: "test-only", snapshotPath: null,
    },
    async embed(texts) {
      return texts.map((text) => {
        const raw = patterns.map((pattern) => pattern.test(text) ? 1 : 0);
        if (!raw.some(Boolean)) raw[raw.length - 1] = 0.01;
        const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
        return raw.map((value) => value / norm);
      });
    },
  };
}

async function makeCase(t, { incomplete = false } = {}) {
  const root = temporary(t, "afh-retrieval-");
  const source = path.join(root, "retrieval.jsonl");
  const records = [
    { timestamp: "2026-02-01T10:00:00Z", session_id: "retrieval", role: "user", content: "The parser exceeded its deadline while scanning an enormous session." },
    { timestamp: "2026-02-01T10:01:00Z", session_id: "retrieval", role: "assistant", content: "The garden needs water tomorrow." },
    { timestamp: "2026-02-01T10:02:00Z", session_id: "retrieval", role: "assistant", content: "The delegated child returned evidence for the repair." },
  ];
  const content = `${records.map(JSON.stringify).join("\n")}\n${incomplete ? "{broken-json\n" : ""}`;
  fs.writeFileSync(source, content);
  const audit = await auditSession(source, {
    harness: "generic", caseDir: path.join(root, "case"), workspace: root, includeChildren: false,
  });
  return { root, audit };
}

test("legacy lexical query remains an array while explicit retrieval modes are explained", async (t) => {
  const { audit } = await makeCase(t);
  const legacy = searchCase(audit.caseDir, "parser deadline", 25);
  assert.ok(Array.isArray(legacy));
  assert.equal(legacy.length, 1);

  const lexical = await queryCase(audit.caseDir, "parser deadline", { mode: "lexical", limit: 25 });
  assert.equal(lexical.modeEffective, "lexical");
  assert.equal(lexical.assessment.status, "VERIFIED_PRESENT");
  assert.equal(lexical.results[0].id, legacy[0].id);
  assert.ok(lexical.results[0].explanation.lexicalRank >= 1);
  assert.equal(lexical.receipt.semanticProjection, null);
});

test("semantic and hybrid recover paraphrases without degrading exact retrieval", async (t) => {
  const { audit } = await makeCase(t);
  const embeddingProvider = provider();
  const projection = await buildSemanticIndex(audit.caseDir, { provider: embeddingProvider });
  const paraphrase = "conversation reader timed out on a huge transcript";
  assert.equal(searchCase(audit.caseDir, paraphrase, 25).length, 0);

  const semantic = await queryCase(audit.caseDir, paraphrase, {
    mode: "semantic", provider: embeddingProvider, projectionDir: projection.projectionDir, limit: 5,
  });
  const hybrid = await queryCase(audit.caseDir, paraphrase, {
    mode: "hybrid", provider: embeddingProvider, projectionDir: projection.projectionDir, limit: 5,
  });
  assert.match(semantic.results[0].input_preview, /parser exceeded its deadline/i);
  assert.equal(hybrid.results[0].id, semantic.results[0].id);
  assert.ok(hybrid.results[0].explanation.vectorContribution > 0);

  const exactLexical = await queryCase(audit.caseDir, "parser deadline", { mode: "lexical", limit: 5 });
  const exactHybrid = await queryCase(audit.caseDir, "parser deadline", {
    mode: "hybrid", provider: embeddingProvider, projectionDir: projection.projectionDir, limit: 5,
  });
  assert.equal(exactHybrid.results[0].id, exactLexical.results[0].id);
});

test("semantic mode never silently falls back and explicit lexical fallback is visible", async (t) => {
  const { audit } = await makeCase(t);
  const unavailable = await queryCase(audit.caseDir, "parser deadline", { mode: "semantic" });
  assert.equal(unavailable.modeEffective, "unavailable");
  assert.equal(unavailable.assessment.status, "UNAVAILABLE");
  assert.equal(unavailable.results.length, 0);

  const fallback = await queryCase(audit.caseDir, "parser deadline", {
    mode: "semantic", allowLexicalFallback: true,
  });
  assert.equal(fallback.modeEffective, "lexical-fallback");
  assert.equal(fallback.results.length, 1);
  assert.match(fallback.receipt.fallbackReason, /projection/i);
});

test("structured filters apply to lexical and semantic candidates", async (t) => {
  const { audit } = await makeCase(t);
  const embeddingProvider = provider();
  const projection = await buildSemanticIndex(audit.caseDir, { provider: embeddingProvider });
  const lexical = await queryCase(audit.caseDir, "delegated child", {
    mode: "lexical", kind: "message.agent", actor: "PRIMARY_AGENT",
    from: "2026-02-01T10:01:30Z", to: "2026-02-01T10:03:00Z",
  });
  assert.equal(lexical.results.length, 1);
  const filteredOut = await queryCase(audit.caseDir, "delegated child", {
    mode: "semantic", provider: embeddingProvider, projectionDir: projection.projectionDir,
    kind: "message.user",
  });
  assert.equal(filteredOut.results.length, 0);
  assert.equal(filteredOut.assessment.status, "NOT_OBSERVED_IN_CAPTURED_EVIDENCE");
});

test("negative retrieval distinguishes complete from incomplete coverage", async (t) => {
  const complete = await makeCase(t);
  const absent = await queryCase(complete.audit.caseDir, "nonexistent control phrase", { mode: "lexical" });
  assert.equal(absent.assessment.status, "NOT_OBSERVED_IN_CAPTURED_EVIDENCE");
  assert.match(absent.assessment.note, /not verified absent/i);

  const incomplete = await makeCase(t, { incomplete: true });
  const uncertain = await queryCase(incomplete.audit.caseDir, "nonexistent control phrase", { mode: "lexical" });
  assert.equal(uncertain.assessment.status, "INCONCLUSIVE_COVERAGE");
  assert.ok(uncertain.assessment.gaps.some((gap) => /unparsed/i.test(gap)));
});


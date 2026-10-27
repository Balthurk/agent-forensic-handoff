import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runRetrievalBenchmark } from "../src/index.js";

function fixtureProvider() {
  const patterns = [
    /parser|reader|transcript|dialogue|conversation/i,
    /delegate|delegated|child agent|otro agente|devolvi[oó].*prueba/i,
    /database|connection pool|base de datos|conexiones/i,
    /rotate|revoke|credential|cambia.*clave|revoca/i,
    /stale search index|lookup|outdated|validate.*result/i,
    /context bundle|model limit|l[ií]mite de contexto|resumirlo|compressed/i,
    /./,
  ];
  return {
    identity: {
      provider: "fixture-local", runtime: "gold-test-provider", runtimeVersion: "1",
      modelId: "fixture/hybrid-gold", revision: "v1", modelDigest: "c".repeat(64),
      dimensions: patterns.length, dtype: "f32", pooling: "fixture", normalization: "l2-v1",
      license: "test-only", snapshotPath: null,
    },
    async embed(texts) {
      return texts.map((text) => {
        const raw = patterns.map((pattern, index) => index === patterns.length - 1 ? 0.001 : (pattern.test(text) ? 1 : 0));
        const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
        return raw.map((value) => value / norm);
      });
    },
  };
}

test("versioned hybrid gold set enforces retrieval, graph, evidence, and negative-state gates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afh-gold-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await runRetrievalBenchmark({ output: root, provider: fixtureProvider() });
  assert.equal(result.passed, true);
  assert.equal(result.metrics.exactRecallAtK, 1);
  assert.equal(result.metrics.semanticParaphraseRecallAt25, 1);
  assert.equal(result.metrics.hybridParaphraseRecallAt25, 1);
  assert.equal(result.metrics.graphAccuracy, 1);
  assert.equal(result.metrics.evidenceRefResolvability, 1);
  assert.equal(result.metrics.falseAbsenceCount, 0);
  assert.ok(fs.existsSync(path.join(root, "retrieval-benchmark-results.json")));
});

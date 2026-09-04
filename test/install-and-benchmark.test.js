import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installSkill } from "../src/install.js";
import { runBenchmark } from "../src/benchmark.js";

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("generic skill installation is idempotent and protects divergent content", async (t) => {
  const root = temporary(t, "afh-install-");
  const destination = path.join(root, "agent-forensic-handoff");
  const first = await installSkill({ target: "generic", explicitPath: destination });
  const second = await installSkill({ target: "generic", explicitPath: destination });
  assert.equal(first[0].status, "INSTALLED");
  assert.equal(second[0].status, "UNCHANGED");
  assert.ok(fs.existsSync(path.join(destination, "SKILL.md")));

  fs.appendFileSync(path.join(destination, "SKILL.md"), "\nlocal change\n");
  await assert.rejects(installSkill({ target: "generic", explicitPath: destination }), /different content/);
  const forced = await installSkill({ target: "generic", explicitPath: destination, force: true });
  assert.equal(forced[0].status, "INSTALLED");
  assert.doesNotMatch(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), /local change/);
});

test("deterministic benchmark gates pass on committed fixtures", async (t) => {
  const root = temporary(t, "afh-benchmark-test-");
  const result = await runBenchmark({ output: root, giantRecords: 100 });
  assert.equal(result.passed, true);
  assert.equal(result.metrics.parseAccounting, 1);
  assert.equal(result.metrics.evidenceRefResolvability, 1);
  assert.equal(result.metrics.unsupportedClaimRate, 0);
  assert.equal(result.metrics.giantSession.parseAccounting, true);
  assert.ok(result.metrics.giantSession.hotToSourceTokenRatio < 1);
  assert.equal(result.metrics.continuationSuccessRate, null);
});

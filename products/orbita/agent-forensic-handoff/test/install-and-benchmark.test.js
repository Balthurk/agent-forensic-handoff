import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {closeCommonStore} from '../src/common-store.js';
const fixtureRoot=path.join(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,'native-benchmarks');
fs.mkdirSync(fixtureRoot,{recursive:true});
test.after(()=>{if(fs.existsSync(process.env.ORBITA_POSTGRES_TEST_ROOT))throw new Error('NATIVE_OPERATIONAL_OUTPUT');closeCommonStore();});
import { installSkill } from "../src/install.js";
import { runBenchmark } from "../src/benchmark.js";

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(fixtureRoot, prefix));
  // Explicit native fixture/export bytes remain bound to this receipt.
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
  assert.equal(forced[0].status, "REPLACED_ATOMICALLY");
  assert.doesNotMatch(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), /local change/);
});

test("deterministic benchmark gates pass on committed fixtures", async (t) => {
  const root = temporary(t, "afh-benchmark-test-");
  const result = await runBenchmark({ output: root, caseRoot:path.join(process.env.ORBITA_POSTGRES_TEST_ROOT,"benchmark",path.basename(root)), giantRecords: 100 });
  assert.equal(result.passed, true);
  assert.equal(result.metrics.parseAccounting, 1);
  assert.equal(result.metrics.evidenceRefResolvability, 1);
  assert.equal(result.metrics.unsupportedClaimRate, 0);
  assert.equal(result.metrics.giantSession.parseAccounting, true);
  assert.ok(result.metrics.giantSession.hotToSourceTokenRatio < 1);
  assert.equal(result.metrics.continuationSuccessRate, null);
});

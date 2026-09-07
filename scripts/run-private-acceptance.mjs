import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const required = ["AFH_ACCEPTANCE_RUN", "AFH_READER_CLOSURE_BUILDER", "AFH_LEGACY_FIXTURES", "AFH_PRE03_PRODUCER_IDENTITY"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required for the private acceptance replay`);
}
const relativeTemp = path.relative(path.dirname(process.env.AFH_ACCEPTANCE_RUN), os.tmpdir());
if (relativeTemp.startsWith("..") || path.isAbsolute(relativeTemp)) {
  throw new Error("TEMP/TMP must be contained beside AFH_ACCEPTANCE_RUN");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = ["afh-01.test.mjs", "afh-02.test.mjs", "afh-03.test.mjs"]
  .map(name => path.join("test", "acceptance", name));
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

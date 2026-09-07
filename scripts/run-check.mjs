import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = fs.readdirSync(path.join(root, "test"), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".test.js"))
  .map(entry => path.join("test", entry.name))
  .sort();
tests.push(path.join("specification", "validate-package.test.mjs"));

const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

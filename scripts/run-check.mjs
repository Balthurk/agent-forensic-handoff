import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Keep the skill's tests separate from the independently qualified Orbita snapshot.
// Include nested acceptance tests and specification tests; do not silently skip them.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [];
function discover(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error(`TEST_LINK_REFUSED: ${filename}`);
    if (item.isDirectory()) discover(filename);
    else if (/\.test\.[cm]?js$/.test(item.name)) tests.push(filename);
  }
}
for (const directory of ['test', 'specification']) discover(path.join(root, directory));
tests.sort();
if (!tests.length) throw new Error('NO_TEST_FILES');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--list') {
  console.log(JSON.stringify(tests.map(filename => path.relative(root, filename).split(path.sep).join('/')), null, 2));
} else {
  if (args.length) throw new Error('Usage: node scripts/run-check.mjs [--list]');
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

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
  let env = { ...process.env };
  if (args.length === 2 && args[0] === '--prepared') {
    const preparation = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8'));
    if (preparation.status !== 'PREREQUISITES_PREPARED_NOT_ACCEPTANCE') throw new Error('INVALID_PREPARATION');
    env = { ...env, ...preparation.environment };
  } else if (args.length) throw new Error('Usage: node scripts/run-check.mjs [--list | --prepared /external/lab/PREPARATION.json]');
  const required = ['AFH_ACCEPTANCE_RUN', 'AFH_READER_CLOSURE_BUILDER', 'AFH_LEGACY_FIXTURES',
    'AFH_PRE03_PRODUCER_IDENTITY', 'AFH_PREGRAPH04_PRODUCER', 'AFH_SHM_HELPER_MANIFEST', 'AFH_SHM_HELPER_MANIFEST_SHA256'];
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error('ACCEPTANCE_PREREQUISITES_REQUIRED: ' + missing.join(', ') + '. See scripts/acceptance-support/README.md');
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

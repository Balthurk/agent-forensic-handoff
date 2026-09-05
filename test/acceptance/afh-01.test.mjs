import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { auditSession, readEvidence, showEvent, loadManifest, verifyCaseIntegrity } from '../../src/index.js';
import { runtimeSnapshot, snapshotStability, inspectNativeIdentity, assertNativeIdentityObservation } from '../../specification/contract-checks.mjs';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const registry = JSON.parse(fs.readFileSync(path.join(checkout, 'specification/contracts.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(checkout, 'specification/fixtures/critical-contracts.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
function rows(caseDir, sql) {
  const db = new DatabaseSync(path.join(caseDir, 'case.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); }
}
function createRun(id) {
  const base = process.env.AFH_ACCEPTANCE_RUN || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, id + '-'));
}
function fileInventory(root) {
  const result = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, 'Inventory must not silently traverse links');
      if (stat.isDirectory()) visit(file);
      else result.push({ path: path.relative(root, file), bytes: stat.size, sha256: hash(fs.readFileSync(file)) });
    }
  }
  visit(root);
  return result;
}
async function observeExecution(run, receipt, body) {
  const methods = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];
  const originals = Object.fromEntries(methods.map(method => [method, childProcess[method]]));
  const currentGitReads = [['rev-parse', 'HEAD'], ['branch', '--show-current'], ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']];
  const observed = { permitted_current_workspace_reads: [], other_process_calls: [], scope: 'All node:child_process APIs during this scenario body; real current-state Git reads allowed only inside this new RUN.' };
  for (const method of methods) childProcess[method] = function(command, args, options) {
    const cwd = path.resolve(options?.cwd || '.'), relative = path.relative(run, cwd);
    const allowed = method === 'spawnSync' && command === 'git' && currentGitReads.some(list => canonical(list) === canonical(args)) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    (allowed ? observed.permitted_current_workspace_reads : observed.other_process_calls).push({ method, command, args, cwd });
    if (!allowed) throw new Error('Unexpected process execution in forensic scenario');
    return originals[method].apply(this, arguments);
  };
  syncBuiltinESMExports();
  try { await body(); }
  finally {
    Object.assign(childProcess, originals); syncBuiltinESMExports();
    receipt.control_observations.NO_HISTORICAL_EXECUTION = observed;
  }
  assert.equal(observed.other_process_calls.length, 0);
}
async function observeLegacyCase(caseDir, receipt) {
  const before = fileInventory(caseDir), manifest = loadManifest(caseDir);
  const schema = rows(caseDir, 'SELECT schema_version FROM ingest_run');
  assert.equal(manifest.schemaVersion, 3);
  assert.ok(schema.length > 0);
  assert.ok(schema.every(row => row.schema_version === 3));
  const events = rows(caseDir, 'SELECT id FROM event ORDER BY id');
  assert.ok(events.length > 0);
  for (const event of events) assert.equal(showEvent(caseDir, event.id).id, event.id);
  const sources = rows(caseDir, 'SELECT id,canonical_sha256 FROM source');
  const records = rows(caseDir, 'SELECT * FROM source_record ORDER BY source_id,ordinal');
  const resolved = [];
  for (const record of records) {
    const source = sources.find(item => item.id === record.source_id);
    const uri = `afh://evidence/sha256/${source.canonical_sha256}/record/${record.ordinal}#bytes=${record.byte_offset}:${record.byte_length}`;
    const read = readEvidence(caseDir, uri), digest = hash(Buffer.from(read.text));
    assert.equal(digest, record.sha256);
    resolved.push({ uri, sha256: digest });
  }
  const integrity = await verifyCaseIntegrity(caseDir);
  assert.equal(integrity.passed, true);
  assert.deepEqual(fileInventory(caseDir), before);
  receipt.control_observations.LEGACY_SCHEMA_IDENTITY = { manifest_schema: 3, ingest_run: schema, sql_schema_sha256: hash(fs.readFileSync(path.join(checkout, 'src/schema.sql'))) };
  receipt.control_observations.READ_ONLY_INVENTORY = { before, after: fileInventory(caseDir), operations: ['showEvent', 'readEvidence', 'verifyCaseIntegrity'], event_count: events.length };
  receipt.control_observations.PROVENANCE_RESOLUTION = { case_dir: caseDir, records: resolved, integrity };
  receipt.control_observations.LOSS_GUARD = { record_count: records.length, source_count: sources.length, resolved_record_count: resolved.length, integrity };
}
async function scenario(t, id, body) {
  const run = createRun(id), contract = registry.scenarios.find(s => s.id === id);
  const before = runtimeSnapshot(checkout);
  const receipt = {
    scenario_id: id, role: 'COMPONENT_OBSERVATION', acceptance_eligible: false,
    input_class: 'SYNTHETIC', runtime_class: 'REAL_AFH', provider_class: 'NONE',
    evidence_kind: contract.evidence_kind, oracle_sha256: contract.oracle_ref.sha256,
    candidate_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
    node: process.version, platform: process.platform, arch: process.arch,
    runtime_before: before, runner_sha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    control_observations: {},
    required_checks: Object.fromEntries(contract.required_checks.map(k => [k, 'PENDING'])),
    classification_phase: 'PRECONDITION',
    scope_note: 'Direct frozen oracle; inherited checks need individually applicable evidence before FULL_ACCEPTANCE.'
  };
  try {
    assert.equal(hash(canonical(fixtures.cases[id])), contract.fixture_ref.sha256);
    assert.equal(hash(canonical(fixtures.oracles[id])), contract.oracle_ref.sha256);
    const fixture = fixtures.cases[id];
    assert.equal(hash(canonical(fixtures.datasets[fixture.dataset_ref.split('/').at(-1)])), fixture.dataset_sha256);
    receipt.required_checks.EXACT_INPUT_IDENTITY = 'PASS';
    receipt.control_observations.EXACT_INPUT_IDENTITY = { fixture_sha256: contract.fixture_ref.sha256, oracle_sha256: contract.oracle_ref.sha256, dataset_sha256: fixture.dataset_sha256, actual_hashes_matched: true };
    await observeExecution(run, receipt, () => body({ run, fixture, expected: fixtures.oracles[id].expected, receipt }));
    receipt.status = 'GREEN_BEHAVIOR';
  } catch (error) {
    receipt.status = error.code === 'NOT_IMPLEMENTED' ? 'NOT_IMPLEMENTED'
      : error.code === 'UNAVAILABLE' ? 'UNAVAILABLE'
      : error.code === 'ERR_ASSERTION' && receipt.classification_phase === 'BEHAVIOR' ? 'RED_BEHAVIOR' : 'ERROR_MECHANICAL_OR_PRECONDITION';
    receipt.reason = error.message;
    if (['NOT_IMPLEMENTED', 'UNAVAILABLE'].includes(receipt.status)) t.skip(receipt.status + ': ' + error.message);
    else throw error;
  } finally {
    receipt.runtime_after = runtimeSnapshot(checkout);
    receipt.stability = snapshotStability(before, receipt.runtime_after);
    if (!receipt.stability.stable) receipt.status = 'EVIDENCE_UNSTABLE';
    fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    t.diagnostic('Evidence: ' + path.join(run, 'receipt.json'));
    assert.equal(receipt.stability.stable, true, 'Owned runtime changed during observation');
  }
}

test('AFH-01-T01 native owner, separate grouping, content, actor and every record remain resolvable', async t => {
  await scenario(t, 'AFH-01-T01', async ({ run, fixture, expected, receipt }) => {
    const marker = 'Work assigned to the child.';
    const records = [
      { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: fixture.input.native_id, session_id: fixture.input.shared_id, cwd: '.', cli_version: 'synthetic-spec-v1' } },
      { timestamp: '2026-01-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', id: 'message-1', role: 'user', content: [{ type: 'input_text', text: marker }] } }
    ];
    const source = path.join(run, 'source.jsonl'), bytes = records.map(JSON.stringify).join('\n') + '\n';
    fs.writeFileSync(source, bytes, { flag: 'wx' });
    const sourceHash = hash(Buffer.from(bytes));
    const audit = await auditSession(source, { harness: 'codex', caseDir: path.join(run, 'case'), workspace: run, includeChildren: false });
    // Preconditions are checked separately from the behavior assertion.
    const integrity = await verifyCaseIntegrity(audit.caseDir);
    if (!integrity.passed) throw new Error('Acquisition integrity precondition failed');
    assert.equal(hash(fs.readFileSync(source)), sourceHash);
    receipt.source_sha256 = sourceHash;
    receipt.case_hash = audit.caseHash;
    receipt.required_checks.IMMUTABLE_SOURCE_INVENTORY = 'PASS';
    receipt.control_observations.IMMUTABLE_SOURCE_INVENTORY = { source, before_sha256: sourceHash, after_sha256: hash(fs.readFileSync(source)) };
    const acquired = rows(audit.caseDir, 'SELECT * FROM source_record ORDER BY ordinal');
    assert.equal(acquired.length, records.length);
    for (const row of acquired) {
      const uri = `afh://evidence/sha256/${sourceHash}/record/${row.ordinal}#bytes=${row.byte_offset}:${row.byte_length}`;
      const resolved = readEvidence(audit.caseDir, uri);
      // Legacy schema3 uses zero-based ordinals; v4 must not rewrite this convention.
      assert.equal(resolved.text, JSON.stringify(records[row.ordinal]));
      assert.equal(hash(Buffer.from(resolved.text)), row.sha256);
    }
    const message = rows(audit.caseDir, "SELECT e.*, a.kind AS actor_kind, a.role AS actor_role FROM event e JOIN actor a ON a.id=e.actor_id WHERE e.kind='message.user'");
    assert.equal(message.length, 1);
    assert.equal(message[0].actor_kind, 'HUMAN_USER');
    assert.equal(message[0].actor_role, 'user');
    const refs = rows(audit.caseDir, 'SELECT uri FROM evidence_ref');
    assert.ok(refs.length >= 2);
    assert.ok(refs.some(ref => readEvidence(audit.caseDir, ref.uri).text === JSON.stringify(records[1])));
    receipt.required_checks.LOSS_GUARD = 'PASS';
    receipt.required_checks.PROVENANCE_RESOLUTION = 'PASS';
    const repeat = await auditSession(source, { harness: 'codex', caseDir: audit.caseDir, workspace: run, includeChildren: false });
    assert.equal(repeat.reused, true);
    assert.equal(repeat.caseHash, audit.caseHash);
    receipt.legacy_snapshot_reuse = 'PASS';
    receipt.observed = await inspectNativeIdentity(audit.caseDir, expected);
    receipt.classification_phase = 'BEHAVIOR';
    assertNativeIdentityObservation(receipt.observed, expected);
    // A shared grouping alone cannot manufacture a causal parent link.
    assert.equal(rows(audit.caseDir, 'SELECT * FROM session_edge').length, 0);
    await observeLegacyCase(audit.caseDir, receipt);
    assert.equal(hash(fs.readFileSync(source)), sourceHash);
    receipt.control_observations.LEGACY_REGRESSION = { same_case_reused: repeat.reused, case_hash: repeat.caseHash, actor_kind: message[0].actor_kind, actor_role: message[0].actor_role, grouping_does_not_infer_parent: true };
  });
});

test('AFH-01-T03 an ambiguous alias keeps both origins and selects neither', async t => {
  await scenario(t, 'AFH-01-T03', async ({ run, fixture, expected, receipt }) => {
    const modulePath = path.join(checkout, 'src/archive/identity.js');
    if (!fs.existsSync(modulePath)) throw Object.assign(new Error('Native identity module is absent'), { code: 'NOT_IMPLEMENTED' });
    const identity = await import('../../src/archive/identity.js');
    if (typeof identity.resolveNativeAlias !== 'function') throw Object.assign(new Error('resolveNativeAlias is absent'), { code: 'NOT_IMPLEMENTED' });
    const entries = fixture.input.origins.map((origin, i) => {
      const raw = JSON.stringify({ harness: 'codex', origin_domain_id: origin, native_id: 'repeat' });
      const file = path.join(run, `origin-${i}.json`);
      fs.writeFileSync(file, raw, { flag: 'wx' });
      return { harness: 'codex', origin_domain_id: origin, native_id: 'repeat', evidence_refs: [{ path: file, sha256: hash(raw) }] };
    });
    const original = structuredClone(entries);
    receipt.classification_phase = 'BEHAVIOR';
    const result = identity.resolveNativeAlias(entries, fixture.input.alias);
    receipt.observed = result;
    assert.equal(result.error, expected.error);
    assert.equal(result.candidates.length, expected.candidates);
    assert.equal(result.selected, expected.selected);
    assert.deepEqual(entries, original);
    assert.deepEqual(result.candidates.map(c => c.origin_domain_id).sort(), fixture.input.origins.toSorted());
    for (const candidate of result.candidates) for (const ref of candidate.evidence_refs) assert.equal(hash(fs.readFileSync(ref.path)), ref.sha256);
    assert.deepEqual(identity.resolveNativeAlias([...entries].reverse(), fixture.input.alias), result);
    const exactIds = entries.map(entry => 'ses4-' + hash(JSON.stringify([entry.harness, entry.origin_domain_id, entry.native_id])));
    assert.deepEqual(result.candidates.map(candidate => candidate.id).sort(), exactIds.toSorted());
    assert.equal(new Set(exactIds).size, entries.length);
    assert.deepEqual(entries.map(identity.nativeSessionId), structuredClone(entries).map(identity.nativeSessionId));
    receipt.control_observations.IDENTITY_STABILITY = { exact_ids: exactIds, reordered_inputs_same_result: true, cloned_inputs_same_ids: true };
    receipt.control_observations.IMMUTABLE_SOURCE_INVENTORY = { before: original, after: entries, raw_hashes_reopened: true };
    receipt.control_observations.LOSS_GUARD = { input: original, result, no_selection: result.selected === null };
    receipt.control_observations.PROVENANCE_RESOLUTION = { candidates: result.candidates, every_ref_reopened_and_hashed: true };
    receipt.required_checks.LOSS_GUARD = 'PASS';
    receipt.required_checks.PROVENANCE_RESOLUTION = 'PASS';
  });
});

test('AFH-01-T19 reject reparse acquisition before reading target bytes', async t => {
  await scenario(t, 'AFH-01-T19', async ({ run, expected, receipt }) => {
    const allowed = path.join(run, 'allowed'), external = path.join(run, 'outside-authorized-root');
    fs.mkdirSync(allowed); fs.mkdirSync(external);
    const sentinel = path.join(external, 'outside-sentinel.jsonl');
    const content = '{"session_id":"outside","role":"user","content":"synthetic sentinel"}\n';
    fs.writeFileSync(sentinel, content, { flag: 'wx' });
    const link = path.join(allowed, 'linked');
    try { fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { throw Object.assign(new Error('Cannot create real reparse fixture: ' + error.code), { code: 'UNAVAILABLE' }); }
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    let externalReads = 0;
    const originals = {};
    for (const method of ['readFileSync', 'createReadStream', 'openSync']) {
      originals[method] = fs[method];
      fs[method] = function (file, ...args) {
        if (String(file).includes('outside-sentinel.jsonl')) externalReads++;
        return originals[method].call(this, file, ...args);
      };
    }
    const observations = [];
    try {
      for (const target of [link, path.join(link, 'outside-sentinel.jsonl')]) {
        let error = null;
        try { await auditSession(target, { harness: 'generic', caseDir: path.join(run, 'case-' + observations.length), workspace: allowed, includeChildren: false }); }
        catch (caught) { error = caught.code ?? null; }
        observations.push({ error, external_reads: externalReads });
      }
    } finally { for (const [method, original] of Object.entries(originals)) fs[method] = original; }
    receipt.observed = observations;
    assert.equal(fs.readFileSync(sentinel, 'utf8'), content);
    receipt.classification_phase = 'BEHAVIOR';
    for (const observed of observations) assert.deepEqual(observed, expected);
    assert.equal(fs.existsSync(path.join(run, 'case-0')), false);
    assert.equal(fs.existsSync(path.join(run, 'case-1')), false);
    receipt.control_observations.IMMUTABLE_SOURCE_INVENTORY = { source: sentinel, before_sha256: hash(content), after_sha256: hash(fs.readFileSync(sentinel)), external_reads: externalReads };
    // An ordinary authorized source supplies the real legacy-version/regression control.
    // Its historical command is inert corpus data and must never create this marker.
    const marker = path.join(run, 'historical-execution-marker');
    const command = process.execPath + ' -e ' + JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`);
    const ordinary = path.join(allowed, 'authorized.jsonl');
    const positiveRecords = [
      { type: 'session_meta', payload: { id: 'safety-control', cwd: run } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'historical-call', arguments: JSON.stringify({ command }) } }
    ];
    const positiveBytes = positiveRecords.map(JSON.stringify).join('\n') + '\n';
    fs.writeFileSync(ordinary, positiveBytes, { flag: 'wx' });
    const positive = await auditSession(ordinary, { harness: 'codex', caseDir: path.join(run, 'ordinary-case'), workspace: run, includeChildren: false });
    await observeLegacyCase(positive.caseDir, receipt);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(ordinary, 'utf8'), positiveBytes);
    const repeat = await auditSession(ordinary, { harness: 'codex', caseDir: positive.caseDir, workspace: run, includeChildren: false });
    assert.equal(repeat.reused, true);
    const publishedBefore = fileInventory(positive.caseDir);
    await assert.rejects(auditSession(path.join(link, 'outside-sentinel.jsonl'), { harness: 'generic', caseDir: positive.caseDir, workspace: allowed, includeChildren: false }), { code: 'INVALID_REQUEST' });
    const publishedAfter = fileInventory(positive.caseDir);
    assert.deepEqual(publishedAfter, publishedBefore, 'Rejection must preserve an already published case');
    assert.equal((await verifyCaseIntegrity(positive.caseDir)).passed, true);
    receipt.control_observations.LOSS_GUARD.rejected_over_existing_case = { before: publishedBefore, after: publishedAfter, integrity_passed: true };
    receipt.control_observations.LEGACY_REGRESSION = { ordinary_case: positive.caseDir, same_case_reused: true, historical_command: command, execution_marker_absent: true, negative_observations: observations, no_negative_case_published: true, prior_case_preserved_on_rejection: true };
    receipt.control_observations.IMMUTABLE_SOURCE_INVENTORY.ordinary = { path: ordinary, before_sha256: hash(positiveBytes), after_sha256: hash(fs.readFileSync(ordinary)) };
  });
});

test('PRODUCT01-P2-01 authorized junction preserves native child discovery and its limit', async t => {
  const run = createRun('PRODUCT01-P2-01');
  const before = runtimeSnapshot(checkout);
  const physical = path.join(run, 'physical-sessions'), home = path.join(run, 'codex-home');
  fs.mkdirSync(physical); fs.mkdirSync(home);
  const linked = path.join(home, 'sessions');
  fs.symlinkSync(physical, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, 'A real junction/symlink is required');
  const parent = '01a10000-0000-7000-8000-000000000011';
  const child = '01a10000-0000-7000-8000-000000000012';
  const sibling = '01a10000-0000-7000-8000-000000000013';
  const sourceRecords = {
    [parent]: [
      { timestamp: '2026-09-04T10:00:00Z', type: 'session_meta', payload: { id: parent, cwd: run } },
      { timestamp: '2026-09-04T10:00:01Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: parent, item: { type: 'McpToolCall', id: 'create-child', server: 'codex_app', tool: 'create_thread', status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ threadId: child, hostId: 'local' }) }], isError: false } } } }
    ],
    [child]: [
      { timestamp: '2026-09-04T10:00:02Z', type: 'session_meta', payload: { id: child, cwd: run } },
      { timestamp: '2026-09-04T10:00:03Z', type: 'event_msg', payload: { type: 'user_message', message: 'Actual synthetic child acquired through authorized junction.' } }
    ]
  };
  const secondCreation = structuredClone(sourceRecords[parent][1]);
  secondCreation.payload.item.id = 'create-sibling';
  secondCreation.payload.item.result.content[0].text = JSON.stringify({ threadId: sibling, hostId: 'local' });
  sourceRecords[parent].push(secondCreation);
  sourceRecords[sibling] = [{ timestamp: '2026-09-04T10:00:04Z', type: 'session_meta', payload: { id: sibling, cwd: run } }];
  const dbPath = path.join(home, 'state_5.sqlite'), state = new DatabaseSync(dbPath);
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at_ms INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT)');
  for (const [id, records] of Object.entries(sourceRecords)) {
    fs.writeFileSync(path.join(physical, id + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n', { flag: 'wx' });
    state.prepare('INSERT INTO threads VALUES (?,?,?)').run(id, path.join(linked, id + '.jsonl'), 1);
  }
  state.close();
  const sourceFiles = [...Object.keys(sourceRecords).map(id => path.join(physical, id + '.jsonl')), dbPath];
  const inventory = () => sourceFiles.map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) }));
  const report = { id: 'PRODUCT01-P2-01', input_class: 'SYNTHETIC', runtime_class: 'REAL_AFH', junction: linked, source_before: inventory(), runtime_before: before, observations: [] };
  try {
    for (const request of [
      { includeChildren: false, allowSymlink: true },
      { includeChildren: true, allowSymlink: true },
      { includeChildren: true, allowSymlink: true, maxChildSessions: 1 },
      { includeChildren: false }, { includeChildren: true }
    ]) {
      const observed = { request };
      try {
        const result = await auditSession(parent, { ...request, harness: 'codex', codexHome: home, workspace: run, caseDir: path.join(run, 'case-' + report.observations.length) });
        observed.native_ids = rows(result.caseDir, 'SELECT native_id FROM session ORDER BY native_id').map(row => row.native_id);
        observed.sources = rows(result.caseDir, 'SELECT native_uri FROM source ORDER BY native_uri');
        observed.records = rows(result.caseDir, 'SELECT * FROM source_record ORDER BY source_id,ordinal');
        observed.edges = rows(result.caseDir, 'SELECT * FROM session_edge');
        observed.integrity = await verifyCaseIntegrity(result.caseDir);
        observed.case_dir = result.caseDir;
        if (observed.sources.some(source => source.native_uri.includes(child))) {
          const refs = rows(result.caseDir, 'SELECT uri FROM evidence_ref');
          assert.ok(refs.some(ref => readEvidence(result.caseDir, ref.uri).text === JSON.stringify(sourceRecords[child][1])), 'Child bytes must be resolvable');
        }
      } catch (error) { observed.error = { code: error.code, message: error.message }; }
      report.observations.push(observed);
    }
    const [without, withChild, limited, defaultWithout, defaultWith] = report.observations;
    assert.equal(without.error, undefined);
    assert.equal(without.sources.length, 1);
    assert.ok(without.sources[0].native_uri.includes(parent));
    assert.equal(without.records.length, 3);
    assert.equal(without.integrity.passed, true);
    assert.equal(withChild.error, undefined, 'Explicit allowSymlink must survive child discovery');
    assert.deepEqual(withChild.native_ids, [parent, child, sibling]);
    assert.equal(withChild.sources.length, 3);
    assert.equal(withChild.records.length, 6);
    assert.equal(withChild.integrity.passed, true);
    assert.ok(withChild.edges.some(edge => edge.child_session_id === 'ses:codex:' + child && edge.evidence_event_id));
    assert.equal(limited.error, undefined);
    assert.equal(limited.sources.length, 2);
    assert.ok(limited.sources.some(source => source.native_uri.includes(child)));
    assert.equal(limited.sources.some(source => source.native_uri.includes(sibling)), false);
    assert.equal(limited.records.length, 5);
    assert.equal(limited.integrity.passed, true);
    assert.equal(defaultWithout.error?.code, 'INVALID_REQUEST');
    assert.equal(defaultWith.error?.code, 'INVALID_REQUEST');
    report.status = 'PASS';
  } catch (error) { report.status = error.code === 'ERR_ASSERTION' ? 'RED_BEHAVIOR' : 'ERROR_MECHANICAL_OR_PRECONDITION'; throw error; }
  finally {
    report.source_after = inventory();
    report.runtime_after = runtimeSnapshot(checkout);
    report.stability = snapshotStability(before, report.runtime_after);
    report.runner_sha256 = hash(fs.readFileSync(fileURLToPath(import.meta.url)));
    fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    t.diagnostic('Evidence: ' + path.join(run, 'report.json'));
    assert.deepEqual(report.source_after, report.source_before);
    assert.equal(report.stability.stable, true);
  }
});

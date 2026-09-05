import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { auditSession, readEvidence, verifyCaseIntegrity } from '../../src/index.js';
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
    await body({ run, fixture, expected: fixtures.oracles[id].expected, receipt });
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
  });
});

// Specification-phase probes. Calls the real existing runtime; contains no replacement implementation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimeSnapshot, snapshotStability, validateUnresolvedAssignment, inspectNativeIdentity, assertNativeIdentityObservation, inspectHumanDecisionCandidates, assertHumanDecisionCandidates } from './contract-checks.mjs';

const outIndex = process.argv.indexOf('--out');
if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error('--out requires a new private result directory');
const out = path.resolve(process.argv[outIndex + 1]);
if (fs.existsSync(out)) throw new Error('Refusing to overwrite a probe run; use a new --out directory');
fs.mkdirSync(out, { recursive: true });
const expectedRed = process.argv.includes('--expect-red');
const observeOnly=process.argv.includes('--observe');
if(expectedRed&&observeOnly)throw new Error('Choose --observe or --expect-red');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex < 0 ? null : process.argv[onlyIndex + 1];
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const product = JSON.parse(fs.readFileSync(path.join(checkout,'package.json'),'utf8'));
const registry=JSON.parse(fs.readFileSync(path.join(checkout,'specification/contracts.json'),'utf8'));
const actualHead = execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim();
const actualStatus = execFileSync('git',['status','--porcelain'],{cwd:checkout,encoding:'utf8'}).trim();
const runtimeBefore=runtimeSnapshot(checkout);
const runnerBefore=createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const helperBefore=createHash('sha256').update(fs.readFileSync(path.join(checkout,'specification/contract-checks.mjs'))).digest('hex');
const { auditSession, readHotContext, verifyCaseIntegrity } = await import('../src/index.js');
const { CaseDatabase } = await import('../src/database.js');
const { loopGroups } = await import('../src/reducers.js');
const sourceInventory = [];
const results = [];
const iso = i => new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString();
const meta = (id, shared = id) => ({ timestamp: iso(0), type: 'session_meta', payload: { id, session_id: shared, cwd: '.', cli_version: 'synthetic-spec-v1' } });
const user = (text, i = 1, id = 'message-1') => ({ timestamp: iso(i), type: 'response_item', payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] } });
const call = (id, i = 2, command = 'npm test') => ({ timestamp: iso(i), type: 'response_item', payload: { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd: command, workdir: '.' }) } });
const result = (id, code, i = 3) => ({ timestamp: iso(i), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify({ exit_code: code, output: code === 0 ? 'PASS synthetic validation' : 'FAIL synthetic validation' }) } });
const observed = (id, code, i, status) => ({ timestamp: iso(i), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id, command: 'npm test', status: status ?? (code === 0 ? 'completed' : 'failed'), exit_code: code, cwd: '.', stdout: `synthetic output ${id}`, duration: { secs: 1, nanos: 0 } } } });

function writeRecords(file, rows) { fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n'); }
async function capture(name, rows, options = {}) {
  const root = path.join(out, name); fs.mkdirSync(root);
  const file = path.join(root, 'source.jsonl'); writeRecords(file, rows);
  const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const audit = await auditSession(file, { harness: 'codex', caseDir: path.join(root, 'case'), workspace: root, includeChildren: false, ...options });
  const integrity = await verifyCaseIntegrity(audit.caseDir);
  assert.equal(integrity.passed, true, 'Probe acquisition must pass deep integrity before testing semantic behavior');
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before, 'Source must stay unchanged');
  sourceInventory.push({file:path.relative(out,file),sha256:before,case_hash:audit.caseHash});
  return { audit, root, sourceSha256: before };
}
function query(audit, sql, values = []) {
  const db = new DatabaseSync(path.join(audit.caseDir, 'case.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...values).map(x => ({ ...x })); } finally { db.close(); }
}
async function probe(id, description, fn) {
  if (only && only !== id) return;
  let observation;
  try {
    observation = await fn();
    const { actual, expected, check } = observation;
    try { check ? check(actual) : assert.deepEqual(actual, expected); }
    catch (error) {
      if (error.code !== 'ERR_ASSERTION') throw error;
      results.push({ id, description, status: 'RED_BEHAVIOR', actual, expected, evidence: observation.evidence, reason: error.message });
      return;
    }
    results.push({ id, description, status: 'GREEN_BEHAVIOR', actual, expected, evidence: observation.evidence });
  } catch (error) {
    results.push({ id, description, status: 'ERROR_MECHANICAL_OR_PRECONDITION', error: error.message, stack: error.stack });
  }
}

await probe('AFH-01-T01', 'Native child id wins over a shared grouping id', async () => {
  const { audit } = await capture('native-child', [meta('synthetic-child', 'synthetic-parent'), user('Work assigned to the child.')]);
  const expected={event_session:'synthetic-child',grouping:'synthetic-parent'};
  return {actual:await inspectNativeIdentity(audit.caseDir,expected),expected,check:value=>assertNativeIdentityObservation(value,expected),evidence:audit.caseDir};
});

await probe('AFH-05-T01', 'Delegation tool output remains recoverable as the task assignment', async () => {
  const marker = 'Implement the synthetic parser and preserve all failed attempts.';
  const envelope = `<codex_delegation><source_thread_id>synthetic-parent</source_thread_id><input>${marker}</input></codex_delegation>`;
  const { audit } = await capture('delegated-mission', [meta('synthetic-child'), { timestamp: iso(1), type: 'response_item', payload: { type: 'function_call_output', name: 'codex_app.create_thread', call_id: 'create-1', output: envelope } }]);
  const rows=query(audit,"SELECT object_json,evidence_refs_json FROM claim WHERE subject='mission' AND predicate='task_assignment'");
  const claim=rows[0] ? JSON.parse(rows[0].object_json) : null;
  const refs=rows[0] ? JSON.parse(rows[0].evidence_refs_json) : [];
  const provenance=await validateUnresolvedAssignment(audit.caseDir,claim,refs,{marker,recipient:'ses:codex:synthetic-child',origin:'ses:codex:synthetic-parent'});
  const actual={text_in_hot:readHotContext(audit.caseDir).includes(marker),assignments:rows.length,recipient:claim?.recipient_session_id??null,origin:claim?.origin_session_id??null,origin_status:claim?.origin_status??null,transmission_ref_count:refs.length,chain:claim?.authority_chain??[],provenance};
  return { actual, expected:{text_in_hot:true,assignments:1,recipient:'ses:codex:synthetic-child',origin:'ses:codex:synthetic-parent',origin_status:'UNRESOLVED',transmission_ref_count_min:1,chain_contains_resolvable_transmission:true},check:value=>{
    assert.equal(value.text_in_hot,true);assert.equal(value.assignments,1);assert.equal(value.recipient,'ses:codex:synthetic-child');assert.equal(value.origin,'ses:codex:synthetic-parent');assert.equal(value.origin_status,'UNRESOLVED');assert.ok(value.transmission_ref_count>=1);assert.ok(value.chain.length>=1);assert.equal(value.provenance.passed,true,JSON.stringify(value.provenance.problems));
  },evidence:audit.caseDir };
});

await probe('AFH-05-T03', 'Marker-free direct human decision is retained as an intention candidate', async () => {
  const marker = 'Usa SQLite y conserva las decisiones anteriores.';
  const { audit } = await capture('human-decision', [meta('synthetic-human'), user(marker)]);
  const expected={marker,session_id:'ses:codex:synthetic-human'};
  return {actual:await inspectHumanDecisionCandidates(audit.caseDir,expected),expected:{candidates_gte:1,decision_text_exact:marker,source_actor:'human'},check:rows=>assertHumanDecisionCandidates(rows,expected),evidence:audit.caseDir};
});

await probe('AFH-03-T01', 'Ten actual executions of the same command count ten', async () => {
  const { audit } = await capture('ten-executions', [meta('synthetic-executions'), ...Array.from({ length: 10 }, (_, i) => observed(`execution-${i}`, i === 9 ? 0 : 1, i + 1))]);
  return { actual: query(audit, 'SELECT COUNT(*) AS n FROM tool_execution')[0].n, expected: 10, evidence: audit.caseDir };
});

await probe('AFH-03-T04', 'The same callId in two native sessions cannot share an execution', async () => {
  const root = path.join(out, 'call-collision'); fs.mkdirSync(root);
  const codexHome = path.join(root, '.codex'); fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  const parent = '01a10000-0000-7000-8000-000000000001';
  const child = '01a10000-0000-7000-8000-000000000002';
  const parentPath = path.join(codexHome, 'sessions', `${parent}.jsonl`);
  const childPath = path.join(codexHome, 'sessions', `${child}.jsonl`);
  writeRecords(parentPath, [meta(parent), call('shared-call', 1), result('shared-call', 1, 2)]);
  writeRecords(childPath, [meta(child), call('shared-call', 3), result('shared-call', 0, 4)]);
  const originalHashes=[parentPath,childPath].map(file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  const state = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, updated_at_ms INTEGER); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT)');
  state.prepare('INSERT INTO threads VALUES(?,?,?)').run(parent, parentPath, 1);
  state.prepare('INSERT INTO threads VALUES(?,?,?)').run(child, childPath, 2);
  state.prepare('INSERT INTO thread_spawn_edges VALUES(?,?,?)').run(parent, child, 'spawned'); state.close();
  const audit = await auditSession(parent, { codexHome, out: path.join(root, 'archive'), workspace: root, includeChildren: true });
  assert.equal(audit.metrics.sources, 2); assert.equal((await verifyCaseIntegrity(audit.caseDir)).passed, true);
  for(const [i,file] of [parentPath,childPath].entries()){const hash=createHash('sha256').update(fs.readFileSync(file)).digest('hex');assert.equal(hash,originalHashes[i]);sourceInventory.push({file:path.relative(out,file),sha256:hash,case_hash:audit.caseHash});}
  const rows=query(audit,'SELECT session_id,status,exit_code FROM tool_execution ORDER BY session_id');
  return { actual:rows,expected:[{session_id:`ses:codex:${parent}`,status:'FAILED',exit_code:1},{session_id:`ses:codex:${child}`,status:'COMPLETED',exit_code:0}],evidence:audit.caseDir };
});

await probe('AFH-03-T07', 'Unknown validation status without exit code cannot certify PASS', async () => {
  const { audit } = await capture('unknown-validation', [meta('synthetic-unknown'), observed('unknown-execution', undefined, 1, 'unknown')]);
  const rows=query(audit,"SELECT v.status,v.evidence_event_id,e.session_id,t.id AS occurrence_id FROM validation v JOIN event e ON e.id=v.evidence_event_id JOIN tool_execution t ON t.result_event_id=e.id WHERE v.level='HISTORICAL'");
  return { actual:rows,expected:{rows:1,status:'UNKNOWN',session_id:'ses:codex:synthetic-unknown',occurrence_id_present:true,evidence_event_resolves:true},check:value=>{assert.equal(value.length,1,'Unknown validation must not disappear');assert.equal(value[0].status,'UNKNOWN');assert.equal(value[0].session_id,'ses:codex:synthetic-unknown');assert.ok(value[0].occurrence_id);assert.ok(value[0].evidence_event_id);assert.ok(query(audit,'SELECT uri FROM evidence_ref WHERE event_id=?',[value[0].evidence_event_id]).length>=1);},evidence:audit.caseDir };
});

await probe('AFH-03-T09', 'Loop terminal is the final recorded execution, not alphabetic MAX(status)', async () => {
  const { audit } = await capture('loop-terminal', [meta('synthetic-loop'), call('a', 1), result('a', 1, 2), call('b', 3), result('b', 1, 4), call('c', 5), result('c', 0, 6)]);
  const db = new CaseDatabase(path.join(audit.caseDir, 'case.sqlite'), { readOnly: true });
  let groups; try { groups = loopGroups(db); } finally { db.close(); }
  return {actual:groups,expected:{groups:1,attempts:3,terminal_status:'COMPLETED'},check:value=>{assert.equal(value.length,1);assert.equal(value[0].attempts,3);assert.equal(value[0].terminal_status,'COMPLETED');},evidence:audit.caseDir};
});

await probe('AFH-04-T07', 'Later equal command without same-target validation does not resolve a failure', async () => {
  const { audit } = await capture('unproven-supersession', [meta('synthetic-repair'), user('Repair parser-alpha; parser-beta is a separate artifact.'), call('old', 2, 'npm run check'), result('old', 1, 3), user('Now inspect parser-beta; parser-alpha remains unresolved.', 4, 'message-2'), call('new', 5, 'npm run check'), result('new', 0, 6), { timestamp: iso(7), type: 'event_msg', payload: { type: 'agent_message', message: 'Completed: check for parser-alpha.', phase: 'final' } }]);
  return { actual: query(audit, "SELECT COUNT(*) AS n FROM claim WHERE epistemic_status='CONTRADICTED'")[0].n, expected: 1, evidence: audit.caseDir };
});

await probe('AFH-03-T03', 'Two real messages with different native IDs are not deduplicated by equal text', async () => {
  const { audit } = await capture('real-repetition', [meta('synthetic-repeat'), user('Keep every attempt.', 1, 'real-message-a'), user('Keep every attempt.', 2, 'real-message-b')]);
  return { actual: query(audit, "SELECT COUNT(*) AS n FROM event WHERE kind='message.user' AND canonical=1")[0].n, expected: 2, evidence: audit.caseDir };
});

await probe('AFH-08-T01', 'Audit exposes real monotonic phase progress through its callback', async () => {
  const phases = [];
  const { audit } = await capture('phase-progress', [meta('synthetic-progress'), user('Capture this synthetic message.')], { onProgress: p => phases.push(p) });
  return { actual: phases.some(p => p.phase === 'normalization' && Number.isFinite(p.elapsed_ms)), expected: true, evidence: audit.caseDir };
});

for(const result of results){const s=registry.scenarios.find(s=>s.id===result.id);Object.assign(result,{role:'BASELINE_DIAGNOSTIC',acceptance_eligible:false,oracle_sha256:s.oracle_ref.sha256,coverage:s.probe_contract});}
const counts = Object.fromEntries(['RED_BEHAVIOR', 'GREEN_BEHAVIOR', 'ERROR_MECHANICAL_OR_PRECONDITION'].map(status => [status, results.filter(x => x.status === status).length]));
const runtimeAfter=runtimeSnapshot(checkout);
const stability=snapshotStability(runtimeBefore,runtimeAfter);
const headAfter=execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim();
const runnerAfter=createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const helperAfter=createHash('sha256').update(fs.readFileSync(path.join(checkout,'specification/contract-checks.mjs'))).digest('hex');
const stable=stability.stable&&actualHead===headAfter&&runnerBefore===runnerAfter&&helperBefore===helperAfter;
const report = { schema_version: 4, generated_at: new Date().toISOString(), product_version:product.version,candidate_head:actualHead,candidate_head_after:headAfter,candidate_dirty:actualStatus.length>0,runtime_inventory:runtimeBefore.files,runtime_inventory_after:runtimeAfter.files,runtime_tree_sha256:runtimeBefore.sha256,runtime_tree_sha256_after:runtimeAfter.sha256,candidate_stability:{...stability,stable},evidence_status:stable?'STABLE':'EVIDENCE_UNSTABLE',runner_sha256:runnerBefore,runner_sha256_after:runnerAfter,helper_sha256:helperBefore,helper_sha256_after:helperAfter,node:process.version,platform:process.platform,arch:process.arch,input_class:'SYNTHETIC',runtime_class:'REAL_AFH',provider_class:'NONE',model_identity:null,source_inventory:sourceInventory,corpus_sha256:createHash('sha256').update(JSON.stringify(sourceInventory)).digest('hex'),purpose:'Confirm behavior against actual runtime; not whole-product acceptance',mode:observeOnly?'OBSERVE_DIAGNOSTICS':expectedRed?'EXPECT_RED':'REQUIRE_GREEN',counts,results };
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report,runtime_inventory:undefined,runtime_inventory_after:undefined, results: results.map(({ id, status, actual, expected }) => ({ id, status, actual, expected })) }, null, 2));
process.exitCode = !stable || results.length===0 || counts.ERROR_MECHANICAL_OR_PRECONDITION > 0 || (!observeOnly&&(expectedRed ? counts.GREEN_BEHAVIOR > 0 : counts.RED_BEHAVIOR > 0)) ? 1 : 0;

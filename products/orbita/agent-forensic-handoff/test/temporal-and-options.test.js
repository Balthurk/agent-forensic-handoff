import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendGovernedTemporalFact,
  auditSession,
  getContinuationOptions,
  graphNeighbors,
  listEntities,
  parseApplyPatchText,
  parseCodexExecEnvelope,
  queryCase,
  reconstructStateAtMoment,
  traceWhy,
  verifyCaseIntegrity,
} from "../src/index.js";
import { CaseDatabase } from "../src/database.js";

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("parseApplyPatchText and parseCodexExecEnvelope unpack Codex tool payloads accurately", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/new-helper.js",
    "+export function helper() {",
    "+  return 42;",
    "+}",
    "*** Update File: src/existing.js",
    "@@ -1,3 +1,3 @@",
    "-const oldVal = 1;",
    "+const newVal = 2;",
    "*** Delete File: src/obsolete.js",
    "*** End Patch",
  ].join("\n");

  const artifacts = parseApplyPatchText(patch);
  assert.equal(artifacts.length, 3);
  assert.equal(artifacts[0].path, "src/new-helper.js");
  assert.equal(artifacts[0].operation, "CREATE");
  assert.match(artifacts[0].content, /export function helper/);
  assert.equal(artifacts[1].path, "src/existing.js");
  assert.equal(artifacts[1].operation, "UPDATE");
  assert.match(artifacts[1].diff, /\+const newVal = 2;/);
  assert.equal(artifacts[2].path, "src/obsolete.js");
  assert.equal(artifacts[2].operation, "DELETE");

  const execRaw = [
    "Chunk ID: chk-991a",
    "Wall time: 1.25 seconds",
    "Process exited with code 0",
    "Original token count: 140",
    "Output:",
    "TAP version 13",
    "ok 1 - suite passed",
  ].join("\n");

  const env = parseCodexExecEnvelope(execRaw);
  assert.equal(env.exitCode, 0);
  assert.equal(env.durationMs, 1250);
  assert.equal(env.chunkId, "chk-991a");
  assert.match(env.stdout, /ok 1 - suite passed/);
});

test("component probes: preserves repeated messages across turns/IDs, isolates same callId across sessions, applies temporal filter before limit, and scopes facts by session", async (t) => {
  const root = temporary(t, "afh-probes-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  const rollout = path.join(root, "probes.jsonl");
  const lines = [
    { timestamp: "2026-10-12T10:00:00Z", session_id: "sess-alpha", id: "msg-u1", role: "user", content: "Repeat check alphabeta." },
    { timestamp: "2026-10-12T10:00:01Z", session_id: "sess-alpha", type: "tool_call", tool_name: "shell", call_id: "shared-call-1", input: { command: "echo alpha" } },
    { timestamp: "2026-10-12T10:00:02Z", session_id: "sess-alpha", type: "tool_result", tool_name: "shell", call_id: "shared-call-1", output: "alpha", exit_code: 0 },
    { timestamp: "2026-10-12T10:00:03Z", session_id: "sess-alpha", id: "msg-u2", role: "user", content: "Repeat check alphabeta." },
    { timestamp: "2026-10-12T10:00:04Z", session_id: "sess-beta", id: "msg-b1", role: "user", content: "Second session directive." },
    { timestamp: "2026-10-12T10:00:05Z", session_id: "sess-beta", type: "tool_call", tool_name: "shell", call_id: "shared-call-1", input: { command: "echo beta" } },
    { timestamp: "2026-10-12T10:00:06Z", session_id: "sess-beta", type: "tool_result", tool_name: "shell", call_id: "shared-call-1", output: "beta", exit_code: 0 },
  ];

  for (let i = 1; i <= 5; i += 1) {
    lines.push({
      timestamp: new Date(Date.UTC(2026, 9, 12, 10, 1, i)).toISOString(),
      session_id: "sess-alpha",
      id: `early-${i}`,
      role: "user",
      content: `Historical milestone directive number ${i} must preserve audit trail.`,
    });
  }
  for (let i = 6; i <= 35; i += 1) {
    lines.push({
      timestamp: new Date(Date.UTC(2026, 9, 12, 10, 5, i)).toISOString(),
      session_id: "sess-alpha",
      id: `late-${i}`,
      role: "user",
      content: `Later milestone directive number ${i} must preserve audit trail.`,
    });
  }

  fs.writeFileSync(rollout, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const res = await auditSession(rollout, {
    harness: "generic",
    caseDir: path.join(root, "case"),
    workspace,
    includeChildren: false,
  });

  const db = new CaseDatabase(path.join(res.caseDir, "case.sqlite"), { readOnly: true });
  try {
    const repeatedMsgs = db.all(
      "SELECT id, canonical, record_ordinal FROM event WHERE kind='message.user' AND input_preview LIKE '%Repeat check alphabeta%'",
    );
    assert.equal(repeatedMsgs.length, 2);
    assert.equal(repeatedMsgs[0].canonical, 1);
    assert.equal(repeatedMsgs[1].canonical, 1);

    const tools = db.all("SELECT id, session_id, command_text, status FROM tool_execution ORDER BY session_id");
    assert.equal(tools.length, 2, "Expected 2 distinct tool_execution records across the 2 sessions");
    assert.notEqual(tools[0].session_id, tools[1].session_id);
  } finally {
    db.close();
  }

  const historicalQuery = await queryCase(res.caseDir, "milestone directive", {
    mode: "lexical",
    asOf: 11,
    limit: 5,
  });
  assert.equal(
    historicalQuery.temporalMatches.facts.length,
    5,
    `Expected 5 historical facts at asOf=11, got ${historicalQuery.temporalMatches.facts.length}`,
  );
  assert.equal(historicalQuery.results.length, 5);

  const nonexistentSessionQuery = await queryCase(res.caseDir, "directive", {
    mode: "lexical",
    session: "nonexistent-session-999",
    limit: 25,
  });
  assert.equal(nonexistentSessionQuery.results.length, 0);
  assert.equal(nonexistentSessionQuery.temporalMatches.facts.length, 0);
  assert.equal(nonexistentSessionQuery.temporalMatches.entities.length, 0);
});

test("2D bi-temporal consumer: distinguishes valid_at vs known_at, preserves both versions and evidence, and rejects manual authority", async (t) => {
  const root = temporary(t, "afh-u2-bitemporal-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  const rollout = path.join(root, "u2-session.jsonl");
  const records = [
    {
      timestamp: "2026-10-10T10:00:00.000Z",
      session_id: "u2-sess",
      id: "ev-1",
      role: "user",
      content: "Initial configuration: service port is 8080.",
    },
    {
      timestamp: "2026-10-10T12:00:00.000Z",
      session_id: "u2-sess",
      id: "ev-2",
      role: "assistant",
      content: "Correction observed at 12:00Z: service port switched to 9090 effective at 11:00Z.",
    },
  ];
  fs.writeFileSync(rollout, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const audit = await auditSession(rollout, {
    harness: "generic",
    caseDir: path.join(root, "case"),
    workspace,
    includeChildren: false,
  });

  const db = new CaseDatabase(path.join(audit.caseDir, "case.sqlite"), { readOnly: true });
  let ev1;
  let ev2;
  try {
    ev1 = db.get("SELECT id FROM event WHERE record_ordinal = 0");
    ev2 = db.get("SELECT id FROM event WHERE record_ordinal = 1");
  } finally {
    db.close();
  }

  const v1 = appendGovernedTemporalFact(audit.caseDir, {
    sourceEventId: ev1.id,
    subjectId: "config:service_port",
    subjectKind: "CONFIGURATION",
    predicate: "SERVICE_PORT",
    factText: "service_port = 8080",
    validAt: "2026-10-10T10:00:00.000Z",
    knownAt: "2026-10-10T10:00:00.000Z",
  });
  assert.ok(v1.id);
  assert.equal(v1.evidenceRefs.length, 1);

  const v2 = appendGovernedTemporalFact(audit.caseDir, {
    sourceEventId: ev2.id,
    subjectId: "config:service_port",
    subjectKind: "CONFIGURATION",
    predicate: "SERVICE_PORT",
    factText: "service_port = 9090",
    validAt: "2026-10-10T11:00:00.000Z",
    knownAt: "2026-10-10T12:00:00.000Z",
  });
  assert.equal(v2.supersededFactId, v1.id);

  const stateKnown1130 = reconstructStateAtMoment(audit.caseDir, {
    validAt: "2026-10-10T11:30:00.000Z",
    knownAt: "2026-10-10T11:30:00.000Z",
  });
  const portFacts1130 = stateKnown1130.facts.filter((f) => f.predicate === "SERVICE_PORT");
  assert.equal(portFacts1130.length, 1);
  assert.equal(portFacts1130[0].id, v1.id);
  assert.equal(portFacts1130[0].effective_validity_status, "VIGENTE");

  const stateKnown1230 = reconstructStateAtMoment(audit.caseDir, {
    validAt: "2026-10-10T11:30:00.000Z",
    knownAt: "2026-10-10T12:30:00.000Z",
  });
  const portFacts1230 = stateKnown1230.facts.filter((f) => f.predicate === "SERVICE_PORT");
  assert.equal(portFacts1230.length, 2);
  assert.equal(portFacts1230.find((f) => f.id === v1.id).effective_validity_status, "SUPERSEDED");
  assert.equal(portFacts1230.find((f) => f.id === v2.id).effective_validity_status, "VIGENTE");

  const stateValid1030Known1230 = reconstructStateAtMoment(audit.caseDir, {
    validAt: "2026-10-10T10:30:00.000Z",
    knownAt: "2026-10-10T12:30:00.000Z",
  });
  const portFacts1030 = stateValid1030Known1230.facts.filter((f) => f.predicate === "SERVICE_PORT");
  assert.equal(portFacts1030.length, 1);
  assert.equal(portFacts1030[0].id, v1.id);
  assert.equal(portFacts1030[0].effective_validity_status, "VIGENTE");

  assert.throws(
    () =>
      appendGovernedTemporalFact(audit.caseDir, {
        sourceEventId: ev1.id,
        predicate: "SERVICE_PORT",
        factText: "service_port = 7777",
        authority: "manual-override",
      }),
    /MANUAL_AUTHORITY_REJECTED/,
  );
  assert.throws(
    () =>
      appendGovernedTemporalFact(audit.caseDir, {
        sourceEventId: ev1.id,
        predicate: "SERVICE_PORT",
        factText: "service_port = 7777",
        evidenceRefs: ["afh://evidence/sha256/0000/record/999#bytes=0:10"],
      }),
    /Evidence URI is not registered|MANUAL_AUTHORITY_REJECTED/,
  );
});

test("bi-temporal graph tracks vigente vs stale state, rollback invalidation, --as-of time travel, why tracing, rerankers, and continuation options", async (t) => {
  const root = temporary(t, "afh-bitemporal-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "cache.js"), "export const mode = 'lru-stream';\n");

  const rolloutPath = path.join(root, "rollout-codex-full.jsonl");
  const records = [
    {
      timestamp: "2026-10-14T01:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-bitemporal-001",
        session_id: "codex-bitemporal-001",
        cwd: workspace,
        model: "gpt-5-codex",
      },
    },
    {
      timestamp: "2026-10-14T01:00:01.000Z",
      type: "world_state",
      payload: {
        full: true,
        state: {
          model: "gpt-5-codex",
          collaboration_mode: { mode: "code" },
          personality: "pragmatic",
        },
      },
    },
    {
      timestamp: "2026-10-14T01:00:02.000Z",
      type: "turn_context",
      payload: { turn_id: "turn_1", cwd: workspace, model: "gpt-5-codex" },
    },
    {
      timestamp: "2026-10-14T01:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Implement the cache module in src/cache.js. You must not use external native addons and must preserve deterministic eviction.",
          },
        ],
      },
    },
    {
      timestamp: "2026-10-14T01:00:04.000Z",
      type: "event_msg",
      payload: {
        type: "agent_reasoning",
        text: "The user needs a cache in src/cache.js without native addons. I will start with an in-memory Map buffer.",
      },
    },
    {
      timestamp: "2026-10-14T01:00:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Decision: use an unbounded Map cache because initial prototypes are small.",
          },
        ],
      },
    },
    {
      timestamp: "2026-10-14T01:00:06.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "call_patch_1",
        call_id: "call_patch_1",
        name: "apply_patch",
        input: [
          "*** Begin Patch",
          "*** Add File: src/cache.js",
          "+export class UnboundedCache {}",
          "*** End Patch",
        ].join("\n"),
      },
    },
    {
      timestamp: "2026-10-14T01:00:07.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_patch_1",
        output: "Success. Updated the following files:\nA src/cache.js",
      },
    },
    {
      timestamp: "2026-10-14T01:00:08.000Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn_1",
        item: {
          id: "cmd_test_1",
          type: "CommandExecution",
          command: ["npm", "test"],
          status: "completed",
          exit_code: 0,
          aggregated_output: "pass 1 - initial cache test passed",
        },
      },
    },
    {
      timestamp: "2026-10-14T01:01:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn_2", cwd: workspace, model: "gpt-5-codex" },
    },
    {
      timestamp: "2026-10-14T01:01:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Try experimental unsafe pointer cache.",
      },
    },
    {
      timestamp: "2026-10-14T01:01:02.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Decision: use experimental unsafe buffer pool.",
      },
    },
    {
      timestamp: "2026-10-14T01:01:05.000Z",
      type: "event_msg",
      payload: {
        type: "thread_rolled_back",
        num_turns: 1,
      },
    },
    {
      timestamp: "2026-10-14T01:02:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn_3", cwd: workspace, model: "gpt-5-codex" },
    },
    {
      timestamp: "2026-10-14T01:02:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Switch to bounded LRU streaming cache and update the plan.",
      },
    },
    {
      timestamp: "2026-10-14T01:02:02.000Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn_3",
        item: {
          id: "plan_1",
          type: "Plan",
          text: "1. Replace unbounded Map with bounded LRU in src/cache.js\n2. Re-run npm test to verify memory bounds",
        },
      },
    },
    {
      timestamp: "2026-10-14T01:02:03.000Z",
      type: "event_msg",
      payload: {
        type: "agent_reasoning",
        text: "Unbounded Map risks OOM on large rollouts; I will pivot to a bounded LRU streaming cache while respecting the no-native-addons constraint.",
      },
    },
    {
      timestamp: "2026-10-14T01:02:04.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Decision: switch to a bounded LRU streaming cache instead of an unbounded Map because large rollouts exceed memory.",
      },
    },
    {
      timestamp: "2026-10-14T01:02:05.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "call_patch_2",
        call_id: "call_patch_2",
        name: "apply_patch",
        input: [
          "*** Begin Patch",
          "*** Update File: src/cache.js",
          "@@ -1 +1 @@",
          "-export class UnboundedCache {}",
          "+export const mode = 'lru-stream';",
          "*** End Patch",
        ].join("\n"),
      },
    },
    {
      timestamp: "2026-10-14T01:02:06.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_patch_2",
        output: "Success. Updated the following files:\nM src/cache.js",
      },
    },
    {
      timestamp: "2026-10-14T01:02:07.000Z",
      type: "event_msg",
      payload: {
        type: "exited_review_mode",
        turn_id: "turn_3",
        user_facing_hint: "Review completed",
        review_output: {
          overall_correctness: "correct",
          summary: "LRU cache implementation is clean, but tests must be re-run after the latest patch.",
        },
      },
    },
  ];

  fs.writeFileSync(rolloutPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const auditResult = await auditSession(rolloutPath, {
    harness: "codex",
    caseDir: path.join(root, "case"),
    workspace,
    includeChildren: false,
  });

  const integrity = await verifyCaseIntegrity(auditResult.caseDir);
  assert.equal(integrity.passed, true, `Integrity failed: ${JSON.stringify(integrity.findings.filter((f) => !f.ok))}`);

  const latestState = reconstructStateAtMoment(auditResult.caseDir);
  assert.ok(latestState.counts.vigenteFacts >= 4);
  assert.ok(latestState.counts.staleFacts >= 3);

  const staleValidation = latestState.staleFacts.find((f) => f.predicate === "VALIDATION_STATE");
  assert.ok(staleValidation);
  assert.equal(staleValidation.effective_validity_status, "STALE");
  assert.equal(staleValidation.valid_from_ordinal, 8);
  assert.equal(staleValidation.invalid_at_ordinal, 18);

  const decOrd5 = latestState.decisions.find((d) => d.valid_from_ordinal === 5);
  const decOrd11 = latestState.decisions.find((d) => d.valid_from_ordinal === 11);
  const decOrd17 = latestState.decisions.find((d) => d.valid_from_ordinal === 17);
  assert.equal(decOrd5.effective_validity_status, "SUPERSEDED");
  assert.equal(decOrd5.superseded_by_id, decOrd17.id);
  assert.equal(decOrd11.effective_validity_status, "ROLLED_BACK");
  assert.equal(decOrd17.effective_validity_status, "VIGENTE");

  const stateAtOrd9 = reconstructStateAtMoment(auditResult.caseDir, { asOf: 9 });
  const valAtOrd9 = stateAtOrd9.vigenteFacts.find((f) => f.predicate === "VALIDATION_STATE");
  assert.ok(valAtOrd9);
  assert.equal(valAtOrd9.effective_validity_status, "VIGENTE");
  const dec5AtOrd9 = stateAtOrd9.decisions.find((d) => d.valid_from_ordinal === 5);
  assert.equal(dec5AtOrd9.effective_validity_status, "VIGENTE");

  const whyPivot = traceWhy(auditResult.caseDir, decOrd17.id);
  assert.equal(whyPivot.found, true);
  assert.equal(whyPivot.target.targetKind, "DECISION");
  assert.ok(whyPivot.inferredReasoningAtMoment.some((r) => /Unbounded Map risks OOM/i.test(r.reasoning)));
  assert.ok(whyPivot.knownEmpiricalFactsAtMoment.some((f) => f.predicate === "ENFORCES_CONSTRAINT"));

  const patchEvent = latestState.vigenteFacts.find((f) => f.predicate === "ARTIFACT_STATE");
  const whyPatch = traceWhy(auditResult.caseDir, patchEvent.source_event_id);
  assert.equal(whyPatch.found, true);
  assert.ok(whyPatch.causalChain.some((ev) => ev.kind === "reasoning.summary" && ev.record_ordinal === 16));
  assert.ok(whyPatch.causalChain.some((ev) => ev.kind === "message.user" && ev.record_ordinal === 14));

  const entities = listEntities(auditResult.caseDir);
  assert.ok(entities.some((e) => e.entity_kind === "ARTIFACT" && e.canonical_name === "src/cache.js"));
  assert.ok(entities.some((e) => e.entity_kind === "CONSTRAINT" && /native addons/i.test(e.canonical_name)));
  assert.ok(entities.some((e) => e.entity_kind === "DESIGN_CONCEPT"));

  const options = getContinuationOptions(auditResult.caseDir);
  assert.ok(options.length >= 2);
  assert.ok(options.some((o) => o.strategy === "REVERIFY_STALE_OR_CONTRADICTED" && o.recommended === true));
  assert.ok(options.some((o) => o.strategy === "PRIMARY_CONTINUATION"));
  assert.ok(options.some((o) => o.strategy === "GUARDRAIL_AVOID_DEAD_ENDS" && o.recommended === false));

  const qMmr = await queryCase(auditResult.caseDir, "cache", {
    mode: "lexical",
    rerank: "mmr",
    validity: "vigente",
  });
  assert.equal(qMmr.rerank, "mmr");
  assert.ok(qMmr.results.length > 0);
  assert.ok(qMmr.results.every((r) => r.temporal_validity === "VIGENTE"));
  assert.ok(qMmr.temporalMatches.entities.length > 0);

  const qMentions = await queryCase(auditResult.caseDir, "cache", {
    mode: "lexical",
    rerank: "mentions",
  });
  assert.equal(qMentions.results[0].explanation.reranker, "episode-mentions");

  const qDistance = await queryCase(auditResult.caseDir, "cache", {
    mode: "lexical",
    rerank: "node-distance",
    centerNodeId: decOrd17.source_event_id,
  });
  assert.equal(qDistance.results[0].explanation.reranker, "node-distance");

  const entityNode = entities.find((e) => e.entity_kind === "ARTIFACT");
  const entNeighbors = graphNeighbors(auditResult.caseDir, entityNode.id, { hops: 1 });
  assert.ok(entNeighbors.visitedCount >= 2);
});

test("candidate-v3 regressions: distinct failed/succeeded executions, same-ID fact history, temporal tamper detection, provenance/knownAt/CORROBORATED guards, pre-session 2020 cut, cross-session isolation, and U2 merge", async (t) => {
  const root = temporary(t, "afh-v3-regressions-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  // 1. Rollout with two executions of the exact same command in different turns/IDs (first fails, second succeeds)
  // plus two sessions for cross-session supersession testing
  const rollout = path.join(root, "v3-rollout.jsonl");
  const records = [
    {
      timestamp: "2026-10-12T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "sess-v3-1", session_id: "sess-v3-1", cwd: workspace, model: "gpt-5-codex" },
    },
    {
      timestamp: "2026-10-12T10:01:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn_1", cwd: workspace, model: "gpt-5-codex" },
    },
    {
      timestamp: "2026-10-12T10:01:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Run the test suite now." },
    },
    {
      timestamp: "2026-10-12T10:01:05.000Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn_1",
        item: {
          id: "cmd_exec_fail_1",
          type: "CommandExecution",
          command: ["npm", "test"],
          status: "failed",
          exit_code: 1,
          aggregated_output: "FAIL: 1 test failed",
        },
      },
    },
    {
      timestamp: "2026-10-12T10:02:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn_2", cwd: workspace, model: "gpt-5-codex" },
    },
    {
      timestamp: "2026-10-12T10:02:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Re-run the test suite after fix." },
    },
    {
      timestamp: "2026-10-12T10:02:05.000Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn_2",
        item: {
          id: "cmd_exec_pass_2",
          type: "CommandExecution",
          command: ["npm", "test"],
          status: "completed",
          exit_code: 0,
          aggregated_output: "PASS: all tests passed",
        },
      },
    },
    {
      timestamp: "2026-10-12T10:03:00.000Z",
      type: "session_meta",
      payload: { id: "sess-v3-2", session_id: "sess-v3-2", cwd: workspace, model: "gpt-5-codex" },
    },
    {
      timestamp: "2026-10-12T10:03:05.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Secondary session checking configuration." },
    },
  ];

  fs.writeFileSync(rollout, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const audited = await auditSession(rollout, {
    harness: "codex",
    caseDir: path.join(root, "case"),
    workspace,
    includeChildren: false,
  });

  // Finding 1: Both failed and succeeded executions of "npm test" must survive in tool_execution
  const db = new CaseDatabase(path.join(audited.caseDir, "case.sqlite"), { readOnly: true });
  let evTurn1;
  let evTurn2;
  let evSess2;
  let evTurn1Uri;
  try {
    const tools = db.all("SELECT * FROM tool_execution WHERE command_text = 'npm test' ORDER BY started_at, ended_at, id");
    assert.equal(tools.length, 2, `Expected 2 distinct tool_execution rows for 'npm test', got ${tools.length}`);
    assert.equal(tools[0].status, "FAILED");
    assert.equal(tools[0].exit_code, 1);
    assert.equal(tools[1].status, "COMPLETED");
    assert.equal(tools[1].exit_code, 0);

    evTurn1 = db.get("SELECT * FROM event WHERE record_ordinal = 2");
    evTurn2 = db.get("SELECT * FROM event WHERE record_ordinal = 5");
    evSess2 = db.get("SELECT * FROM event WHERE record_ordinal = 8");
    evTurn1Uri = db.get("SELECT uri FROM evidence_ref WHERE event_id = $id LIMIT 1", { id: evTurn1.id }).uri;
  } finally {
    db.close();
  }

  // Finding 5: Queries prior to the first event (e.g. 2020 on a 2026 case) must return 0 facts, 0 decisions, and 0 entities
  const preSessionState = reconstructStateAtMoment(audited.caseDir, { asOf: "2020-01-01T00:00:00Z" });
  assert.equal(preSessionState.counts.vigenteFacts, 0);
  assert.equal(preSessionState.counts.staleFacts, 0);
  assert.equal(preSessionState.counts.decisions, 0);
  assert.equal(preSessionState.counts.entities, 0, `Expected 0 entities at 2020-01-01, got ${preSessionState.counts.entities}`);
  assert.equal(preSessionState.entities.length, 0);

  const preSessionEntities = listEntities(audited.caseDir, { asOf: "2020-01-01T00:00:00Z" });
  assert.equal(preSessionEntities.length, 0);

  const preSessionQuery = await queryCase(audited.caseDir, "test", { mode: "lexical", asOf: "2020-01-01T00:00:00Z" });
  assert.equal(preSessionQuery.results.length, 0);
  assert.equal(preSessionQuery.temporalMatches.entities.length, 0);
  assert.equal(preSessionQuery.temporalMatches.facts.length, 0);

  // Finding 2: Two calls to appendGovernedTemporalFact with the SAME id and different values must preserve both versions in the ledger
  const firstVer = appendGovernedTemporalFact(audited.caseDir, {
    id: "custom-fact-id-1",
    sourceEventId: evTurn1.id,
    subjectId: "cfg:mode",
    subjectKind: "CONFIGURATION",
    predicate: "OPERATING_MODE",
    factText: "mode = safe-draft",
    value: { mode: "safe-draft" },
    validAt: "2026-10-12T10:01:01.000Z",
    knownAt: "2026-10-12T10:01:01.000Z",
  });
  const secondVer = appendGovernedTemporalFact(audited.caseDir, {
    id: "custom-fact-id-1",
    sourceEventId: evTurn2.id,
    subjectId: "cfg:mode",
    subjectKind: "CONFIGURATION",
    predicate: "OPERATING_MODE",
    factText: "mode = production",
    value: { mode: "production" },
    validAt: "2026-10-12T10:02:01.000Z",
    knownAt: "2026-10-12T10:02:01.000Z",
  });
  assert.equal(firstVer.id, "custom-fact-id-1");
  assert.notEqual(secondVer.id, firstVer.id);
  assert.equal(secondVer.supersededFactId, firstVer.id);

  const afterBoth = reconstructStateAtMoment(audited.caseDir);
  const modeFacts = afterBoth.facts.filter((f) => f.predicate === "OPERATING_MODE");
  assert.equal(modeFacts.length, 2, "Both versions of custom-fact-id-1 must remain in temporal_fact ledger");
  assert.equal(modeFacts.find((f) => f.id === firstVer.id).effective_validity_status, "SUPERSEDED");
  assert.equal(modeFacts.find((f) => f.id === secondVer.id).effective_validity_status, "VIGENTE");

  // Finding 4: Provenance, CORROBORATED, and knownAt < event.observed_at guards
  // 4a. Associating a claim with evidence from another event must be rejected
  assert.throws(
    () =>
      appendGovernedTemporalFact(audited.caseDir, {
        sourceEventId: evTurn2.id,
        subjectId: "cfg:spoof",
        predicate: "SPOOFED_EVIDENCE",
        factText: "claim citing event 1 URI while attached to event 2",
        evidenceRefs: [evTurn1Uri],
      }),
    /PROVENANCE_MISMATCH|MANUAL_AUTHORITY_REJECTED/,
  );

  // 4b. Marking a governed claim as CORROBORATED must be rejected
  assert.throws(
    () =>
      appendGovernedTemporalFact(audited.caseDir, {
        sourceEventId: evTurn2.id,
        subjectId: "cfg:spoof",
        predicate: "SELF_CORROBORATED",
        factText: "claim self-marked as CORROBORATED",
        epistemic: "CORROBORATED",
      }),
    /MANUAL_AUTHORITY_REJECTED/,
  );
  assert.throws(
    () =>
      appendGovernedTemporalFact(audited.caseDir, {
        sourceEventId: evTurn2.id,
        subjectId: "cfg:spoof",
        predicate: "SELF_CORROBORATED",
        factText: "claim self-marked via status",
        status: "CORROBORATED",
      }),
    /MANUAL_AUTHORITY_REJECTED/,
  );

  // 4c. Setting knownAt earlier than the cited event's observed_at must be rejected
  assert.throws(
    () =>
      appendGovernedTemporalFact(audited.caseDir, {
        sourceEventId: evTurn2.id,
        subjectId: "cfg:time-travel-known",
        predicate: "PRECOGNITION",
        factText: "known before the evidence event happened",
        validAt: "2026-10-12T10:00:00.000Z",
        knownAt: "2026-10-12T10:01:30.000Z", // evTurn2 is at 10:02:01.000Z
      }),
    /TEMPORAL_PROVENANCE_VIOLATION|MANUAL_AUTHORITY_REJECTED/,
  );

  // Finding 7: Cross-session supersession isolation by default vs explicit shared entity
  const sess1Fact = appendGovernedTemporalFact(audited.caseDir, {
    sourceEventId: evTurn1.id,
    subjectId: "worker:port",
    subjectKind: "CONFIGURATION",
    predicate: "LISTEN_PORT",
    factText: "port = 3001",
  });
  const sess2Fact = appendGovernedTemporalFact(audited.caseDir, {
    sourceEventId: evSess2.id,
    subjectId: "worker:port",
    subjectKind: "CONFIGURATION",
    predicate: "LISTEN_PORT",
    factText: "port = 3002",
  });
  assert.equal(sess2Fact.supersededFactId, null, "Session 2 must not supersede Session 1's session-scoped fact");
  const stateAfterCross = reconstructStateAtMoment(audited.caseDir);
  const listenPortFacts = stateAfterCross.vigenteFacts.filter((f) => f.predicate === "LISTEN_PORT");
  assert.equal(listenPortFacts.length, 2, "Both session-scoped facts must remain VIGENTE in their respective sessions");

  // Explicit shared entity (ARTIFACT + scope: 'shared') DOES supersede across sessions
  const sharedArt1 = appendGovernedTemporalFact(audited.caseDir, {
    sourceEventId: evTurn1.id,
    subjectId: "art:README.md",
    subjectKind: "ARTIFACT",
    scope: "shared",
    predicate: "DOC_STATUS",
    factText: "README is draft",
  });
  const sharedArt2 = appendGovernedTemporalFact(audited.caseDir, {
    sourceEventId: evSess2.id,
    subjectId: "art:README.md",
    subjectKind: "ARTIFACT",
    scope: "shared",
    predicate: "DOC_STATUS",
    factText: "README is finalized",
  });
  assert.equal(sharedArt2.supersededFactId, sharedArt1.id, "Explicitly shared ARTIFACT entity supersedes prior session's state");

  // Finding 3: verify-case passes on legitimate state, and FAILS when temporal_fact text or date is altered in SQLite
  const validCheck = await verifyCaseIntegrity(audited.caseDir);
  assert.equal(validCheck.passed, true, `Expected valid case to pass verify-case: ${JSON.stringify(validCheck.findings.filter((f) => !f.ok))}`);

  const tamperedDir = path.join(root, "case-tampered");
  fs.cpSync(audited.caseDir, tamperedDir, { recursive: true });
  const tamperDb = new CaseDatabase(path.join(tamperedDir, "case.sqlite"));
  try {
    tamperDb.run(
      "UPDATE temporal_fact SET fact_text = 'mode = hacked', valid_at = '2026-10-12T23:59:59.000Z' WHERE id = $id",
      { id: secondVer.id },
    );
  } finally {
    tamperDb.close();
  }

  const tamperedState = reconstructStateAtMoment(tamperedDir);
  assert.ok(tamperedState.vigenteFacts.some((f) => f.fact_text === "mode = hacked"));

  const tamperedCheck = await verifyCaseIntegrity(tamperedDir);
  assert.equal(tamperedCheck.passed, false, "verify-case must fail when temporal_fact text or date is tampered with");
  assert.ok(
    tamperedCheck.findings.some((f) => (f.check === "temporal.identity" || f.check === "temporal.fact_integrity") && !f.ok),
  );

  // Finding 6: scripts/merge-into-u2.mjs handles paths cleanly and completes full U2 integration while preserving U2 archive/temporal-cli
  const { integrateIntoU2, resolveCliTarget } = await import("../scripts/merge-into-u2.mjs");
  const parsedArgs = resolveCliTarget(["--u2-root", path.join(root, "mock-u2"), "--dry-run"]);
  assert.equal(parsedArgs.dryRun, true);
  assert.ok(!parsedArgs.targetRoot.includes("C:\\C:\\"));

  const mockU2 = path.join(root, "mock-u2");
  fs.mkdirSync(path.join(mockU2, "src", "archive"), { recursive: true });
  fs.mkdirSync(path.join(mockU2, "skills", "agent-forensic-handoff", "references"), { recursive: true });
  fs.writeFileSync(path.join(mockU2, "src", "archive", "index.js"), "export function archiveCase() { return 'archived'; }\n");
  fs.writeFileSync(path.join(mockU2, "src", "temporal-cli.js"), "export function runTemporalCli() { return 'u2-temporal'; }\n");
  fs.writeFileSync(path.join(mockU2, "src", "constants.js"), 'export const AFH_VERSION = "0.4.0";\nexport const U2_EXTRA = true;\n');
  fs.writeFileSync(path.join(mockU2, "src", "adapters.js"), "export function legacyAdapter() {}\n");
  fs.writeFileSync(
    path.join(mockU2, "src", "index.js"),
    'export { archiveCase } from "./archive/index.js";\nexport { runTemporalCli } from "./temporal-cli.js";\n',
  );
  fs.writeFileSync(
    path.join(mockU2, "src", "cli.js"),
    fs.readFileSync(new URL("../src/cli.js", import.meta.url), "utf8").replace(
      'const command = positional.shift() || "help";',
      'const command = positional.shift() || "help";\n  if (command === "archive") return "archive";',
    ),
  );
  fs.writeFileSync(path.join(mockU2, "skills", "agent-forensic-handoff", "SKILL.md"), "# Skill\n");

  integrateIntoU2(mockU2, { dryRun: false, log: () => {} });
  const mergedIndex = fs.readFileSync(path.join(mockU2, "src", "index.js"), "utf8");
  assert.match(mergedIndex, /archiveCase/);
  assert.match(mergedIndex, /runTemporalCli/);
  assert.match(mergedIndex, /reconstructStateAtMoment/);
  assert.match(mergedIndex, /getContinuationOptions/);
  const mergedConstants = fs.readFileSync(path.join(mockU2, "src", "constants.js"), "utf8");
  assert.match(mergedConstants, /AFH_VERSION = "0\.4\.0"/);
  assert.match(mergedConstants, /U2_EXTRA = true/);
  const mergedCli = fs.readFileSync(path.join(mockU2, "src", "cli.js"), "utf8");
  assert.match(mergedCli, /command === "archive"/);
  assert.match(mergedCli, /command === "options"/);
  assert.match(mergedCli, /command === "state"/);
  assert.ok(fs.existsSync(path.join(mockU2, "test", "temporal-and-options.test.js")));
});

test("candidate-v4 regressions: 3-revision bitemporal closure immutability (A->B->C), atomic rollback on invalid objectId, pre-append entity tamper rejection, and full executable U2-r2 integration with options={}", async (t) => {
  const root = temporary(t, "afh-v4-regressions-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  const rollout = path.join(root, "v4-rollout.jsonl");
  const records = [
    {
      timestamp: "2026-10-12T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "sess-v4-1", session_id: "sess-v4-1", cwd: workspace, model: "gpt-5-codex" },
    },
    {
      timestamp: "2026-10-12T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Step 1: initialize service alpha in src/alpha.js." },
    },
    {
      timestamp: "2026-10-12T12:00:00.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Step 2: update service alpha." },
    },
    {
      timestamp: "2026-10-12T14:00:00.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Step 3: finalize service alpha." },
    },
  ];
  fs.writeFileSync(rollout, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const audited = await auditSession(rollout, {
    harness: "codex",
    caseDir: path.join(root, "case"),
    workspace,
    includeChildren: false,
  });

  const db = new CaseDatabase(path.join(audited.caseDir, "case.sqlite"), { readOnly: true });
  let ev1;
  let ev2;
  let ev3;
  try {
    ev1 = db.get("SELECT * FROM event WHERE record_ordinal = 1");
    ev2 = db.get("SELECT * FROM event WHERE record_ordinal = 2");
    ev3 = db.get("SELECT * FROM event WHERE record_ordinal = 3");
  } finally {
    db.close();
  }

  // Finding 2: A -> B -> C revision chain must NEVER overwrite A's historical closure when C is appended
  const revA = appendGovernedTemporalFact(audited.caseDir, {
    id: "fact-chain-1",
    sourceEventId: ev1.id,
    subjectId: "svc:alpha",
    subjectKind: "CONFIGURATION",
    predicate: "TIMEOUT_MS",
    factText: "timeout = 1000",
    value: { timeout: 1000 },
    validAt: "2026-10-12T10:00:01.000Z",
    knownAt: "2026-10-12T10:00:01.000Z",
  });
  const revB = appendGovernedTemporalFact(audited.caseDir, {
    id: "fact-chain-1",
    sourceEventId: ev2.id,
    subjectId: "svc:alpha",
    subjectKind: "CONFIGURATION",
    predicate: "TIMEOUT_MS",
    factText: "timeout = 2000",
    value: { timeout: 2000 },
    validAt: "2026-10-12T11:00:00.000Z",
    knownAt: "2026-10-12T12:00:00.000Z",
    supersedesFactId: revA.id,
  });

  const beforeC = reconstructStateAtMoment(audited.caseDir, {
    validAt: "2026-10-12T11:30:00.000Z",
    knownAt: "2026-10-12T12:30:00.000Z",
  });
  const factsBeforeC = beforeC.facts.filter((f) => f.predicate === "TIMEOUT_MS");
  assert.equal(factsBeforeC.length, 2);
  assert.equal(factsBeforeC.find((f) => f.id === revA.id).effective_validity_status, "SUPERSEDED");
  assert.equal(factsBeforeC.find((f) => f.id === revB.id).effective_validity_status, "VIGENTE");

  // Now append C, explicitly passing supersedesFactId: revA.id and id: "fact-chain-1"
  const revC = appendGovernedTemporalFact(audited.caseDir, {
    id: "fact-chain-1",
    sourceEventId: ev3.id,
    subjectId: "svc:alpha",
    subjectKind: "CONFIGURATION",
    predicate: "TIMEOUT_MS",
    factText: "timeout = 3000",
    value: { timeout: 3000 },
    validAt: "2026-10-12T13:00:00.000Z",
    knownAt: "2026-10-12T14:00:00.000Z",
    supersedesFactId: revA.id,
  });

  // Querying the exact same historical cut (11:30 valid, 12:30 known) after C MUST still show A as SUPERSEDED and B as VIGENTE!
  const afterC = reconstructStateAtMoment(audited.caseDir, {
    validAt: "2026-10-12T11:30:00.000Z",
    knownAt: "2026-10-12T12:30:00.000Z",
  });
  const factsAfterC = afterC.facts.filter((f) => f.predicate === "TIMEOUT_MS");
  assert.equal(factsAfterC.length, 2);
  assert.equal(
    factsAfterC.find((f) => f.id === revA.id).effective_validity_status,
    "SUPERSEDED",
    "Revision A must remain SUPERSEDED at (11:30, 12:30) after C is added",
  );
  assert.equal(
    factsAfterC.find((f) => f.id === revB.id).effective_validity_status,
    "VIGENTE",
    "Revision B must remain VIGENTE at (11:30, 12:30) after C is added",
  );

  const latestAfterC = reconstructStateAtMoment(audited.caseDir);
  const allTimeoutFacts = latestAfterC.facts.filter((f) => f.predicate === "TIMEOUT_MS");
  assert.equal(allTimeoutFacts.length, 3);
  assert.equal(allTimeoutFacts.find((f) => f.id === revA.id).effective_validity_status, "SUPERSEDED");
  assert.equal(allTimeoutFacts.find((f) => f.id === revB.id).effective_validity_status, "SUPERSEDED");
  assert.equal(allTimeoutFacts.find((f) => f.id === revC.id).effective_validity_status, "VIGENTE");

  // Finding 3: Failed append with invalid objectId must not leave prior fact invalidated or pointing to missing revision
  assert.throws(
    () =>
      appendGovernedTemporalFact(audited.caseDir, {
        id: "fact-chain-1",
        sourceEventId: ev3.id,
        subjectId: "svc:alpha",
        subjectKind: "CONFIGURATION",
        predicate: "TIMEOUT_MS",
        objectId: { badObject: 123 },
        factText: "timeout = 4000",
        validAt: "2026-10-12T14:00:00.000Z",
        knownAt: "2026-10-12T14:00:00.000Z",
        supersedesFactId: revC.id,
      }),
    /Invalid objectId/,
  );

  const stateAfterFailedAppend = reconstructStateAtMoment(audited.caseDir);
  const revCAfterFail = stateAfterFailedAppend.facts.find((f) => f.id === revC.id);
  assert.equal(revCAfterFail.effective_validity_status, "VIGENTE", "revC must remain VIGENTE after failed append");
  assert.equal(revCAfterFail.invalid_at, null);
  assert.equal(revCAfterFail.superseded_by_fact_id, null);
  const integrityAfterFailedAppend = await verifyCaseIntegrity(audited.caseDir);
  assert.equal(integrityAfterFailedAppend.passed, true);

  // Finding 4: Modifying an entity in a copy causes verify-case to fail, AND a subsequent legitimate append must fail and NOT reseal the tampered entity
  const entityTamperedDir = path.join(root, "case-entity-tampered");
  fs.cpSync(audited.caseDir, entityTamperedDir, { recursive: true });
  const tamperDb = new CaseDatabase(path.join(entityTamperedDir, "case.sqlite"));
  try {
    tamperDb.run("UPDATE entity_node SET summary = 'TAMPERED_ENTITY_SUMMARY'");
  } finally {
    tamperDb.close();
  }

  const checkBeforeAppend = await verifyCaseIntegrity(entityTamperedDir);
  assert.equal(checkBeforeAppend.passed, false, "Tampered entity must fail verifyCaseIntegrity");

  assert.throws(
    () =>
      appendGovernedTemporalFact(entityTamperedDir, {
        sourceEventId: ev3.id,
        subjectId: "svc:legit",
        predicate: "LEGIT_FACT",
        factText: "legitimate append on tampered case",
      }),
    /CASE_INTEGRITY_FAILED/,
  );

  const checkAfterRejectedAppend = await verifyCaseIntegrity(entityTamperedDir);
  assert.equal(
    checkAfterRejectedAppend.passed,
    false,
    "Tampered case must remain failed in verifyCaseIntegrity after rejected append",
  );

  // Finding 1: Full executable U2-r2 clone integration with functions having default object parameters (options={})
  const { integrateIntoU2 } = await import("../scripts/merge-into-u2.mjs");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const u2Clone = path.join(root, "u2-full-clone");
  fs.mkdirSync(u2Clone, { recursive: true });
  for (const dirName of ["bin", "src", "skills", "scripts", ...(fs.existsSync(path.join(repoRoot, "schemas")) ? ["schemas"] : [])]) {
    fs.cpSync(path.join(repoRoot, dirName), path.join(u2Clone, dirName), { recursive: true });
  }
  fs.cpSync(path.join(repoRoot, "package.json"), path.join(u2Clone, "package.json"));

  // Simulate U2-r2's own src/temporal.js, src/temporal-cli.js, src/archive/index.js, and functions with options={}
  fs.mkdirSync(path.join(u2Clone, "src", "archive"), { recursive: true });
  fs.writeFileSync(
    path.join(u2Clone, "src", "archive", "index.js"),
    "export function createForensicArchive(caseDir, options={ compress: true }) { return { caseDir, options }; }\n",
  );
  fs.writeFileSync(
    path.join(u2Clone, "src", "temporal.js"),
    "export function appendTemporal(archivePath,input,options={}){ return { archivePath, input, options, engine: 'u2-native' }; }\nexport function queryTemporal() { return {}; }\nexport function historyTemporal() { return {}; }\nexport function verifyTemporal() { return {}; }\nexport function temporalSources() { return []; }\n",
  );
  fs.writeFileSync(
    path.join(u2Clone, "src", "temporal-cli.js"),
    'import { appendTemporal } from "./temporal.js";\nexport function handleTemporalCli(args, options={}) { return appendTemporal(args[0], args[1], options); }\n',
  );
  fs.writeFileSync(
    path.join(u2Clone, "src", "constants.js"),
    `${fs.readFileSync(path.join(u2Clone, "src", "constants.js"), "utf8").replace(/AFH_VERSION = "[^"]+"/, 'AFH_VERSION = "0.4.0"')}\nexport const U2_MARKER = "u2-r2";\n`,
  );
  // Simulate U2-r2 importing DatabaseSync from "node:sqlite" in database.js and integrity.js
  for (const relFile of ["src/database.js", "src/integrity.js"]) {
    const p = path.join(u2Clone, relFile);
    fs.writeFileSync(
      p,
      fs.readFileSync(p, "utf8").replace("./sqlite-compat.js", "node:sqlite"),
    );
  }
  fs.appendFileSync(
    path.join(u2Clone, "src", "database.js"),
    "\nexport function u2DbHelper(dbPath, options={ readOnly: true }) { return Boolean(dbPath && options); }\n",
  );
  fs.appendFileSync(
    path.join(u2Clone, "src", "integrity.js"),
    "\nfunction u2HelperCheck(x, opts={ deep: true }) { return Boolean(x && opts.deep); }\nexport function verifyU2ArchiveIntegrity(archivePath, options={ deep: true }) { return u2HelperCheck(archivePath, options); }\n",
  );
  fs.appendFileSync(
    path.join(u2Clone, "src", "index.js"),
    'export { appendTemporal } from "./temporal.js";\nexport { createForensicArchive } from "./archive/index.js";\n',
  );

  integrateIntoU2(u2Clone, { dryRun: false, log: () => {} });

  // Execute integrated CLI: --version, audit, state, verify-case
  const verOut = spawnSync(process.execPath, [path.join(u2Clone, "bin", "afh.js"), "--version"], { encoding: "utf8" });
  assert.equal(verOut.status, 0, `--version failed: ${verOut.stderr}`);
  assert.equal(verOut.stdout.trim(), "0.4.0");

  const mergedCaseDir = path.join(root, "u2-merged-case");
  const auditOut = spawnSync(
    process.execPath,
    [path.join(u2Clone, "bin", "afh.js"), "audit", rollout, "--case-dir", mergedCaseDir, "--workspace", workspace, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(auditOut.status, 0, `audit failed on merged U2: ${auditOut.stderr}`);

  const stateOut = spawnSync(
    process.execPath,
    [path.join(u2Clone, "bin", "afh.js"), "state", mergedCaseDir, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(stateOut.status, 0, `state failed on merged U2: ${stateOut.stderr}`);
  const parsedState = JSON.parse(stateOut.stdout);
  assert.ok(parsedState.counts.vigenteFacts >= 1);

  const verifyOut = spawnSync(
    process.execPath,
    [path.join(u2Clone, "bin", "afh.js"), "verify-case", mergedCaseDir, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(verifyOut.status, 0, `verify-case failed on merged U2: ${verifyOut.stderr}`);
  assert.equal(JSON.parse(verifyOut.stdout).passed, true);

  // Verify U2's native src/temporal.js and extra integrity export with options={} were NOT truncated and execute properly
  const u2TemporalMod = await import(pathToFileURL(path.join(u2Clone, "src", "temporal.js")).href);
  assert.equal(typeof u2TemporalMod.appendTemporal, "function");
  assert.equal(u2TemporalMod.appendTemporal("arch.afh", { x: 1 }).engine, "u2-native");

  const u2IntegrityMod = await import(pathToFileURL(path.join(u2Clone, "src", "integrity.js")).href);
  assert.equal(typeof u2IntegrityMod.verifyU2ArchiveIntegrity, "function");
  assert.equal(u2IntegrityMod.verifyU2ArchiveIntegrity("arch.afh"), true);
});

test("candidate-v5 regressions: coherent manifest recovery after interrupted case.json publication and non-destructive staged U2 integration rollback", async (t) => {
  const root = temporary(t, "afh-v5-regressions-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  const rollout = path.join(root, "v5-rollout.jsonl");
  const records = [
    {
      timestamp: "2026-10-12T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "sess-v5-1", session_id: "sess-v5-1", cwd: workspace, model: "gpt-5-codex" },
    },
    {
      timestamp: "2026-10-12T10:00:05.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Configure service endpoint." },
    },
    {
      timestamp: "2026-10-12T10:05:00.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Endpoint configured and verified." },
    },
  ];
  fs.writeFileSync(rollout, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const audited = await auditSession(rollout, {
    harness: "codex",
    caseDir: path.join(root, "case"),
    workspace,
    includeChildren: false,
  });

  const db = new CaseDatabase(path.join(audited.caseDir, "case.sqlite"), { readOnly: true });
  let ev1;
  let ev2;
  try {
    ev1 = db.get("SELECT * FROM event WHERE record_ordinal = 1");
    ev2 = db.get("SELECT * FROM event WHERE record_ordinal = 2");
  } finally {
    db.close();
  }

  // 1. Simulate a failure when publishing case.json after SQLite commits
  const manifestPath = path.join(audited.caseDir, "case.json");
  const oldManifestBytes = fs.readFileSync(manifestPath, "utf8");

  const committedFact = appendGovernedTemporalFact(audited.caseDir, {
    sourceEventId: ev1.id,
    subjectId: "svc:endpoint",
    subjectKind: "CONFIGURATION",
    predicate: "ENDPOINT_URL",
    factText: "url = https://api.internal.v1",
    value: { url: "https://api.internal.v1" },
  });
  assert.ok(committedFact.id);

  // Restore old case.json to simulate a crash/error right after SQLite commit before case.json was replaced
  fs.writeFileSync(manifestPath, oldManifestBytes, "utf8");

  // Verify that verifyCaseIntegrity detects the incoherence between updated SQLite and old case.json
  const incoherentCheck = await verifyCaseIntegrity(audited.caseDir);
  assert.equal(incoherentCheck.passed, false, "verifyCaseIntegrity must detect stale case.json after interrupted publish");

  // Retry the exact same appendGovernedTemporalFact: it must recover case.json via temporal_seal_log and succeed idempotently
  const retriedFact = appendGovernedTemporalFact(audited.caseDir, {
    sourceEventId: ev1.id,
    subjectId: "svc:endpoint",
    subjectKind: "CONFIGURATION",
    predicate: "ENDPOINT_URL",
    factText: "url = https://api.internal.v1",
    value: { url: "https://api.internal.v1" },
  });
  assert.equal(retriedFact.id, committedFact.id);
  assert.equal(retriedFact.reused, true);
  assert.equal(retriedFact.recoveredManifest, true);

  const recoveredCheck = await verifyCaseIntegrity(audited.caseDir);
  assert.equal(recoveredCheck.passed, true, "verifyCaseIntegrity must pass after retry recovers case.json");

  // Simulate another interrupted case.json publish, then append a NEW fact on top: must recover and append cleanly
  const manifestAfterFirst = fs.readFileSync(manifestPath, "utf8");
  const secondFact = appendGovernedTemporalFact(audited.caseDir, {
    sourceEventId: ev2.id,
    subjectId: "svc:endpoint",
    subjectKind: "CONFIGURATION",
    predicate: "ENDPOINT_URL",
    factText: "url = https://api.internal.v2",
    value: { url: "https://api.internal.v2" },
  });
  fs.writeFileSync(manifestPath, manifestAfterFirst, "utf8");
  assert.equal((await verifyCaseIntegrity(audited.caseDir)).passed, false);

  const thirdFact = appendGovernedTemporalFact(audited.caseDir, {
    sourceEventId: ev2.id,
    subjectId: "svc:endpoint",
    subjectKind: "CONFIGURATION",
    predicate: "ENDPOINT_URL",
    factText: "url = https://api.internal.v3",
    value: { url: "https://api.internal.v3" },
  });
  assert.equal(thirdFact.recoveredManifest, true);
  assert.equal(thirdFact.supersededFactId, secondFact.id);
  assert.equal((await verifyCaseIntegrity(audited.caseDir)).passed, true);

  // 2. Verify staged integration rollback: if staging validation fails, targetRoot is NOT modified
  const { integrateIntoU2 } = await import("../scripts/merge-into-u2.mjs");
  const brokenTarget = path.join(root, "broken-u2-target");
  fs.mkdirSync(path.join(brokenTarget, "src"), { recursive: true });
  fs.mkdirSync(path.join(brokenTarget, "bin"), { recursive: true });
  const originalAdapters = "export function keepMeIntact() { return 1; }\n";
  fs.writeFileSync(path.join(brokenTarget, "src", "adapters.js"), originalAdapters, "utf8");
  // Place a syntax-broken bin/afh.js so staging validation fails
  fs.writeFileSync(path.join(brokenTarget, "bin", "afh.js"), "export function broken( {\n", "utf8");

  assert.throws(
    () => integrateIntoU2(brokenTarget, { dryRun: false, log: () => {} }),
    /Syntax validation failed/,
  );

  // Target's src/adapters.js must remain 100% untouched because staging failed before commit!
  assert.equal(fs.readFileSync(path.join(brokenTarget, "src", "adapters.js"), "utf8"), originalAdapters);
});

test("candidate-v6 regressions: mid-commit copy failure rollback, junction/symlink rejection across all resolved sources, and complete scripts/merge-into-u2.mjs packaging in integrated target", async (t) => {
  const root = temporary(t, "afh-v6-regressions-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  // 1. Junction & symlink directory protection across all resolved sources (direct, nested file inside junction, parent dir walk, and session-ID discovery)
  const realSourceDir = path.join(root, "real-source-dir");
  fs.mkdirSync(realSourceDir, { recursive: true });
  const realRollout = path.join(realSourceDir, "rollout-junc-001.jsonl");
  const rolloutLines = [
    {
      timestamp: "2026-10-12T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "junc-sess-001", session_id: "junc-sess-001", cwd: workspace, model: "gpt-5-codex" },
    },
    {
      timestamp: "2026-10-12T10:00:05.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Verify junction rejection." },
    },
  ];
  fs.writeFileSync(realRollout, `${rolloutLines.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const parentContainer = path.join(root, "container-with-junction");
  fs.mkdirSync(parentContainer, { recursive: true });
  const junctionDir = path.join(parentContainer, "junction-link");
  fs.symlinkSync(realSourceDir, junctionDir, process.platform === "win32" ? "junction" : "dir");
  const fileThroughJunction = path.join(junctionDir, "rollout-junc-001.jsonl");

  // 1a. Passing the junction directory directly must be rejected by default
  await assert.rejects(
    () =>
      auditSession(junctionDir, {
        harness: "codex",
        caseDir: path.join(root, "case-junc-dir"),
        workspace,
      }),
    /Refusing a symlink source/,
  );

  // 1b. Passing a regular file *inside* a junction directory must also be rejected by default
  await assert.rejects(
    () =>
      auditSession(fileThroughJunction, {
        harness: "codex",
        caseDir: path.join(root, "case-junc-file"),
        workspace,
      }),
    /Refusing a symlink source/,
  );

  // 1c. Discovering a session ID via Codex state_1.sqlite whose rollout_path traverses a junction must also be rejected by default
  const fakeCodexHome = path.join(root, "fake-codex-home");
  fs.mkdirSync(fakeCodexHome, { recursive: true });
  const stateDb = new CaseDatabase(path.join(fakeCodexHome, "state_1.sqlite"));
  try {
    stateDb.db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        cwd TEXT,
        title TEXT,
        created_at TEXT,
        updated_at TEXT,
        updated_at_ms INTEGER,
        cli_version TEXT,
        model TEXT,
        agent_path TEXT,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT
      );
    `);
    stateDb.run(
      "INSERT INTO threads (id, rollout_path, cwd, updated_at_ms) VALUES ($id, $path, $cwd, 1000)",
      { id: "junc-sess-001", path: fileThroughJunction, cwd: workspace },
    );
  } finally {
    stateDb.close();
  }
  await assert.rejects(
    () =>
      auditSession("junc-sess-001", {
        harness: "codex",
        codexHome: fakeCodexHome,
        caseDir: path.join(root, "case-junc-discovered"),
        workspace,
      }),
    /Refusing a symlink source/,
  );

  // 1e. With explicit allowSymlink: true, reading through the junction is permitted
  const allowedRes = await auditSession(fileThroughJunction, {
    harness: "codex",
    allowSymlink: true,
    caseDir: path.join(root, "case-junc-allowed"),
    workspace,
  });
  assert.equal(allowedRes.manifest.status, "COMPLETE");

  // 2. Mid-commit copy failure rollback & complete scripts/merge-into-u2.mjs packaging
  const { integrateIntoU2 } = await import("../scripts/merge-into-u2.mjs");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const u2Target = path.join(root, "u2-rollback-target");
  fs.mkdirSync(u2Target, { recursive: true });
  for (const dirName of ["bin", "src", "skills", ...(fs.existsSync(path.join(repoRoot, "schemas")) ? ["schemas"] : [])]) {
    fs.cpSync(path.join(repoRoot, dirName), path.join(u2Target, dirName), { recursive: true });
  }
  fs.cpSync(path.join(repoRoot, "package.json"), path.join(u2Target, "package.json"));
  // Notice: u2Target starts WITHOUT scripts/merge-into-u2.mjs, with U2's own src/temporal.js,
  // and with U2's own version "0.4.0-u2-orig" and U2's own src/audit.js marker
  fs.appendFileSync(
    path.join(u2Target, "src", "bitemporal-graph.js"),
    "\nexport function placeholderPreMerge() { return 'pre-merge'; }\n",
  );
  fs.writeFileSync(
    path.join(u2Target, "src", "constants.js"),
    fs.readFileSync(path.join(u2Target, "src", "constants.js"), "utf8").replace(/AFH_VERSION = "[^"]+"/, 'AFH_VERSION = "0.4.0-u2-orig"'),
  );
  const origAuditText = `${fs.readFileSync(path.join(u2Target, "src", "audit.js"), "utf8")}\nexport const U2_ORIG_AUDIT_MARKER = true;\n`;
  fs.writeFileSync(path.join(u2Target, "src", "audit.js"), origAuditText);

  // Inject a failure partway through the final commit (after 5 files have already been overwritten in u2Target!)
  let copiedBeforeFail = 0;
  assert.throws(
    () =>
      integrateIntoU2(u2Target, {
        dryRun: false,
        log: () => {},
        copyFileFn: (src, dst) => {
          copiedBeforeFail += 1;
          if (copiedBeforeFail === 6) {
            throw new Error("EIO: simulated mid-commit copy failure on file #6");
          }
          fs.copyFileSync(src, dst);
        },
      }),
    /simulated mid-commit copy failure/,
  );

  // Verify rollback restored u2Target completely:
  assert.match(
    fs.readFileSync(path.join(u2Target, "src", "bitemporal-graph.js"), "utf8"),
    /placeholderPreMerge/,
    "Overwritten file must be restored byte-for-byte on rollback",
  );
  assert.equal(
    fs.existsSync(path.join(u2Target, "scripts", "merge-into-u2.mjs")),
    false,
    "Newly created file (scripts/merge-into-u2.mjs) must be removed on rollback",
  );
  // - src/audit.js was restored byte-for-byte
  assert.equal(fs.readFileSync(path.join(u2Target, "src", "audit.js"), "utf8"), origAuditText);
  // - u2Target CLI still boots and prints 0.4.0-u2-orig
  const verAfterRollback = spawnSync(process.execPath, [path.join(u2Target, "bin", "afh.js"), "--version"], { encoding: "utf8" });
  assert.equal(verAfterRollback.status, 0);
  assert.equal(verAfterRollback.stdout.trim(), "0.4.0-u2-orig");

  // 3. Now run integrateIntoU2 without fault injection and verify scripts/merge-into-u2.mjs is packaged in u2Target
  integrateIntoU2(u2Target, { dryRun: false, log: () => {} });
  assert.equal(
    fs.existsSync(path.join(u2Target, "scripts", "merge-into-u2.mjs")),
    true,
    "Integrated target must include scripts/merge-into-u2.mjs so test/temporal-and-options.test.js can import it",
  );
  assert.equal(
    fs.existsSync(path.join(u2Target, "src", "bitemporal-graph.js")),
    true,
  );
});

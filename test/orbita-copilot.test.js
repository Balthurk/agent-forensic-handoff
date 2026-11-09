import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeCopilot } from "../src/adapters.js";
import { normalizeRecord } from "../products/orbita/agent-forensic-handoff/src/adapters.js";
import { processTool } from "../products/orbita/agent-forensic-handoff/src/audit.js";
import { resolveSession } from "../products/orbita/agent-forensic-handoff/src/discovery.js";

const fixture = fileURLToPath(new URL("./fixtures/copilot/session-state/c0f1a07e-5e55-4000-8000-000000000001/events.jsonl", import.meta.url));
const records = fs.readFileSync(fixture, "utf8").split(/\r?\n/).flatMap(line => {
  try { return [JSON.parse(line)]; } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return [];
  }
});
const context = { harness: "copilot", nativeId: path.basename(path.dirname(fixture)) };

test("Orbita dispatches every synthetic Copilot record to the committed adapter", () => {
  for (const record of records) {
    const expected = normalizeCopilot(record, context);
    const actual = normalizeRecord(record, context);
    const facts = events => events.map(event => ({
      kind: event.kind, subtype: event.subtype, callId: event.callId,
      actor: event.actor, session: event.session, input: event.input,
      output: event.output, status: event.status, artifacts: event.artifacts,
      pointer: event.pointer, origin: event.metadata.origin,
    }));
    assert.deepEqual(facts(actual), facts(expected), record.type);
  }
});

test("Orbita detects Copilot while preserving native identity", async () => {
  const resolved = await resolveSession(fixture);
  assert.equal(resolved.harness, "copilot");
  assert.equal(resolved.rootNativeId, context.nativeId);
});

test("Orbita joins Copilot requests, progress and terminal results without treating starts as results", () => {
  const rows = new Map();
  const db = {
    get(_sql, params) { return rows.get(params.id); },
    upsertTool(row) {
      rows.set(row.id, {
        ...row, tool_name: row.toolName, call_event_id: row.callEvent,
        result_event_id: row.resultEvent, started_at: row.started, ended_at: row.ended,
        actor_id: row.actorId, command_text: row.command, exit_code: row.exitCode,
      });
    },
  };
  let ordinal = 0;
  for (const record of records) {
    for (const normalized of normalizeRecord(record, context)) {
      if (!["tool.requested", "tool.started", "tool.completed"].includes(normalized.kind)) continue;
      if (normalized.callId !== "call_view_1") continue;
      const event = {
        id: `event-${++ordinal}`, kind: normalized.kind, status: normalized.status,
        sessionId: context.nativeId, sourceId: "source", callId: normalized.callId,
        turnId: normalized.turnId, actorId: normalized.actor.id,
        observedAt: record.timestamp,
      };
      processTool(db, event, normalized);
      assert.equal(rows.size, 1);
      const row = [...rows.values()][0];
      if (normalized.kind === "tool.started") {
        assert.equal(row.status, "INCOMPLETE");
        assert.equal(row.resultEvent, null);
      }
    }
  }
  assert.ok(ordinal >= 3);
  const row = [...rows.values()][0];
  assert.equal(row.status, "COMPLETED");
  assert.ok(row.callEvent);
  assert.ok(row.resultEvent);
  assert.equal(row.toolName, "view");
});

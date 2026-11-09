# GitHub Copilot SDK / VS Code Agent Host adapter

## Source and contract

The Copilot runtime used by the VS Code Agent Host persists one session per directory:

```text
~/.copilot/session-state/<sessionId>/events.jsonl
```

Each line is an envelope `{id, parentId, timestamp, type, data}` with optional `agentId` and `ephemeral`. The adapter (`normalizeCopilot` in `src/adapters.js`) is derived from two independent sources:

1. `@github/copilot-sdk` `schemas/session-events.schema.json` (SDK 1.0.27, 164 event variants, 78 not marked `ephemeral`), shipped with VS Code;
2. a schema-only inventory of 11 local sessions (≈12k records, 42 types). Only type names, key paths, value types, enum values and join statistics were inspected. No local record is committed.

Facts that shape the mapping, all measured on local records:

| Fact | Consequence |
|---|---|
| `parentId` is the chronologically preceding event; about 1% of records chain to an earlier record because writers run concurrently | Kept as `metadata.parentEventId`; never an edge, never used to reorder |
| `turnId` is a counter that restarts per interaction (366 reuses in 11 sessions) | Kept verbatim with `metadata.interactionId`; AFH synthesizes no composite turn |
| `toolCallId` is unique per session and joins `assistant.message.toolRequests[]`, `tool.execution_start`, `permission.*`, `external_tool.requested` and `tool.execution_complete` (100% join on local data) | Correlation is session-scoped (`callIdScope: "session"`) |
| A resume-time `tool.execution_complete` carries `error.code="interrupted"`, `model="resumed"` and no `turnId` | Terminal `INTERRUPTED`, attributed to the harness; it binds to its start despite the missing `turnId` |
| 48 completions report `success: true` with a non-zero `shellExecution.exitCode` | Observed status `FAILED`; `metadata.reportedSuccess` keeps the runtime claim |
| `fileEdits[]` lists mutations the built-in editor committed, with paths and kinds but no bytes | The only artifact source; revisions stay `LIVE_UNVERIFIED` at best |
| Hooks carry a tool call ID only for `preToolUse` (`input.toolCalls[].id`) and `preMcpToolCall` | Other hook links are `UNAVAILABLE`, not inferred |
| `external_tool.completed` is `ephemeral` in the schema but persisted; `model.*` auxiliary records are not in the schema | Mapped and flagged (`persistedEphemeral`, `documented: false`) |
| Observed schema drift, e.g. `session.permissions_changed` and `session.shutdown.codeChanges` | Fields are read defensively; unread fields remain in the cold record |

## Mapping

| Copilot record | AFH kind | Notes |
|---|---|---|
| `session.start` | `session.meta` | Session ID, cwd, version, model, git context; `detachedFromSpawningParentSessionId` → `SPAWNED` edge (schema-derived) |
| `session.resume`, `session.shutdown`, `abort` | `session.resumed`, `session.shutdown`, `session.aborted` | Shutdown keeps reported code-change totals as metadata only |
| `user.message` | `message.user` | Only without `agentId` and `source`; otherwise `message.instruction` with an unknown-source actor |
| `system.message`, `skill.*` | `message.instruction` | `*_ref` variants keep only the content reference |
| `assistant.message` | `message.agent`, `reasoning.summary`, `tool.requested` ×N | Reasoning uses visible `reasoningText`; opaque/encrypted reasoning is `UNAVAILABLE` |
| `assistant.reasoning` | `reasoning.summary` | Schema-derived |
| `assistant.turn_start` / `turn_end` | `session.turn_started` / `session.turn_ended` | |
| `tool.user_requested` | `tool.requested` | Human actor |
| `tool.execution_start` | `tool.started` | Progress only; MCP calls use an `MCP_SERVER` actor |
| `tool.execution_complete` | `tool.completed` | `COMPLETED`, `FAILED`, `APPROVAL_DENIED`, `INTERRUPTED`; artifacts from `fileEdits` |
| `permission.requested` / `completed` | `permission.requested` / `permission.completed` | Decider: human for `human_response`, policy actor otherwise |
| retired `permission.*Authorization*` etc. | `permission.legacy_claim` | `NON_AUTHORITATIVE` per schema |
| `hook.start` / `hook.end` | `external.hook` | Paired by `hookInvocationId`; `contextInjected` when `additionalContext` is returned |
| `subagent.started` / `completed` / `failed` | `external.subagent` | Same session file; sub-agent records attributed by `agentId` |
| `external_tool.*` | `external.tool_dispatch` | Client-side dispatch; the result is carried by `tool.execution_complete` |
| `human_response.recorded` | `message.human_response` | Not a new mission |
| `system.notification` | `session.notification` | |
| `session.usage_record`, `session.usage_checkpoint` | `telemetry.token_usage`, `telemetry.usage_checkpoint` | |
| `session.compaction_*`, `session.truncation`, `session.context_*` | `session.compaction_started`, `session.compacted`, `session.truncated`, `session.context_changed`/`cleared` | |
| settings, mode, model and limits changes | `session.settings` | |
| `model.*` | `telemetry.auxiliary_model` | Auxiliary model calls; never projected as messages |
| unknown type, invalid envelope, missing correlation field | `forensic.unknown_record` + `UNKNOWN_RECORD` warning | Record stays byte-exact cold evidence |
| invalid JSON (e.g. torn tail) | `forensic.unparsed_record` + `INVALID_JSON` | |

Every emitted JSON pointer resolves inside its own record. The archive pipeline uses the same mapping: Copilot occurrences are keyed by the native call or message ID (not the per-record event ID), `tool.started` is non-terminal, and an interrupted completion becomes lifecycle `CANCELLED` with reason `INTERRUPTED` because the archive lifecycle enum has no interrupted value.

## Parity matrix

Measured by `test/copilot.test.js` (capability present in the reconstructed case). The Codex column is the union of the committed Codex fixtures; the generic column is the previous path applied to the same Copilot fixture.

| Capability | Codex | Copilot | Generic on Copilot |
|---|---|---|---|
| Human messages / missions | yes | yes | no |
| Agent messages | yes | yes | no |
| Reasoning summaries (visible only) | adapter supports; not in committed fixtures | yes | no |
| Request ↔ result correlation by native ID | yes | yes | no |
| Observed exit codes and historical validations | yes | yes | no |
| Artifact revisions | yes | yes (paths/kinds only) | no |
| Token usage | yes | yes | no |
| Compaction | yes | yes | no |
| Delegation / sub-agent attribution | yes | yes (schema-derived fixture) | no |
| MCP attribution | yes | yes | no |
| External influence (hooks, dispatch) | yes | yes | no |
| Turn relationships | yes | yes | no |
| Session metadata | yes | yes | no |
| Every record accounted | yes | yes | yes |
| Permission decisions | not in fixtures | yes | no |
| Hook invocations | not in fixtures | yes | no |
| Interrupted / aborted calls | not in fixtures | yes | no |
| Incomplete calls (no durable completion) | not in fixtures | yes | everything is incomplete |

Real-session measurement (read-only, not committed; 11 local sessions, 12,268 records): 0 unknown records and 0 warnings; 1,290 tool executions, 1,287 correlated from request to completion; 3 without completion (one aborted `ask_user`, the rest in flight while measured); 1 `INTERRUPTED`; 3 `APPROVAL_DENIED`. The generic adapter on the same bytes: 9,464 unknown records, 0 user messages and 0 correlated tool calls.

## Installed skill and Orbita integration

The CLI and the user-level skill must both be updated. Orbita loads a separate
AFH snapshot under `products/orbita/agent-forensic-handoff`; updating only the
top-level CLI does not update the web importer. That snapshot now includes the
same Copilot normalizer and session-scoped tool reducer, while retaining its
PostgreSQL storage, document imports and existing non-Copilot correlation.
`test/orbita-copilot.test.js` checks dispatch parity, discovery and request/start/
completion correlation across that boundary.

Orbita's context graph groups Copilot messages by the persisted session and
`interactionId`, not the restarting `turnId` counter. An absent interaction ID
does not create a guessed dependency on a different user request.

Existing cases are immutable projections of the adapter used at import time.
Re-audit and re-import the same bytes as a new case after an adapter upgrade;
keep the earlier case for comparison rather than modifying its evidence.

## Remaining gaps

- Sub-agent records (`subagent.*`, envelope `agentId`, `parentToolCallId`), `assistant.reasoning`, `tool.user_requested`, `human_response.recorded`, `session.task_complete`, the retired permission claims and the fusion records are mapped from the schema only; they did not occur in the inspected sessions.
- A sub-agent's lifecycle actor (`act:subagent:call:<toolCallId>`) and its record actor (`act:subagent:<agentId>`) are not merged; both carry `parentToolCallId` for joining.
- MCP calls are attributed through the `tool.started` actor; Copilot completions do not repeat the server, so they are not counted as `mcp.*` external-influence events.
- `fileEdits` carries no bytes, so Copilot artifacts can never be `LIVE_VERIFIED`; shell-based edits are not attributed to artifacts. `result.detailedContent` diffs remain cold evidence.
- Hook-to-tool links exist only for `preToolUse` and `preMcpToolCall`.
- `create_session` and other cross-session tools are not followed; no child session is synthesized from tool output.
- Ephemeral schema types other than `external_tool.completed` are reported as unknown if a future runtime persists them.
- Discovery does not read `~/.copilot/session-store.db`; titles and cross-session indexes are not used.

## Fixture

`test/fixtures/copilot/session-state/<id>/events.jsonl` is synthetic and generated by `scripts/build-copilot-fixture.mjs`; `node scripts/build-copilot-fixture.mjs --check` (also run by the tests) proves the committed bytes match the generator. It includes a prompt-injection probe in tool output, a concurrent-writer `parentId`, an unknown type, a contract violation, an invalid envelope and a torn final line.

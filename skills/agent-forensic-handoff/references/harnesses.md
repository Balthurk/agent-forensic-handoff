# Harness notes

## Codex

Discovery order:

1. read-only `state_*.sqlite` thread metadata under `CODEX_HOME`;
2. exact rollout path, accepting `.zst`/`.gz` variants;
3. filename search under `sessions/` and `archived_sessions/`.

The adapter recognizes current common `session_meta`, `turn_context`, `world_state`, `response_item`, `event_msg`, `token_usage_record`, `realtime_item`, `inter_agent_communication_metadata`, and `compacted` records. It classifies observed item-completion variants including user/agent messages, reasoning, commands, MCP calls, file changes, subagent/collaboration activity, extensions, images, and compaction. Raw rollout JSONL is an implementation surface and can drift; unsupported variants become warnings and retained cold evidence.

Parent/child edges are used only when explicit state rows or exact identifiers in persisted successful create/fork/subagent observations expose them. A full native ID is preferred. Prefix resolution is refused when ambiguous unless the operator explicitly acknowledges `--allow-prefix`.

## Claude Code

Discovery scans `~/.claude/projects` for an exact ID in supported transcript filenames. The baseline adapter handles user/assistant blocks, tool use/results, compact summaries, and file-history snapshots. Claude versions can add record types; unknown types stay visible.

## Google Antigravity

Discovery checks configured Antigravity roots and explicit paths. Because local transcript contracts vary, v0.1 uses conservative common-field normalization. Treat support as experimental and inspect warnings. Prefer an explicit export/path when ID lookup fails.

## Generic harnesses

Provide JSONL/NDJSON with one JSON object per line. Useful fields include:

- `timestamp` or `time`;
- `session_id`, `sessionId`, or `conversationId`;
- `role`, `actor.role`, or `message.role`;
- `content`, `text`, or `message.content`;
- `type`, `event`, or `kind`;
- `tool_name`, `toolName`, `tool.name`, or `name`;
- `call_id`, `callId`, `tool_use_id`, or `id`;
- `input`, `arguments`, `command`, `output`, `result`, `exit_code`, `cwd`;
- explicit parent session IDs.

When the generic adapter cannot classify a valid JSON record, it emits `forensic.unknown_record`. Invalid JSON emits `forensic.unparsed_record`. Both retain the exact source record as evidence.

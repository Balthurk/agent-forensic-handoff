# Harness notes

## Codex

Discovery order:

1. read-only `state_*.sqlite` thread metadata under `CODEX_HOME`;
2. exact rollout path, accepting `.zst`/`.gz` variants;
3. filename search under `sessions/` and `archived_sessions/`.

The adapter normalizes all canonical Codex rollout records and lifecycle events:

- **Top-level rollout records:** `session_meta` (including `forked_from_id`, `history_mode`, `history_base`, `subagent_history_start_ordinal`, `memory_mode`), `turn_context` (`turn_id`, `model`, `cwd`, `effort`, `approval_policy`, `sandbox_policy`, `collaboration_mode`), `world_state`, `response_item`, `event_msg`, `compacted` (`replacement_history`), `token_usage_record`, `realtime_item`, `inter_agent_communication`, `inter_agent_communication_metadata`, and `security_risk_score`.
- **`response_item` variants:** `message` / `agent_message` (handling `input_text`, `output_text`, `text`, plus `internal_chat_message_metadata_passthrough.turn_id`), `reasoning` (`summary`, `content`, `encrypted_content`), `function_call`, `custom_tool_call`, `local_shell_call`, `function_call_output`, `custom_tool_call_output`, `tool_search_call`, `tool_search_output`, `web_search_call`, `image_generation_call`, and `compaction`.
- **`apply_patch` & `exec_command` unpacking:** Parses `*** Begin Patch` / `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` blocks into structured per-file artifact revisions and diffs (`parseApplyPatchText`), and unpacks Codex `exec_command` / `write_stdin` output wrappers (`Chunk ID`, `Wall time`, `Process exited with code`, `Output:`) via `parseCodexExecEnvelope`.
- **`event_msg` & `item_completed` variants:** `user_message`, `agent_message`, `agent_reasoning`, `agent_reasoning_raw_content`, `task_started` / `turn_started`, `task_complete` / `turn_complete`, `turn_aborted` (marks in-flight turn actions `ABORTED_BY`), `thread_rolled_back` (`num_turns` rollback invalidation via `ROLLED_BACK_BY`), `thread_goal_updated`, `entered_review_mode` / `exited_review_mode`, `patch_apply_end`, `mcp_tool_call_end`, `sub_agent_activity`, `web_search_end`, `image_generation_end`, `context_compacted`, `thread_settings_applied`, `token_count`, and all `item_completed` items (`UserMessage`, `AgentMessage`, `Plan`, `Reasoning`, `CommandExecution`, `DynamicToolCall`, `McpToolCall`, `FileChange`, `HookPrompt`, `EnteredReviewMode`, `ExitedReviewMode`, `SubAgentActivity`, `CollabAgentToolCall`, `Extension`, `WebSearch`, `ImageView`, `ImageGeneration`, `ContextCompaction`).

Parent/child edges are used only when explicit state rows or exact identifiers in persisted successful create/fork/subagent observations expose them. A full native ID is preferred. Prefix resolution is refused when ambiguous unless the operator explicitly acknowledges `--allow-prefix`.

## Claude Code

Discovery scans `~/.claude/projects` for an exact ID in supported transcript filenames. The adapter handles user/assistant blocks, `thinking` blocks (normalized to `reasoning.summary` with `signaturePresent` metadata), `tool_use` / `tool_result`, compact summaries, and `file-history-snapshot` records. Claude versions can add record types; unknown types stay visible as `forensic.unknown_record`.

## Google Antigravity

Discovery checks configured Antigravity roots and explicit paths. Because local transcript contracts vary, AFH uses conservative common-field normalization. Treat support as experimental and inspect warnings. Prefer an explicit export/path when ID lookup fails.

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

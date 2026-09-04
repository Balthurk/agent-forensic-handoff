import path from "node:path";
import { ACTOR_KINDS, EPISTEMIC } from "./constants.js";
import { asText, normalizeTimestamp, safeJson } from "./util.js";

function actor(id, kind, role = null, displayName = null, nativeId = null) {
  return { id, kind, role, displayName, nativeId, epistemic: EPISTEMIC.DIRECT };
}

function timestampOf(record, payload = {}) {
  return normalizeTimestamp(record.timestamp ?? payload.timestamp ?? payload.occurred_at_ms ?? payload.started_at ?? payload.completed_at);
}

function normalized({ kind, subtype = null, actor: eventActor, input = "", output = "", status = null, nativeId = null, callId = null, turnId = null, phase = null, metadata = {}, artifacts = [], session = null, sessionEdges = [], pointer = "" }, record, payload) {
  const time = timestampOf(record, payload);
  return {
    kind, subtype, actor: eventActor, input, output, status, nativeId, callId,
    turnId, phase, metadata, artifacts, session, sessionEdges, pointer,
    observedAt: time.value, timePrecision: time.value ? time.precision : "ORDER_ONLY",
    epistemic: EPISTEMIC.DIRECT,
  };
}

function contentText(content) {
  if (!Array.isArray(content)) return asText(content);
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return "";
    if (["input_text", "output_text", "text"].includes(block.type)) return block.text ?? block.input_text ?? block.output_text ?? "";
    return "";
  }).filter(Boolean).join("\n");
}

function durationMs(value) {
  if (typeof value === "number") return Math.round(value);
  if (value && typeof value === "object") return Math.round((value.secs ?? 0) * 1000 + (value.nanos ?? 0) / 1_000_000);
  return null;
}

function codexSession(payload, sourceContext) {
  const nativeId = payload.session_id ?? payload.id ?? sourceContext.nativeId;
  return {
    id: `ses:${sourceContext.harness}:${nativeId}`,
    nativeId,
    harness: "codex",
    sourceId: sourceContext.sourceId,
    parentNativeId: payload.parent_thread_id ?? payload.forked_from_id ?? null,
    cwd: payload.cwd ?? sourceContext.stateMetadata?.cwd ?? null,
    startedAt: normalizeTimestamp(payload.timestamp).value,
    title: sourceContext.stateMetadata?.title ?? null,
    harnessVersion: payload.cli_version ?? sourceContext.stateMetadata?.harnessVersion ?? null,
    model: payload.model ?? sourceContext.stateMetadata?.model ?? null,
    metadata: {
      originator: payload.originator ?? null,
      source: payload.source ?? null,
      threadSource: payload.thread_source ?? null,
      historyMode: payload.history_mode ?? null,
      contextWindow: payload.context_window ?? null,
      agentPath: payload.agent_path ?? null,
      agentNickname: payload.agent_nickname ?? null,
    },
  };
}

function codexActorForRole(role) {
  if (role === "user") return actor("act:user", ACTOR_KINDS.USER, "user");
  if (role === "assistant") return actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant");
  return actor(`act:system:${role || "unknown"}`, ACTOR_KINDS.SYSTEM, role || "system");
}

function codexResponseItem(record, payload, ctx) {
  if (payload.type === "message" || payload.type === "agent_message") {
    const role = payload.role ?? (payload.type === "agent_message" ? "assistant" : "unknown");
    return [normalized({
      kind: role === "user" ? "message.user" : role === "assistant" ? "message.agent" : "message.instruction",
      subtype: payload.type,
      actor: codexActorForRole(role),
      input: contentText(payload.content),
      nativeId: payload.id ?? null,
      phase: payload.phase ?? null,
      metadata: { origin: "response_item", role },
      pointer: "/payload/content",
    }, record, payload)];
  }
  if (["function_call", "custom_tool_call"].includes(payload.type)) {
    const name = payload.namespace ? `${payload.namespace}.${payload.name}` : payload.name;
    const input = payload.arguments ?? payload.input ?? "";
    return [normalized({
      kind: "tool.requested", subtype: payload.type,
      actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: typeof input === "string" ? input : JSON.stringify(input),
      status: payload.status ?? "REQUESTED", nativeId: payload.id ?? null,
      callId: payload.call_id ?? payload.id ?? null,
      metadata: { toolName: name || "unknown", namespace: payload.namespace ?? null },
      artifacts: artifactsFromTool(name, safeJson(input, input)), pointer: "/payload",
    }, record, payload)];
  }
  if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
    return [normalized({
      kind: "tool.completed", subtype: payload.type,
      actor: actor("act:tool:unknown", ACTOR_KINDS.TOOL, "tool"),
      output: asText(payload.output), status: outputStatus(payload.output),
      callId: payload.call_id ?? null, pointer: "/payload/output",
      metadata: outputMetadata(payload.output),
    }, record, payload)];
  }
  if (payload.type === "reasoning") {
    const summary = contentText(payload.summary);
    return [normalized({
      kind: "reasoning.summary", subtype: "model_exposed_summary",
      actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: summary,
      status: summary ? "AVAILABLE" : "UNAVAILABLE",
      metadata: { encryptedContentPresent: Boolean(payload.encrypted_content), privateReasoningRecoverable: false },
      pointer: summary ? "/payload/summary" : "/payload",
    }, record, payload)];
  }
  return [normalized({
    kind: "forensic.unknown_record", subtype: `response_item.${payload.type || "unknown"}`,
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    status: "PRESERVED", metadata: { keys: Object.keys(payload).sort() },
  }, record, payload)];
}

function codexEventMessage(record, payload, ctx) {
  if (payload.type === "user_message") return [normalized({
    kind: "message.user", subtype: "event_msg", actor: actor("act:user", ACTOR_KINDS.USER, "user"),
    input: payload.message ?? "", metadata: { origin: "event_msg", userVisible: true }, pointer: "/payload/message",
  }, record, payload)];
  if (payload.type === "agent_message") return [normalized({
    kind: "message.agent", subtype: "event_msg", actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
    input: payload.message ?? "", phase: payload.phase ?? null,
    metadata: { origin: "event_msg", userVisible: true }, pointer: "/payload/message",
  }, record, payload)];
  if (payload.type === "mcp_tool_call_end") {
    const invocation = payload.invocation ?? {};
    const result = payload.result ?? {};
    const status = result.Err || result.error || result.isError ? "FAILED" : "COMPLETED";
    return [normalized({
      kind: "mcp.completed", subtype: payload.action_name ?? invocation.tool ?? null,
      actor: actor(`act:mcp:${invocation.server || payload.app_name || "unknown"}`, ACTOR_KINDS.MCP, "mcp_server", payload.app_name ?? invocation.server ?? null),
      input: JSON.stringify(invocation.arguments ?? {}), output: JSON.stringify(result), status,
      callId: payload.call_id ?? null,
      metadata: { toolName: invocation.tool ?? payload.action_name ?? "unknown", server: invocation.server ?? null, appName: payload.app_name ?? null, durationMs: durationMs(payload.duration) },
      pointer: "/payload",
    }, record, payload)];
  }
  if (payload.type === "patch_apply_end") {
    const artifacts = Object.entries(payload.changes ?? {}).map(([filePath, change]) => ({
      path: filePath,
      operation: String(change?.type ?? "update").toUpperCase(),
      content: change?.content ?? null,
      diff: change?.unified_diff ?? null,
      movePath: change?.move_path ?? null,
    }));
    return [normalized({
      kind: "filesystem.patch", subtype: "apply_patch",
      actor: actor("act:tool:apply_patch", ACTOR_KINDS.TOOL, "tool", "apply_patch"),
      input: JSON.stringify(Object.keys(payload.changes ?? {})), output: `${payload.stdout ?? ""}${payload.stderr ? `\n${payload.stderr}` : ""}`,
      status: payload.success ? "COMPLETED" : "FAILED", callId: payload.call_id ?? null,
      turnId: payload.turn_id ?? null, artifacts,
      metadata: { toolName: "apply_patch", success: Boolean(payload.success) }, pointer: "/payload/changes",
    }, record, payload)];
  }
  if (payload.type === "sub_agent_activity") {
    const subId = payload.agent_thread_id ?? payload.agent_path ?? "unknown";
    return [normalized({
      kind: "external.subagent", subtype: payload.kind ?? "activity",
      actor: actor(`act:subagent:${subId}`, ACTOR_KINDS.SUBAGENT, payload.agent_path ?? "subagent", payload.agent_path ?? null, subId),
      status: payload.kind ?? "OBSERVED", nativeId: payload.event_id ?? null,
      metadata: { agentThreadId: payload.agent_thread_id ?? null, agentPath: payload.agent_path ?? null },
      sessionEdges: payload.agent_thread_id ? [{ parentNativeId: ctx.sessionNativeId, childNativeId: payload.agent_thread_id, type: "SPAWNED" }] : [],
    }, record, payload)];
  }
  if (payload.type === "web_search_end") return [normalized({
    kind: "tool.completed", subtype: "web_search",
    actor: actor("act:tool:web_search", ACTOR_KINDS.SERVICE, "external_service", "web_search"),
    input: payload.query ?? JSON.stringify(payload.action ?? {}), status: "COMPLETED",
    callId: payload.call_id ?? null, metadata: { toolName: "web_search" }, pointer: "/payload",
  }, record, payload)];
  if (payload.type === "image_generation_end") return [normalized({
    kind: "tool.completed", subtype: "image_generation",
    actor: actor("act:tool:image_generation", ACTOR_KINDS.SERVICE, "external_service", "image_generation"),
    input: payload.revised_prompt ?? "", output: JSON.stringify(payload.result ?? {}),
    status: String(payload.status ?? "COMPLETED").toUpperCase(), callId: payload.call_id ?? null,
    metadata: { toolName: "image_generation" },
    artifacts: payload.saved_path ? [{ path: payload.saved_path, operation: "CREATE", content: null, diff: null }] : [],
  }, record, payload)];
  if (["task_started", "task_complete"].includes(payload.type)) return [normalized({
    kind: `session.${payload.type}`, subtype: payload.type,
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    status: payload.type === "task_complete" ? "COMPLETED" : "STARTED",
    turnId: payload.turn_id ?? null,
    output: payload.last_agent_message ?? "",
    metadata: { durationMs: payload.duration_ms ?? null, timeToFirstTokenMs: payload.time_to_first_token_ms ?? null },
  }, record, payload)];
  if (payload.type === "context_compacted") return [normalized({
    kind: "session.compacted", subtype: "event_msg",
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"), status: "OBSERVED",
  }, record, payload)];
  if (payload.type === "thread_settings_applied") return [normalized({
    kind: "session.settings", subtype: payload.type,
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    input: JSON.stringify(payload.thread_settings ?? {}), status: "APPLIED", pointer: "/payload/thread_settings",
  }, record, payload)];
  if (payload.type === "token_count") return [normalized({
    kind: "telemetry.token_count", subtype: payload.type,
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    status: "OBSERVED", metadata: { info: payload.info ?? null }, pointer: "/payload/info",
  }, record, payload)];
  return [normalized({
    kind: "forensic.unknown_record", subtype: `event_msg.${payload.type || "unknown"}`,
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"), status: "PRESERVED",
    metadata: { keys: Object.keys(payload).sort() },
  }, record, payload)];
}

export function normalizeCodex(record, ctx) {
  const payload = record.payload ?? {};
  if (record.type === "session_meta") {
    const session = codexSession(payload, ctx);
    return [normalized({
      kind: "session.meta", subtype: "codex", actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness", "Codex"),
      status: "OBSERVED", session,
      sessionEdges: session.parentNativeId ? [{ parentNativeId: session.parentNativeId, childNativeId: session.nativeId, type: payload.forked_from_id ? "FORKED" : "CHILD" }] : [],
      metadata: session.metadata,
    }, record, payload)];
  }
  if (record.type === "turn_context") return [normalized({
    kind: "session.turn_context", subtype: "codex", actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    status: "OBSERVED", turnId: payload.turn_id ?? null,
    metadata: { cwd: payload.cwd ?? null, model: payload.model ?? null, timezone: payload.timezone ?? null, effort: payload.effort ?? null, summaryPresent: Boolean(payload.summary) },
    input: payload.summary ?? "", pointer: payload.summary ? "/payload/summary" : "/payload",
  }, record, payload)];
  if (record.type === "world_state") return [normalized({
    kind: "session.world_state", subtype: "codex", actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    status: "OBSERVED", metadata: { full: payload.full ?? null, keys: Object.keys(payload.state ?? {}).sort() },
  }, record, payload)];
  if (record.type === "response_item") return codexResponseItem(record, payload, ctx);
  if (record.type === "event_msg") return codexEventMessage(record, payload, ctx);
  if (record.type === "compacted") return [normalized({
    kind: "session.compacted", subtype: "replacement_history",
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    input: payload.replacement_history ?? "", status: "OBSERVED",
    metadata: { windowId: payload.window_id ?? null, previousWindowId: payload.previous_window_id ?? null, windowNumber: payload.window_number ?? null },
    pointer: "/payload/replacement_history",
  }, record, payload)];
  return [normalized({
    kind: "forensic.unknown_record", subtype: record.type || "unknown",
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"), status: "PRESERVED",
    metadata: { keys: Object.keys(record).sort(), payloadKeys: Object.keys(payload).sort() },
  }, record, payload)];
}

function claudeSession(record, ctx) {
  const nativeId = record.sessionId ?? ctx.nativeId;
  return {
    id: `ses:claude:${nativeId}`, nativeId, harness: "claude", sourceId: ctx.sourceId,
    parentNativeId: null, cwd: record.cwd ?? null, startedAt: normalizeTimestamp(record.timestamp).value,
    title: null, harnessVersion: record.version ?? null, model: record.message?.model ?? null,
    metadata: { gitBranch: record.gitBranch ?? null, userType: record.userType ?? null },
  };
}

export function normalizeClaude(record, ctx) {
  const events = [];
  const session = claudeSession(record, ctx);
  if (["user", "assistant"].includes(record.type)) {
    const role = record.message?.role ?? record.type;
    const content = record.message?.content ?? record.content ?? "";
    const blocks = Array.isArray(content) ? content : [{ type: "text", text: asText(content) }];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") events.push(normalized({
        kind: role === "user" ? "message.user" : "message.agent", subtype: "claude",
        actor: role === "user" ? actor("act:user", ACTOR_KINDS.USER, "user") : actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
        input: block.text ?? "", nativeId: record.uuid ?? null,
        metadata: { origin: "claude-transcript", parentUuid: record.parentUuid ?? null, userVisible: true },
        session, pointer: "/message/content",
      }, record, record));
      else if (block.type === "tool_use") events.push(normalized({
        kind: "tool.requested", subtype: "claude.tool_use", actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
        input: JSON.stringify(block.input ?? {}), callId: block.id ?? null, nativeId: record.uuid ?? null,
        metadata: { toolName: block.name ?? "unknown" }, artifacts: artifactsFromTool(block.name, block.input ?? {}),
        session, pointer: "/message/content",
      }, record, record));
      else if (block.type === "tool_result") events.push(normalized({
        kind: "tool.completed", subtype: "claude.tool_result", actor: actor("act:tool:unknown", ACTOR_KINDS.TOOL, "tool"),
        output: asText(block.content), status: block.is_error ? "FAILED" : "COMPLETED",
        callId: block.tool_use_id ?? null, nativeId: record.uuid ?? null,
        metadata: { isError: Boolean(block.is_error) }, session, pointer: "/message/content",
      }, record, record));
    }
    if (!events.length) events.push(normalized({
      kind: "forensic.unknown_record", subtype: `claude.${record.type}.empty`, actor: actor("act:harness:claude", ACTOR_KINDS.SYSTEM, "harness"),
      status: "PRESERVED", session,
    }, record, record));
    return events;
  }
  if (record.type === "summary" || record.isCompactSummary) return [normalized({
    kind: "session.compacted", subtype: "claude.summary", actor: actor("act:harness:claude", ACTOR_KINDS.SYSTEM, "harness"),
    input: asText(record.summary ?? record.message ?? record.content), status: "OBSERVED", session, pointer: "/summary",
  }, record, record)];
  if (record.type === "file-history-snapshot") {
    const paths = Object.keys(record.snapshot?.trackedFileBackups ?? record.trackedFileBackups ?? {});
    return [normalized({
      kind: "filesystem.snapshot", subtype: "claude.file-history", actor: actor("act:harness:claude", ACTOR_KINDS.SYSTEM, "harness"),
      status: "OBSERVED", session, metadata: { fileCount: paths.length },
      artifacts: paths.map((file) => ({ path: file, operation: "SNAPSHOT", content: null, diff: null })),
    }, record, record)];
  }
  if (record.type === "system" && (record.subtype?.includes("compact") || record.compactMetadata)) return [normalized({
    kind: "session.compacted", subtype: record.subtype ?? "claude.system", actor: actor("act:harness:claude", ACTOR_KINDS.SYSTEM, "harness"),
    input: asText(record.content ?? record.message), status: "OBSERVED", session,
  }, record, record)];
  return [normalized({
    kind: record.type === "progress" ? "external.hook" : "forensic.unknown_record",
    subtype: `claude.${record.type || "unknown"}`, actor: actor("act:harness:claude", ACTOR_KINDS.SYSTEM, "harness"),
    input: asText(record.data?.message ?? ""), status: "PRESERVED", session,
    metadata: { keys: Object.keys(record).sort() },
  }, record, record)];
}

export function normalizeGeneric(record, ctx) {
  const type = String(record.type ?? record.event ?? record.kind ?? "unknown");
  const role = record.role ?? record.actor?.role ?? record.message?.role ?? null;
  const nativeId = record.session_id ?? record.sessionId ?? record.conversationId ?? ctx.nativeId;
  const session = {
    id: `ses:${ctx.harness}:${nativeId}`, nativeId, harness: ctx.harness, sourceId: ctx.sourceId,
    parentNativeId: record.parent_session_id ?? record.parentSessionId ?? null,
    cwd: record.cwd ?? record.workspace ?? null, startedAt: normalizeTimestamp(record.timestamp ?? record.time).value,
    title: record.title ?? null, harnessVersion: record.version ?? null, model: record.model ?? null, metadata: {},
  };
  if (role || ["user", "assistant", "message"].includes(type)) {
    const isUser = role === "user" || type === "user";
    return [normalized({
      kind: isUser ? "message.user" : "message.agent", subtype: `${ctx.harness}.generic`,
      actor: isUser ? actor("act:user", ACTOR_KINDS.USER, "user") : actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: asText(record.message?.content ?? record.message ?? record.content ?? record.text),
      nativeId: record.id ?? record.uuid ?? null, session, pointer: "/",
    }, record, record)];
  }
  const toolName = record.tool_name ?? record.toolName ?? record.tool?.name ?? record.name;
  if (toolName || type.includes("tool") || record.command) {
    const completed = record.output != null || record.result != null || record.exit_code != null;
    return [normalized({
      kind: completed ? "tool.completed" : "tool.requested", subtype: `${ctx.harness}.generic`,
      actor: completed ? actor(`act:tool:${toolName || "unknown"}`, ACTOR_KINDS.TOOL, "tool") : actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: asText(record.input ?? record.arguments ?? record.command), output: asText(record.output ?? record.result),
      status: completed ? (record.error || record.exit_code > 0 ? "FAILED" : "COMPLETED") : "REQUESTED",
      callId: record.call_id ?? record.callId ?? record.tool_use_id ?? record.id ?? null,
      metadata: { toolName: toolName ?? (record.command ? "shell" : "unknown"), exitCode: record.exit_code ?? record.exitCode ?? null, cwd: record.cwd ?? null },
      artifacts: artifactsFromTool(toolName, record.input ?? record.arguments ?? record), session,
    }, record, record)];
  }
  return [normalized({
    kind: "forensic.unknown_record", subtype: `${ctx.harness}.${type}`,
    actor: actor(`act:harness:${ctx.harness}`, ACTOR_KINDS.SYSTEM, "harness"),
    status: "PRESERVED", session, metadata: { keys: Object.keys(record).sort() },
  }, record, record)];
}

function artifactsFromTool(name, input) {
  const tool = String(name ?? "").toLowerCase();
  const value = typeof input === "string" ? safeJson(input, {}) : input ?? {};
  const paths = [];
  if (["write", "edit", "multiedit", "notebookedit", "apply_patch"].some((part) => tool.includes(part))) {
    for (const key of ["file_path", "path", "notebook_path", "target_file", "filename"]) {
      if (typeof value?.[key] === "string") paths.push(value[key]);
    }
  }
  return [...new Set(paths)].map((filePath) => ({
    path: filePath, operation: tool.includes("write") ? "CREATE_OR_REPLACE" : "UPDATE",
    content: typeof value.content === "string" ? value.content : typeof value.new_string === "string" ? value.new_string : null,
    diff: null,
  }));
}

function outputStatus(output) {
  const value = typeof output === "string" ? safeJson(output, null) : output;
  if (value && typeof value === "object") {
    const code = value.exit_code ?? value.exitCode ?? value.status;
    if (typeof code === "number") return code === 0 ? "COMPLETED" : "FAILED";
    if (value.isError === true || value.error) return "FAILED";
  }
  const text = asText(output);
  if (/\b(script failed|command failed|exit(?:ed)? (?:code|status) [1-9]|isError["']?\s*:\s*true)\b/i.test(text)) return "FAILED";
  return "COMPLETED";
}

function outputMetadata(output) {
  const value = typeof output === "string" ? safeJson(output, {}) : output ?? {};
  return {
    exitCode: typeof value.exit_code === "number" ? value.exit_code : typeof value.exitCode === "number" ? value.exitCode : null,
    durationMs: value.duration_ms ?? value.durationMs ?? null,
  };
}

export function normalizeRecord(record, context) {
  if (context.harness === "codex") return normalizeCodex(record, context);
  if (context.harness === "claude") return normalizeClaude(record, context);
  return normalizeGeneric(record, context);
}

export function inferredSessionFromSource(source, startedAt = null) {
  const nativeId = source.nativeId || path.basename(source.path);
  return {
    id: `ses:${source.harness}:${nativeId}`, nativeId, harness: source.harness,
    sourceId: source.sourceId, parentNativeId: source.stateMetadata?.parentNativeId ?? null,
    cwd: source.stateMetadata?.cwd ?? null, startedAt, title: source.stateMetadata?.title ?? null,
    harnessVersion: source.stateMetadata?.harnessVersion ?? null, model: source.stateMetadata?.model ?? null,
    metadata: { discovery: "source", stateMetadata: source.stateMetadata ?? {} },
  };
}

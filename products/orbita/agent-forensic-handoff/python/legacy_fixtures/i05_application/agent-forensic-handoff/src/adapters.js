import path from "node:path";
import { ACTOR_KINDS, EPISTEMIC } from "./constants.js";
import { asText, normalizeTimestamp, safeJson } from "./util.js";
import { sharedContentText } from "./chatgpt-share.js";

function actor(id, kind, role = null, displayName = null, nativeId = null) {
  return { id, kind, role, displayName, nativeId, epistemic: EPISTEMIC.DIRECT };
}

function timestampOf(record, payload = {}) {
  return normalizeTimestamp(
    record.timestamp
      ?? payload.timestamp
      ?? payload.completed_at_ms
      ?? payload.started_at_ms
      ?? payload.occurred_at_ms
      ?? payload.started_at
      ?? payload.completed_at
      ?? payload.internal_chat_message_metadata_passthrough?.create_time
  );
}

function normalized({
  kind, subtype = null, actor: eventActor, input = "", output = "", status = null,
  nativeId = null, callId = null, turnId = null, phase = null, metadata = {},
  artifacts = [], session = null, sessionEdges = [], pointer = "",
}, record, payload) {
  const time = timestampOf(record, payload);
  const passthroughTurnId = payload?.internal_chat_message_metadata_passthrough?.turn_id
    ?? record?.metadata?.turn_id
    ?? null;
  const enrichedMetadata = {
    ...(record?.ordinal != null ? { codexOrdinal: Number(record.ordinal) } : {}),
    ...(record?.metadata?.client_authored != null ? { clientAuthored: Boolean(record.metadata.client_authored) } : {}),
    ...metadata,
  };
  return {
    kind, subtype, actor: eventActor, input, output, status, nativeId, callId,
    turnId: turnId ?? passthroughTurnId, phase, metadata: enrichedMetadata,
    artifacts, session, sessionEdges, pointer,
    observedAt: time.value, timePrecision: time.value ? time.precision : "ORDER_ONLY",
    epistemic: EPISTEMIC.DIRECT,
  };
}

function contentText(content) {
  if (!Array.isArray(content)) return asText(content);
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return "";
    const t = String(block.type || "").toLowerCase();
    if (["input_text", "output_text", "text", "summary_text", "reasoning_text", "inputtext"].includes(t)) {
      return block.text ?? block.input_text ?? block.output_text ?? block.summary_text ?? "";
    }
    return "";
  }).filter(Boolean).join("\n");
}

function reasoningTextFromPayload(payload = {}) {
  const parts = [];
  if (payload.summary != null) {
    const s = Array.isArray(payload.summary) ? contentText(payload.summary) : asText(payload.summary);
    if (s) parts.push(s);
  }
  if (payload.summary_text != null) {
    const st = Array.isArray(payload.summary_text) ? payload.summary_text.filter(Boolean).join("\n") : asText(payload.summary_text);
    if (st && !parts.includes(st)) parts.push(st);
  }
  if (payload.content != null) {
    const c = Array.isArray(payload.content) ? contentText(payload.content) : asText(payload.content);
    if (c && !parts.includes(c)) parts.push(c);
  }
  if (payload.raw_content != null) {
    const rc = Array.isArray(payload.raw_content) ? payload.raw_content.filter(Boolean).join("\n") : asText(payload.raw_content);
    if (rc && !parts.includes(rc)) parts.push(rc);
  }
  if (payload.text != null) {
    const tx = asText(payload.text);
    if (tx && !parts.includes(tx)) parts.push(tx);
  }
  return parts.join("\n\n").trim();
}

function durationMs(value) {
  if (typeof value === "number") return Math.round(value);
  if (value && typeof value === "object") return Math.round((value.secs ?? 0) * 1000 + (value.nanos ?? 0) / 1_000_000);
  return null;
}

function exactThreadIds(value) {
  const ids = new Set();
  const visit = (node, depth = 0) => {
    if (depth > 8 || node == null) return;
    if (typeof node === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(node)) { ids.add(node); return; }
      try { visit(JSON.parse(node), depth + 1); } catch {}
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if ((key === "threadId" || key === "thread_id") && typeof child === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(child)) ids.add(child);
      else visit(child, depth + 1);
    }
  };
  visit(value);
  return [...ids];
}

function commandFromCompletedItem(item) {
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map((entry) => entry?.cmd).filter(Boolean) : [];
  return parsed.join("\n--- parsed command ---\n") || (Array.isArray(item.command) ? item.command.join(" ") : asText(item.command));
}

export function parseApplyPatchText(rawPatch) {
  const text = typeof rawPatch === "string" ? rawPatch : "";
  if (!text.includes("*** Begin Patch") && !text.includes("*** Update File:") && !text.includes("*** Add File:") && !text.includes("*** Delete File:")) {
    return [];
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const artifacts = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const diffText = current.lines.join("\n").trim();
    const contentTextVal = current.operation === "CREATE"
      ? current.lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n") + "\n"
      : null;
    artifacts.push({
      path: current.movePath || current.path,
      operation: current.operation,
      content: contentTextVal,
      diff: diffText || null,
      movePath: current.movePath || null,
    });
    current = null;
  };
  for (const line of lines) {
    const addMatch = /^\*\*\*\s+Add File:\s+(.+?)\s*$/.exec(line);
    if (addMatch) {
      flush();
      current = { path: addMatch[1].trim(), operation: "CREATE", movePath: null, lines: [] };
      continue;
    }
    const updateMatch = /^\*\*\*\s+Update File:\s+(.+?)\s*$/.exec(line);
    if (updateMatch) {
      flush();
      current = { path: updateMatch[1].trim(), operation: "UPDATE", movePath: null, lines: [] };
      continue;
    }
    const deleteMatch = /^\*\*\*\s+Delete File:\s+(.+?)\s*$/.exec(line);
    if (deleteMatch) {
      flush();
      current = { path: deleteMatch[1].trim(), operation: "DELETE", movePath: null, lines: [] };
      continue;
    }
    const moveMatch = /^\*\*\*\s+Move to:\s+(.+?)\s*$/.exec(line);
    if (moveMatch && current) {
      current.movePath = moveMatch[1].trim();
      current.operation = "MOVE";
      continue;
    }
    if (/^\*\*\*\s+(?:Begin|End)\s+Patch/.test(line)) {
      if (line.includes("End Patch")) flush();
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return artifacts;
}

export function parseCodexExecEnvelope(output) {
  const raw = asText(output);
  if (!raw) return { exitCode: null, durationMs: null, chunkId: null, stdout: "" };
  const exitMatch = /(?:Process exited with code|Exit code:)\s*(-?\d+)/i.exec(raw);
  const wallMatch = /Wall time:\s*([\d.]+)\s*seconds?/i.exec(raw);
  const chunkMatch = /Chunk ID:\s*([^\s\n]+)/i.exec(raw);
  const outSplit = /\nOutput:\r?\n([\s\S]*)$/i.exec(raw);
  return {
    exitCode: exitMatch ? Number(exitMatch[1]) : null,
    durationMs: wallMatch ? Math.round(Number(wallMatch[1]) * 1000) : null,
    chunkId: chunkMatch ? chunkMatch[1] : null,
    stdout: outSplit ? outSplit[1] : raw,
  };
}

function summarizeWorldState(state = {}) {
  if (!state || typeof state !== "object") return "";
  const parts = [];
  if (state.model) parts.push(`model=${typeof state.model === "string" ? state.model : JSON.stringify(state.model)}`);
  if (state.collaboration_mode) {
    const mode = typeof state.collaboration_mode === "string" ? state.collaboration_mode : state.collaboration_mode.mode;
    if (mode) parts.push(`collaboration_mode=${mode}`);
  }
  if (state.personality) {
    const p = typeof state.personality === "string" ? state.personality : state.personality.personality;
    if (p) parts.push(`personality=${p}`);
  }
  if (state.agents_md?.directory) parts.push(`agents_md=${state.agents_md.directory}`);
  if (Array.isArray(state.approved_command_prefixes) && state.approved_command_prefixes.length) {
    parts.push(`approved_prefixes=${state.approved_command_prefixes.map((p) => Array.isArray(p) ? p.join(" ") : p).join(",")}`);
  }
  return parts.join("; ");
}

function normalizeCompletedItem(record, payload, ctx) {
  const item = payload.item ?? {};
  const common = { nativeId: item.id ?? null, turnId: payload.turn_id ?? null };
  if (item.type === "UserMessage" || item.type === "AgentMessage") {
    const isUser = item.type === "UserMessage";
    return [normalized({
      ...common,
      kind: isUser ? "message.user" : "message.agent",
      subtype: `item_completed.${item.type}`,
      actor: isUser ? actor("act:user", ACTOR_KINDS.USER, "user") : actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: contentText(item.content), phase: item.phase ?? null,
      metadata: {
        origin: "event_msg.item_completed",
        userVisible: true,
        ...(item.memory_citation ? { memoryCitation: item.memory_citation } : {}),
      },
      pointer: "/payload/item/content",
    }, record, payload)];
  }
  if (item.type === "Plan") {
    return [normalized({
      ...common,
      kind: "plan.updated",
      subtype: "item_completed.Plan",
      actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: asText(item.text ?? item.content),
      phase: "plan",
      status: "PLANNED",
      metadata: { origin: "event_msg.item_completed", isPlan: true },
      pointer: "/payload/item",
    }, record, payload)];
  }
  if (item.type === "HookPrompt") {
    const text = Array.isArray(item.fragments)
      ? item.fragments.map((f) => f?.text).filter(Boolean).join("\n")
      : asText(item.text ?? item.content);
    return [normalized({
      ...common,
      kind: "external.hook",
      subtype: "item_completed.HookPrompt",
      actor: actor("act:hook:codex", ACTOR_KINDS.HOOK, "hook", "HookPrompt"),
      input: text,
      status: "OBSERVED",
      metadata: { origin: "event_msg.item_completed", fragments: item.fragments?.length ?? 0 },
      pointer: "/payload/item",
    }, record, payload)];
  }
  if (item.type === "Reasoning") {
    const text = reasoningTextFromPayload(item);
    return [normalized({
      ...common, kind: "reasoning.summary", subtype: "item_completed.Reasoning",
      actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: text,
      status: text ? "AVAILABLE" : "UNAVAILABLE",
      metadata: { origin: "event_msg.item_completed", privateReasoningRecoverable: false },
      pointer: "/payload/item",
    }, record, payload)];
  }
  if (item.type === "CommandExecution") {
    const command = commandFromCompletedItem(item);
    return [normalized({
      ...common, callId: item.call_id ?? null, kind: "tool.observed", subtype: "item_completed.CommandExecution",
      actor: actor("act:tool:exec", ACTOR_KINDS.TOOL, "tool", "command execution"),
      input: command, output: item.aggregated_output ?? `${item.stdout ?? ""}${item.stderr ? `\n${item.stderr}` : ""}`,
      status: String(item.status ?? (item.exit_code === 0 ? "completed" : "failed")).toUpperCase(),
      metadata: {
        toolName: "exec", command, exitCode: item.exit_code ?? null,
        cwd: String(item.cwd ?? "").replace(/^file:\/\/\//i, ""), durationMs: durationMs(item.duration),
        processId: item.process_id ?? null, source: item.source ?? null,
        parsedCmds: Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [],
        origin: "event_msg.item_completed",
      },
      pointer: "/payload/item",
    }, record, payload)];
  }
  if (item.type === "DynamicToolCall") {
    const toolName = item.namespace ? `${item.namespace}.${item.tool}` : (item.tool ?? "dynamic_tool");
    const completed = String(item.status || "").toLowerCase() === "completed" && item.success !== false && !item.error;
    return [normalized({
      ...common, kind: "tool.observed", subtype: "item_completed.DynamicToolCall",
      actor: actor(`act:tool:${toolName}`, ACTOR_KINDS.TOOL, "tool", toolName),
      input: JSON.stringify(item.arguments ?? {}),
      output: asText(item.content_items ?? item.error ?? ""),
      status: completed ? "COMPLETED" : "FAILED",
      callId: item.id ?? null,
      metadata: { toolName, namespace: item.namespace ?? null, durationMs: durationMs(item.duration), origin: "event_msg.item_completed" },
      pointer: "/payload/item",
    }, record, payload)];
  }
  if (item.type === "McpToolCall") {
    const completed = String(item.status || "").toLowerCase() === "completed" && item.result?.isError !== true && !item.error;
    const children = completed && ["create_thread", "fork_thread"].includes(item.tool) ? exactThreadIds(item.result) : [];
    return [normalized({
      ...common, kind: "mcp.observed", subtype: item.tool ?? "item_completed.McpToolCall",
      actor: actor(`act:mcp:${item.server || "unknown"}`, ACTOR_KINDS.MCP, "mcp_server", item.server ?? null),
      input: JSON.stringify(item.arguments ?? {}), output: asText(item.result ?? item.error),
      status: completed ? "COMPLETED" : "FAILED", callId: item.id ?? null,
      metadata: { toolName: item.tool ?? "unknown", server: item.server ?? null, durationMs: durationMs(item.duration), origin: "event_msg.item_completed" },
      sessionEdges: children.map((childNativeId) => ({ parentNativeId: payload.thread_id ?? ctx.sessionNativeId, childNativeId, type: item.tool === "fork_thread" ? "FORKED" : "DELEGATED_TASK" })),
      pointer: "/payload/item",
    }, record, payload)];
  }
  if (item.type === "FileChange") {
    const artifacts = Object.entries(item.changes ?? {}).map(([filePath, change]) => ({
      path: filePath, operation: String(change?.type ?? "update").toUpperCase(),
      content: change?.content ?? null, diff: change?.unified_diff ?? null, movePath: change?.move_path ?? null,
    }));
    return [normalized({
      ...common, kind: "filesystem.patch", subtype: "item_completed.FileChange",
      actor: actor("act:tool:apply_patch", ACTOR_KINDS.TOOL, "tool", "apply_patch"),
      input: JSON.stringify(Object.keys(item.changes ?? {})),
      output: `${item.stdout ?? ""}${item.stderr ? `\n${item.stderr}` : ""}`,
      status: String(item.status ?? "completed").toUpperCase(), artifacts,
      metadata: { toolName: "apply_patch", autoApproved: item.auto_approved ?? null, origin: "event_msg.item_completed" },
      pointer: "/payload/item/changes",
    }, record, payload)];
  }
  if (item.type === "ContextCompaction") return [normalized({
    ...common, kind: "session.compacted", subtype: "item_completed.ContextCompaction",
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"), status: "OBSERVED",
  }, record, payload)];
  if (item.type === "FunctionCallOutput") return [normalized({
    ...common, kind: "tool.observed", subtype: "item_completed.FunctionCallOutput",
    actor: actor(`act:tool:${item.name || "unknown"}`, ACTOR_KINDS.TOOL, "tool", item.name ?? null),
    output: asText(item.output), status: outputStatus(item.output),
    metadata: { toolName: item.name ?? "unknown", namespace: item.namespace ?? null, ...outputMetadata(item.output), origin: "event_msg.item_completed" },
    pointer: "/payload/item/output",
  }, record, payload)];
  if (item.type === "WebSearch") return [normalized({
    ...common, kind: "tool.observed", subtype: "item_completed.WebSearch",
    actor: actor("act:tool:web_search", ACTOR_KINDS.SERVICE, "external_service", "web_search"),
    input: item.query ?? JSON.stringify(item.action ?? {}),
    output: JSON.stringify(item.results ?? []),
    status: "COMPLETED",
    metadata: { toolName: "web_search", origin: "event_msg.item_completed" },
    pointer: "/payload/item",
  }, record, payload)];
  if (item.type === "ImageView") return [normalized({
    ...common, kind: "external.image_view", subtype: "item_completed.ImageView",
    actor: actor("act:tool:image_view", ACTOR_KINDS.TOOL, "tool", "image view"),
    input: item.path ?? "", status: "OBSERVED", metadata: { origin: "event_msg.item_completed" },
    pointer: "/payload/item",
  }, record, payload)];
  if (item.type === "ImageGeneration") return [normalized({
    ...common, kind: "tool.observed", subtype: "item_completed.ImageGeneration",
    actor: actor("act:tool:image_generation", ACTOR_KINDS.SERVICE, "external_service", "image_generation"),
    input: item.revised_prompt ?? "", output: asText(item.result),
    status: String(item.status ?? "COMPLETED").toUpperCase(),
    artifacts: item.saved_path ? [{ path: item.saved_path, operation: "CREATE", content: null, diff: null }] : [],
    metadata: { toolName: "image_generation", origin: "event_msg.item_completed" },
    pointer: "/payload/item",
  }, record, payload)];
  if (item.type === "EnteredReviewMode" || item.type === "ExitedReviewMode") {
    return [normalized({
      ...common, kind: "external.review", subtype: `item_completed.${item.type}`,
      actor: actor("act:reviewer:codex", ACTOR_KINDS.REVIEWER, "reviewer", "Codex Review"),
      input: item.user_facing_hint ?? JSON.stringify(item.target ?? {}),
      output: item.review_output ? JSON.stringify(item.review_output) : "",
      status: String(item.review_output?.overall_correctness ?? "OBSERVED").toUpperCase(),
      metadata: { origin: "event_msg.item_completed", reviewOutput: item.review_output ?? null, target: item.target ?? null },
      pointer: "/payload/item",
    }, record, payload)];
  }
  if (item.type === "SubAgentActivity") {
    const childNativeId = item.agent_thread_id ?? null;
    return [normalized({
      ...common, kind: "external.subagent", subtype: item.kind ?? "activity",
      actor: actor(`act:subagent:${childNativeId || item.agent_path || "unknown"}`, ACTOR_KINDS.SUBAGENT, item.agent_path ?? "subagent", item.agent_path ?? null, childNativeId),
      status: String(item.kind ?? "observed").toUpperCase(),
      metadata: { agentThreadId: childNativeId, agentPath: item.agent_path ?? null, origin: "event_msg.item_completed" },
      sessionEdges: childNativeId ? [{ parentNativeId: payload.thread_id ?? ctx.sessionNativeId, childNativeId, type: "SPAWNED" }] : [],
      pointer: "/payload/item",
    }, record, payload)];
  }
  if (item.type === "CollabAgentToolCall") return [normalized({
    ...common, kind: "external.collaboration", subtype: item.tool ?? "collaboration",
    actor: actor("act:tool:collaboration", ACTOR_KINDS.TOOL, "coordination_tool", "collaboration"),
    input: JSON.stringify({ senderThreadId: item.sender_thread_id ?? null, receiverThreadIds: item.receiver_thread_ids ?? [], receiverAgents: item.receiver_agents ?? [], prompt: item.prompt ?? null }),
    output: JSON.stringify(item.agents_states ?? {}), status: String(item.status ?? "observed").toUpperCase(),
    metadata: { toolName: item.tool ?? "collaboration", prompt: item.prompt ?? null, origin: "event_msg.item_completed" },
    pointer: "/payload/item",
  }, record, payload)];
  if (item.type === "Extension") return [normalized({
    ...common, kind: "external.extension", subtype: item.kind ?? "extension",
    actor: actor(`act:service:${item.kind || "extension"}`, ACTOR_KINDS.SERVICE, "external_service", item.kind ?? "extension"),
    input: item.query ?? JSON.stringify(item.action ?? {}), output: JSON.stringify(item.results ?? []), status: "COMPLETED",
    metadata: { toolName: item.kind ?? "extension", resultCount: Array.isArray(item.results) ? item.results.length : null, origin: "event_msg.item_completed" },
    pointer: "/payload/item",
  }, record, payload)];
  return [normalized({
    ...common, kind: "forensic.unknown_record", subtype: `event_msg.item_completed.${item.type || "unknown"}`,
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"), status: "PRESERVED",
    metadata: { keys: Object.keys(item).sort() },
  }, record, payload)];
}

function codexSession(payload, sourceContext) {
  const nativeId = payload.session_id ?? payload.id ?? sourceContext.nativeId;
  return {
    id: `ses:${sourceContext.harness}:${nativeId}`,
    nativeId,
    harness: "codex",
    sourceId: sourceContext.sourceId,
    parentNativeId: payload.parent_thread_id ?? payload.forked_from_id ?? payload.history_base?.thread_id ?? null,
    cwd: payload.cwd ?? sourceContext.stateMetadata?.cwd ?? null,
    startedAt: normalizeTimestamp(payload.timestamp).value,
    title: sourceContext.stateMetadata?.title ?? null,
    harnessVersion: payload.cli_version ?? sourceContext.stateMetadata?.harnessVersion ?? null,
    model: payload.model ?? payload.base_instructions?.provenance?.model ?? sourceContext.stateMetadata?.model ?? null,
    metadata: {
      originator: payload.originator ?? null,
      source: payload.source ?? null,
      threadSource: payload.thread_source ?? null,
      historyMode: payload.history_mode ?? null,
      historyBase: payload.history_base ?? null,
      subagentHistoryStartOrdinal: payload.subagent_history_start_ordinal ?? null,
      contextWindow: payload.context_window ?? null,
      agentPath: payload.agent_path ?? null,
      agentNickname: payload.agent_nickname ?? null,
      agentRole: payload.agent_role ?? payload.agent_type ?? null,
      git: payload.git ?? null,
      memoryMode: payload.memory_mode ?? null,
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
      metadata: {
        origin: "response_item",
        role,
        ...(payload.author ? { author: payload.author } : {}),
        ...(payload.recipient ? { recipient: payload.recipient } : {}),
      },
      pointer: "/payload/content",
    }, record, payload)];
  }
  if (["function_call", "custom_tool_call"].includes(payload.type)) {
    const name = payload.namespace ? `${payload.namespace}.${payload.name}` : payload.name;
    const input = payload.arguments ?? payload.input ?? "";
    const inputText = typeof input === "string" ? input : JSON.stringify(input);
    return [normalized({
      kind: "tool.requested", subtype: payload.type,
      actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: inputText,
      status: payload.status ?? "REQUESTED", nativeId: payload.id ?? null,
      callId: payload.call_id ?? payload.id ?? null,
      metadata: { toolName: name || "unknown", namespace: payload.namespace ?? null },
      artifacts: artifactsFromTool(name, safeJson(input, inputText)), pointer: "/payload",
    }, record, payload)];
  }
  if (payload.type === "local_shell_call") {
    const action = payload.action ?? {};
    const cmd = Array.isArray(action.command) ? action.command.join(" ") : asText(action.command ?? payload.command ?? "");
    return [normalized({
      kind: "tool.requested", subtype: "local_shell_call",
      actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: cmd,
      status: payload.status ?? "REQUESTED",
      nativeId: payload.id ?? null,
      callId: payload.call_id ?? payload.id ?? null,
      metadata: {
        toolName: "local_shell",
        command: cmd,
        cwd: action.working_directory ?? null,
        timeoutMs: action.timeout_ms ?? null,
      },
      pointer: "/payload",
    }, record, payload)];
  }
  if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(payload.type)) {
    return [normalized({
      kind: "tool.completed", subtype: payload.type,
      actor: actor("act:tool:unknown", ACTOR_KINDS.TOOL, "tool"),
      output: contentText(payload.output) || asText(payload.output),
      status: outputStatus(payload.output),
      callId: payload.call_id ?? null, pointer: "/payload/output",
      metadata: outputMetadata(payload.output),
    }, record, payload)];
  }
  if (payload.type === "web_search_call" || payload.type === "tool_search_call") {
    return [normalized({
      kind: "tool.requested", subtype: payload.type,
      actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: JSON.stringify(payload.action ?? payload.query ?? {}),
      status: payload.status ?? "REQUESTED",
      nativeId: payload.id ?? null,
      callId: payload.call_id ?? payload.id ?? null,
      metadata: { toolName: payload.type === "web_search_call" ? "web_search" : "tool_search" },
      pointer: "/payload",
    }, record, payload)];
  }
  if (payload.type === "image_generation_call") {
    return [normalized({
      kind: "tool.completed", subtype: "image_generation_call",
      actor: actor("act:tool:image_generation", ACTOR_KINDS.SERVICE, "external_service", "image_generation"),
      input: payload.revised_prompt ?? "",
      output: asText(payload.result ?? ""),
      status: String(payload.status ?? "COMPLETED").toUpperCase(),
      nativeId: payload.id ?? null,
      callId: payload.call_id ?? payload.id ?? null,
      metadata: { toolName: "image_generation" },
      pointer: "/payload",
    }, record, payload)];
  }
  if (payload.type === "reasoning") {
    const summary = reasoningTextFromPayload(payload);
    return [normalized({
      kind: "reasoning.summary", subtype: "model_exposed_summary",
      actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: summary,
      status: summary ? "AVAILABLE" : "UNAVAILABLE",
      metadata: { encryptedContentPresent: Boolean(payload.encrypted_content), privateReasoningRecoverable: false },
      pointer: summary ? "/payload/summary" : "/payload",
    }, record, payload)];
  }
  if (payload.type === "compaction" || payload.type === "context_compaction") {
    return [normalized({
      kind: "session.compacted", subtype: `response_item.${payload.type}`,
      actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
      status: "OBSERVED",
      metadata: { encryptedContentPresent: Boolean(payload.encrypted_content) },
      pointer: "/payload",
    }, record, payload)];
  }
  return [normalized({
    kind: "forensic.unknown_record", subtype: `response_item.${payload.type || "unknown"}`,
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    status: "PRESERVED", metadata: { keys: Object.keys(payload).sort() },
  }, record, payload)];
}

function codexEventMessage(record, payload, ctx) {
  if (payload.type === "item_completed") return normalizeCompletedItem(record, payload, ctx);
  if (payload.type === "user_message") return [normalized({
    kind: "message.user", subtype: "event_msg", actor: actor("act:user", ACTOR_KINDS.USER, "user"),
    input: payload.message ?? "",
    metadata: {
      origin: "event_msg",
      userVisible: true,
      ...(Array.isArray(payload.local_images) && payload.local_images.length ? { localImages: payload.local_images } : {}),
    },
    pointer: "/payload/message",
  }, record, payload)];
  if (payload.type === "agent_message") return [normalized({
    kind: "message.agent", subtype: "event_msg", actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
    input: payload.message ?? "", phase: payload.phase ?? null,
    metadata: {
      origin: "event_msg",
      userVisible: true,
      ...(payload.memory_citation ? { memoryCitation: payload.memory_citation } : {}),
    },
    pointer: "/payload/message",
  }, record, payload)];
  if (payload.type === "agent_reasoning" || payload.type === "agent_reasoning_raw_content") {
    const text = asText(payload.text ?? payload.message ?? "");
    return [normalized({
      kind: "reasoning.summary", subtype: payload.type,
      actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
      input: text,
      status: text ? "AVAILABLE" : "UNAVAILABLE",
      metadata: { origin: "event_msg", isRawContent: payload.type === "agent_reasoning_raw_content", privateReasoningRecoverable: false },
      pointer: "/payload/text",
    }, record, payload)];
  }
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
    input: payload.query ?? JSON.stringify(payload.action ?? {}),
    output: payload.results ? JSON.stringify(payload.results) : "",
    status: "COMPLETED",
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
  if (["task_started", "task_complete", "turn_started", "turn_complete"].includes(payload.type)) {
    const canonicalType = payload.type === "turn_started" ? "task_started" : payload.type === "turn_complete" ? "task_complete" : payload.type;
    return [normalized({
      kind: `session.${canonicalType}`, subtype: payload.type,
      actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
      status: canonicalType === "task_complete" ? (payload.error ? "FAILED" : "COMPLETED") : "STARTED",
      turnId: payload.turn_id ?? null,
      output: payload.last_agent_message ?? (payload.error ? JSON.stringify(payload.error) : ""),
      metadata: {
        durationMs: payload.duration_ms ?? null,
        timeToFirstTokenMs: payload.time_to_first_token_ms ?? null,
        collaborationModeKind: payload.collaboration_mode_kind ?? null,
        error: payload.error ?? null,
      },
    }, record, payload)];
  }
  if (payload.type === "turn_aborted") {
    return [normalized({
      kind: "session.turn_aborted", subtype: "turn_aborted",
      actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
      status: String(payload.reason || "INTERRUPTED").toUpperCase(),
      turnId: payload.turn_id ?? null,
      input: String(payload.reason || "interrupted"),
      metadata: { reason: payload.reason ?? "interrupted", durationMs: payload.duration_ms ?? null },
      pointer: "/payload",
    }, record, payload)];
  }
  if (payload.type === "thread_rolled_back") {
    const numTurns = Number(payload.num_turns ?? 1);
    return [normalized({
      kind: "session.rolled_back", subtype: "thread_rolled_back",
      actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
      status: "ROLLED_BACK",
      input: `Rolled back ${numTurns} turn(s)`,
      metadata: { numTurns },
      pointer: "/payload",
    }, record, payload)];
  }
  if (payload.type === "thread_goal_updated") {
    const goal = payload.goal ?? {};
    return [normalized({
      kind: "session.goal_updated", subtype: "thread_goal_updated",
      actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
      status: String(goal.status ?? "ACTIVE").toUpperCase(),
      turnId: payload.turnId ?? payload.turn_id ?? null,
      input: asText(goal.objective ?? ""),
      metadata: { goal },
      pointer: "/payload/goal",
    }, record, payload)];
  }
  if (payload.type === "entered_review_mode" || payload.type === "exited_review_mode") {
    return [normalized({
      kind: "external.review", subtype: payload.type,
      actor: actor("act:reviewer:codex", ACTOR_KINDS.REVIEWER, "reviewer", "Codex Review"),
      turnId: payload.turn_id ?? null,
      input: payload.user_facing_hint ?? JSON.stringify(payload.target ?? {}),
      output: payload.review_output ? JSON.stringify(payload.review_output) : "",
      status: String(payload.review_output?.overall_correctness ?? "OBSERVED").toUpperCase(),
      metadata: { reviewOutput: payload.review_output ?? null, target: payload.target ?? null },
      pointer: "/payload",
    }, record, payload)];
  }
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
    status: "OBSERVED", metadata: { info: payload.info ?? null, rateLimits: payload.rate_limits ?? null }, pointer: "/payload/info",
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
      sessionEdges: session.parentNativeId ? [{ parentNativeId: session.parentNativeId, childNativeId: session.nativeId, type: payload.forked_from_id ? "FORKED" : payload.history_base ? "REVERTED_OR_FORKED" : "CHILD" }] : [],
      metadata: session.metadata,
    }, record, payload)];
  }
  if (record.type === "turn_context") return [normalized({
    kind: "session.turn_context", subtype: "codex", actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    status: "OBSERVED", turnId: payload.turn_id ?? null,
    metadata: {
      cwd: payload.cwd ?? null,
      model: payload.model ?? null,
      timezone: payload.timezone ?? null,
      effort: payload.effort ?? null,
      approvalPolicy: payload.approval_policy ?? null,
      sandboxPolicy: payload.sandbox_policy ?? null,
      collaborationMode: payload.collaboration_mode ?? null,
      summaryPresent: Boolean(payload.summary),
    },
    input: payload.summary ?? "", pointer: payload.summary ? "/payload/summary" : "/payload",
  }, record, payload)];
  if (record.type === "world_state") {
    const stateSummary = summarizeWorldState(payload.state ?? {});
    return [normalized({
      kind: "session.world_state", subtype: "codex", actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
      status: "OBSERVED",
      input: stateSummary,
      metadata: {
        full: payload.full ?? null,
        keys: Object.keys(payload.state ?? {}).sort(),
        stateSnapshot: payload.state ?? {},
      },
    }, record, payload)];
  }
  if (record.type === "response_item") return codexResponseItem(record, payload, ctx);
  if (record.type === "event_msg") return codexEventMessage(record, payload, ctx);
  if (record.type === "compacted") return [normalized({
    kind: "session.compacted", subtype: "replacement_history",
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    input: typeof payload.replacement_history === "string"
      ? payload.replacement_history
      : asText(payload.message ?? payload.replacement_history ?? ""),
    status: "OBSERVED",
    metadata: {
      windowId: payload.window_id ?? null,
      previousWindowId: payload.previous_window_id ?? null,
      windowNumber: payload.window_number ?? null,
      replacementItemCount: Array.isArray(payload.replacement_history) ? payload.replacement_history.length : null,
    },
    pointer: "/payload/replacement_history",
  }, record, payload)];
  if (record.type === "token_usage_record") return [normalized({
    kind: "telemetry.token_usage", subtype: "token_usage_record",
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"), status: "OBSERVED",
    turnId: payload.turn_id ?? null,
    metadata: {
      responseId: payload.response_id ?? null, usage: payload.usage ?? null,
      turnTokenUsage: payload.turn_token_usage ?? null, threadTokenUsage: payload.thread_token_usage ?? null,
    },
    pointer: "/payload",
  }, record, payload)];
  if (record.type === "realtime_item") {
    if (payload.type === "transcript_segment") {
      const isUser = payload.role === "user";
      return [normalized({
        kind: "realtime.transcript", subtype: payload.type,
        actor: isUser ? actor("act:user", ACTOR_KINDS.USER, "user") : actor("act:agent:primary", ACTOR_KINDS.AGENT, payload.role ?? "assistant"),
        input: payload.text ?? "", nativeId: payload.id ?? null,
        metadata: { realtimeSessionId: payload.realtime_session_id ?? null, role: payload.role ?? null },
        pointer: "/payload/text",
      }, record, payload)];
    }
    return [normalized({
      kind: "realtime.session", subtype: payload.type ?? "unknown",
      actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
      status: payload.outcome ?? (payload.type === "realtime_session_closed" ? "CLOSED" : "OBSERVED"),
      nativeId: payload.id ?? null,
      metadata: { realtimeSessionId: payload.realtime_session_id ?? null, itemId: payload.item_id ?? null, presentation: payload.presentation ?? null },
      pointer: "/payload",
    }, record, payload)];
  }
  if (record.type === "inter_agent_communication") {
    return [normalized({
      kind: "external.collaboration", subtype: "inter_agent_communication",
      actor: actor(`act:subagent:${payload.sender || payload.author || "inter_agent"}`, ACTOR_KINDS.SUBAGENT, "subagent"),
      input: asText(payload.message ?? payload.content ?? payload),
      status: "OBSERVED",
      metadata: { sender: payload.sender ?? payload.author ?? null, recipient: payload.recipient ?? null },
      pointer: "/payload",
    }, record, payload)];
  }
  if (record.type === "inter_agent_communication_metadata") return [normalized({
    kind: "telemetry.inter_agent", subtype: "inter_agent_communication_metadata",
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"), status: "OBSERVED",
    metadata: { triggerTurn: payload.trigger_turn ?? null }, pointer: "/payload",
  }, record, payload)];
  if (record.type === "security_risk_score") return [normalized({
    kind: "telemetry.security_risk", subtype: "security_risk_score",
    actor: actor("act:harness:codex", ACTOR_KINDS.SYSTEM, "harness"),
    status: String(payload.level ?? payload.risk_level ?? "OBSERVED").toUpperCase(),
    metadata: payload, pointer: "/payload",
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
      else if (block.type === "thinking") {
        const text = asText(block.thinking ?? block.text ?? "");
        events.push(normalized({
          kind: "reasoning.summary", subtype: "claude.thinking",
          actor: actor("act:agent:primary", ACTOR_KINDS.AGENT, "assistant"),
          input: text,
          status: text ? "AVAILABLE" : "UNAVAILABLE",
          nativeId: record.uuid ?? null,
          metadata: { origin: "claude-transcript", signaturePresent: Boolean(block.signature), privateReasoningRecoverable: false },
          session, pointer: "/message/content",
        }, record, record));
      }
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
  if (typeof input === "string") {
    const patchArtifacts = parseApplyPatchText(input);
    if (patchArtifacts.length) return patchArtifacts;
  }
  const value = typeof input === "string" ? safeJson(input, {}) : input ?? {};
  if (typeof value?.patch === "string" || typeof value?.input === "string") {
    const patchArtifacts = parseApplyPatchText(value.patch ?? value.input);
    if (patchArtifacts.length) return patchArtifacts;
  }
  const paths = [];
  if (["write", "edit", "multiedit", "notebookedit", "apply_patch", "strreplace"].some((part) => tool.includes(part))) {
    for (const key of ["file_path", "path", "notebook_path", "target_file", "filename", "filePath"]) {
      if (typeof value?.[key] === "string") paths.push(value[key]);
    }
  }
  return [...new Set(paths)].map((filePath) => ({
    path: filePath, operation: tool.includes("write") ? "CREATE_OR_REPLACE" : "UPDATE",
    content: typeof value.content === "string" ? value.content : typeof value.new_string === "string" ? value.new_string : typeof value.newString === "string" ? value.newString : null,
    diff: null,
  }));
}

function outputStatus(output) {
  const value = typeof output === "string" ? safeJson(output, null) : output;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const code = value.exit_code ?? value.exitCode ?? value.status;
    if (typeof code === "number") return code === 0 ? "COMPLETED" : "FAILED";
    if (value.isError === true || value.error) return "FAILED";
  }
  const envelope = parseCodexExecEnvelope(output);
  if (typeof envelope.exitCode === "number") {
    return envelope.exitCode === 0 ? "COMPLETED" : "FAILED";
  }
  const text = asText(output);
  if (/\b(script failed|command failed|exit(?:ed)? (?:with )?(?:code|status) [1-9]|isError["']?\s*:\s*true)\b/i.test(text)) return "FAILED";
  return "COMPLETED";
}

function outputMetadata(output) {
  const value = typeof output === "string" ? safeJson(output, {}) : output ?? {};
  const envelope = parseCodexExecEnvelope(output);
  return {
    exitCode: typeof value.exit_code === "number" ? value.exit_code
      : typeof value.exitCode === "number" ? value.exitCode
      : envelope.exitCode,
    durationMs: value.duration_ms ?? value.durationMs ?? envelope.durationMs ?? null,
    ...(envelope.chunkId ? { chunkId: envelope.chunkId } : {}),
  };
}

export function normalizeRecord(record, context) {
  if (context.harness === "document") {
    if (!["afh.document.header","afh.document.block"].includes(record.type) || typeof record.session_id !== "string") throw new Error("DOCUMENT_RECORD_FORMAT");
    return [normalized({kind:record.type === "afh.document.block" ? "document.text" : "session.meta", subtype:record.type,
      actor:actor("act:document",ACTOR_KINDS.SYSTEM,"document"),input:record.type === "afh.document.block" ? record.text : "",nativeId:record.id ?? "document-header",status:"PRESERVED",
      session:{id:`ses:document:${record.session_id}`,nativeId:record.session_id,harness:"document",sourceId:context.sourceId,metadata:{authorship:"document_not_authenticated_human"}},
      metadata:{originalByteStart:record.start ?? null,originalByteEnd:record.end ?? null},pointer:"/text"},record,{})];
  }
  if (context.harness === "chatgpt-import") return normalizeConversationImport(record, context);
  if (context.harness === "chatgpt-share") return normalizeChatGPTShare(record, context);
  if (context.harness === "codex") return normalizeCodex(record, context);
  if (context.harness === "claude") return normalizeClaude(record, context);
  return normalizeGeneric(record, context);
}

function normalizeChatGPTShare(record, ctx) {
  const m=record.node?.message, role=m?.author?.role;
  const nativeId=record.shareId||record.capture?.shareId||ctx.nativeId;
  const session={id:`ses:chatgpt-share:${nativeId}`,nativeId,harness:'chatgpt-share',parentNativeId:null,cwd:null,startedAt:null,title:record.title||record.conversation?.title||null,harnessVersion:null,model:m?.metadata?.model_slug||null,metadata:{origin:'chatgpt-share',coverage:'PUBLISHED_SNAPSHOT_ONLY'}};
  if(!m)return [normalized({kind:record.type==='chatgpt.share_capture'?'session.meta':'session.context',subtype:record.type,actor:actor('act:harness:chatgpt-share',ACTOR_KINDS.SYSTEM,'harness'),input:record.capture?JSON.stringify(record.capture):'',nativeId:record.node?.id||null,status:'PRESERVED',session,metadata:{origin:'chatgpt-share',nodeId:record.node?.id||null,parentNodeId:record.node?.parent||null},pointer:'/'},record,{})];
  const toolRequest=role==='assistant'&&m.recipient&&m.recipient!=='all';
  const toolResult=role==='tool';
  const publishedRationale=['thoughts','reasoning_recap'].includes(m.content.content_type);
  const kind=publishedRationale?'reasoning.visible':m.content.content_type==='model_editable_context'?'session.context':toolResult?'tool.observed':toolRequest?'tool.requested':role==='user'?'message.user':role==='assistant'?'message.agent':'session.context';
  const text=sharedContentText(m.content);
  const eventActor=role==='user'?actor('act:user',ACTOR_KINDS.USER,role):toolResult?actor(`act:tool:${m.author.name||'unknown'}`,ACTOR_KINDS.TOOL,role):role==='assistant'?actor('act:agent:primary',ACTOR_KINDS.AGENT,role):actor(`act:harness:chatgpt-share:${role}`,ACTOR_KINDS.SYSTEM,role);
  const result=normalized({kind,subtype:`chatgpt-share.${m.content.content_type||'unknown'}`,actor:eventActor,input:toolResult?'':text,output:toolResult?text:'',status:toolRequest?'REQUESTED':'OBSERVED',nativeId:m.id,callId:toolRequest?m.id:record.requestMessageId,turnId:m.metadata?.turn_exchange_id||null,phase:m.channel||null,session,pointer:'/node/message',metadata:{origin:'chatgpt-share',nodeId:record.node.id,parentNodeId:record.node.parent||null,childNodeIds:record.node.children||[],publishedStatus:m.status||null,recipient:m.recipient||null,channel:m.channel||null,hiddenInPublishedUI:Boolean(m.metadata?.is_visually_hidden_from_conversation),toolName:toolResult?m.author.name:toolRequest?m.recipient:null,correlationBasis:record.requestMessageId?'published_parent_edge':null,sourceUrl:record.sourceUrl,publishedPointer:record.pointer,contentType:m.content.content_type}}, {timestamp:m.create_time}, {});
  result.metadata.scope=record.scope??'unknown';
  result.metadata.branchId=record.branchId??null;
  if(record.scope && record.scope!=='active') {result.kind='forensic.alternative';result.status='PRESERVED';result.callId=null;}
  if(publishedRationale)result.epistemic=EPISTEMIC.INFERRED;
  return [result];
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

function normalizeConversationImport(record, ctx) {
  const imported={...record,shareId:record.conversationId};
  const results=normalizeChatGPTShare(imported,ctx);
  for(const result of results) {
    result.session={...result.session,id:`ses:${record.conversationId}`,nativeId:record.conversationId,harness:'chatgpt-import',metadata:{origin:'chatgpt-import',coverage:record.coverage}};
    result.metadata={...result.metadata,origin:'chatgpt-import',scope:record.scope??'context',branchId:record.branchId??null,representationOnly:Boolean(record.representationOnly),identityConflict:Boolean(record.identityConflict)};
    result.subtype=record.type;
    if(record.type==='afh.conversation.header'){result.kind='session.meta';result.input=JSON.stringify(record.conversation);}
    if(record.node && record.scope!=='active' || record.representationOnly) {
      result.kind='forensic.alternative';result.status='PRESERVED';result.callId=null;
    }
  }
  return results;
}

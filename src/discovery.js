import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodedLines } from "./evidence.js";
import { expandHome, walkFiles } from "./util.js";

const SESSION_EXTENSIONS = [".jsonl", ".jsonl.zst", ".jsonl.gz", ".ndjson"];

function isSessionFile(filePath) {
  return SESSION_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function existingVariant(filePath) {
  const candidates = [filePath, `${filePath}.zst`, `${filePath}.gz`];
  if (filePath.endsWith(".zst")) candidates.push(filePath.slice(0, -4));
  if (filePath.endsWith(".gz")) candidates.push(filePath.slice(0, -3));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function sniffHarness(filePath) {
  if (/[/\\]\.codex[/\\]|[/\\]codex[/\\]/i.test(filePath)) return "codex";
  if (/[/\\]\.claude[/\\]/i.test(filePath)) return "claude";
  if (/[/\\](?:antigravity|\.gemini)[/\\]/i.test(filePath)) return "antigravity";
  try {
    for await (const { line } of decodedLines(filePath)) {
      const record = JSON.parse(line);
      if (["session_meta", "turn_context", "world_state", "response_item", "event_msg", "token_usage_record", "realtime_item", "inter_agent_communication_metadata", "compacted"].includes(record?.type)) return "codex";
      if (record?.sessionId && ["user", "assistant", "system", "progress", "summary", "file-history-snapshot"].includes(record?.type)) return "claude";
      if (record?.conversationId || record?.transcriptPath || record?.artifactDirectory) return "antigravity";
      return "generic";
    }
  } catch {}
  return "generic";
}

function codexStateFiles(codexHome) {
  return walkFiles(codexHome, (file) => /^state_.*\.sqlite$/.test(path.basename(file)), 100);
}

function retainNewest(rows, row) {
  const previous = rows.get(row.id);
  const timestamp = Number(row.updated_at_ms ?? row.updated_at ?? 0);
  const previousTimestamp = Number(previous?.updated_at_ms ?? previous?.updated_at ?? -1);
  if (!previous || timestamp >= previousTimestamp) rows.set(row.id, row);
}

function readCodexState(codexHome, identifier, includeChildren, maxChildSessions) {
  const dbFiles = codexStateFiles(codexHome);
  const rows = new Map();
  const edges = [];
  const warnings = [];
  const warnedChildren = new Set();
  for (const dbFile of dbFiles) {
    let db;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      if (!tables.has("threads")) continue;
      const matches = db.prepare("SELECT * FROM threads WHERE id = ? OR id LIKE ? ORDER BY updated_at_ms DESC").all(identifier, `${identifier}%`);
      for (const row of matches) retainNewest(rows, { ...row, _state_db: dbFile });
      if (includeChildren && tables.has("thread_spawn_edges")) {
        const queue = [...rows.keys()];
        const seen = new Set(queue);
        const sourceLimit = maxChildSessions + matches.length;
        while (queue.length) {
          const parent = queue.shift();
          const children = db.prepare("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges WHERE parent_thread_id = ?").all(parent);
          for (const edge of children) {
            edges.push(edge);
            if (seen.has(edge.child_thread_id)) continue;
            if (seen.size >= sourceLimit) {
              if (!warnedChildren.has(edge.child_thread_id)) warnings.push(`Child session limit reached (${maxChildSessions}); ${edge.child_thread_id} was not acquired.`);
              warnedChildren.add(edge.child_thread_id);
              continue;
            }
            seen.add(edge.child_thread_id);
            queue.push(edge.child_thread_id);
            const child = db.prepare("SELECT * FROM threads WHERE id = ?").get(edge.child_thread_id);
            if (child) retainNewest(rows, { ...child, _state_db: dbFile });
          }
        }
      }
    } catch {}
    finally { try { db?.close(); } catch {} }
  }
  return { rows: [...rows.values()], edges, warnings };
}

function findCodexStateRow(codexHome, identifier) {
  const candidates = new Map();
  for (const dbFile of codexStateFiles(codexHome)) {
    let db;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      const hasThreads = db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='threads'").get();
      if (!hasThreads) continue;
      const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(identifier);
      if (row) retainNewest(candidates, { ...row, _state_db: dbFile });
    } catch {}
    finally { try { db?.close(); } catch {} }
  }
  return candidates.get(identifier) ?? null;
}

function returnedThreadIds(result) {
  const ids = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) { ids.add(value); return; }
      try { visit(JSON.parse(value), depth + 1); } catch {}
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "threadId" || key === "thread_id") && typeof child === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(child)) ids.add(child);
      else visit(child, depth + 1);
    }
  };
  visit(result);
  return [...ids];
}

async function observedCodexDelegations(source) {
  const edges = [];
  for await (const decoded of decodedLines(source.path)) {
    if (!decoded.line.includes('"item_completed"') || (!decoded.line.includes('"create_thread"') && !decoded.line.includes('"fork_thread"') && !decoded.line.includes('"SubAgentActivity"'))) continue;
    let record;
    try { record = JSON.parse(decoded.line); } catch { continue; }
    const payload = record?.type === "event_msg" && record?.payload?.type === "item_completed" ? record.payload : null;
    const item = payload?.item;
    const isTaskCreation = item?.type === "McpToolCall" && ["create_thread", "fork_thread"].includes(item.tool)
      && String(item.status || "").toLowerCase() === "completed" && item.result?.isError !== true;
    const isSubagentStart = item?.type === "SubAgentActivity" && item.kind === "started" && typeof item.agent_thread_id === "string";
    if (!isTaskCreation && !isSubagentStart) continue;
    const children = isSubagentStart ? [item.agent_thread_id] : returnedThreadIds(item.result);
    for (const child of children) {
      if (child === (payload.thread_id || source.nativeId)) continue;
      edges.push({
        parent_thread_id: payload.thread_id || source.nativeId,
        child_thread_id: child,
        status: isSubagentStart ? "OBSERVED_STARTED" : "OBSERVED_COMPLETED",
        edge_type: isSubagentStart ? "SPAWNED" : item.tool === "fork_thread" ? "FORKED" : "DELEGATED_TASK",
        discovery: `event_msg.item_completed:${isSubagentStart ? "SubAgentActivity" : item.tool}`,
        source_record_ordinal: decoded.ordinal,
      });
    }
  }
  return edges;
}

function sourceFromStateRow(row) {
  const resolved = existingVariant(expandHome(row.rollout_path));
  if (!resolved) return null;
  return {
    path: path.resolve(resolved),
    nativeId: row.id,
    harness: "codex",
    kind: "codex-rollout",
    stateMetadata: {
      cwd: row.cwd ?? null,
      title: row.title ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      parentNativeId: null,
      harnessVersion: row.cli_version ?? null,
      model: row.model ?? null,
      agentPath: row.agent_path ?? null,
      gitSha: row.git_sha ?? null,
      gitBranch: row.git_branch ?? null,
      gitOriginUrl: row.git_origin_url ?? null,
      stateDb: row._state_db,
    },
  };
}

async function discoverCodex(identifier, options) {
  const codexHome = expandHome(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const maxChildSessions = Number(options.maxChildSessions ?? 32);
  const fromState = readCodexState(codexHome, identifier, options.includeChildren, maxChildSessions);
  const sources = fromState.rows.map(sourceFromStateRow).filter(Boolean);
  const warnings = [...fromState.warnings];
  if (!sources.length) {
    const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const file of walkFiles(root, (candidate) => isSessionFile(candidate) && path.basename(candidate).includes(identifier))) {
        sources.push({ path: file, nativeId: identifier, harness: "codex", kind: "codex-rollout", stateMetadata: {} });
      }
    }
  }
  const sourceByNativeId = new Map(sources.map((source) => [source.nativeId, source]));
  const edgeByPair = new Map(fromState.edges.map((edge) => [`${edge.parent_thread_id}\0${edge.child_thread_id}`, edge]));
  if (options.includeChildren && sources.length) {
    const queue = [...sources];
    let includedChildren = Math.max(0, sources.length - 1);
    const warnedChildren = new Set();
    while (queue.length) {
      const parentSource = queue.shift();
      for (const edge of await observedCodexDelegations(parentSource)) {
        const key = `${edge.parent_thread_id}\0${edge.child_thread_id}`;
        if (!edgeByPair.has(key)) edgeByPair.set(key, edge);
        if (sourceByNativeId.has(edge.child_thread_id)) continue;
        if (includedChildren >= maxChildSessions) {
          if (!warnedChildren.has(edge.child_thread_id)) warnings.push(`Child session limit reached (${maxChildSessions}); ${edge.child_thread_id} was not acquired.`);
          warnedChildren.add(edge.child_thread_id);
          continue;
        }
        const row = findCodexStateRow(codexHome, edge.child_thread_id);
        const childSource = row ? sourceFromStateRow(row) : null;
        if (!childSource) {
          if (!warnedChildren.has(edge.child_thread_id)) warnings.push(`Directly observed child ${edge.child_thread_id} could not be resolved to an accessible rollout.`);
          warnedChildren.add(edge.child_thread_id);
          continue;
        }
        sourceByNativeId.set(childSource.nativeId, childSource);
        sources.push(childSource);
        queue.push(childSource);
        includedChildren += 1;
      }
    }
  }
  return { codexHome, sources, edges: [...edgeByPair.values()], warnings };
}

function discoverClaude(identifier, options) {
  const root = expandHome(options.claudeHome || path.join(os.homedir(), ".claude"));
  const projectRoot = path.join(root, "projects");
  const sources = fs.existsSync(projectRoot)
    ? walkFiles(projectRoot, (file) => isSessionFile(file) && path.basename(file).includes(identifier))
      .map((file) => ({ path: file, nativeId: identifier, harness: "claude", kind: "claude-transcript", stateMetadata: {} }))
    : [];
  return { sources, edges: [] };
}

function discoverAntigravity(identifier, options) {
  const roots = [
    expandHome(options.antigravityHome || path.join(os.homedir(), ".gemini", "antigravity")),
    path.join(os.homedir(), ".antigravity"),
  ];
  const sources = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walkFiles(root, (candidate) => isSessionFile(candidate) && path.basename(candidate).includes(identifier))) {
      sources.push({ path: file, nativeId: identifier, harness: "antigravity", kind: "antigravity-transcript", stateMetadata: {} });
    }
  }
  return { sources, edges: [] };
}

export async function resolveSession(identifier, options = {}) {
  const requestedHarness = options.harness || "auto";
  const expanded = expandHome(identifier);
  if (fs.existsSync(expanded)) {
    const stat = fs.lstatSync(expanded);
    if (stat.isSymbolicLink() && !options.allowSymlink) throw new Error("Refusing a symlink source; pass --allow-symlink to acknowledge it");
    const files = stat.isDirectory() ? walkFiles(expanded, isSessionFile) : [expanded];
    if (!files.length) throw new Error(`No supported transcript files found at ${expanded}`);
    const sources = [];
    for (const file of files) {
      const harness = requestedHarness === "auto" ? await sniffHarness(file) : requestedHarness;
      sources.push({ path: path.resolve(file), nativeId: path.basename(file).replace(/\.(?:jsonl(?:\.zst|\.gz)?|ndjson)$/i, ""), harness, kind: `${harness}-transcript`, stateMetadata: {} });
    }
    return {
      requestedIdentifier: identifier,
      rootNativeId: sources[0].nativeId,
      harness: requestedHarness === "auto" ? sources[0].harness : requestedHarness,
      sources,
      edges: [],
      warnings: sources.length > 1 ? ["Explicit directory import: session relationships are included only when source records expose them."] : [],
    };
  }

  const attempts = requestedHarness === "auto" ? ["codex", "claude", "antigravity"] : [requestedHarness];
  for (const harness of attempts) {
    const result = harness === "codex" ? await discoverCodex(identifier, options)
      : harness === "claude" ? discoverClaude(identifier, options)
        : harness === "antigravity" ? discoverAntigravity(identifier, options)
          : { sources: [], edges: [] };
    const exactIds = new Set(result.sources.map((source) => source.nativeId));
    if (result.sources.length) {
      if (exactIds.size > 1 && !exactIds.has(identifier) && !options.allowPrefix) {
        throw new Error(`Session prefix is ambiguous (${[...exactIds].slice(0, 8).join(", ")}); provide the full ID or --allow-prefix`);
      }
      const rootNativeId = exactIds.has(identifier) ? identifier : result.sources[0].nativeId;
      return { requestedIdentifier: identifier, rootNativeId, harness, sources: result.sources, edges: result.edges, warnings: result.warnings ?? [] };
    }
  }
  throw new Error(`Unable to resolve session '${identifier}'. Supply an exact native ID or transcript path.`);
}

export async function inspectSource(filePath) {
  const stat = fs.statSync(filePath);
  return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, harness: await sniffHarness(filePath) };
}

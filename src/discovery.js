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
      if (["session_meta", "turn_context", "world_state", "response_item", "event_msg", "compacted"].includes(record?.type)) return "codex";
      if (record?.sessionId && ["user", "assistant", "system", "progress", "summary", "file-history-snapshot"].includes(record?.type)) return "claude";
      if (record?.conversationId || record?.transcriptPath || record?.artifactDirectory) return "antigravity";
      return "generic";
    }
  } catch {}
  return "generic";
}

function readCodexState(codexHome, identifier, includeChildren) {
  const dbFiles = walkFiles(codexHome, (file) => /^state_.*\.sqlite$/.test(path.basename(file)), 100);
  const rows = new Map();
  const edges = [];
  for (const dbFile of dbFiles) {
    let db;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      if (!tables.has("threads")) continue;
      const matches = db.prepare("SELECT * FROM threads WHERE id = ? OR id LIKE ? ORDER BY updated_at_ms DESC").all(identifier, `${identifier}%`);
      for (const row of matches) rows.set(row.id, { ...row, _state_db: dbFile });
      if (includeChildren && tables.has("thread_spawn_edges")) {
        const queue = [...rows.keys()];
        const seen = new Set(queue);
        while (queue.length) {
          const parent = queue.shift();
          const children = db.prepare("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges WHERE parent_thread_id = ?").all(parent);
          for (const edge of children) {
            edges.push(edge);
            if (seen.has(edge.child_thread_id)) continue;
            seen.add(edge.child_thread_id);
            queue.push(edge.child_thread_id);
            const child = db.prepare("SELECT * FROM threads WHERE id = ?").get(edge.child_thread_id);
            if (child) rows.set(child.id, { ...child, _state_db: dbFile });
          }
        }
      }
    } catch {}
    finally { try { db?.close(); } catch {} }
  }
  return { rows: [...rows.values()], edges };
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
      gitSha: row.git_sha ?? null,
      gitBranch: row.git_branch ?? null,
      gitOriginUrl: row.git_origin_url ?? null,
      stateDb: row._state_db,
    },
  };
}

function discoverCodex(identifier, options) {
  const codexHome = expandHome(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const fromState = readCodexState(codexHome, identifier, options.includeChildren);
  const sources = fromState.rows.map(sourceFromStateRow).filter(Boolean);
  if (!sources.length) {
    const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const file of walkFiles(root, (candidate) => isSessionFile(candidate) && path.basename(candidate).includes(identifier))) {
        sources.push({ path: file, nativeId: identifier, harness: "codex", kind: "codex-rollout", stateMetadata: {} });
      }
    }
  }
  return { codexHome, sources, edges: fromState.edges };
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
    const result = harness === "codex" ? discoverCodex(identifier, options)
      : harness === "claude" ? discoverClaude(identifier, options)
        : harness === "antigravity" ? discoverAntigravity(identifier, options)
          : { sources: [], edges: [] };
    const exactIds = new Set(result.sources.map((source) => source.nativeId));
    if (result.sources.length) {
      if (exactIds.size > 1 && !exactIds.has(identifier) && !options.allowPrefix) {
        throw new Error(`Session prefix is ambiguous (${[...exactIds].slice(0, 8).join(", ")}); provide the full ID or --allow-prefix`);
      }
      const rootNativeId = exactIds.has(identifier) ? identifier : result.sources[0].nativeId;
      return { requestedIdentifier: identifier, rootNativeId, harness, sources: result.sources, edges: result.edges, warnings: [] };
    }
  }
  throw new Error(`Unable to resolve session '${identifier}'. Supply an exact native ID or transcript path.`);
}

export async function inspectSource(filePath) {
  const stat = fs.statSync(filePath);
  return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, harness: await sniffHarness(filePath) };
}

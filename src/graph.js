import path from "node:path";
import { CaseDatabase } from "./database.js";
import { DEFAULTS } from "./constants.js";
import { sha256, stableStringify } from "./util.js";

const HARD_MAX_HOPS = DEFAULTS.maxGraphHops;
const HARD_MAX_NODES = 5_000;

export function graphNeighbors(caseDir, nodeId, options = {}) {
  const direction = String(options.direction || "both").toLowerCase();
  if (!["in", "out", "both"].includes(direction)) throw new Error("direction must be in, out, or both");
  const hops = boundedInteger(options.hops ?? DEFAULTS.graphHops, "hops", 1, HARD_MAX_HOPS);
  const maxNodes = boundedInteger(options.maxNodes ?? DEFAULTS.maxGraphNodes, "maxNodes", 1, HARD_MAX_NODES);
  const edgeTypes = normalizeTypes(options.edgeTypes);
  const db = new CaseDatabase(path.join(path.resolve(caseDir), "case.sqlite"), { readOnly: true });
  try {
    const start = describeNode(db, nodeId);
    if (!start) throw new Error(`Graph node not found: ${nodeId}`);
    const allEdges = loadGraphEdges(db).filter((edge) => !edgeTypes.size || edgeTypes.has(edge.edgeType));
    const visited = new Set([nodeId]);
    let frontier = new Set([nodeId]);
    const selected = new Map();
    let truncated = false;
    for (let depth = 1; depth <= hops && frontier.size; depth += 1) {
      const next = new Set();
      for (const edge of allEdges) {
        const candidates = [];
        if ((direction === "out" || direction === "both") && frontier.has(edge.fromNodeId)) candidates.push(edge.toNodeId);
        if ((direction === "in" || direction === "both") && frontier.has(edge.toNodeId)) candidates.push(edge.fromNodeId);
        for (const target of candidates) {
          if (!visited.has(target) && visited.size >= maxNodes) { truncated = true; continue; }
          selected.set(edgeIdentity(edge), { ...edge, traversalDepth: depth });
          if (!visited.has(target)) { visited.add(target); next.add(target); }
        }
      }
      frontier = next;
    }
    const nodes = [...visited].sort().map((id) => describeNode(db, id)).filter(Boolean);
    return {
      rootNodeId: nodeId, direction, requestedHops: hops, maxNodes,
      visitedCount: nodes.length, truncated, nodes,
      edges: [...selected.values()].sort(compareEdges),
    };
  } finally { db.close(); }
}

export function graphPath(caseDir, fromNodeId, toNodeId, options = {}) {
  const maxHops = boundedInteger(options.maxHops ?? 6, "maxHops", 1, HARD_MAX_HOPS);
  const maxNodes = boundedInteger(options.maxNodes ?? DEFAULTS.maxGraphNodes, "maxNodes", 2, HARD_MAX_NODES);
  const direction = String(options.direction || "out").toLowerCase();
  if (!["in", "out", "both"].includes(direction)) throw new Error("direction must be in, out, or both");
  const edgeTypes = normalizeTypes(options.edgeTypes);
  const db = new CaseDatabase(path.join(path.resolve(caseDir), "case.sqlite"), { readOnly: true });
  try {
    if (!describeNode(db, fromNodeId)) throw new Error(`Graph node not found: ${fromNodeId}`);
    if (!describeNode(db, toNodeId)) throw new Error(`Graph node not found: ${toNodeId}`);
    if (fromNodeId === toNodeId) return { fromNodeId, toNodeId, found: true, path: [], visitedCount: 1, truncated: false };
    const edges = loadGraphEdges(db).filter((edge) => !edgeTypes.size || edgeTypes.has(edge.edgeType));
    const queue = [{ node: fromNodeId, path: [] }];
    const visited = new Set([fromNodeId]);
    let truncated = false;
    while (queue.length) {
      const current = queue.shift();
      if (current.path.length >= maxHops) continue;
      for (const edge of edges) {
        const steps = [];
        if ((direction === "out" || direction === "both") && edge.fromNodeId === current.node) steps.push({ next: edge.toNodeId, edge });
        if ((direction === "in" || direction === "both") && edge.toNodeId === current.node) steps.push({ next: edge.fromNodeId, edge: { ...edge, traversedReverse: true } });
        for (const step of steps) {
          const candidatePath = [...current.path, { ...step.edge, traversalDepth: current.path.length + 1 }];
          if (step.next === toNodeId) {
            return { fromNodeId, toNodeId, found: true, path: candidatePath, visitedCount: visited.size + (visited.has(step.next) ? 0 : 1), truncated };
          }
          if (visited.has(step.next)) continue;
          if (visited.size >= maxNodes) { truncated = true; continue; }
          visited.add(step.next);
          queue.push({ node: step.next, path: candidatePath });
        }
      }
    }
    return { fromNodeId, toNodeId, found: false, path: [], visitedCount: visited.size, truncated };
  } finally { db.close(); }
}

export function computeGraphIdentity(db) {
  const edges = loadGraphEdges(db).map((edge) => ({
    sourceTable: edge.sourceTable, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId,
    fromNodeKind: edge.fromNodeKind, toNodeKind: edge.toNodeKind, edgeType: edge.edgeType,
    grade: edge.grade, ruleId: edge.ruleId, epistemicStatus: edge.epistemicStatus,
    evidenceEventId: edge.evidenceEventId, metadata: edge.metadata,
  }));
  return sha256(stableStringify(edges));
}

export function loadGraphEdges(db) {
  const edges = [];
  if (tableExists(db, "event_edge")) {
    const columns = tableColumns(db, "event_edge");
    for (const row of db.all("SELECT * FROM event_edge ORDER BY from_event_id,to_event_id,edge_type")) {
      edges.push(normalizeEdge({
        sourceTable: "event_edge", fromNodeId: row.from_event_id, toNodeId: row.to_event_id,
        fromNodeKind: "EVENT", toNodeKind: "EVENT", edgeType: row.edge_type,
        grade: row.grade, ruleId: row.rule_id, epistemicStatus: row.epistemic_status,
        evidenceEventId: columns.has("evidence_event_id") ? row.evidence_event_id : row.to_event_id,
        metadataJson: columns.has("metadata_json") ? row.metadata_json : "{}",
      }));
    }
  }
  if (tableExists(db, "session_edge")) {
    const columns = tableColumns(db, "session_edge");
    for (const row of db.all("SELECT * FROM session_edge ORDER BY parent_session_id,child_session_id,edge_type")) {
      edges.push(normalizeEdge({
        sourceTable: "session_edge", fromNodeId: row.parent_session_id, toNodeId: row.child_session_id,
        fromNodeKind: "SESSION", toNodeKind: "SESSION", edgeType: row.edge_type,
        grade: columns.has("grade") ? row.grade : "EXPLICIT",
        ruleId: columns.has("rule_id") ? row.rule_id : "native-session-edge",
        epistemicStatus: row.epistemic_status, evidenceEventId: row.evidence_event_id,
        metadataJson: columns.has("metadata_json") ? row.metadata_json : "{}",
      }));
    }
  }
  if (tableExists(db, "entity_edge")) {
    for (const row of db.all("SELECT * FROM entity_edge ORDER BY from_node_id,to_node_id,edge_type,rule_id")) {
      edges.push(normalizeEdge({
        sourceTable: "entity_edge", fromNodeId: row.from_node_id, toNodeId: row.to_node_id,
        fromNodeKind: row.from_node_kind, toNodeKind: row.to_node_kind, edgeType: row.edge_type,
        grade: row.grade, ruleId: row.rule_id, epistemicStatus: row.epistemic_status,
        evidenceEventId: row.evidence_event_id, metadataJson: row.metadata_json,
      }));
    }
  }
  return edges.sort(compareEdges);
}

function normalizeEdge(edge) {
  let metadata = {};
  try { metadata = JSON.parse(edge.metadataJson || "{}"); } catch { metadata = { invalidMetadata: true }; }
  return {
    sourceTable: edge.sourceTable, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId,
    fromNodeKind: edge.fromNodeKind, toNodeKind: edge.toNodeKind, edgeType: edge.edgeType,
    grade: edge.grade || "UNAVAILABLE", ruleId: edge.ruleId || null,
    epistemicStatus: edge.epistemicStatus || "UNAVAILABLE",
    evidenceEventId: edge.evidenceEventId || null, metadata,
  };
}

function describeNode(db, nodeId) {
  const lookups = [
    ["EVENT", "SELECT id,kind AS label,status FROM event WHERE id=$id"],
    ["SESSION", "SELECT id,COALESCE(title,native_id) AS label,NULL AS status FROM session WHERE id=$id"],
    ["ARTIFACT", "SELECT id,logical_path AS label,current_status AS status FROM artifact WHERE id=$id"],
    ["VALIDATION", "SELECT id,target AS label,status FROM validation WHERE id=$id"],
    ["CLAIM", "SELECT id,predicate AS label,epistemic_status AS status FROM claim WHERE id=$id"],
    ["TASK", "SELECT id,text AS label,state AS status FROM task WHERE id=$id"],
    ["DECISION", "SELECT id,decision_text AS label,status FROM decision_record WHERE id=$id"],
  ];
  for (const [kind, sql] of lookups) {
    if (!tableExists(db, tableForNodeKind(kind))) continue;
    const row = db.get(sql, { id: nodeId });
    if (row) return { id: row.id, kind, label: row.label, status: row.status ?? null };
  }
  return null;
}

function tableForNodeKind(kind) {
  return ({ EVENT: "event", SESSION: "session", ARTIFACT: "artifact", VALIDATION: "validation", CLAIM: "claim", TASK: "task", DECISION: "decision_record" })[kind];
}

function tableExists(db, name) {
  return Boolean(db.get("SELECT 1 ok FROM sqlite_master WHERE type IN ('table','view') AND name=$name", { name }));
}

function tableColumns(db, name) {
  return new Set(db.all(`PRAGMA table_info(${name})`).map((row) => row.name));
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

function normalizeTypes(value) {
  if (value == null || value === "") return new Set();
  const values = Array.isArray(value) ? value : String(value).split(",");
  return new Set(values.map((item) => String(item).trim().toUpperCase()).filter(Boolean));
}

function edgeIdentity(edge) {
  return `${edge.sourceTable}\0${edge.fromNodeId}\0${edge.toNodeId}\0${edge.edgeType}\0${edge.ruleId || ""}`;
}

function compareEdges(a, b) {
  return edgeIdentity(a).localeCompare(edgeIdentity(b));
}

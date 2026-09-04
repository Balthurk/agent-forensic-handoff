import path from "node:path";
import { CaseDatabase } from "./database.js";
import { loadGraphEdges } from "./graph.js";
import { loadManifest, readEvidence, searchCase } from "./render.js";
import { semanticSearch } from "./semantic.js";
import { SemanticUnavailableError } from "./semantic-model.js";
import { sha256, stableStringify } from "./util.js";

const RRF_K = 60;
const MAX_CANDIDATES = 1_000;
const MAX_GRAPH_SEEDS = 12;
const MAX_GRAPH_HOPS = 4;
const MAX_GRAPH_NODES = 500;

export async function queryCase(caseDir, terms, options = {}) {
  const root = path.resolve(caseDir);
  const query = String(terms || "").trim();
  if (!query) throw new Error("Search terms are required");
  const mode = String(options.mode || "lexical").toLowerCase();
  if (!["lexical", "semantic", "hybrid"].includes(mode)) throw new Error("mode must be lexical, semantic, or hybrid");
  const limit = boundedInteger(options.limit ?? 25, "limit", 1, 1_000);
  const filters = normalizeFilters(root, options);
  const candidateLimit = Math.min(MAX_CANDIDATES, Math.max(limit * 20, 100));
  const lexical = () => lexicalCandidates(root, query, candidateLimit, filters);

  if (mode === "lexical") {
    const results = lexical().slice(0, limit);
    const assessment = assessRetrieval(root, results);
    return envelope({ root, query, modeRequested: mode, modeEffective: mode, results, filters, assessment, lexicalCount: results.length });
  }

  let semantic;
  try {
    semantic = await semanticSearch(root, query, {
      provider: options.provider,
      projectionDir: options.projectionDir,
      modelHome: options.modelHome,
      limit: candidateLimit,
      filters,
      minSimilarity: options.minSimilarity,
    });
  } catch (error) {
    if (!(error instanceof SemanticUnavailableError) && error?.code !== "SEMANTIC_UNAVAILABLE") throw error;
    if (options.allowLexicalFallback === true) {
      const results = lexical().slice(0, limit);
      const assessment = assessRetrieval(root, results, [`Semantic mode unavailable: ${error.message}`]);
      return envelope({
        root, query, modeRequested: mode, modeEffective: "lexical-fallback", results, filters,
        assessment, lexicalCount: results.length, fallbackReason: error.message,
      });
    }
    return envelope({
      root, query, modeRequested: mode, modeEffective: "unavailable", results: [], filters,
      assessment: { status: "UNAVAILABLE", gaps: [error.message], note: "The requested semantic mode did not run; no fallback was applied." },
      semanticProjection: null,
    });
  }

  if (mode === "semantic") {
    const results = semantic.results.slice(0, limit);
    const assessment = assessRetrieval(root, results, semanticCoverageGaps(semantic));
    return envelope({
      root, query, modeRequested: mode, modeEffective: mode, results, filters, assessment,
      semanticProjection: semantic, semanticCount: semantic.results.length,
    });
  }

  const lexicalResults = lexical();
  const fused = fuseHybrid(root, lexicalResults, semantic.results, {
    limit,
    graphHops: boundedInteger(options.graphHops ?? 1, "graphHops", 0, MAX_GRAPH_HOPS),
    maxGraphNodes: boundedInteger(options.maxGraphNodes ?? 250, "maxGraphNodes", 1, MAX_GRAPH_NODES),
  });
  const assessment = assessRetrieval(root, fused.results, semanticCoverageGaps(semantic));
  return envelope({
    root, query, modeRequested: mode, modeEffective: mode, results: fused.results, filters, assessment,
    lexicalCount: lexicalResults.length, semanticCount: semantic.results.length,
    semanticProjection: semantic, graph: fused.graph,
  });
}

function lexicalCandidates(caseDir, query, limit, filters) {
  const raw = searchCase(caseDir, query, limit);
  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    const results = [];
    let rank = 0;
    for (const event of raw) {
      rank += 1;
      const actor = event.actor_id ? db.get("SELECT kind,role FROM actor WHERE id=$id", { id: event.actor_id }) : null;
      const candidate = { ...event, actor_kind: actor?.kind ?? null, actor_role: actor?.role ?? null };
      if (!passesEventFilters(candidate, filters)) continue;
      results.push({
        ...candidate,
        explanation: {
          lexicalRank: rank,
          lexicalContribution: rrf(rank),
          note: "FTS5 retrieval rank; evidence must still be opened for consequential use.",
        },
      });
    }
    return results;
  } finally { db.close(); }
}

function fuseHybrid(caseDir, lexicalResults, semanticResults, { limit, graphHops, maxGraphNodes }) {
  const candidates = new Map();
  lexicalResults.forEach((event, index) => {
    const item = candidate(candidates, event);
    item.explanation.lexicalRank = index + 1;
    item.explanation.lexicalContribution = rrf(index + 1);
  });
  semanticResults.forEach((event, index) => {
    const item = candidate(candidates, event);
    item.explanation.vectorRank = event.explanation.vectorRank || index + 1;
    item.explanation.vectorDistance = event.explanation.cosineDistance;
    item.explanation.vectorSimilarity = event.explanation.cosineSimilarity;
    item.explanation.vectorContribution = rrf(index + 1);
    item.explanation.semanticChunkId = event.semanticChunkId;
  });

  const graph = graphHops > 0 ? expandGraph(caseDir, candidates, graphHops, maxGraphNodes) : { hops: 0, visitedNodes: 0, truncated: false, addedEvents: 0 };
  const results = [...candidates.values()].map((item) => {
    const explanation = item.explanation;
    explanation.fusedScore = (explanation.lexicalContribution || 0) + (explanation.vectorContribution || 0) + (explanation.graphContribution || 0);
    explanation.fusion = `reciprocal-rank-fusion(k=${RRF_K})`;
    explanation.note = "Scores express retrieval contribution only, never truth confidence.";
    return { ...item.event, explanation };
  }).sort((a, b) => b.explanation.fusedScore - a.explanation.fusedScore || a.id.localeCompare(b.id)).slice(0, limit);
  return { results, graph };
}

function expandGraph(caseDir, candidates, hops, maxNodes) {
  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    const edges = loadGraphEdges(db);
    const seeds = [...candidates.values()]
      .sort((a, b) => ((b.explanation.lexicalContribution || 0) + (b.explanation.vectorContribution || 0)) - ((a.explanation.lexicalContribution || 0) + (a.explanation.vectorContribution || 0)) || a.event.id.localeCompare(b.event.id))
      .slice(0, MAX_GRAPH_SEEDS);
    const visited = new Set(seeds.map((seed) => seed.event.id));
    let frontier = seeds.map((seed, index) => ({ nodeId: seed.event.id, seedRank: index + 1, path: [] }));
    let addedEvents = 0;
    let truncated = false;
    for (let depth = 1; depth <= hops && frontier.length; depth += 1) {
      const next = [];
      for (const state of frontier) {
        for (const edge of edges) {
          let target = null;
          let traversedReverse = false;
          if (edge.fromNodeId === state.nodeId) target = edge.toNodeId;
          else if (edge.toNodeId === state.nodeId) { target = edge.fromNodeId; traversedReverse = true; }
          if (!target || visited.has(target)) continue;
          if (visited.size >= maxNodes) { truncated = true; continue; }
          visited.add(target);
          const pathStep = { ...edge, traversedReverse, traversalDepth: depth };
          const pathValue = [...state.path, pathStep];
          const event = db.get("SELECT e.*,a.kind actor_kind,a.role actor_role FROM event e LEFT JOIN actor a ON a.id=e.actor_id WHERE e.id=$id", { id: target });
          if (event) {
            event.evidence = db.all("SELECT id,uri,json_pointer,availability FROM evidence_ref WHERE event_id=$id ORDER BY id", { id: target });
            const item = candidate(candidates, event);
            const contribution = rrf(state.seedRank + depth * 10);
            if (!item.explanation.graphContribution || contribution > item.explanation.graphContribution) {
              item.explanation.graphContribution = contribution;
              item.explanation.graphPath = pathValue;
            }
            addedEvents += 1;
          }
          next.push({ nodeId: target, seedRank: state.seedRank, path: pathValue });
        }
      }
      frontier = next;
    }
    return { hops, visitedNodes: visited.size, truncated, addedEvents };
  } finally { db.close(); }
}

function candidate(candidates, event) {
  let item = candidates.get(event.id);
  if (!item) {
    item = { event, explanation: {} };
    candidates.set(event.id, item);
  }
  return item;
}

function assessRetrieval(caseDir, results, additionalGaps = []) {
  const manifest = loadManifest(caseDir);
  const gaps = [...additionalGaps];
  if (Number(manifest.metrics?.unparsedRecords || 0) > 0) gaps.push(`${manifest.metrics.unparsedRecords} unparsed record(s) exist`);
  if (Number(manifest.metrics?.warnings || 0) > 0) gaps.push(`${manifest.metrics.warnings} parser/source warning(s) exist`);
  for (const warning of manifest.sourceResolutionWarnings || []) gaps.push(`Source/session coverage warning: ${warning}`);
  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    const unavailableRefs = Number(db.get("SELECT COUNT(*) n FROM evidence_ref WHERE availability<>'AVAILABLE'")?.n ?? 0);
    if (unavailableRefs) gaps.push(`${unavailableRefs} evidence reference(s) are unavailable`);
    const uncovered = Number(db.get(`SELECT COUNT(*) n FROM source_record sr WHERE NOT EXISTS
      (SELECT 1 FROM evidence_ref er WHERE er.source_id=sr.source_id AND er.record_ordinal=sr.ordinal)`)?.n ?? 0);
    if (uncovered) gaps.push(`${uncovered} source record(s) lack evidence references`);
  } finally { db.close(); }

  let evidenceFailures = 0;
  for (const result of results) {
    const ref = result.evidence?.find((item) => item.availability == null || item.availability === "AVAILABLE");
    if (!ref) { evidenceFailures += 1; continue; }
    try { readEvidence(caseDir, ref.uri); } catch { evidenceFailures += 1; }
  }
  if (evidenceFailures) gaps.push(`${evidenceFailures} selected result(s) failed exact evidence resolution`);
  const uniqueGaps = [...new Set(gaps)];
  if (results.length && evidenceFailures === 0) {
    return {
      status: "VERIFIED_PRESENT",
      gaps: uniqueGaps,
      note: "Matching material is present in hash-verified captured evidence; this does not prove that a natural-language claim inside it is true.",
    };
  }
  if (results.length) return { status: "INCONCLUSIVE_COVERAGE", gaps: uniqueGaps, note: "Candidates exist, but exact evidence resolution or coverage is incomplete." };
  if (uniqueGaps.length) return { status: "INCONCLUSIVE_COVERAGE", gaps: uniqueGaps, note: "No candidate was observed, but captured evidence or projection coverage is incomplete." };
  return {
    status: "NOT_OBSERVED_IN_CAPTURED_EVIDENCE",
    gaps: [],
    note: "No candidate was observed inside the checked captured evidence. This is not verified absent (VERIFIED_ABSENT) and does not prove universal absence.",
  };
}

function envelope({ root, query, modeRequested, modeEffective, results, filters, assessment, lexicalCount = 0, semanticCount = 0, semanticProjection = null, graph = null, fallbackReason = null }) {
  const projectionSummary = semanticProjection ? {
    projectionId: semanticProjection.projectionId,
    model: semanticProjection.model,
    coverage: semanticProjection.coverage,
    minSimilarity: semanticProjection.minSimilarity,
  } : null;
  return {
    modeRequested,
    modeEffective,
    results,
    assessment,
    receipt: {
      schemaVersion: 1,
      querySha256: sha256(query),
      caseHash: loadManifest(root).caseHash,
      modeRequested,
      modeEffective,
      filters,
      lexicalCandidates: lexicalCount,
      semanticCandidates: semanticCount,
      semanticProjection: projectionSummary,
      graph,
      fallbackReason,
      resultIds: results.map((result) => result.id),
      resultSetSha256: sha256(stableStringify(results.map((result) => ({ id: result.id, evidence: result.evidence?.map((ref) => ref.uri) || [] })))),
      warning: "Retrieval scores rank candidates; they are not confidence in truth. Open show/evidence before consequential reliance.",
    },
  };
}

function normalizeFilters(caseDir, options) {
  let session = options.session || null;
  if (session) {
    const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
    try {
      const row = db.get("SELECT id FROM session WHERE id=$id OR native_id=$id ORDER BY CASE WHEN id=$id THEN 0 ELSE 1 END LIMIT 1", { id: session });
      session = row?.id || `UNRESOLVED_SESSION:${session}`;
    } finally { db.close(); }
  }
  return {
    session,
    kind: options.kind || null,
    status: options.status || null,
    actor: options.actor || null,
    from: normalizeOptionalTime(options.from, "from"),
    to: normalizeOptionalTime(options.to, "to"),
    evidence: options.evidence === true || String(options.evidence || "").toLowerCase() === "available",
  };
}

function passesEventFilters(event, filters) {
  if (filters.session && event.session_id !== filters.session) return false;
  if (filters.kind && event.kind !== filters.kind) return false;
  if (filters.status && String(event.status || "") !== String(filters.status)) return false;
  if (filters.actor && event.actor_kind !== filters.actor && event.actor_role !== filters.actor) return false;
  if (filters.from && (!event.observed_at || event.observed_at < filters.from)) return false;
  if (filters.to && (!event.observed_at || event.observed_at > filters.to)) return false;
  if (filters.evidence && !event.evidence?.some((ref) => ref.availability == null || ref.availability === "AVAILABLE")) return false;
  return true;
}

function semanticCoverageGaps(semantic) {
  return semantic.coverage?.chunks === 0 ? ["Semantic projection contains no eligible chunks"] : [];
}

function normalizeOptionalTime(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

function rrf(rank) { return 1 / (RRF_K + Number(rank)); }

import path from "node:path";
import { CaseDatabase } from "./database.js";
import { loadGraphEdges } from "./graph.js";
import { loadManifest, readEvidence } from "./render.js";
import { semanticSearch } from "./semantic.js";
import { SemanticUnavailableError } from "./semantic-model.js";
import { evaluateEntityAtBiTemporalCut, evaluateFactAtBiTemporalCut, resolveBiTemporalCut } from "./bitemporal-graph.js";
import { safeJson, sha256, stableStringify } from "./util.js";

const RRF_K = 60;
const MAX_CANDIDATES = 10_000;
const MAX_GRAPH_SEEDS = 12;
const MAX_GRAPH_HOPS = 4;
const MAX_GRAPH_NODES = 500;

export async function queryCase(caseDir, terms, options = {}) {
  const root = path.resolve(caseDir);
  const query = String(terms || "").trim();
  if (!query) throw new Error("Search terms are required");
  const mode = String(options.mode || "lexical").toLowerCase();
  if (!["lexical", "semantic", "hybrid"].includes(mode)) throw new Error("mode must be lexical, semantic, or hybrid");
  const rerank = String(options.rerank || "rrf").toLowerCase();
  if (!["rrf", "mmr", "mentions", "node-distance"].includes(rerank)) {
    throw new Error("rerank must be rrf, mmr, mentions, or node-distance");
  }
  const limit = boundedInteger(options.limit ?? 25, "limit", 1, 1_000);
  const filters = normalizeFilters(root, options);
  const candidateLimit = Math.min(MAX_CANDIDATES, Math.max(limit * 40, 250));
  const lexical = () => lexicalCandidates(root, query, candidateLimit, filters);
  const temporalMatches = searchTemporalGraph(root, query, filters, limit);

  if (mode === "lexical") {
    const rawResults = lexical();
    const reranked = applyReranker(root, rawResults, {
      rerank,
      limit,
      centerNodeId: options.centerNodeId,
      mmrLambda: options.mmrLambda,
    });
    const assessment = assessRetrieval(root, reranked);
    return envelope({
      root, query, modeRequested: mode, modeEffective: mode, results: reranked, filters, assessment,
      lexicalCount: rawResults.length, temporalMatches, rerank,
    });
  }

  let semantic;
  try {
    semantic = await semanticSearch(root, query, {
      provider: options.provider,
      projectionDir: options.projectionDir,
      modelHome: options.modelHome,
      // The vector engine admits at most 1000 candidates, even when the
      // public query result limit makes the lexical oversampling pool larger.
      limit: Math.min(candidateLimit, 1_000),
      filters,
      minSimilarity: options.minSimilarity,
    });
  } catch (error) {
    if (!(error instanceof SemanticUnavailableError) && error?.code !== "SEMANTIC_UNAVAILABLE") throw error;
    if (options.allowLexicalFallback === true) {
      const rawResults = lexical();
      const results = applyReranker(root, rawResults, {
        rerank,
        limit,
        centerNodeId: options.centerNodeId,
        mmrLambda: options.mmrLambda,
      });
      const assessment = assessRetrieval(root, results, [`Semantic mode unavailable: ${error.message}`]);
      return envelope({
        root, query, modeRequested: mode, modeEffective: "lexical-fallback", results, filters,
        assessment, lexicalCount: rawResults.length, fallbackReason: error.message,
        temporalMatches, rerank,
      });
    }
    return envelope({
      root, query, modeRequested: mode, modeEffective: "unavailable", results: [], filters,
      assessment: { status: "UNAVAILABLE", gaps: [error.message], note: "The requested semantic mode did not run; no fallback was applied." },
      semanticProjection: null, temporalMatches, rerank,
    });
  }

  const filteredSemanticResults = filterAndAnnotateTemporal(root, semantic.results, filters);

  if (mode === "semantic") {
    const results = applyReranker(root, filteredSemanticResults, {
      rerank,
      limit,
      centerNodeId: options.centerNodeId,
      mmrLambda: options.mmrLambda,
    });
    const assessment = assessRetrieval(root, results, semanticCoverageGaps(semantic));
    return envelope({
      root, query, modeRequested: mode, modeEffective: mode, results, filters, assessment,
      semanticProjection: semantic, semanticCount: filteredSemanticResults.length,
      temporalMatches, rerank,
    });
  }

  const lexicalResults = lexical();
  const fused = fuseHybrid(root, lexicalResults, filteredSemanticResults, {
    limit: candidateLimit,
    graphHops: boundedInteger(options.graphHops ?? 1, "graphHops", 0, MAX_GRAPH_HOPS),
    maxGraphNodes: boundedInteger(options.maxGraphNodes ?? 250, "maxGraphNodes", 1, MAX_GRAPH_NODES),
    filters,
  });
  const finalResults = applyReranker(root, fused.results, {
    rerank,
    limit,
    centerNodeId: options.centerNodeId,
    mmrLambda: options.mmrLambda,
  });
  const assessment = assessRetrieval(root, finalResults, semanticCoverageGaps(semantic));
  return envelope({
    root, query, modeRequested: mode, modeEffective: mode, results: finalResults, filters, assessment,
    lexicalCount: lexicalResults.length, semanticCount: filteredSemanticResults.length,
    semanticProjection: semantic, graph: fused.graph, temporalMatches, rerank,
  });
}

function buildFtsMatchQuery(query, operator = "AND") {
  const tokens = String(query)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`);
  return tokens.join(` ${operator} `);
}

function lexicalCandidates(caseDir, query, limit, filters) {
  if (filters.session && String(filters.session).startsWith("UNRESOLVED_SESSION:")) {
    return [];
  }
  const ftsQuery = buildFtsMatchQuery(query, "AND");
  if (!ftsQuery) return [];
  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    const maxOrd = maxOrdinalFromFilters(filters);
    const raw = db.all(
      `SELECT e.*, a.kind AS actor_kind, a.role AS actor_role
       FROM event_fts f
       JOIN event e ON e.id = f.event_id
       LEFT JOIN actor a ON a.id = e.actor_id
       WHERE event_fts MATCH $query
         AND ($session IS NULL OR e.session_id = $session)
         AND ($kind IS NULL OR e.kind = $kind)
         AND ($status IS NULL OR e.status = $status)
         AND ($from IS NULL OR (e.observed_at IS NOT NULL AND e.observed_at >= $from))
         AND ($to IS NULL OR (e.observed_at IS NOT NULL AND e.observed_at <= $to))
         AND ($maxOrd IS NULL OR e.record_ordinal <= $maxOrd)
       ORDER BY COALESCE(e.observed_at,''), e.source_id, e.record_ordinal`,
      {
        query: ftsQuery,
        session: filters.session || null,
        kind: filters.kind || null,
        status: filters.status || null,
        from: filters.from || null,
        to: filters.to || null,
        maxOrd,
      },
    );

    const eventValidityMap = buildEventValidityMap(db, filters.biTemporalCut);
    const results = [];
    let rank = 0;
    for (const event of raw) {
      rank += 1;
      const evidence = db.all("SELECT id,uri,json_pointer,availability FROM evidence_ref WHERE event_id=$id ORDER BY id", { id: event.id });
      const validityInfo = eventValidityMap.get(event.id) || { validityStatus: "VIGENTE", facts: [] };
      const candidate = {
        ...event,
        evidence,
        temporal_validity: validityInfo.validityStatus,
        temporal_facts: validityInfo.facts,
      };
      if (!passesEventFilters(candidate, filters)) continue;
      results.push({
        ...candidate,
        explanation: {
          lexicalRank: rank,
          lexicalContribution: rrf(rank),
          temporalValidity: validityInfo.validityStatus,
          note: "FTS5 retrieval rank; evidence must still be opened for consequential use.",
        },
      });
      if (results.length >= limit) break;
    }
    return results;
  } finally { db.close(); }
}

function filterAndAnnotateTemporal(caseDir, events, filters) {
  if (filters.session && String(filters.session).startsWith("UNRESOLVED_SESSION:")) {
    return [];
  }
  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    const eventValidityMap = buildEventValidityMap(db, filters.biTemporalCut);
    const out = [];
    for (const ev of events) {
      const validityInfo = eventValidityMap.get(ev.id) || { validityStatus: "VIGENTE", facts: [] };
      const annotated = {
        ...ev,
        temporal_validity: validityInfo.validityStatus,
        temporal_facts: validityInfo.facts,
      };
      if (!passesEventFilters(annotated, filters)) continue;
      out.push(annotated);
    }
    return out;
  } finally {
    db.close();
  }
}

function buildEventValidityMap(db, biTemporalCut) {
  const map = new Map();
  const hasFactTable = db.get("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='temporal_fact'");
  if (!hasFactTable) return map;

  const facts = db.all("SELECT * FROM temporal_fact ORDER BY valid_from_ordinal ASC, id ASC");
  for (const f of facts) {
    const evalResult = biTemporalCut?.hasCut
      ? evaluateFactAtBiTemporalCut(f, biTemporalCut)
      : { included: true, effectiveValidity: f.validity_status };
    if (!evalResult.included) continue;
    const effectiveStatus = evalResult.effectiveValidity;
    const entry = map.get(f.source_event_id) || { validityStatus: "VIGENTE", facts: [] };
    entry.facts.push({
      id: f.id,
      predicate: f.predicate,
      factText: f.fact_text,
      validityStatus: effectiveStatus,
      validAt: f.valid_at,
      invalidAt: f.invalid_at,
      createdAt: f.created_at,
      expiredAt: f.expired_at,
      validFromOrdinal: f.valid_from_ordinal,
      invalidAtOrdinal: f.invalid_at_ordinal,
    });
    if (effectiveStatus !== "VIGENTE" && entry.facts.every((item) => item.validityStatus !== "VIGENTE")) {
      entry.validityStatus = effectiveStatus;
    } else if (entry.facts.some((item) => item.validityStatus === "VIGENTE")) {
      entry.validityStatus = "VIGENTE";
    }
    map.set(f.source_event_id, entry);
  }

  const maxOrd = biTemporalCut?.validAtBound?.maxOrdinal ?? biTemporalCut?.knownAtBound?.maxOrdinal ?? biTemporalCut?.asOfBound?.maxOrdinal ?? null;
  const rbEdges = db.all("SELECT from_event_id, to_event_id, edge_type FROM event_edge WHERE edge_type IN ('ROLLED_BACK_BY','ABORTED_BY')");
  for (const edge of rbEdges) {
    if (maxOrd != null) {
      const targetEv = db.get("SELECT record_ordinal FROM event WHERE id=$id", { id: edge.to_event_id });
      if (targetEv && targetEv.record_ordinal > maxOrd) continue;
    }
    const entry = map.get(edge.from_event_id) || { validityStatus: "VIGENTE", facts: [] };
    entry.validityStatus = edge.edge_type === "ROLLED_BACK_BY" ? "ROLLED_BACK" : "INVALIDATED_BY_FAILURE";
    map.set(edge.from_event_id, entry);
  }

  return map;
}

export function searchTemporalGraph(caseDir, query, filters = {}, limit = 25) {
  if (filters.session && String(filters.session).startsWith("UNRESOLVED_SESSION:")) {
    return { entities: [], facts: [] };
  }
  const ftsQuery = buildFtsMatchQuery(query, "OR");
  if (!ftsQuery) return { entities: [], facts: [] };

  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    const hasEntityFts = db.get("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='entity_fts'");
    const hasFactFts = db.get("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='fact_fts'");
    const cut = filters.biTemporalCut || resolveBiTemporalCut(db, {
      asOf: filters.asOf,
      validAt: filters.validAt,
      knownAt: filters.knownAt,
    });
    const maxOrd = maxOrdinalFromFilters({ ...filters, biTemporalCut: cut });

    let entities = [];
    if (hasEntityFts) {
      const rawEntities = db.all(
        `SELECT en.*
         FROM entity_fts ef
         JOIN entity_node en ON en.id = ef.entity_id
         WHERE entity_fts MATCH $query
           AND ($session IS NULL OR EXISTS (
             SELECT 1 FROM entity_mention em WHERE em.entity_id = en.id AND em.session_id = $session
           ))
           AND ($maxOrd IS NULL OR COALESCE(en.first_ordinal, 0) <= $maxOrd)
           AND ($from IS NULL OR en.last_seen_at IS NULL OR en.last_seen_at >= $from)
           AND ($to IS NULL OR en.first_seen_at IS NULL OR en.first_seen_at <= $to)
         ORDER BY en.mention_count DESC, COALESCE(en.first_ordinal, 0) ASC`,
        {
          query: ftsQuery,
          session: filters.session || null,
          maxOrd,
          from: filters.from || null,
          to: filters.to || null,
        },
      );
      entities = rawEntities
        .filter((en) => (cut.hasCut ? evaluateEntityAtBiTemporalCut(en, cut) : true))
        .slice(0, limit);
    }

    let facts = [];
    if (hasFactFts) {
      const rawFacts = db.all(
        `SELECT tf.*, e.session_id
         FROM fact_fts ff
         JOIN temporal_fact tf ON tf.id = ff.fact_id
         JOIN event e ON e.id = tf.source_event_id
         WHERE fact_fts MATCH $query
           AND ($session IS NULL OR e.session_id = $session)
           AND ($from IS NULL OR COALESCE(tf.valid_at, tf.created_at, e.observed_at) IS NULL OR COALESCE(tf.valid_at, tf.created_at, e.observed_at) >= $from)
           AND ($to IS NULL OR COALESCE(tf.valid_at, tf.created_at, e.observed_at) IS NULL OR COALESCE(tf.valid_at, tf.created_at, e.observed_at) <= $to)
         ORDER BY tf.valid_from_ordinal DESC, tf.id ASC`,
        {
          query: ftsQuery,
          session: filters.session || null,
          from: filters.from || null,
          to: filters.to || null,
        },
      );

      const evaluatedFacts = [];
      for (const f of rawFacts) {
        const evalResult = cut.hasCut
          ? evaluateFactAtBiTemporalCut(f, cut)
          : { included: true, effectiveValidity: f.validity_status };
        if (!evalResult.included) continue;

        const effectiveValidity = evalResult.effectiveValidity;
        if (filters.validity && filters.validity !== "all") {
          const v = String(filters.validity).toLowerCase();
          if (v === "vigente" || v === "active") {
            if (effectiveValidity !== "VIGENTE") continue;
          } else if (v === "stale" || v === "invalidated") {
            if (effectiveValidity === "VIGENTE") continue;
          } else if (effectiveValidity.toLowerCase() !== v) {
            continue;
          }
        }

        evaluatedFacts.push({
          ...f,
          known_at: f.created_at,
          effective_validity_status: effectiveValidity,
          evidence_refs: safeJson(f.evidence_refs_json, []),
        });
        if (evaluatedFacts.length >= limit) break;
      }
      facts = evaluatedFacts;
    }

    return { entities, facts };
  } finally {
    db.close();
  }
}

function maxOrdinalFromFilters(filters) {
  const candidates = [
    filters.asOfBound?.maxOrdinal,
    filters.biTemporalCut?.asOfBound?.maxOrdinal,
    filters.biTemporalCut?.validAtBound?.maxOrdinal,
    filters.biTemporalCut?.knownAtBound?.maxOrdinal,
  ].filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)));
  return candidates.length ? Math.min(...candidates.map(Number)) : null;
}

function applyReranker(caseDir, candidates, { rerank = "rrf", limit = 25, centerNodeId = null, mmrLambda = 0.65 }) {
  if (!candidates.length) return [];

  if (rerank === "rrf") {
    return candidates.slice(0, limit);
  }

  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    if (rerank === "mentions") {
      const mentionWeightStmt = db.statement(`
        SELECT COALESCE(SUM(en.mention_count), 0) AS total_mentions, COUNT(DISTINCT en.id) AS entity_count
        FROM entity_mention em
        JOIN entity_node en ON en.id = em.entity_id
        WHERE em.event_id = $eventId
      `);
      return [...candidates]
        .map((ev, idx) => {
          const baseScore = ev.explanation?.fusedScore ?? ev.explanation?.lexicalContribution ?? ev.explanation?.cosineSimilarity ?? rrf(idx + 1);
          const stats = mentionWeightStmt.get({ eventId: ev.id }) || { total_mentions: 0, entity_count: 0 };
          const mentionBoost = Math.log1p(Number(stats.total_mentions || 0)) * 0.008;
          const rerankedScore = baseScore + mentionBoost;
          return {
            ...ev,
            explanation: {
              ...(ev.explanation || {}),
              reranker: "episode-mentions",
              entityCount: Number(stats.entity_count || 0),
              totalEntityMentions: Number(stats.total_mentions || 0),
              rerankedScore,
            },
          };
        })
        .sort((a, b) => b.explanation.rerankedScore - a.explanation.rerankedScore || a.id.localeCompare(b.id))
        .slice(0, limit);
    }

    if (rerank === "node-distance") {
      const allEdges = loadGraphEdges(db);
      const focalId = centerNodeId || candidates[0]?.id;
      const distances = computeUndirectedDistances(allEdges, focalId, 6);
      return [...candidates]
        .map((ev, idx) => {
          const baseScore = ev.explanation?.fusedScore ?? ev.explanation?.lexicalContribution ?? ev.explanation?.cosineSimilarity ?? rrf(idx + 1);
          const dist = distances.has(ev.id) ? distances.get(ev.id) : 10;
          const distanceScore = 1 / (1 + dist);
          const rerankedScore = baseScore + distanceScore * 0.02;
          return {
            ...ev,
            explanation: {
              ...(ev.explanation || {}),
              reranker: "node-distance",
              centerNodeId: focalId,
              graphDistance: distances.has(ev.id) ? dist : null,
              rerankedScore,
            },
          };
        })
        .sort((a, b) => b.explanation.rerankedScore - a.explanation.rerankedScore || a.id.localeCompare(b.id))
        .slice(0, limit);
    }

    if (rerank === "mmr") {
      const lambda = Number.isFinite(Number(mmrLambda)) ? Math.max(0, Math.min(1, Number(mmrLambda))) : 0.65;
      const pool = candidates.slice(0, Math.min(candidates.length, Math.max(limit * 4, 60))).map((ev, idx) => {
        const relevance = ev.explanation?.fusedScore ?? ev.explanation?.lexicalContribution ?? ev.explanation?.cosineSimilarity ?? rrf(idx + 1);
        const tokens = tokenSet(`${ev.kind} ${ev.input_preview || ""} ${ev.output_preview || ""}`);
        return { ev, relevance, tokens };
      });
      const maxRel = Math.max(...pool.map((p) => p.relevance), 1e-9);
      const selected = [];
      while (selected.length < limit && pool.length > 0) {
        let bestIdx = 0;
        let bestMmr = -Infinity;
        for (let i = 0; i < pool.length; i += 1) {
          const cand = pool[i];
          const normRel = cand.relevance / maxRel;
          let maxSim = 0;
          for (const sel of selected) {
            const sim = jaccardSimilarity(cand.tokens, sel.tokens);
            if (sim > maxSim) maxSim = sim;
          }
          const mmrScore = selected.length === 0 ? normRel : lambda * normRel - (1 - lambda) * maxSim;
          if (mmrScore > bestMmr) {
            bestMmr = mmrScore;
            bestIdx = i;
          }
        }
        const [picked] = pool.splice(bestIdx, 1);
        selected.push({
          ...picked,
          ev: {
            ...picked.ev,
            explanation: {
              ...(picked.ev.explanation || {}),
              reranker: `mmr(lambda=${lambda})`,
              mmrScore: Number(bestMmr.toFixed(6)),
            },
          },
        });
      }
      return selected.map((s) => s.ev);
    }

    return candidates.slice(0, limit);
  } finally {
    db.close();
  }
}

function tokenSet(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9_]{3,}/g) || [],
  );
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection += 1;
  }
  return intersection / (setA.size + setB.size - intersection);
}

function computeUndirectedDistances(edges, startNodeId, maxHops = 6) {
  const dist = new Map();
  if (!startNodeId) return dist;
  dist.set(startNodeId, 0);
  let frontier = [startNodeId];
  for (let d = 1; d <= maxHops && frontier.length > 0; d += 1) {
    const next = [];
    for (const node of frontier) {
      for (const edge of edges) {
        const neighbor =
          edge.fromNodeId === node ? edge.toNodeId : edge.toNodeId === node ? edge.fromNodeId : null;
        if (neighbor && !dist.has(neighbor)) {
          dist.set(neighbor, d);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

function fuseHybrid(caseDir, lexicalResults, semanticResults, { limit, graphHops, maxGraphNodes, filters }) {
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

  const graph = graphHops > 0 ? expandGraph(caseDir, candidates, graphHops, maxGraphNodes, filters) : { hops: 0, visitedNodes: 0, truncated: false, addedEvents: 0 };
  const results = [...candidates.values()].map((item) => {
    const explanation = item.explanation;
    explanation.fusedScore = (explanation.lexicalContribution || 0) + (explanation.vectorContribution || 0) + (explanation.graphContribution || 0);
    explanation.fusion = `reciprocal-rank-fusion(k=${RRF_K})`;
    explanation.note = "Scores express retrieval contribution only, never truth confidence.";
    return { ...item.event, explanation };
  }).sort((a, b) => b.explanation.fusedScore - a.explanation.fusedScore || a.id.localeCompare(b.id)).slice(0, limit);
  return { results, graph };
}

function expandGraph(caseDir, candidates, hops, maxNodes, filters) {
  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    const edges = loadGraphEdges(db);
    const eventValidityMap = buildEventValidityMap(db, filters?.biTemporalCut);
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
            const validityInfo = eventValidityMap.get(event.id) || { validityStatus: "VIGENTE", facts: [] };
            event.temporal_validity = validityInfo.validityStatus;
            event.temporal_facts = validityInfo.facts;
            if (!filters || passesEventFilters(event, filters)) {
              const item = candidate(candidates, event);
              const contribution = rrf(state.seedRank + depth * 10);
              if (!item.explanation.graphContribution || contribution > item.explanation.graphContribution) {
                item.explanation.graphContribution = contribution;
                item.explanation.graphPath = pathValue;
              }
              addedEvents += 1;
            }
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

function envelope({ root, query, modeRequested, modeEffective, results, filters, assessment, lexicalCount = 0, semanticCount = 0, semanticProjection = null, graph = null, fallbackReason = null, temporalMatches = null, rerank = "rrf" }) {
  const projectionSummary = semanticProjection ? {
    projectionId: semanticProjection.projectionId,
    model: semanticProjection.model,
    coverage: semanticProjection.coverage,
    minSimilarity: semanticProjection.minSimilarity,
  } : null;
  const serializedFilters = { ...filters };
  delete serializedFilters.asOfBound;
  delete serializedFilters.biTemporalCut;
  return {
    modeRequested,
    modeEffective,
    rerank,
    results,
    temporalMatches: temporalMatches || { entities: [], facts: [] },
    assessment,
    receipt: {
      schemaVersion: 1,
      querySha256: sha256(query),
      caseHash: loadManifest(root).caseHash,
      modeRequested,
      modeEffective,
      rerank,
      filters: serializedFilters,
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
  if(options.scope!=null && !["active","all"].includes(options.scope))throw new Error("Unsupported scope");
  let session = options.session || null;
  let biTemporalCut = null;
  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    if (session) {
      const row = db.get("SELECT id FROM session WHERE id=$id OR native_id=$id ORDER BY CASE WHEN id=$id THEN 0 ELSE 1 END LIMIT 1", { id: session });
      session = row?.id || `UNRESOLVED_SESSION:${session}`;
    }
    biTemporalCut = resolveBiTemporalCut(db, {
      asOf: options.asOf,
      validAt: options.validAt,
      knownAt: options.knownAt,
    });
  } finally { db.close(); }

  return {
    session,
    scope: options.scope || "active",
    kind: options.kind || null,
    status: options.status || null,
    actor: options.actor || null,
    from: normalizeOptionalTime(options.from, "from"),
    to: normalizeOptionalTime(options.to, "to"),
    asOf: options.asOf != null ? String(options.asOf) : null,
    validAt: options.validAt != null ? String(options.validAt) : null,
    knownAt: options.knownAt != null ? String(options.knownAt) : null,
    asOfBound: biTemporalCut?.asOfBound || null,
    biTemporalCut,
    validity: options.validity ? String(options.validity).toLowerCase() : null,
    evidence: options.evidence === true || String(options.evidence || "").toLowerCase() === "available",
  };
}

function passesEventFilters(event, filters) {
  if(filters.scope!=="all" && event.kind==="forensic.alternative")return false;
  if (filters.session && event.session_id !== filters.session) return false;
  if (filters.kind && event.kind !== filters.kind) return false;
  if (filters.status && String(event.status || "") !== String(filters.status)) return false;
  if (filters.actor && event.actor_kind !== filters.actor && event.actor_role !== filters.actor) return false;
  if (filters.from && (!event.observed_at || event.observed_at < filters.from)) return false;
  if (filters.to && (!event.observed_at || event.observed_at > filters.to)) return false;
  const maxOrd = maxOrdinalFromFilters(filters);
  if (maxOrd != null && Number(event.record_ordinal) > maxOrd) return false;
  if (filters.biTemporalCut?.validAtBound?.timestamp && event.observed_at && event.observed_at > filters.biTemporalCut.validAtBound.timestamp) {
    return false;
  }
  if (filters.biTemporalCut?.knownAtBound?.timestamp && event.observed_at && event.observed_at > filters.biTemporalCut.knownAtBound.timestamp) {
    return false;
  }
  if (filters.validity && filters.validity !== "all") {
    const v = String(event.temporal_validity || "VIGENTE").toLowerCase();
    if (filters.validity === "vigente" || filters.validity === "active") {
      if (v !== "vigente") return false;
    } else if (filters.validity === "stale" || filters.validity === "invalidated") {
      if (v === "vigente") return false;
    } else if (v !== filters.validity) {
      return false;
    }
  }
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

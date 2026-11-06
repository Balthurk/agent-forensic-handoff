import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditSession } from "./audit.js";
import { CaseDatabase } from "./database.js";
import { graphPath } from "./graph.js";
import { readEvidence } from "./render.js";
import { queryCase } from "./retrieval.js";
import { buildSemanticIndex, verifySemanticProjection } from "./semantic.js";
import { createTransformersProvider } from "./semantic-model.js";
import { atomicWrite, ensureDir, readJson, walkFiles } from "./util.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.resolve(MODULE_DIR, "..", "benchmarks", "fixtures", "hybrid-gold.jsonl");
const DEFAULT_TRUTH = path.resolve(MODULE_DIR, "..", "benchmarks", "fixtures", "hybrid-gold-truth.json");

export async function runRetrievalBenchmark(options = {}) {
  const root = path.resolve(options.output || fs.mkdtempSync(path.join(os.tmpdir(), "afh-retrieval-benchmark-")));
  ensureDir(root);
  const fixture = path.resolve(options.fixture || DEFAULT_FIXTURE);
  const truth = readJson(path.resolve(options.truth || DEFAULT_TRUTH));
  if (!truth?.exact?.length || !truth?.semantic?.length) throw new Error("Retrieval benchmark truth set is missing exact or semantic queries");
  const caseDir = path.join(root, "case");
  const auditStart = performance.now();
  const audit = await auditSession(fixture, { harness: "generic", caseDir, workspace: root, includeChildren: false, tokenBudget: 6000 });
  const auditMs = performance.now() - auditStart;
  const ownsProvider = !options.provider;
  const providerStart = performance.now();
  const provider = options.provider || await createTransformersProvider({
    model: options.model, modelHome: options.modelHome, allowDownload: options.allowModelDownload === true,
  });
  const providerLoadMs = performance.now() - providerStart;
  try {
    const indexStart = performance.now();
    const projection = await buildSemanticIndex(caseDir, { provider, out: path.join(root, "projections") });
    const indexMs = performance.now() - indexStart;
    const verificationStart = performance.now();
    const projectionVerification = await verifySemanticProjection(caseDir, projection.projectionDir, { deep: true });
    const projectionVerificationMs = performance.now() - verificationStart;

    const exactLexical = await evaluateQueries(caseDir, truth.exact, "lexical", truth.exactLimit, { provider, projectionDir: projection.projectionDir });
    const exactHybrid = await evaluateQueries(caseDir, truth.exact, "hybrid", truth.exactLimit, { provider, projectionDir: projection.projectionDir });
    const semanticLexical = await evaluateQueries(caseDir, truth.semantic, "lexical", truth.semanticLimit, { provider, projectionDir: projection.projectionDir });
    const semanticVector = await evaluateQueries(caseDir, truth.semantic, "semantic", truth.semanticLimit, { provider, projectionDir: projection.projectionDir });
    const semanticHybrid = await evaluateQueries(caseDir, truth.semantic, "hybrid", truth.semanticLimit, { provider, projectionDir: projection.projectionDir });
    const graph = evaluateGraph(caseDir, truth.graph);
    const negative = await evaluateNegative(root, fixture, truth.negativeQuery);
    const evidenceResolution = verifySelectedEvidence(caseDir, [...exactLexical.rows, ...exactHybrid.rows, ...semanticVector.rows, ...semanticHybrid.rows]);
    const metrics = {
      exactRecallAtK: exactLexical.recall,
      hybridExactRecallAtK: exactHybrid.recall,
      lexicalParaphraseRecallAt25: semanticLexical.recall,
      semanticParaphraseRecallAt25: semanticVector.recall,
      hybridParaphraseRecallAt25: semanticHybrid.recall,
      hybridImprovementOverLexical: semanticHybrid.recall - semanticLexical.recall,
      graphAccuracy: graph.passed ? 1 : 0,
      evidenceRefResolvability: evidenceResolution,
      falseAbsenceCount: negative.falseAbsenceCount,
      latencyMs: {
        providerColdLoad: round(providerLoadMs),
        auditWithoutEmbeddings: round(auditMs),
        fullSemanticBuild: round(indexMs),
        deepProjectionVerification: round(projectionVerificationMs),
        lexicalQueryP50: percentile([...exactLexical.latencies, ...semanticLexical.latencies], 0.5),
        semanticQueryP50: percentile(semanticVector.latencies, 0.5),
        hybridQueryP50: percentile([...exactHybrid.latencies, ...semanticHybrid.latencies], 0.5),
      },
      storageBytes: {
        case: directoryBytes(caseDir),
        semanticProjection: directoryBytes(projection.projectionDir),
      },
    };
    const gates = {
      exactRecall: metrics.exactRecallAtK === 1,
      hybridExactRecall: metrics.hybridExactRecallAtK === 1,
      semanticRecall: metrics.semanticParaphraseRecallAt25 >= 0.90,
      hybridSemanticRecall: metrics.hybridParaphraseRecallAt25 >= 0.90,
      materialImprovement: metrics.hybridImprovementOverLexical >= 0.25,
      graphAccuracy: metrics.graphAccuracy === 1,
      evidenceRefResolvability: metrics.evidenceRefResolvability === 1,
      noFalseAbsence: metrics.falseAbsenceCount === 0,
      projectionIntegrity: projectionVerification.passed,
    };
    const result = {
      schemaVersion: 1,
      fixtureVersion: truth.fixtureVersion,
      generatedAt: new Date().toISOString(),
      caseHash: audit.caseHash,
      model: provider.identity,
      projection: { projectionDir: projection.projectionDir, projectionId: projection.projectionId, projectionHash: projection.projectionHash },
      metrics,
      gates,
      passed: Object.values(gates).every(Boolean),
      querySets: { exactLexical, exactHybrid, semanticLexical, semanticVector, semanticHybrid },
      graph,
      negative,
    };
    atomicWrite(path.join(root, "retrieval-benchmark-results.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (ownsProvider) await provider.dispose?.();
  }
}

async function evaluateQueries(caseDir, queries, mode, limit, shared) {
  const rows = [];
  const latencies = [];
  for (const item of queries) {
    const started = performance.now();
    const response = await queryCase(caseDir, item.query, { mode, limit, ...shared });
    latencies.push(performance.now() - started);
    const rank = response.results.findIndex((event) => eventText(event).includes(item.marker));
    rows.push({ query: item.query, querySha256: response.receipt.querySha256, marker: item.marker, split: item.split, found: rank >= 0, rank: rank >= 0 ? rank + 1 : null, resultIds: response.receipt.resultIds, assessment: response.assessment.status });
  }
  return { mode, limit, recall: ratio(rows.filter((row) => row.found).length, rows.length), latencies: latencies.map(round), rows };
}

function evaluateGraph(caseDir, expected) {
  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    const from = db.get("SELECT id FROM event WHERE kind=$kind ORDER BY record_ordinal LIMIT 1", { kind: expected.fromKind });
    const to = db.get("SELECT id FROM event WHERE kind=$kind ORDER BY record_ordinal LIMIT 1", { kind: expected.toKind });
    if (!from || !to) return { passed: false, reason: "expected graph endpoint missing" };
    const result = graphPath(caseDir, from.id, to.id, { maxHops: 2, maxNodes: 25 });
    return { passed: result.found && result.path.some((edge) => edge.edgeType === expected.edgeType), from: from.id, to: to.id, result };
  } finally { db.close(); }
}

async function evaluateNegative(root, fixture, query) {
  const incompleteSource = path.join(root, "incomplete-control.jsonl");
  fs.copyFileSync(fixture, incompleteSource);
  fs.appendFileSync(incompleteSource, "{synthetic-incomplete-record\n");
  const incompleteCase = path.join(root, "incomplete-case");
  await auditSession(incompleteSource, { harness: "generic", caseDir: incompleteCase, workspace: root, includeChildren: false });
  const complete = await queryCase(path.join(root, "case"), query, { mode: "lexical" });
  const incomplete = await queryCase(incompleteCase, query, { mode: "lexical" });
  const falseAbsenceCount = [
    complete.assessment.status !== "NOT_OBSERVED_IN_CAPTURED_EVIDENCE",
    incomplete.assessment.status !== "INCONCLUSIVE_COVERAGE",
    complete.assessment.status === "VERIFIED_ABSENT",
    incomplete.assessment.status === "VERIFIED_ABSENT",
  ].filter(Boolean).length;
  return { complete: complete.assessment, incomplete: incomplete.assessment, falseAbsenceCount };
}

function verifySelectedEvidence(caseDir, rows) {
  let selected = 0;
  let resolved = 0;
  for (const row of rows) {
    if (!row.found) continue;
    const responseIds = row.resultIds || [];
    const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
    try {
      for (const id of responseIds) {
        selected += 1;
        const ref = db.get("SELECT uri FROM evidence_ref WHERE event_id=$id AND availability='AVAILABLE' ORDER BY id LIMIT 1", { id });
        try { if (ref) { readEvidence(caseDir, ref.uri); resolved += 1; } } catch {}
      }
    } finally { db.close(); }
  }
  return ratio(resolved, selected);
}

function eventText(event) { return `${event.input_preview || ""}\n${event.output_preview || ""}`; }
function directoryBytes(root) { return walkFiles(root).reduce((sum, file) => sum + fs.statSync(file).size, 0); }
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]);
}
function ratio(numerator, denominator) { return denominator ? numerator / denominator : 1; }
function round(value) { return Math.round(Number(value) * 100) / 100; }

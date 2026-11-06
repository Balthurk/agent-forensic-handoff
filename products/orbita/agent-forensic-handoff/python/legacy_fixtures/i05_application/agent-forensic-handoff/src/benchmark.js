import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditSession } from "./audit.js";
import { CaseDatabase } from "./database.js";
import { readEvidence } from "./render.js";
import { atomicWrite, ensureDir, readJson, tokenEstimate } from "./util.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(MODULE_DIR, "..", "test", "fixtures");

export async function runBenchmark(options = {}) {
  const root = options.output ? path.resolve(options.output) : fs.mkdtempSync(path.join(os.tmpdir(), "afh-benchmark-"));
  ensureDir(root);
  const fixtures = [
    { harness: "codex", transcript: path.join(FIXTURE_ROOT, "codex", "basic.jsonl"), truth: path.join(FIXTURE_ROOT, "codex", "truth.json") },
    { harness: "codex", transcript: path.join(FIXTURE_ROOT, "codex", "modern.jsonl"), truth: path.join(FIXTURE_ROOT, "codex", "modern-truth.json") },
    { harness: "claude", transcript: path.join(FIXTURE_ROOT, "claude", "basic.jsonl"), truth: path.join(FIXTURE_ROOT, "claude", "truth.json") },
    { harness: "generic", transcript: path.join(FIXTURE_ROOT, "generic", "mixed.jsonl"), truth: path.join(FIXTURE_ROOT, "generic", "truth.json") },
  ];
  const reports = [];
  for (const fixture of fixtures) reports.push(await evaluateFixture(root, fixture));
  const requestedGiantRecords = Number(options.giantRecords || 10_000);
  if (!Number.isSafeInteger(requestedGiantRecords) || requestedGiantRecords < 1 || requestedGiantRecords > 5_000_000) {
    throw new Error("giantRecords must be an integer between 1 and 5,000,000");
  }
  const giant = await evaluateGiant(root, Math.max(100, requestedGiantRecords));
  const aggregate = aggregateReports(reports);
  const gates = {
    parseAccounting: aggregate.parseAccounting === 1,
    criticalFactRecall: aggregate.criticalFactRecall >= 0.95,
    precision: aggregate.precision >= 0.98,
    unsupportedClaimRate: aggregate.unsupportedClaimRate <= 0.005,
    evidenceRefResolvability: aggregate.evidenceRefResolvability === 1,
    artifactProvenanceAccuracy: aggregate.artifactProvenanceAccuracy >= 0.95,
    timelineAccuracy: aggregate.timelineAccuracy >= 0.98,
    actorAttributionAccuracy: aggregate.actorAttributionAccuracy >= 0.98,
    continuationContextCoverage: aggregate.continuationContextCoverage >= 0.90,
    giantParseAccounting: giant.parseAccounting === true,
    giantHotToSourceTokenRatio: giant.hotToSourceTokenRatio <= 0.20,
    idempotence: reports.every((report) => report.idempotent),
  };
  const result = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    fixtureCount: reports.length,
    metrics: {
      ...aggregate,
      continuationSuccessRate: null,
      continuationSuccessStatus: "REQUIRES_FRESH_AGENT_RUN; see benchmarks/continuation-protocol.md",
      giantSession: giant,
    },
    gates,
    passed: Object.values(gates).every(Boolean),
    fixtures: reports,
  };
  atomicWrite(path.join(root, "benchmark-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function evaluateFixture(root, fixture) {
  const truth = readJson(fixture.truth);
  const fixtureRoot = ensureDir(path.join(root, truth.name));
  const workspace = ensureDir(path.join(fixtureRoot, "workspace"));
  prepareWorkspace(truth.name, workspace);
  const caseDir = path.join(fixtureRoot, "case");
  const first = await auditSession(fixture.transcript, {
    harness: fixture.harness, caseDir, workspace, verificationLevel: "V0", tokenBudget: 6000, includeChildren: false,
  });
  const second = await auditSession(fixture.transcript, {
    harness: fixture.harness, caseDir, workspace, verificationLevel: "V0", tokenBudget: 6000, includeChildren: false,
  });
  const db = new CaseDatabase(path.join(caseDir, "case.sqlite"), { readOnly: true });
  try {
    const critical = truth.critical;
    const actualKinds = new Set(db.all("SELECT DISTINCT kind FROM event WHERE canonical=1").map((row) => row.kind));
    const actualActors = new Set(db.all("SELECT DISTINCT kind FROM actor").map((row) => row.kind));
    const actualTools = Object.fromEntries(db.all("SELECT status,COUNT(*) n FROM tool_execution GROUP BY status").map((row) => [row.status, Number(row.n)]));
    const actualArtifacts = new Set(db.all("SELECT logical_path FROM artifact").map((row) => row.logical_path));
    const actualDecisions = new Set(db.all("SELECT decision_text FROM decision_record").map((row) => row.decision_text));
    const events = db.all("SELECT id,kind,source_id,record_ordinal,subordinal FROM event WHERE canonical=1 ORDER BY source_id,record_ordinal,subordinal");

    const checks = [];
    for (const kind of critical.eventKinds) checks.push({ category: "event", expected: kind, ok: actualKinds.has(kind) });
    for (const kind of critical.actorKinds) checks.push({ category: "actor", expected: kind, ok: actualActors.has(kind) });
    for (const [status, count] of Object.entries(critical.toolStatuses)) checks.push({ category: "tool", expected: `${status}>=${count}`, ok: (actualTools[status] || 0) >= count });
    for (const artifact of critical.artifacts) checks.push({ category: "artifact", expected: artifact, ok: actualArtifacts.has(artifact) });
    for (const decision of critical.decisions) checks.push({ category: "decision", expected: decision, ok: actualDecisions.has(decision) });
    checks.push({ category: "external", expected: `>=${critical.externalMinimum}`, ok: Number(db.get("SELECT COUNT(*) n FROM event WHERE canonical=1 AND (kind LIKE 'external.%' OR kind LIKE 'mcp.%')").n) >= critical.externalMinimum });
    checks.push({ category: "unparsed", expected: critical.unparsed, ok: Number(db.get("SELECT COUNT(*) n FROM source_record WHERE parse_status!='PARSED'").n) === critical.unparsed });
    if (critical.warnings != null) checks.push({ category: "warnings", expected: critical.warnings, ok: Number(db.get("SELECT COUNT(*) n FROM parse_warning").n) === critical.warnings });
    if (critical.validationsMinimum != null) checks.push({ category: "validations", expected: `>=${critical.validationsMinimum}`, ok: Number(db.get("SELECT COUNT(*) n FROM validation").n) >= critical.validationsMinimum });

    const timelineChecks = critical.timelinePairs.map(([before, after]) => {
      const a = events.findIndex((event) => event.kind === before);
      const b = events.findIndex((event) => event.kind === after && events.indexOf(event) > a);
      return { before, after, ok: a !== -1 && b !== -1 && a < b };
    });
    const evidenceRefs = db.all("SELECT * FROM evidence_ref ORDER BY id");
    let resolvable = 0;
    for (const ref of evidenceRefs) {
      try { readEvidence(caseDir, ref.uri); resolvable += 1; } catch {}
    }
    const claims = db.all("SELECT * FROM claim");
    const unsupported = claims.filter((claim) => {
      const refs = JSON.parse(claim.evidence_refs_json || "[]");
      return !refs.length || refs.some((uri) => !db.get("SELECT id FROM evidence_ref WHERE uri=$uri", { uri }));
    }).length;
    const hot = fs.readFileSync(path.join(caseDir, "hot-context.md"), "utf8");
    const hotHits = critical.hotTerms.filter((term) => hot.toLowerCase().includes(term.toLowerCase())).length;
    const rawBytes = fs.statSync(fixture.transcript).size;
    const scoredExpected = new Set([...critical.eventKinds, ...critical.actorKinds]);
    const scoredActual = new Set([...actualKinds, ...actualActors]);
    const unexpected = [...scoredActual].filter((value) => !scoredExpected.has(value) && value !== "forensic.unknown_record");
    const artifactChecks = checks.filter((check) => check.category === "artifact");
    return {
      name: truth.name,
      caseHash: first.caseHash,
      idempotent: second.reused === true && second.caseHash === first.caseHash,
      parseAccounting: Number(db.get("SELECT COUNT(*) n FROM source_record").n) === first.metrics.sourceRecords ? 1 : 0,
      criticalFactRecall: ratio(checks.filter((check) => check.ok).length, checks.length),
      precision: ratio(scoredActual.size - unexpected.length, scoredActual.size),
      unsupportedClaimRate: ratio(unsupported, claims.length, 0),
      evidenceRefResolvability: ratio(resolvable, evidenceRefs.length),
      artifactProvenanceAccuracy: artifactChecks.length ? ratio(artifactChecks.filter((check) => check.ok).length, artifactChecks.length) : 1,
      timelineAccuracy: ratio(timelineChecks.filter((check) => check.ok).length, timelineChecks.length),
      actorAttributionAccuracy: ratio(critical.actorKinds.filter((kind) => actualActors.has(kind)).length, critical.actorKinds.length),
      continuationContextCoverage: ratio(hotHits, critical.hotTerms.length),
      hotToSourceTokenRatio: ratio(tokenEstimate(hot), Math.ceil(rawBytes / 4)),
      checks,
      timelineChecks,
    };
  } finally { db.close(); }
}

function prepareWorkspace(name, workspace) {
  if (name === "codex-basic") {
    ensureDir(path.join(workspace, "src"));
    fs.writeFileSync(path.join(workspace, "src", "parser.js"), "export const canary = 'ALPHA-42';\n");
  }
  if (name === "claude-basic") fs.writeFileSync(path.join(workspace, "config.yaml"), "mode: safe");
  if (name === "codex-modern") {
    ensureDir(path.join(workspace, "src"));
    fs.writeFileSync(path.join(workspace, "src", "modern.js"), "modern artifact\n");
  }
}

async function evaluateGiant(root, count) {
  const fixtureRoot = ensureDir(path.join(root, "giant"));
  const source = path.join(fixtureRoot, "giant.jsonl");
  const fd = fs.openSync(source, "w");
  try {
    fs.writeSync(fd, `${JSON.stringify({ timestamp: "2026-01-04T00:00:00Z", type: "session_meta", payload: { id: "giant-fixture", session_id: "giant-fixture", cwd: "." } })}\n`);
    fs.writeSync(fd, `${JSON.stringify({ timestamp: "2026-01-04T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "Audit a giant noisy session without loading it into one prompt." } })}\n`);
    for (let i = 0; i < count; i += 1) fs.writeSync(fd, `${JSON.stringify({ timestamp: new Date(Date.UTC(2026, 0, 4, 0, 0, 2) + i).toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: i } } })}\n`);
  } finally { fs.closeSync(fd); }
  const started = performance.now();
  const result = await auditSession(source, { harness: "codex", caseDir: path.join(fixtureRoot, "case"), workspace: fixtureRoot, includeChildren: false, tokenBudget: 2000 });
  const elapsedMs = Math.round(performance.now() - started);
  const hot = fs.readFileSync(path.join(result.caseDir, "hot-context.md"), "utf8");
  const sourceTokenEstimate = Math.ceil(fs.statSync(source).size / 4);
  return {
    requestedNoiseRecords: count,
    parsedSourceRecords: result.metrics.sourceRecords,
    elapsedMs,
    recordsPerSecond: Math.round(result.metrics.sourceRecords / Math.max(elapsedMs / 1000, 0.001)),
    parseAccounting: result.metrics.unparsedRecords === 0,
    hotTokenEstimate: tokenEstimate(hot),
    sourceTokenEstimate,
    hotToSourceTokenRatio: ratio(tokenEstimate(hot), sourceTokenEstimate),
    note: count >= 1_000_000
      ? "Local synthetic release-scale run; CI keeps a smaller default profile."
      : "Synthetic scale smoke test; run one million records for the local release profile.",
  };
}

function aggregateReports(reports) {
  const keys = ["parseAccounting", "criticalFactRecall", "precision", "unsupportedClaimRate", "evidenceRefResolvability", "artifactProvenanceAccuracy", "timelineAccuracy", "actorAttributionAccuracy", "continuationContextCoverage", "hotToSourceTokenRatio"];
  return Object.fromEntries(keys.map((key) => [key, reports.reduce((sum, report) => sum + report[key], 0) / reports.length]));
}

function ratio(numerator, denominator, whenEmpty = 1) {
  return denominator ? numerator / denominator : whenEmpty;
}

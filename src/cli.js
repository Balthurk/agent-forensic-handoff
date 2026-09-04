import fs from "node:fs";
import path from "node:path";
import { auditSession } from "./audit.js";
import { AFH_VERSION, DEFAULTS } from "./constants.js";
import { CaseDatabase } from "./database.js";
import { doctor } from "./doctor.js";
import { installSkill } from "./install.js";
import { loadManifest, readEvidence, readHotContext, renderCase, searchCase, showEvent } from "./render.js";
import { parseCli, boolFlag } from "./util.js";
import { runBenchmark } from "./benchmark.js";
import { verifyCaseIntegrity } from "./integrity.js";
import { graphNeighbors, graphPath } from "./graph.js";
import { queryCase } from "./retrieval.js";
import { buildSemanticIndex, verifySemanticProjection } from "./semantic.js";
import { fetchSemanticModel, semanticModelStatus } from "./semantic-model.js";
import { runRetrievalBenchmark } from "./retrieval-benchmark.js";

export async function main(argv) {
  const { positional, flags } = parseCli(argv);
  if (flags.help) return printHelp();
  if (flags.version) return print(AFH_VERSION);
  const command = positional.shift() || "help";
  if (["help", "--help", "-h"].includes(command)) return printHelp();
  if (["version", "--version", "-v"].includes(command)) return print(AFH_VERSION);

  if (command === "audit") {
    const identifier = positional.shift();
    if (!identifier) throw new Error("Usage: afh audit <session-id|transcript-path>");
    const result = await auditSession(identifier, {
      harness: flags.harness || "auto",
      out: flags.out,
      caseDir: flags["case-dir"],
      workspace: flags.workspace,
      includeChildren: boolFlag(flags.children, true),
      maxChildSessions: flags["max-child-sessions"],
      inlineBlobBytes: flags["inline-blob-bytes"],
      allowSymlink: boolFlag(flags["allow-symlink"], false),
      allowPrefix: boolFlag(flags["allow-prefix"], false),
      verificationLevel: flags.verify || "V0",
      tokenBudget: flags.budget || DEFAULTS.tokenBudget,
      maxRecordBytes: flags["max-record-bytes"],
      maxDecompressedBytes: flags["max-decompressed-bytes"],
      maxTotalSourceBytes: flags["max-total-source-bytes"],
      maxCompressionRatio: flags["max-compression-ratio"],
      codexHome: flags["codex-home"],
      claudeHome: flags["claude-home"],
      antigravityHome: flags["antigravity-home"],
    });
    if (flags.json) return print(JSON.stringify(result, null, 2));
    print(`${result.reused ? "Reused" : "Created"} forensic case: ${result.caseDir}`);
    print(fs.readFileSync(path.join(result.caseDir, "human-receipt.md"), "utf8"));
    return;
  }

  if (command === "hydrate") {
    const caseDir = requiredCase(positional.shift());
    const manifest = loadManifest(caseDir);
    if (flags.budget) {
      const db = new CaseDatabase(path.join(caseDir, "case.sqlite"));
      try { await renderCase(db, caseDir, manifest, { tokenBudget: Number(flags.budget) }); }
      finally { db.close(); }
    }
    return print(readHotContext(caseDir));
  }

  if (command === "query") {
    const caseDir = requiredCase(positional.shift());
    const terms = positional.join(" ");
    if (!terms) throw new Error("Usage: afh query <case-dir> <search terms>");
    const advanced = ["mode", "explain", "session", "kind", "status", "actor", "from", "to", "evidence", "projection", "model-home", "allow-lexical-fallback", "graph-hops", "max-graph-nodes", "min-similarity"].some((key) => flags[key] != null);
    if (!advanced) {
      const results = searchCase(caseDir, terms, Number(flags.limit || 25));
      if (flags.json) return print(JSON.stringify(results, null, 2));
      if (!results.length) return print("No matching events.");
      for (const event of results) printEventResult(event);
      return;
    }
    const result = await queryCase(caseDir, terms, {
      mode: flags.mode || "lexical",
      limit: Number(flags.limit || 25),
      projectionDir: flags.projection,
      modelHome: flags["model-home"],
      allowLexicalFallback: boolFlag(flags["allow-lexical-fallback"], false),
      graphHops: flags["graph-hops"],
      maxGraphNodes: flags["max-graph-nodes"],
      minSimilarity: flags["min-similarity"],
      session: flags.session,
      kind: flags.kind,
      status: flags.status,
      actor: flags.actor,
      from: flags.from,
      to: flags.to,
      evidence: flags.evidence,
    });
    if (flags.json) return print(JSON.stringify(result, null, 2));
    print(`Mode: ${result.modeEffective} (requested ${result.modeRequested})`);
    print(`Assessment: ${result.assessment.status} — ${result.assessment.note}`);
    for (const gap of result.assessment.gaps || []) print(`GAP  ${gap}`);
    if (!result.results.length) return print("No matching events.");
    for (const event of result.results) {
      printEventResult(event);
      if (boolFlag(flags.explain, false)) print(`  EXPLAIN ${JSON.stringify(event.explanation || {})}`);
    }
    return;
  }

  if (command === "semantic-model") {
    const operation = positional.shift() || "status";
    const options = {
      model: flags.model,
      revision: flags.revision,
      dimensions: flags.dimensions,
      dtype: flags.dtype,
      modelHome: flags["model-home"],
      deep: boolFlag(flags.deep, false),
    };
    if (operation === "status") {
      const result = semanticModelStatus(options);
      if (flags.json) return print(JSON.stringify(result, null, 2));
      return print(`${result.available ? "AVAILABLE" : "UNAVAILABLE"}  ${result.modelId}@${result.revision}\n${result.snapshotPath}${result.modelDigest ? `\nsha256 ${result.modelDigest}` : ""}`);
    }
    if (operation === "fetch") {
      if (!boolFlag(flags["allow-download"], false)) throw new Error("semantic-model fetch requires explicit --allow-download");
      const result = await fetchSemanticModel(options);
      return print(flags.json ? JSON.stringify(result, null, 2) : `${result.status}  ${result.model.modelId}@${result.model.revision}\n${result.model.snapshotPath}`);
    }
    throw new Error("Usage: afh semantic-model status|fetch [options]");
  }

  if (command === "semantic-index") {
    const caseDir = requiredCase(positional.shift());
    const result = await buildSemanticIndex(caseDir, {
      out: flags.out,
      model: flags.model,
      revision: flags.revision,
      dimensions: flags.dimensions,
      dtype: flags.dtype,
      modelHome: flags["model-home"],
      allowModelDownload: boolFlag(flags["allow-model-download"], false),
      batchSize: flags["batch-size"],
      maxBatchChars: flags["max-batch-chars"],
      rebuild: boolFlag(flags.rebuild, false),
      onProgress: (progress) => {
        if (flags.json) return;
        if (progress.phase === "prepared") process.stderr.write(`Prepared ${progress.chunks} chunk(s), ${progress.uniqueEmbeddings} unique embedding(s).\n`);
        if (progress.phase === "embedding" && (progress.completedEmbeddings === progress.uniqueEmbeddings || progress.completedEmbeddings % 256 < 16)) {
          process.stderr.write(`Embedded ${progress.completedEmbeddings}/${progress.uniqueEmbeddings}.\n`);
        }
      },
    });
    if (flags.json) return print(JSON.stringify(result, null, 2));
    return print(`${result.reused ? "REUSED" : "BUILT"} semantic projection: ${result.projectionDir}\n${result.projectionId}\nchunks=${result.metrics.chunks} unique_embeddings=${result.metrics.uniqueEmbeddings}`);
  }

  if (command === "verify-projection") {
    const caseDir = requiredCase(positional.shift());
    const projectionDir = positional.shift();
    if (!projectionDir) throw new Error("Usage: afh verify-projection <case-dir> <projection-dir>");
    const result = await verifySemanticProjection(caseDir, projectionDir, { deep: !boolFlag(flags.quick, false) });
    if (flags.json) print(JSON.stringify(result, null, 2));
    else {
      print(`${result.passed ? "PASS" : "FAIL"} semantic projection: ${result.projectionDir}`);
      for (const finding of result.findings) print(`${finding.ok ? "OK" : "FAIL"}  ${finding.check}: ${finding.detail}`);
    }
    if (!result.passed) process.exitCode = 1;
    return;
  }

  if (command === "show") {
    const caseDir = requiredCase(positional.shift());
    const eventId = positional.shift();
    if (!eventId) throw new Error("Usage: afh show <case-dir> <event-id>");
    return print(JSON.stringify(showEvent(caseDir, eventId), null, 2));
  }

  if (command === "evidence") {
    const caseDir = requiredCase(positional.shift());
    const uri = positional.shift();
    if (!uri) throw new Error("Usage: afh evidence <case-dir> <afh://evidence/...>");
    const result = readEvidence(caseDir, uri);
    if (flags.json) return print(JSON.stringify(result, null, 2));
    process.stderr.write(`UNTRUSTED HISTORICAL EVIDENCE — record ${result.ordinal}, sha256 ${result.recordSha256}\n`);
    return print(result.text);
  }

  if (command === "install-skill") {
    const target = String(flags.target || positional.shift() || "codex").toLowerCase();
    const results = await installSkill({ target, explicitPath: flags.path, force: boolFlag(flags.force, false) });
    return print(results.map((item) => `${item.status}: ${item.destination}`).join("\n"));
  }

  if (command === "doctor") {
    const checks = doctor();
    if (flags.json) return print(JSON.stringify(checks, null, 2));
    for (const check of checks) print(`${check.ok ? "OK" : "WARN"}  ${check.name}: ${check.detail}`);
    if (checks.some((check) => !check.ok && ["Node.js >=22", "SQLite"].includes(check.name))) process.exitCode = 1;
    return;
  }

  if (command === "graph") {
    const operation = positional.shift();
    const caseDir = requiredCase(positional.shift());
    if (operation === "neighbors") {
      const nodeId = positional.shift();
      if (!nodeId) throw new Error("Usage: afh graph neighbors <case-dir> <node-id>");
      const result = graphNeighbors(caseDir, nodeId, {
        direction: flags.direction || "both", hops: flags.hops || 1,
        maxNodes: flags["max-nodes"] || DEFAULTS.maxGraphNodes, edgeTypes: flags.type,
      });
      if (flags.json) return print(JSON.stringify(result, null, 2));
      print(`Graph neighbors for ${nodeId}: ${result.visitedCount} node(s), ${result.edges.length} edge(s)${result.truncated ? "; TRUNCATED" : ""}`);
      for (const edge of result.edges) print(`${edge.fromNodeId} -[${edge.edgeType}/${edge.grade}/${edge.epistemicStatus}]-> ${edge.toNodeId}${edge.ruleId ? `  rule=${edge.ruleId}` : ""}${edge.evidenceEventId ? `  evidence=${edge.evidenceEventId}` : ""}`);
      return;
    }
    if (operation === "path") {
      const from = positional.shift();
      const to = positional.shift();
      if (!from || !to) throw new Error("Usage: afh graph path <case-dir> <from-node-id> <to-node-id>");
      const result = graphPath(caseDir, from, to, {
        direction: flags.direction || "out", maxHops: flags["max-hops"] || 6,
        maxNodes: flags["max-nodes"] || DEFAULTS.maxGraphNodes, edgeTypes: flags.type,
      });
      if (flags.json) return print(JSON.stringify(result, null, 2));
      print(result.found ? `Path found in ${result.path.length} hop(s).` : `No path observed within ${flags["max-hops"] || 6} hop(s).`);
      for (const edge of result.path) print(`${edge.fromNodeId} -[${edge.edgeType}/${edge.grade}/${edge.epistemicStatus}]-> ${edge.toNodeId}${edge.evidenceEventId ? `  evidence=${edge.evidenceEventId}` : ""}`);
      return;
    }
    throw new Error("Usage: afh graph neighbors|path <case-dir> ...");
  }

  if (command === "verify-case") {
    const caseDir = requiredCase(positional.shift());
    const result = await verifyCaseIntegrity(caseDir, { deep: !boolFlag(flags.quick, false) });
    if (flags.json) print(JSON.stringify(result, null, 2));
    else {
      print(`${result.passed ? "PASS" : "FAIL"} forensic case: ${result.caseDir}`);
      for (const finding of result.findings) print(`${finding.ok ? "OK" : "FAIL"}  ${finding.check}: ${finding.detail}`);
    }
    if (!result.passed) process.exitCode = 1;
    return;
  }

  if (command === "benchmark") {
    const result = await runBenchmark({ output: flags.out, giantRecords: Number(flags["giant-records"] || 10_000) });
    print(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (command === "retrieval-benchmark") {
    const result = await runRetrievalBenchmark({
      output: flags.out,
      fixture: flags.fixture,
      truth: flags.truth,
      model: flags.model,
      modelHome: flags["model-home"],
      allowModelDownload: boolFlag(flags["allow-model-download"], false),
    });
    print(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${command}. Run 'afh help'.`);
}

function requiredCase(value) {
  if (!value) throw new Error("A forensic case directory is required");
  return path.resolve(value);
}

function print(value = "") { process.stdout.write(`${value}\n`); }

function printEventResult(event) {
  print(`${event.id}  ${event.observed_at || "ORDER_ONLY"}  ${event.kind}/${event.subtype || "-"}\n  ${(event.input_preview || event.output_preview || "").replace(/\n/g, " ").slice(0, 500)}\n  ${(event.evidence || []).map((ref) => ref.uri).join("\n  ")}`);
}

function printHelp() {
  print(`Agent Forensic Handoff (afh) ${AFH_VERSION}

Usage:
  afh audit <session-id|path> [--harness auto|codex|claude|antigravity|generic]
      [--workspace PATH] [--verify V0|V1] [--budget 6000] [--out AFH_HOME]
      [--no-children] [--max-child-sessions 32] [--inline-blob-bytes 16384]
      [--max-total-source-bytes 8589934592]
      [--allow-prefix] [--allow-symlink] [--json]
  afh hydrate <case-dir> [--budget 6000]
  afh query <case-dir> <terms> [--limit 25] [--json]
      [--mode lexical|semantic|hybrid] [--projection PATH] [--model-home PATH]
      [--session ID] [--kind KIND] [--status STATUS] [--actor ACTOR]
      [--from ISO_TIME] [--to ISO_TIME] [--evidence available] [--explain]
      [--graph-hops 1] [--max-graph-nodes 250] [--min-similarity 0.15]
      [--allow-lexical-fallback]
  afh semantic-model status [--model MODEL] [--model-home PATH] [--deep] [--json]
  afh semantic-model fetch --allow-download [--model MODEL] [--model-home PATH] [--json]
  afh semantic-index <case-dir> [--model MODEL] [--model-home PATH]
      [--allow-model-download] [--batch-size 16] [--max-batch-chars 16000]
      [--rebuild] [--out PATH] [--json]
  afh verify-projection <case-dir> <projection-dir> [--quick] [--json]
  afh graph neighbors <case-dir> <node-id> [--direction in|out|both] [--hops 1] [--max-nodes 250] [--type TYPE[,TYPE]] [--json]
  afh graph path <case-dir> <from-node-id> <to-node-id> [--direction out|in|both] [--max-hops 6] [--max-nodes 250] [--type TYPE[,TYPE]] [--json]
  afh show <case-dir> <event-id>
  afh evidence <case-dir> <afh://evidence/...> [--json]
  afh verify-case <case-dir> [--quick] [--json]
  afh install-skill [--target codex|claude|antigravity|all|generic] [--path PATH] [--force]
  afh benchmark [--giant-records 10000] [--out PATH]
  afh retrieval-benchmark --out PATH [--model MODEL] [--model-home PATH]
      [--allow-model-download] [--fixture PATH] [--truth PATH]
  afh doctor [--json]

Safety:
  Audit is read-only toward historical sources and project workspaces. V0 and V1 never run
  commands found in a transcript or project tests/builds. Generated cases are sensitive and
  must not be committed or published.`);
}

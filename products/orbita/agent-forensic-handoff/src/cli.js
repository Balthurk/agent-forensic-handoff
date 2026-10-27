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
import { appendGovernedTemporalFact, listEntities, reconstructStateAtMoment, traceWhy } from "./bitemporal-graph.js";
import { getContinuationOptions } from "./options.js";

export async function main(argv) {
  const { positional, flags } = parseCli(argv);
  if (flags.help) return printHelp();
  if (flags.version) return print(AFH_VERSION);
  const command = positional.shift() || "help";
  if (["help", "--help", "-h"].includes(command)) return printHelp();
  if (["version", "--version", "-v"].includes(command)) return print(AFH_VERSION);

  if(command==='evidence-open') {
    const {readUnifiedEvidence}=await import('./identity-evidence.js');
    return print(JSON.stringify(await readUnifiedEvidence(requiredCase(positional.shift()),positional.shift(),{start:Number(flags.start??0),end:flags.end==null?null:Number(flags.end),unit:flags.unit??'unicode_codepoints'}),null,2));
  }
  if(command==='export-n01') {
    const {exportN01Packet}=await import('./identity-evidence.js');
    if(!positional.length)throw new Error('export-n01 requires at least one case directory');
    const packet=await exportN01Packet(positional.map(requiredCase),{scope:flags.scope??'active',knownAt:flags['known-at']});
    const output=JSON.stringify(packet,null,2)+'\n';
    if(flags.output){fs.writeFileSync(path.resolve(flags.output),output,{flag:'wx'});return print(path.resolve(flags.output));}
    return print(output);
  }
  if (command === "audit" || command === "import-share" || command === "import-conversation") {
    const identifier = positional.shift();
    if (!identifier) throw new Error("Usage: afh audit <session-id|transcript-path>");
    if(command==='import-share'&&!/^https:\/\//i.test(identifier))throw new Error('import-share requires a public ChatGPT share URL');
    const audit=command==='import-conversation'?(await import('./conversation-intake.js')).importConversation:auditSession;
    const result = await audit(identifier, {
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
      htmlPath: flags["html-file"],
      maxBytes: flags["max-page-bytes"],
      maxEntryBytes: flags["max-entry-bytes"],maxEntries:flags["max-entries"],
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
    const advanced = [
      "scope", "mode", "explain", "session", "kind", "status", "actor", "from", "to",
      "evidence", "projection", "model-home", "allow-lexical-fallback",
      "graph-hops", "max-graph-nodes", "min-similarity",
      "as-of", "valid-at", "known-at", "validity", "rerank", "center-node", "mmr-lambda",
    ].some((key) => flags[key] != null);
    if (!advanced) {
      const results = searchCase(caseDir, terms, Number(flags.limit || 25));
      if (flags.json) return print(JSON.stringify(results, null, 2));
      if (!results.length) return print("No matching events.");
      for (const event of results) printEventResult(event);
      return;
    }
    const result = await queryCase(caseDir, terms, {
      scope: flags.scope || "active",
      mode: flags.mode || "lexical",
      rerank: flags.rerank || "rrf",
      centerNodeId: flags["center-node"],
      mmrLambda: flags["mmr-lambda"],
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
      asOf: flags["as-of"],
      validAt: flags["valid-at"],
      knownAt: flags["known-at"],
      validity: flags.validity,
      evidence: flags.evidence,
    });
    if (flags.json) return print(JSON.stringify(result, null, 2));
    print(`Mode: ${result.modeEffective} (requested ${result.modeRequested}, rerank=${result.rerank || "rrf"})`);
    print(`Assessment: ${result.assessment.status} — ${result.assessment.note}`);
    for (const gap of result.assessment.gaps || []) print(`GAP  ${gap}`);
    if (!result.results.length) return print("No matching events.");
    for (const event of result.results) {
      printEventResult(event);
      if (boolFlag(flags.explain, false)) print(`  EXPLAIN ${JSON.stringify(event.explanation || {})}`);
    }
    return;
  }

  if (command === "state" || (command === "temporal" && positional[0] === "state")) {
    if (command === "temporal") positional.shift();
    const caseDir = requiredCase(positional.shift());
    const result = reconstructStateAtMoment(caseDir, {
      asOf: flags["as-of"],
      validAt: flags["valid-at"],
      knownAt: flags["known-at"],
      session: flags.session,
      validity: flags.validity || "all",
    });
    if (flags.json) return print(JSON.stringify(result, null, 2));
    print(`State reconstruction (${result.asOf.mode}${result.asOf.maxOrdinal != null ? ` <= ord ${result.asOf.maxOrdinal}` : ""}): ${result.counts.vigenteFacts} VIGENTE fact(s), ${result.counts.staleFacts} STALE/INVALIDATED fact(s), ${result.counts.decisions} decision(s), ${result.counts.entities} entity node(s).`);
    for (const fact of result.facts.slice(0, Number(flags.limit || 40))) {
      print(`[${fact.effective_validity_status}] ${fact.id} (${fact.predicate}, ord ${fact.valid_from_ordinal}→${fact.invalid_at_ordinal ?? "active"}): ${fact.fact_text}`);
    }
    return;
  }

  if (command === "temporal") {
    const sub = positional.shift() || "state";
    const caseDir = requiredCase(positional.shift());
    if (sub === "append") {
      const appended = appendGovernedTemporalFact(caseDir, {
        id: flags.id,
        sourceEventId: flags["event-id"] || flags.event,
        subjectId: flags.subject,
        subjectKind: flags["subject-kind"],
        predicate: flags.predicate,
        factText: flags.text || positional.join(" "),
        validAt: flags["valid-at"],
        knownAt: flags["known-at"],
        evidenceUri: flags["evidence-uri"] || flags.uri,
        supersedesFactId: flags.supersedes,
        scope: flags.scope,
        sharedEntity: boolFlag(flags["shared-entity"], false),
        epistemic: flags.epistemic,
        authority: flags.authority,
        authorityTier: flags["authority-tier"],
        manualAuthority: flags["manual-authority"],
        verified: flags.verified === true || flags.verified === "true",
      });
      return print(JSON.stringify(appended, null, 2));
    }
    if (sub === "query") {
      const terms = positional.join(" ");
      const res = await queryCase(caseDir, terms, {
        scope: flags.scope || "active",
      mode: flags.mode || "lexical",
        asOf: flags["as-of"],
        validAt: flags["valid-at"],
        knownAt: flags["known-at"],
        validity: flags.validity,
        session: flags.session,
        limit: Number(flags.limit || 25),
      });
      return print(JSON.stringify(res, null, 2));
    }
    const res = reconstructStateAtMoment(caseDir, {
      asOf: flags["as-of"],
      validAt: flags["valid-at"],
      knownAt: flags["known-at"],
      session: flags.session,
      validity: flags.validity || "all",
    });
    return print(JSON.stringify(res, null, 2));
  }

  if (command === "why") {
    const caseDir = requiredCase(positional.shift());
    const targetId = positional.shift();
    if (!targetId) throw new Error("Usage: afh why <case-dir> <event-id|decision-id|fact-id|entity-id>");
    const result = traceWhy(caseDir, targetId, { depth: flags.depth || 6 });
    if (flags.json) return print(JSON.stringify(result, null, 2));
    if (!result.found) {
      process.exitCode = 1;
      return print(result.error);
    }
    print(`Why trace for ${result.target.targetKind} ${result.target.id} (at ordinal ${result.moment.ordinal}):`);
    print(`  Summary: ${result.target.summary}`);
    print(`  Upstream causal chain (${result.causalChain.length} event(s)):`);
    for (const ev of result.causalChain) {
      print(`    [ord ${ev.record_ordinal}] ${ev.id} (${ev.kind}/${ev.status || "-"}) — ${ev.summary}`);
    }
    print(`  Empirically known facts at moment (${result.knownEmpiricalFactsAtMoment.length}):`);
    for (const f of result.knownEmpiricalFactsAtMoment) {
      print(`    [${f.epistemic_status}] ${f.predicate}: ${f.fact_text}`);
    }
    print(`  Visible model reasoning at moment (${result.inferredReasoningAtMoment.length}):`);
    for (const r of result.inferredReasoningAtMoment) {
      print(`    [ord ${r.ordinal}] ${r.eventId}: ${r.reasoning}`);
    }
    return;
  }

  if (command === "options") {
    const caseDir = requiredCase(positional.shift());
    const options = getContinuationOptions(caseDir);
    if (flags.json) return print(JSON.stringify(options, null, 2));
    if (!options.length) return print("No continuation options composed.");
    for (const opt of options) {
      print(`${opt.rank}. [${opt.recommended ? "RECOMMENDED" : "GUARDRAIL"}] ${opt.title} (${opt.strategy})`);
      print(`   Action: ${opt.description}`);
      print(`   Rationale: ${opt.rationale}`);
      if (opt.activeConstraints.length) print(`   Active constraints: ${opt.activeConstraints.join("; ")}`);
      if (opt.avoidedDeadEnds.length) print(`   Avoided dead ends: ${opt.avoidedDeadEnds.join(" | ")}`);
    }
    return;
  }

  if (command === "entities") {
    const caseDir = requiredCase(positional.shift());
    const entities = listEntities(caseDir, {
      kind: flags.kind,
      session: flags.session,
      asOf: flags["as-of"],
      validAt: flags["valid-at"],
      knownAt: flags["known-at"],
      limit: flags.limit || 50,
    });
    if (flags.json) return print(JSON.stringify(entities, null, 2));
    if (!entities.length) return print("No matching entities.");
    for (const ent of entities) {
      print(`${ent.id}  [${ent.entity_kind}/${ent.validity_status}]  ${ent.canonical_name} (mentions=${ent.mention_count}, ord ${ent.first_ordinal ?? 0}..${ent.last_ordinal ?? 0})`);
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
      representation: flags.representation,
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
  print(`${event.id}  ${event.observed_at || "ORDER_ONLY"}  ${event.kind}/${event.subtype || "-"}${event.temporal_validity ? `  [${event.temporal_validity}]` : ""}\n  ${(event.input_preview || event.output_preview || "").replace(/\n/g, " ").slice(0, 500)}\n  ${(event.evidence || []).map((ref) => ref.uri).join("\n  ")}`);
}

function printHelp() {
  print(`Agent Forensic Handoff (afh) ${AFH_VERSION}

Usage:
  afh audit <session-id|path|https://chatgpt.com/share/UUID> [--harness auto|codex|claude|antigravity|generic]
  afh import-conversation <export.json|export.zip|forensic.jsonl|snapshot.html> [--case-dir path]
  afh evidence-open <case-dir> <representation-id> [--start N --end N]
  afh export-n01 <case-dir> [case-dir...] [--scope active|all] [--known-at ISO] [--output file.json]
  afh import-share <https://chatgpt.com/share/UUID> [--html-file saved.html] [--case-dir path]
      [--workspace PATH] [--verify V0|V1] [--budget 6000] [--out AFH_HOME]
      [--no-children] [--max-child-sessions 32] [--inline-blob-bytes 16384]
      [--max-total-source-bytes 8589934592]
      [--allow-prefix] [--allow-symlink] [--json]
  afh hydrate <case-dir> [--budget 6000]
  afh query <case-dir> <terms> [--limit 25] [--json]
      [--mode lexical|semantic|hybrid] [--rerank rrf|mmr|mentions|node-distance]
      [--center-node NODE_ID] [--mmr-lambda 0.65]
      [--as-of ISO_TIME|ORDINAL] [--validity all|vigente|stale]
      [--projection PATH] [--model-home PATH]
      [--session ID] [--kind KIND] [--status STATUS] [--actor ACTOR]
      [--from ISO_TIME] [--to ISO_TIME] [--evidence available] [--explain]
      [--graph-hops 1] [--max-graph-nodes 250] [--min-similarity 0.15]
      [--allow-lexical-fallback]
  afh state <case-dir> [--as-of ISO_TIME|ORDINAL] [--validity all|vigente|stale] [--limit 40] [--json]
  afh why <case-dir> <event-id|decision-id|fact-id|entity-id> [--depth 6] [--json]
  afh options <case-dir> [--json]
  afh entities <case-dir> [--kind KIND] [--limit 50] [--json]
  afh semantic-model status [--model MODEL] [--model-home PATH] [--deep] [--json]
  afh semantic-model fetch --allow-download [--model MODEL] [--model-home PATH] [--json]
  afh semantic-index <case-dir> [--representation full_source_text] [--model MODEL] [--model-home PATH]
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

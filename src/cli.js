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
      allowSymlink: boolFlag(flags["allow-symlink"], false),
      allowPrefix: boolFlag(flags["allow-prefix"], false),
      verificationLevel: flags.verify || "V0",
      tokenBudget: flags.budget || DEFAULTS.tokenBudget,
      maxRecordBytes: flags["max-record-bytes"],
      maxDecompressedBytes: flags["max-decompressed-bytes"],
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
    const results = searchCase(caseDir, terms, Number(flags.limit || 25));
    if (flags.json) return print(JSON.stringify(results, null, 2));
    if (!results.length) return print("No matching events.");
    for (const event of results) print(`${event.id}  ${event.observed_at || "ORDER_ONLY"}  ${event.kind}/${event.subtype || "-"}\n  ${(event.input_preview || event.output_preview || "").replace(/\n/g, " ").slice(0, 500)}\n  ${event.evidence.map((ref) => ref.uri).join("\n  ")}`);
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

  if (command === "benchmark") {
    const result = await runBenchmark({ output: flags.out, giantRecords: Number(flags["giant-records"] || 10_000) });
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

function printHelp() {
  print(`Agent Forensic Handoff (afh) ${AFH_VERSION}

Usage:
  afh audit <session-id|path> [--harness auto|codex|claude|antigravity|generic]
      [--workspace PATH] [--verify V0|V1] [--budget 6000] [--out AFH_HOME]
      [--no-children] [--allow-prefix] [--allow-symlink] [--json]
  afh hydrate <case-dir> [--budget 6000]
  afh query <case-dir> <terms> [--limit 25] [--json]
  afh show <case-dir> <event-id>
  afh evidence <case-dir> <afh://evidence/...> [--json]
  afh install-skill [--target codex|claude|antigravity|all|generic] [--path PATH] [--force]
  afh benchmark [--giant-records 10000] [--out PATH]
  afh doctor [--json]

Safety:
  Audit is read-only toward historical sources and project workspaces. V0 and V1 never run
  commands found in a transcript or project tests/builds. Generated cases are sensitive and
  must not be committed or published.`);
}

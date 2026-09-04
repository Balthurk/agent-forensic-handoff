import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashFile, sha256, stableStringify, walkFiles } from "./util.js";
import { computeGraphIdentity } from "./graph.js";

export async function verifyCaseIntegrity(caseDir, { deep = true, verifyProjections = true } = {}) {
  const root = path.resolve(caseDir);
  const findings = [];
  const add = (check, ok, detail) => findings.push({ check, ok: Boolean(ok), detail });
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, "case.json"), "utf8")); }
  catch (error) { return { caseDir: root, passed: false, deep, findings: [{ check: "manifest", ok: false, detail: String(error.message || error) }] }; }
  add("manifest.complete", manifest.status === "COMPLETE", `status=${manifest.status ?? "missing"}`);

  const dbPath = path.join(root, "case.sqlite");
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); }
  catch (error) {
    add("sqlite.open", false, String(error.message || error));
    return { caseDir: root, caseHash: manifest.caseHash ?? null, passed: false, deep, findings };
  }
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
    add("sqlite.integrity", integrity.length === 1 && integrity[0] === "ok", integrity.join("; "));
    const run = db.prepare("SELECT * FROM ingest_run ORDER BY started_at DESC LIMIT 1").get();
    add("schema.version", Number(run?.schema_version) === Number(manifest.schemaVersion), `db=${run?.schema_version ?? "missing"}; manifest=${manifest.schemaVersion ?? "missing"}`);

    const sources = db.prepare("SELECT * FROM source ORDER BY id").all();
    add("sources.count", sources.length === manifest.sources?.length, `db=${sources.length}; manifest=${manifest.sources?.length ?? "missing"}`);
    const sourceRoot = path.resolve(root, "evidence", "sources") + path.sep;
    for (const source of sources) {
      const sourcePath = path.resolve(root, source.evidence_path || "");
      const safe = sourcePath.startsWith(sourceRoot);
      add(`source.${source.id}.path`, safe && fs.existsSync(sourcePath), safe ? source.evidence_path : "path escapes evidence/sources");
      if (!safe || !fs.existsSync(sourcePath)) continue;
      const stat = fs.statSync(sourcePath);
      const digest = await hashFile(sourcePath);
      add(`source.${source.id}.length`, stat.size === Number(source.canonical_byte_length), `actual=${stat.size}; expected=${source.canonical_byte_length}`);
      add(`source.${source.id}.sha256`, digest === source.canonical_sha256, `actual=${digest}; expected=${source.canonical_sha256}`);
      const manifestSource = manifest.sources.find((item) => item.rawSha256 === source.raw_sha256 && item.nativeId === db.prepare("SELECT native_id FROM session WHERE source_id=? ORDER BY id LIMIT 1").get(source.id)?.native_id)
        ?? manifest.sources.find((item) => item.rawSha256 === source.raw_sha256);
      add(`source.${source.id}.manifest`, Boolean(manifestSource) && manifestSource.canonicalSha256 === source.canonical_sha256, manifestSource ? "matched" : "missing from manifest");
      if (deep) verifySourceRecords(db, source, sourcePath, add);
    }

    const orphanRefs = Number(db.prepare(`SELECT COUNT(*) n FROM evidence_ref er
      LEFT JOIN source_record sr ON sr.source_id=er.source_id AND sr.ordinal=er.record_ordinal
      WHERE sr.source_id IS NULL OR sr.sha256<>er.record_sha256`).get().n);
    add("evidence.refs", orphanRefs === 0, `${orphanRefs} missing or hash-disagreeing reference(s)`);
    const uncovered = Number(db.prepare(`SELECT COUNT(*) n FROM source_record sr WHERE NOT EXISTS
      (SELECT 1 FROM evidence_ref er WHERE er.source_id=sr.source_id AND er.record_ordinal=sr.ordinal)`).get().n);
    add("records.evidence_coverage", uncovered === 0, `${uncovered} source record(s) without an evidence reference`);

    verifyContentBlobs(db, root, deep, add);
    verifyGraph(db, manifest, add);
    verifyMetrics(db, manifest, add);
    const pack = db.prepare("SELECT * FROM hydration_pack ORDER BY created_at DESC,id DESC LIMIT 1").get();
    const hotPath = path.join(root, "hot-context.md");
    if (pack && fs.existsSync(hotPath)) {
      const hotBytes = fs.readFileSync(hotPath);
      const digest = sha256(hotBytes);
      const legacyDigest = sha256(hotBytes.toString("utf8").replace(/\r?\n$/, ""));
      const exact = digest === pack.content_sha256;
      const legacy = !exact && legacyDigest === pack.content_sha256;
      add("hydration.sha256", exact || legacy, `${legacy ? "legacy-no-terminal-newline; " : ""}actual=${digest}; expected=${pack.content_sha256}`);
    } else add("hydration.present", false, "hydration pack or hot-context.md missing");

    const snapshotSources = [...manifest.sources].sort((a, b) => a.nativeUri.localeCompare(b.nativeUri)).map((source) => ({
      harness: source.harness, nativeId: source.nativeId, rawSha256: source.rawSha256, byteLength: source.byteLength,
    }));
    const sourceSnapshotHash = sha256(stableStringify(snapshotSources));
    add("case.source_snapshot_hash", sourceSnapshotHash === manifest.sourceSnapshotHash, `actual=${sourceSnapshotHash}; expected=${manifest.sourceSnapshotHash}`);
    const semanticConfig = { ...manifest.config, workspace: manifest.config?.workspace ? "<explicit>" : null };
    const caseHash = sha256(stableStringify({ schemaVersion: manifest.schemaVersion, sources: sourceSnapshotHash, config: semanticConfig }));
    add("case.hash", caseHash === manifest.caseHash, `actual=${caseHash}; expected=${manifest.caseHash}`);
  } catch (error) {
    add("verification.runtime", false, String(error.message || error));
  } finally {
    db.close();
  }
  if (verifyProjections) await verifySemanticProjections(root, deep, add);
  return { caseDir: root, caseHash: manifest.caseHash ?? null, deep, passed: findings.every((item) => item.ok), findings };
}

async function verifySemanticProjections(root, deep, add) {
  const projectionsRoot = path.join(root, "projections");
  if (!fs.existsSync(projectionsRoot)) return;
  const targets = fs.readdirSync(projectionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(projectionsRoot, entry.name))
    .filter((target) => fs.existsSync(path.join(target, "projection.json")))
    .sort();
  if (!targets.length) return;
  const { verifySemanticProjection } = await import("./semantic.js");
  for (const target of targets) {
    const result = await verifySemanticProjection(root, target, { deep });
    add(`projection.${path.basename(target)}`, result.passed, result.passed ? `${result.findings.length} semantic checks passed` : failedProjectionChecks(result));
  }
}

function failedProjectionChecks(result) {
  return result.findings.filter((finding) => !finding.ok).map((finding) => `${finding.check}: ${finding.detail}`).join("; ") || "unknown semantic projection failure";
}

function verifyGraph(db, manifest, add) {
  const hasEntityEdge = db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='entity_edge'").get();
  if (!hasEntityEdge && Number(manifest.schemaVersion) < 3) return;
  const orphanEventEdges = Number(db.prepare(`SELECT COUNT(*) n FROM event_edge ee
    LEFT JOIN event f ON f.id=ee.from_event_id LEFT JOIN event t ON t.id=ee.to_event_id
    WHERE f.id IS NULL OR t.id IS NULL`).get().n);
  add("graph.event_edge_endpoints", orphanEventEdges === 0, `${orphanEventEdges} orphan event edge(s)`);
  const orphanSessionEdges = Number(db.prepare(`SELECT COUNT(*) n FROM session_edge se
    LEFT JOIN session p ON p.id=se.parent_session_id LEFT JOIN session c ON c.id=se.child_session_id
    WHERE p.id IS NULL OR c.id IS NULL`).get().n);
  add("graph.session_edge_endpoints", orphanSessionEdges === 0, `${orphanSessionEdges} orphan session edge(s)`);
  if (hasEntityEdge) {
    const nodes = `SELECT id FROM event UNION SELECT id FROM session UNION SELECT id FROM artifact
      UNION SELECT id FROM validation UNION SELECT id FROM claim UNION SELECT id FROM task UNION SELECT id FROM decision_record`;
    const orphanEntityEdges = Number(db.prepare(`WITH nodes AS (${nodes}) SELECT COUNT(*) n FROM entity_edge ee
      LEFT JOIN nodes f ON f.id=ee.from_node_id LEFT JOIN nodes t ON t.id=ee.to_node_id
      WHERE f.id IS NULL OR t.id IS NULL`).get().n);
    add("graph.entity_edge_endpoints", orphanEntityEdges === 0, `${orphanEntityEdges} orphan entity edge(s)`);
    const missingEvidence = Number(db.prepare(`SELECT COUNT(*) n FROM entity_edge ee LEFT JOIN event e ON e.id=ee.evidence_event_id
      WHERE ee.evidence_event_id IS NOT NULL AND e.id IS NULL`).get().n);
    add("graph.edge_evidence", missingEvidence === 0, `${missingEvidence} edge evidence reference(s) unresolved`);
  }
  const adapter = {
    all: (sql, params = {}) => db.prepare(sql).all(params),
    get: (sql, params = {}) => db.prepare(sql).get(params),
  };
  const actual = computeGraphIdentity(adapter);
  add("graph.identity", actual === manifest.graphIdentity, `actual=${actual}; expected=${manifest.graphIdentity ?? "missing"}`);
}

function verifySourceRecords(db, source, sourcePath, add) {
  const records = db.prepare("SELECT * FROM source_record WHERE source_id=? ORDER BY ordinal").all(source.id);
  const fd = fs.openSync(sourcePath, "r");
  let failures = 0;
  try {
    for (const record of records) {
      if (!Number.isSafeInteger(record.byte_offset) || !Number.isSafeInteger(record.byte_length) || record.byte_offset < 0 || record.byte_length < 0 || record.byte_length > 64 * 1024 * 1024) {
        failures += 1;
        continue;
      }
      const buffer = Buffer.alloc(record.byte_length);
      const read = fs.readSync(fd, buffer, 0, buffer.length, record.byte_offset);
      if (read !== buffer.length || sha256(buffer) !== record.sha256) failures += 1;
    }
  } finally { fs.closeSync(fd); }
  add(`source.${source.id}.records`, failures === 0, `${records.length} checked; ${failures} mismatch(es)`);
}

function verifyContentBlobs(db, root, deep, add) {
  const hasTable = db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='content_blob'").get();
  if (!hasTable) {
    const files = walkFiles(path.join(root, "evidence", "blobs"));
    let failures = 0;
    if (deep) {
      for (const file of files) {
        const expected = path.basename(file).split(".")[0];
        const actual = sha256(fs.readFileSync(file));
        if (actual !== expected) failures += 1;
      }
    }
    add("blobs.legacy", failures === 0, `${files.length} legacy file blob(s); ${deep ? `${failures} mismatch(es)` : "hash scan skipped"}`);
    return;
  }
  const blobs = db.prepare("SELECT * FROM content_blob ORDER BY sha256").all();
  const blobRoot = path.resolve(root, "evidence", "blobs") + path.sep;
  let failures = 0;
  for (const blob of blobs) {
    let data;
    if (blob.storage === "SQLITE") data = Buffer.from(blob.inline_data);
    else {
      const file = path.resolve(root, blob.evidence_path || "");
      if (!file.startsWith(blobRoot) || !fs.existsSync(file)) { failures += 1; continue; }
      if (!deep) continue;
      data = fs.readFileSync(file);
    }
    if (data && (data.length !== Number(blob.byte_length) || sha256(data) !== blob.sha256)) failures += 1;
  }
  add("blobs.content_addressing", failures === 0, `${blobs.length} indexed blob(s); ${failures} mismatch(es)`);
}

function verifyMetrics(db, manifest, add) {
  const queries = {
    sources: "SELECT COUNT(*) n FROM source",
    sourceRecords: "SELECT COUNT(*) n FROM source_record",
    parsedRecords: "SELECT COUNT(*) n FROM source_record WHERE parse_status='PARSED'",
    unparsedRecords: "SELECT COUNT(*) n FROM source_record WHERE parse_status!='PARSED'",
    events: "SELECT COUNT(*) n FROM event",
    tools: "SELECT COUNT(*) n FROM tool_execution",
    artifacts: "SELECT COUNT(*) n FROM artifact",
    decisions: "SELECT COUNT(*) n FROM decision_record",
    tasks: "SELECT COUNT(*) n FROM task",
    validations: "SELECT COUNT(*) n FROM validation",
    warnings: "SELECT COUNT(*) n FROM parse_warning",
    ...(manifest.metrics?.graphEdges == null ? {} : { graphEdges: "SELECT (SELECT COUNT(*) FROM event_edge)+(SELECT COUNT(*) FROM session_edge)+(SELECT COUNT(*) FROM entity_edge) n" }),
  };
  const mismatches = [];
  for (const [key, sql] of Object.entries(queries)) {
    const actual = Number(db.prepare(sql).get().n);
    if (actual !== Number(manifest.metrics?.[key])) mismatches.push(`${key}:${actual}!=${manifest.metrics?.[key]}`);
  }
  add("manifest.metrics", mismatches.length === 0, mismatches.length ? mismatches.join("; ") : "selected metrics match database");
}

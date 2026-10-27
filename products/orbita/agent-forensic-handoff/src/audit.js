import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AFH_VERSION, DEFAULTS, EPISTEMIC, SCHEMA_VERSION } from "./constants.js";
import { CaseDatabase } from "./database.js";
import { assertSafeSourcePath, resolveSession, validateResolvedSources } from "./discovery.js";
import { decodedLines, EvidenceStore } from "./evidence.js";
import { inferredSessionFromSource, normalizeRecord } from "./adapters.js";
import { reduceCase, computeCaseMetrics } from "./reducers.js";
import { verifyCurrentState } from "./verify.js";
import { renderCase } from "./render.js";
import { atomicWrite, ensureDir, hashFile, preview, redactText, safeJson, sha256, shortHash, stableStringify, slug } from "./util.js";
import { computeGraphIdentity, computeTemporalIdentity } from "./graph.js";

export async function auditSession(identifier, options = {}) {
  if (!options._deferIdentity && !/^https?:\/\//i.test(identifier)) {
    const {isConversationInput,importConversation}=await import('./conversation-intake.js');
    if(isConversationInput(identifier))return importConversation(identifier,options);
  }
  if (/^https?:\/\//i.test(identifier)) {
    const { importChatGPTShare } = await import('./chatgpt-share.js');
    return importChatGPTShare(identifier, options);
  }
  const config = {
    harness: options.harness || "auto",
    identityContract: "afh.identity-evidence.v1",
    includeChildren: options.includeChildren ?? DEFAULTS.includeChildren,
    maxChildSessions: Number(options.maxChildSessions ?? DEFAULTS.maxChildSessions),
    inlineBlobBytes: Number(options.inlineBlobBytes ?? DEFAULTS.inlineBlobBytes),
    verificationLevel: options.verificationLevel || DEFAULTS.verificationLevel,
    tokenBudget: Number(options.tokenBudget || DEFAULTS.tokenBudget),
    maxRecordBytes: Number(options.maxRecordBytes || DEFAULTS.maxRecordBytes),
    maxDecompressedBytes: Number(options.maxDecompressedBytes || DEFAULTS.maxDecompressedBytes),
    maxTotalSourceBytes: Number(options.maxTotalSourceBytes || DEFAULTS.maxTotalSourceBytes),
    maxCompressionRatio: Number(options.maxCompressionRatio || DEFAULTS.maxCompressionRatio),
    workspace: options.workspace ? path.resolve(options.workspace) : null,
  };
  validateAuditConfig(config);
  const resolution = await resolveSession(identifier, { ...options, ...config });
  validateResolvedSources(resolution.sources, { allowSymlink: Boolean(options.allowSymlink) });
  const sources = resolution.sources.map((source) => ({ ...source, byteLength: fs.statSync(source.path).size }));
  const totalSourceBytes = sources.reduce((sum, source) => sum + source.byteLength, 0);
  if (totalSourceBytes > config.maxTotalSourceBytes) {
    throw new Error(`Resolved sources total ${totalSourceBytes} bytes, exceeding maxTotalSourceBytes=${config.maxTotalSourceBytes}`);
  }
  for (const source of sources) source.rawSha256 = await hashFile(source.path, source.byteLength);
  sources.sort((a, b) => a.path.localeCompare(b.path));
  const snapshotHash = sha256(stableStringify(sources.map((source) => ({
    harness: source.harness, nativeId: source.nativeId, rawSha256: source.rawSha256, byteLength: source.byteLength,
  }))));
  const semanticConfig = { ...config, workspace: config.workspace ? "<explicit>" : null };
  const caseHash = sha256(stableStringify({ schemaVersion: SCHEMA_VERSION, sources: snapshotHash, config: semanticConfig }));
  const base = path.resolve(options.out || process.env.AFH_HOME || path.join(os.homedir(), ".afh"));
  const caseDir = options.caseDir
    ? path.resolve(options.caseDir)
    : path.join(base, "cases", slug(resolution.rootNativeId || identifier), caseHash.slice(0, 16));
  const manifestPath = path.join(caseDir, "case.json");
  if (fs.existsSync(manifestPath)) {
    const existing = safeJson(fs.readFileSync(manifestPath, "utf8"), {});
    if (existing.caseHash === caseHash && existing.status === "COMPLETE") {
      return { caseDir, caseHash, reused: true, manifest: existing, metrics: existing.metrics };
    }
    throw new Error(`Case directory already exists with different evidence: ${caseDir}`);
  }

  ensureDir(path.dirname(caseDir));
  const staging = `${caseDir}.tmp-${process.pid}`;
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  ensureDir(staging);
  const db = new CaseDatabase(path.join(staging, "case.sqlite"));
  const evidence = new EvidenceStore(staging, { db, inlineBlobBytes: config.inlineBlobBytes });
  const runId = `run-${caseHash.slice(0, 20)}`;
  const startedAt = new Date().toISOString();
  const counters = { records: 0, parsed: 0, unparsed: 0, warnings: 0 };
  let currentSourceWriter = null;

  try {
    db.insertRun({ id: runId, schemaVersion: SCHEMA_VERSION, toolVersion: AFH_VERSION, config, sourceSnapshotHash: snapshotHash, startedAt, status: "RUNNING" });
    db.begin();
    for (const source of sources) {
      const sourceId = `src-${shortHash([source.harness, source.rawSha256], 24)}`;
      source.sourceId = sourceId;
      const compression = source.path.endsWith(".zst") || source.path.endsWith(".zstd") ? "zstd" : source.path.endsWith(".gz") ? "gzip" : "none";
      db.insertSource({
        id: sourceId, harness: source.harness, nativeUri: source.path, kind: source.kind,
        rawSha256: source.rawSha256, byteLength: source.byteLength, compression,
        schemaHint: source.harness, availability: "AVAILABLE",
      });
      const fallbackSession = inferredSessionFromSource(source);
      db.upsertSession(fallbackSession);
      let currentSession = fallbackSession;
      let currentTurnId = null;
      let implicitTurnCounter = 0;
      currentSourceWriter = evidence.beginCanonicalSource(sourceId, source.rawSha256);
      let decompressedBytes = 0;
      const dedupe = new Map();

      for await (const decoded of decodedLines(source.path, source.byteLength)) {
        counters.records += 1;
        decompressedBytes = decoded.byteOffset + decoded.byteLength + 1;
        if (decoded.byteLength > config.maxRecordBytes) throw new Error(`Record ${decoded.ordinal} in ${source.path} exceeds maxRecordBytes`);
        if (decompressedBytes > config.maxDecompressedBytes) throw new Error(`Decompressed source exceeds maxDecompressedBytes: ${source.path}`);
        if (source.byteLength > 0 && decompressedBytes / source.byteLength > config.maxCompressionRatio) throw new Error(`Compression ratio exceeds safety limit: ${source.path}`);
        currentSourceWriter.append(decoded.line);
        const recordHash = sha256(decoded.line);
        let record;
        let parseError = null;
        try { record = JSON.parse(decoded.line); } catch (error) { parseError = String(error.message || error); }
        const recordType = Array.isArray(record) ? "json-array" : record?.type ?? record?.event ?? record?.kind ?? null;
        db.insertRecord({
          sourceId, ordinal: decoded.ordinal, byteOffset: decoded.byteOffset,
          byteLength: decoded.byteLength, sha256: recordHash, recordType,
          parseStatus: parseError ? "UNPARSED" : "PARSED", parseError,
        });
        if (parseError) {
          counters.unparsed += 1;
          counters.warnings += 1;
          const warningId = `wrn-${shortHash([sourceId, decoded.ordinal, parseError])}`;
          db.insertWarning({ id: warningId, sourceId, recordOrdinal: decoded.ordinal, code: "INVALID_JSON", message: parseError, evidenceRefId: null });
          insertUnparsedEvent(db, {
            source, sourceId, currentSession, decoded, recordHash, warningId, dedupe,
          });
          continue;
        }
        counters.parsed += 1;
        const records = Array.isArray(record) ? record : [record];
        for (let arrayIndex = 0; arrayIndex < records.length; arrayIndex += 1) {
          const raw = records[arrayIndex];
          const context = {
            harness: source.harness, nativeId: source.nativeId, sourceId,
            stateMetadata: source.stateMetadata, sessionNativeId: currentSession.nativeId,
          };
          const normalizedEvents = normalizeRecord(raw, context);
          for (let eventIndex = 0; eventIndex < normalizedEvents.length; eventIndex += 1) {
            const normalized = normalizedEvents[eventIndex];
            if (normalized.session) {
              currentSession = { ...normalized.session, sourceId };
              db.upsertSession(currentSession);
            }
            if (normalized.kind === "session.turn_context" && normalized.turnId) {
              currentTurnId = normalized.turnId;
            } else if (normalized.turnId) {
              currentTurnId = normalized.turnId;
            } else if (normalized.kind === "message.user" && normalized.subtype !== "event_msg" && normalized.subtype !== "item_completed.UserMessage") {
              implicitTurnCounter += 1;
              currentTurnId = `turn-implicit-${implicitTurnCounter}`;
            }
            if (!normalized.turnId && currentTurnId && normalized.kind !== "session.meta") {
              normalized.turnId = currentTurnId;
            }
            const session = normalized.session ?? currentSession;
            const subordinal = arrayIndex * 1000 + eventIndex;
            insertNormalizedEvent(db, evidence, {
              source, sourceId, session, normalized, decoded, recordHash, subordinal, dedupe,
            });
          }
        }
      }
      const canonical = currentSourceWriter.finish();
      currentSourceWriter = null;
      db.updateCanonicalSource(sourceId, canonical.sha256, canonical.byteLength, canonical.path);
      source.canonicalSha256 = canonical.sha256;
      source.canonicalByteLength = canonical.byteLength;
      source.evidencePath = canonical.path;
      const stableRawSha256 = await hashFile(source.path, source.byteLength);
      if (stableRawSha256 !== source.rawSha256) throw new Error(`Source prefix changed during acquisition: ${source.path}`);
    }
    for (const edge of resolution.edges ?? []) {
      const parent = `ses:codex:${edge.parent_thread_id}`;
      const child = `ses:codex:${edge.child_thread_id}`;
      if (db.get("SELECT id FROM session WHERE id=$id", { id: parent }) && db.get("SELECT id FROM session WHERE id=$id", { id: child })) {
        db.insertSessionEdge({ parent, child, type: edge.edge_type || "SPAWNED", epistemic: EPISTEMIC.DIRECT });
      }
    }
    if (sources.some(source => source.harness === 'chatgpt-share')) {
      const published=db.all("SELECT id,session_id,metadata_json FROM event WHERE subtype LIKE 'chatgpt-share.%' OR subtype='chatgpt.shared_node'");
      const nodes=new Map(published.map(e=>[`${e.session_id}:${JSON.parse(e.metadata_json).nodeId}`,e.id]));
      for(const e of published) {
        const metadata=JSON.parse(e.metadata_json),parent=nodes.get(`${e.session_id}:${metadata.parentNodeId}`);
        if(parent)db.insertEventEdge({from:parent,to:e.id,type:'PUBLISHED_PARENT',grade:'EXPLICIT',rule:'chatgpt-share.parent',epistemic:EPISTEMIC.DIRECT,evidenceEventId:e.id,metadata:{causalityClaimed:false}});
      }
    }
    finalizeIncompleteTools(db);
    reduceCase(db);
    db.commit();
    const verification = await verifyCurrentState(db, { level: config.verificationLevel, workspace: config.workspace });
    const completedAt = new Date().toISOString();
    db.finishRun(runId, { completedAt, status: "COMPLETE", ...counters });
    const metrics = computeCaseMetrics(db);
    const graphIdentity = computeGraphIdentity(db);
    const temporalIdentity = computeTemporalIdentity(db);
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      toolVersion: AFH_VERSION,
      status: "COMPLETE",
      caseHash,
      sourceSnapshotHash: snapshotHash,
      graphIdentity,
      temporalIdentity,
      requestedIdentifier: resolution.requestedIdentifier,
      rootNativeId: resolution.rootNativeId,
      harness: resolution.harness,
      startedAt,
      completedAt,
      config,
      sources: sources.map((source) => ({
        harness: source.harness, nativeId: source.nativeId, kind: source.kind,
        nativeUri: source.path, rawSha256: source.rawSha256, byteLength: source.byteLength,
        compression: source.path.endsWith(".zst") || source.path.endsWith(".zstd") ? "zstd" : source.path.endsWith(".gz") ? "gzip" : "none",
        canonicalSha256: source.canonicalSha256, canonicalByteLength: source.canonicalByteLength,
        evidencePath: source.evidencePath,
      })),
      sourceResolutionWarnings: resolution.warnings ?? [],
      metrics,
      verification,
      safety: {
        historicalContentTrusted: false,
        historicalCommandsExecuted: false,
        projectCommandsExecuted: false,
        projectionsRedacted: true,
        rawEvidenceMayContainSecrets: true,
      },
    };
    atomicWrite(path.join(staging, "case.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await renderCase(db, staging, manifest, { tokenBudget: config.tokenBudget });
    db.close();
    if(!options._deferIdentity) {
      const {archiveNativeSources,writeIdentity}=await import('./identity-evidence.js');
      archiveNativeSources(staging,sources);await writeIdentity(staging);
    }
    ensureDir(path.dirname(caseDir));
    fs.renameSync(staging, caseDir);
    return { caseDir, caseHash, reused: false, manifest:JSON.parse(fs.readFileSync(path.join(caseDir,'case.json'),'utf8')), metrics };
  } catch (error) {
    currentSourceWriter?.abort();
    try { db.rollback(); } catch {}
    try { db.close(); } catch {}
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function validateAuditConfig(config) {
  for (const key of ["tokenBudget", "maxRecordBytes", "maxDecompressedBytes", "maxTotalSourceBytes", "maxCompressionRatio", "maxChildSessions", "inlineBlobBytes"]) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive finite number`);
  }
  if (config.tokenBudget > 1_000_000) throw new Error("tokenBudget exceeds the 1,000,000-token safety limit");
  if (config.maxRecordBytes > config.maxDecompressedBytes) throw new Error("maxRecordBytes cannot exceed maxDecompressedBytes");
  if (config.maxCompressionRatio < 1) throw new Error("maxCompressionRatio must be at least 1");
  if (!Number.isInteger(config.maxChildSessions) || config.maxChildSessions > 256) throw new Error("maxChildSessions must be an integer between 1 and 256");
  if (!Number.isInteger(config.inlineBlobBytes) || config.inlineBlobBytes > 1024 * 1024) throw new Error("inlineBlobBytes must be an integer between 1 and 1048576");
}

function insertUnparsedEvent(db, { source, sourceId, currentSession, decoded, recordHash, dedupe }) {
  const eventId = `evt-${shortHash([sourceId, decoded.ordinal, "unparsed"], 24)}`;
  const uri = evidenceUri(source.rawSha256, decoded);
  db.upsertActor({ id: "act:forensic-parser", kind: "TOOL", role: "parser", displayName: "AFH parser", epistemic: EPISTEMIC.DIRECT });
  db.insertEvent({
    id: eventId, sessionId: currentSession.id, sourceId, recordOrdinal: decoded.ordinal,
    observedAt: null, timePrecision: "ORDER_ONLY", actorId: "act:forensic-parser",
    kind: "forensic.unparsed_record", subtype: "invalid_json", status: "PRESERVED",
    inputPreview: null, outputPreview: null, metadata: { warning: "INVALID_JSON" }, epistemic: EPISTEMIC.DIRECT,
  });
  db.insertEvidenceRef({
    id: `evr-${shortHash([eventId, uri])}`, eventId, sourceId, recordOrdinal: decoded.ordinal,
    byteOffset: decoded.byteOffset, byteLength: decoded.byteLength, recordSha256: recordHash,
    uri, availability: "AVAILABLE",
  });
}

export function insertNormalizedEvent(db, evidence, { source, sourceId, session, normalized, decoded, recordHash, subordinal, dedupe }) {
  db.upsertSession({ ...session, sourceId });
  db.upsertActor(normalized.actor);
  const eventIdentity = [sourceId, decoded.ordinal, subordinal, normalized.kind, normalized.callId, normalized.nativeId];
  const eventId = `evt-${shortHash(eventIdentity, 24)}`;
  // Normalized event values remain recoverable from the exact source record referenced below.
  // Persist their digest for identity, but do not duplicate full transcript payloads as blobs.
  const inputBlob = normalized.input ? evidence.digestText(normalized.input) : null;
  const outputBlob = normalized.output ? evidence.digestText(normalized.output) : null;
  const inputProjection = normalized.input ? preview(normalized.input) : { text: null, findings: [], truncated: false };
  const outputProjection = normalized.output ? preview(normalized.output) : { text: null, findings: [], truncated: false };
  const fingerprint = shortHash([
    session.id,
    normalized.kind,
    normalized.actor.id,
    inputBlob?.sha256,
    outputBlob?.sha256,
    normalized.callId,
    normalized.turnId ?? null,
    normalized.nativeId ?? null,
    normalized.status,
  ], 32);
  const crossChannelFingerprint = shortHash([
    session.id,
    normalized.kind,
    normalized.actor.id,
    inputBlob?.sha256,
    outputBlob?.sha256,
    normalized.callId,
    normalized.status,
  ], 32);
  const priorExact = dedupe.get(fingerprint);
  const priorCross = dedupe.get(crossChannelFingerprint);
  const prior = priorExact || priorCross;
  const turnMismatch = Boolean(
    prior && (normalized.turnId || prior.turnId) && normalized.turnId !== prior.turnId
  );
  const nativeIdMismatch = Boolean(
    prior && (normalized.nativeId || prior.nativeId) && normalized.nativeId !== prior.nativeId
  );
  const sameChannelRepeat = Boolean(
    prior &&
    normalized.subtype &&
    prior.subtype &&
    normalized.subtype === prior.subtype &&
    ["message.user", "message.agent"].includes(normalized.kind) &&
    (!normalized.nativeId || normalized.nativeId !== prior.nativeId)
  );
  const duplicate = Boolean(
    prior &&
    !turnMismatch &&
    !nativeIdMismatch &&
    !sameChannelRepeat &&
    decoded.ordinal - prior.ordinal <= 20 &&
    ["message.user", "message.agent", "tool.completed", "session.compacted"].includes(normalized.kind)
  );
  if (!duplicate) {
    const entry = {
      id: eventId,
      ordinal: decoded.ordinal,
      turnId: normalized.turnId ?? null,
      nativeId: normalized.nativeId ?? null,
      subtype: normalized.subtype ?? null,
    };
    dedupe.set(fingerprint, entry);
    dedupe.set(crossChannelFingerprint, entry);
  }
  const event = {
    id: eventId, sessionId: session.id, sourceId, recordOrdinal: decoded.ordinal, subordinal,
    observedAt: normalized.observedAt, timePrecision: normalized.timePrecision,
    actorId: normalized.actor.id, kind: normalized.kind, subtype: normalized.subtype,
    phase: normalized.phase, status: normalized.status, nativeId: normalized.nativeId,
    callId: normalized.callId, turnId: normalized.turnId, canonical: !duplicate,
    duplicateOf: duplicate ? prior.id : null,
    inputPreview: inputProjection.text, outputPreview: outputProjection.text,
    inputBlobSha256: inputBlob?.sha256 ?? null, outputBlobSha256: outputBlob?.sha256 ?? null,
    metadata: { ...normalized.metadata, projectionTruncated: inputProjection.truncated || outputProjection.truncated },
    epistemic: normalized.epistemic,
  };
  db.insertEvent(event);
  // Keep compact display previews, but index the full redacted published message.
  if (['chatgpt-share','chatgpt-import'].includes(normalized.metadata?.origin)) {
    db.run('UPDATE event_fts SET input_preview=$input,output_preview=$output WHERE event_id=$id', {input:redactText(normalized.input||'').text,output:redactText(normalized.output||'').text,id:eventId});
  }
  const uri = evidenceUri(source.rawSha256, decoded);
  const evidenceRefId = `evr-${shortHash([eventId, uri, normalized.pointer || ""])}`;
  db.insertEvidenceRef({
    id: evidenceRefId, eventId, sourceId, recordOrdinal: decoded.ordinal,
    jsonPointer: normalized.pointer ?? "", byteOffset: decoded.byteOffset,
    byteLength: decoded.byteLength, recordSha256: recordHash, uri, availability: "AVAILABLE",
  });
  for (const finding of [...inputProjection.findings, ...outputProjection.findings]) {
    db.insertSecretFinding({
      id: `sec-${shortHash([eventId, finding.kind, finding.fingerprint])}`,
      source: sourceId, event: eventId, kind: finding.kind,
      fingerprint: finding.fingerprint, projection: "REDACTED",
    });
  }
  if (normalized.kind === "forensic.unknown_record") {
    db.insertWarning({
      id: `wrn-${shortHash([eventId, "unknown-record"])}`, sourceId, recordOrdinal: decoded.ordinal,
      code: "UNKNOWN_RECORD", message: `Preserved unsupported record: ${normalized.subtype ?? "unknown"}`, evidenceRefId,
    });
  }
  processTool(db, event, normalized);
  processArtifacts(db, evidence, event, normalized.artifacts ?? [], session.cwd, evidenceRefId);
  for (const edge of normalized.sessionEdges ?? []) {
    const parent = `ses:${session.harness}:${edge.parentNativeId}`;
    const child = `ses:${session.harness}:${edge.childNativeId}`;
    db.upsertSession({ id: parent, nativeId: edge.parentNativeId, harness: session.harness, sourceId, metadata: {} });
    db.upsertSession({ id: child, nativeId: edge.childNativeId, harness: session.harness, sourceId, metadata: {} });
    db.insertSessionEdge({ parent, child, type: edge.type, epistemic: EPISTEMIC.DIRECT, eventId });
  }
}

function evidenceUri(rawHash, decoded) {
  return `afh://evidence/sha256/${rawHash}/record/${decoded.ordinal}#bytes=${decoded.byteOffset}:${decoded.byteLength}`;
}

export function processTool(db, event, normalized) {
  const correlatedPatch = event.kind === "filesystem.patch" && Boolean(event.callId);
  if (!correlatedPatch && !["tool.requested", "tool.completed", "mcp.completed", "tool.observed"].includes(event.kind)) return;
  const callId = event.callId || event.nativeId || event.id;
  const observedCommand = normalized.metadata?.command || extractCommand(normalized.input) || null;
  const incomingStatus = event.kind === "tool.requested" ? "REQUESTED" : (event.status || "COMPLETED");
  let observedMatch = null;
  if (event.kind === "tool.observed" && !event.callId && observedCommand) {
    const candidates = db.all(
      `SELECT te.*, ce.turn_id AS call_turn_id, ce.call_id AS req_call_id, ce.native_id AS req_native_id,
              re.kind AS res_kind, re.turn_id AS res_turn_id, re.native_id AS res_native_id
       FROM tool_execution te
       LEFT JOIN event ce ON ce.id = te.call_event_id
       LEFT JOIN event re ON re.id = te.result_event_id
       WHERE te.session_id = $session AND te.command_text = $command
       ORDER BY COALESCE(te.ended_at, te.started_at, '') DESC, te.id DESC`,
      { session: event.sessionId, command: observedCommand },
    );
    observedMatch = candidates.find((cand) => {
      if (!cand.call_event_id) return false;
      if (cand.res_kind === "tool.observed") return false;
      const candTurnId = cand.call_turn_id || cand.res_turn_id || null;
      if (event.turnId && candTurnId && event.turnId !== candTurnId) return false;
      const candNativeId = cand.req_native_id || cand.res_native_id || null;
      if (event.nativeId && candNativeId && event.nativeId !== candNativeId) return false;
      if (cand.result_event_id && cand.status && cand.status !== "REQUESTED" && cand.status !== incomingStatus) return false;
      return true;
    }) ?? null;
  }
  let toolId = observedMatch?.id || `tex-${shortHash([event.sessionId, callId], 24)}`;
  let existing = observedMatch || db.get("SELECT * FROM tool_execution WHERE id=$id", { id: toolId });
  if (existing && !observedMatch && event.kind !== "tool.requested" && existing.result_event_id) {
    const prevRes = db.get("SELECT kind, turn_id, native_id, status FROM event WHERE id=$id", { id: existing.result_event_id });
    const turnConflict = Boolean(event.turnId && prevRes?.turn_id && event.turnId !== prevRes.turn_id);
    const idConflict = Boolean(event.nativeId && prevRes?.native_id && event.nativeId !== prevRes.native_id);
    const statusConflict = Boolean(existing.status && existing.status !== "REQUESTED" && existing.status !== incomingStatus);
    const sameResultKind = Boolean(prevRes?.kind && prevRes.kind === event.kind);
    if (turnConflict || idConflict || statusConflict || sameResultKind) {
      toolId = `tex-${shortHash([event.sessionId, callId, event.turnId || "", event.id], 24)}`;
      existing = db.get("SELECT * FROM tool_execution WHERE id=$id", { id: toolId });
    }
  }
  const toolName = normalized.metadata?.toolName || existing?.tool_name || normalized.subtype || "unknown";
  const command = observedCommand || existing?.command_text || null;
  const exitCode = normalized.metadata?.exitCode ?? existing?.exit_code ?? null;
  const status = event.kind === "tool.requested" ? (existing?.status ?? "REQUESTED") : (event.status || "COMPLETED");
  const semantic = event.outputPreview ? semanticExtract(event.outputPreview, status, exitCode) : existing?.semantic_extract ?? null;
  db.upsertTool({
    id: toolId, sessionId: event.sessionId, actorId: event.actorId,
    toolName, command, cwd: normalized.metadata?.cwd ?? existing?.working_directory ?? null,
    callEvent: event.kind === "tool.requested" ? event.id : existing?.call_event_id ?? null,
    resultEvent: event.kind !== "tool.requested" ? event.id : existing?.result_event_id ?? null,
    started: event.kind === "tool.requested" ? event.observedAt : existing?.started_at ?? null,
    ended: event.kind !== "tool.requested" ? event.observedAt : existing?.ended_at ?? null,
    status, exitCode, duration: normalized.metadata?.durationMs ?? existing?.duration_ms ?? null,
    inputBlob: event.inputBlobSha256 ?? existing?.input_blob_sha256 ?? null,
    outputBlob: event.outputBlobSha256 ?? existing?.output_blob_sha256 ?? null,
    semantic,
    fingerprint: shortHash([toolName, command || event.inputBlobSha256, normalized.metadata?.cwd ?? null], 32),
  });
}

function extractCommand(input) {
  if (!input) return null;
  const parsed = safeJson(input, null);
  if (parsed && typeof parsed === "object") {
    const direct = parsed.cmd ?? parsed.command ?? parsed.script;
    if (typeof direct === "string") return direct;
  }
  const commands = [];
  const pattern = /\b(?:cmd|command)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;
  let match;
  while ((match = pattern.exec(String(input))) && commands.length < 32) {
    const literal = match[1];
    try {
      if (literal.startsWith('"')) commands.push(JSON.parse(literal));
      else commands.push(literal.slice(1, -1).replace(/\\n/g, "\n").replace(/\\'/g, "'").replace(/\\`/g, "`"));
    } catch { commands.push(literal.slice(1, -1)); }
  }
  return commands.length ? commands.join("\n--- nested command ---\n") : null;
}

function semanticExtract(output, status, exitCode) {
  const lines = String(output).split(/\r?\n/).filter((line) => line.trim());
  const selected = lines.filter((line) => /(?:fail|error|warn|pass|test|build|lint|benchmark|exit|status|created|modified|deleted)/i.test(line));
  const core = (selected.length ? selected : [...lines.slice(0, 4), ...lines.slice(-4)]).slice(0, 20);
  return [`status=${status}`, exitCode == null ? null : `exit_code=${exitCode}`, ...core].filter(Boolean).join("\n").slice(0, 4000);
}

function processArtifacts(db, evidence, event, artifacts, workspaceRoot, evidenceRefId) {
  for (const item of artifacts) {
    if (!item.path || typeof item.path !== "string") continue;
    const logicalPath = workspaceRoot && path.isAbsolute(item.path) && item.path.startsWith(path.resolve(workspaceRoot) + path.sep)
      ? path.relative(workspaceRoot, item.path).replaceAll(path.sep, "/")
      : item.path.replaceAll(path.sep, "/");
    const artifactId = `art-${shortHash([workspaceRoot || "", logicalPath], 24)}`;
    const contentBlob = typeof item.content === "string" ? evidence.putText(item.content, extensionFor(item.path)) : null;
    const diffBlob = typeof item.diff === "string" ? evidence.putText(item.diff, "diff") : null;
    const prior = db.get("SELECT id FROM artifact_revision WHERE artifact_id=$id ORDER BY observed_at DESC,id DESC LIMIT 1", { id: artifactId });
    const status = event.status === "FAILED" ? "FAILED" : "LIVE_UNVERIFIED";
    db.upsertArtifact({
      id: artifactId, logicalPath, kind: artifactKind(item.path), workspaceRoot: workspaceRoot ?? null,
      currentPath: item.path, currentStatus: status, currentSha: contentBlob?.sha256 ?? null,
      firstSeen: event.observedAt, lastSeen: event.observedAt,
    });
    db.insertArtifactRevision({
      id: `rev-${shortHash([artifactId, event.id, item.operation, contentBlob?.sha256, diffBlob?.sha256], 24)}`,
      artifactId, producerEventId: event.id, predecessor: prior?.id ?? null,
      operation: item.operation || "UPDATE", contentSha: contentBlob?.sha256 ?? null,
      diffSha: diffBlob?.sha256 ?? null, observedAt: event.observedAt,
      status, evidenceRefId,
    });
  }
}

function artifactKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".md", ".txt", ".docx", ".pdf"].includes(ext)) return "DOCUMENT";
  if ([".json", ".yaml", ".yml", ".toml", ".ini", ".env"].includes(ext)) return "CONFIGURATION";
  if ([".sql", ".avsc", ".proto"].includes(ext)) return "SCHEMA";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) return "MEDIA";
  return "FILE";
}

function extensionFor(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "txt";
}

function finalizeIncompleteTools(db) {
  db.run("UPDATE tool_execution SET status='INCOMPLETE' WHERE result_event_id IS NULL AND status='REQUESTED'");
}

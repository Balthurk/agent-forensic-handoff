import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "./sqlite-compat.js";
import { ensureDir, stableStringify } from "./util.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export class CaseDatabase {
  constructor(filePath, { readOnly = false } = {}) {
    ensureDir(path.dirname(filePath));
    this.path = filePath;
    this.db = new DatabaseSync(filePath, { readOnly });
    this.statementCache = new Map();
    this.sessionValueCache = new Map();
    this.actorValueCache = new Map();
    this.db.exec("PRAGMA foreign_keys = ON");
    if (!readOnly) {
      this.db.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32768");
      this.db.exec(fs.readFileSync(path.join(MODULE_DIR, "schema.sql"), "utf8"));
    }
  }

  close() {
    this.statementCache.clear();
    this.db.close();
  }
  begin() { this.db.exec("BEGIN IMMEDIATE"); }
  commit() { this.db.exec("COMMIT"); }
  rollback() { try { this.db.exec("ROLLBACK"); } catch {} }

  statement(sql) {
    let statement = this.statementCache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statementCache.set(sql, statement);
    }
    return statement;
  }

  run(sql, params = {}) { return this.statement(sql).run(params); }
  get(sql, params = {}) { return this.statement(sql).get(params); }
  all(sql, params = {}) { return this.statement(sql).all(params); }

  insertRun(run) {
    this.run(`INSERT INTO ingest_run
      (id, schema_version, tool_version, config_json, source_snapshot_hash, started_at, status)
      VALUES ($id, $schemaVersion, $toolVersion, $config, $sourceHash, $startedAt, $status)`, {
      id: run.id, schemaVersion: run.schemaVersion, toolVersion: run.toolVersion,
      config: stableStringify(run.config), sourceHash: run.sourceSnapshotHash,
      startedAt: run.startedAt, status: run.status,
    });
  }

  finishRun(id, values) {
    this.run(`UPDATE ingest_run SET completed_at=$completedAt, status=$status,
      record_count=$records, parsed_count=$parsed, unparsed_count=$unparsed,
      warning_count=$warnings WHERE id=$id`, {
      id, completedAt: values.completedAt, status: values.status,
      records: values.records, parsed: values.parsed, unparsed: values.unparsed,
      warnings: values.warnings,
    });
  }

  insertSource(source) {
    this.run(`INSERT OR REPLACE INTO source
      (id,harness,native_uri,source_kind,raw_sha256,canonical_sha256,byte_length,
       canonical_byte_length,compression,schema_hint,availability,evidence_path)
      VALUES ($id,$harness,$uri,$kind,$rawHash,$canonicalHash,$bytes,$canonicalBytes,
       $compression,$schema,$availability,$evidencePath)`, {
      id: source.id, harness: source.harness, uri: source.nativeUri, kind: source.kind,
      rawHash: source.rawSha256, canonicalHash: source.canonicalSha256 ?? null,
      bytes: source.byteLength, canonicalBytes: source.canonicalByteLength ?? null,
      compression: source.compression, schema: source.schemaHint ?? null,
      availability: source.availability ?? "AVAILABLE", evidencePath: source.evidencePath ?? null,
    });
  }

  updateCanonicalSource(id, hash, bytes, evidencePath) {
    this.run(`UPDATE source SET canonical_sha256=$hash, canonical_byte_length=$bytes,
      evidence_path=$path WHERE id=$id`, { id, hash, bytes, path: evidencePath });
  }

  insertRecord(record) {
    this.run(`INSERT INTO source_record
      (source_id,ordinal,byte_offset,byte_length,sha256,record_type,parse_status,parse_error)
      VALUES ($sourceId,$ordinal,$offset,$length,$hash,$type,$status,$error)`, {
      sourceId: record.sourceId, ordinal: record.ordinal, offset: record.byteOffset,
      length: record.byteLength, hash: record.sha256, type: record.recordType ?? null,
      status: record.parseStatus, error: record.parseError ?? null,
    });
  }

  upsertSession(session) {
    const metadata = stableStringify(session.metadata ?? {});
    const signature = stableStringify({ ...session, metadata });
    if (this.sessionValueCache.get(session.id) === signature) return;
    this.sessionValueCache.set(session.id, signature);
    this.run(`INSERT INTO session
      (id,native_id,harness,source_id,parent_native_id,cwd,started_at,ended_at,title,harness_version,model,metadata_json)
      VALUES ($id,$nativeId,$harness,$sourceId,$parent,$cwd,$started,$ended,$title,$version,$model,$metadata)
      ON CONFLICT(id) DO UPDATE SET
        source_id=COALESCE(excluded.source_id,session.source_id),
        parent_native_id=COALESCE(excluded.parent_native_id,session.parent_native_id),
        cwd=COALESCE(excluded.cwd,session.cwd),
        started_at=COALESCE(session.started_at,excluded.started_at),
        ended_at=COALESCE(excluded.ended_at,session.ended_at),
        title=COALESCE(excluded.title,session.title),
        harness_version=COALESCE(excluded.harness_version,session.harness_version),
        model=COALESCE(excluded.model,session.model),
        metadata_json=excluded.metadata_json`, {
      id: session.id, nativeId: session.nativeId, harness: session.harness,
      sourceId: session.sourceId ?? null, parent: session.parentNativeId ?? null,
      cwd: session.cwd ?? null, started: session.startedAt ?? null,
      ended: session.endedAt ?? null, title: session.title ?? null,
      version: session.harnessVersion ?? null, model: session.model ?? null,
      metadata,
    });
  }

  insertSessionEdge(edge) {
    this.run(`INSERT OR IGNORE INTO session_edge
      (parent_session_id,child_session_id,edge_type,grade,rule_id,epistemic_status,evidence_event_id,metadata_json)
      VALUES ($parent,$child,$type,$grade,$rule,$epistemic,$event,$metadata)`, {
      parent: edge.parent, child: edge.child, type: edge.type,
      grade: edge.grade ?? "EXPLICIT", rule: edge.rule ?? null,
      epistemic: edge.epistemic, event: edge.eventId ?? null,
      metadata: stableStringify(edge.metadata ?? {}),
    });
  }

  insertEventEdge(edge) {
    this.run(`INSERT OR IGNORE INTO event_edge
      (from_event_id,to_event_id,edge_type,grade,rule_id,epistemic_status,evidence_event_id,metadata_json)
      VALUES ($from,$to,$type,$grade,$rule,$epistemic,$event,$metadata)`, {
      from: edge.from, to: edge.to, type: edge.type, grade: edge.grade,
      rule: edge.rule ?? null, epistemic: edge.epistemic,
      event: edge.evidenceEventId ?? null, metadata: stableStringify(edge.metadata ?? {}),
    });
  }

  insertEntityEdge(edge) {
    this.run(`INSERT OR IGNORE INTO entity_edge
      (from_node_id,to_node_id,from_node_kind,to_node_kind,edge_type,grade,rule_id,
       epistemic_status,evidence_event_id,metadata_json)
      VALUES ($from,$to,$fromKind,$toKind,$type,$grade,$rule,$epistemic,$event,$metadata)`, {
      from: edge.from, to: edge.to, fromKind: edge.fromKind, toKind: edge.toKind,
      type: edge.type, grade: edge.grade, rule: edge.rule ?? "",
      epistemic: edge.epistemic, event: edge.evidenceEventId ?? null,
      metadata: stableStringify(edge.metadata ?? {}),
    });
  }

  upsertEntityNode(node) {
    const existing = this.get("SELECT id, mention_count, first_seen_at, first_ordinal FROM entity_node WHERE id=$id", { id: node.id });
    if (!existing) {
      this.run(`INSERT INTO entity_node
        (id, canonical_name, entity_kind, summary, first_seen_at, last_seen_at, first_ordinal, last_ordinal,
         mention_count, validity_status, attributes_json, epistemic_status)
        VALUES ($id, $name, $kind, $summary, $firstSeen, $lastSeen, $firstOrd, $lastOrd,
         $mentions, $validity, $attrs, $epistemic)`, {
        id: node.id,
        name: node.canonicalName,
        kind: node.entityKind,
        summary: node.summary ?? null,
        firstSeen: node.observedAt ?? null,
        lastSeen: node.observedAt ?? null,
        firstOrd: node.ordinal ?? 0,
        lastOrd: node.ordinal ?? 0,
        mentions: node.mentionCount ?? 1,
        validity: node.validityStatus ?? "VIGENTE",
        attrs: typeof node.attributes === "string" ? node.attributes : stableStringify(node.attributes ?? {}),
        epistemic: node.epistemic ?? "DIRECT_EVIDENCE",
      });
      this.run(`INSERT INTO entity_fts(entity_id, canonical_name, entity_kind, summary)
        VALUES ($id, $name, $kind, $summary)`, {
        id: node.id,
        name: node.canonicalName,
        kind: node.entityKind,
        summary: node.summary ?? "",
      });
    } else {
      const nextMentions = Number(existing.mention_count || 1) + (node.incrementMention === false ? 0 : 1);
      this.run(`UPDATE entity_node SET
        summary = COALESCE($summary, entity_node.summary),
        first_seen_at = CASE WHEN entity_node.first_seen_at IS NULL THEN $lastSeen WHEN $lastSeen IS NOT NULL AND $lastSeen < entity_node.first_seen_at THEN $lastSeen ELSE entity_node.first_seen_at END,
        last_seen_at = COALESCE($lastSeen, entity_node.last_seen_at),
        first_ordinal = CASE WHEN $lastOrd IS NOT NULL AND ($lastOrd < COALESCE(entity_node.first_ordinal, 999999999)) THEN $lastOrd ELSE entity_node.first_ordinal END,
        last_ordinal = CASE WHEN $lastOrd IS NOT NULL AND ($lastOrd > COALESCE(entity_node.last_ordinal, -1)) THEN $lastOrd ELSE entity_node.last_ordinal END,
        mention_count = $mentions,
        validity_status = COALESCE($validity, entity_node.validity_status),
        attributes_json = COALESCE($attrs, entity_node.attributes_json)
        WHERE id = $id`, {
        id: node.id,
        summary: node.summary ?? null,
        lastSeen: node.observedAt ?? null,
        lastOrd: node.ordinal ?? null,
        mentions: nextMentions,
        validity: node.validityStatus ?? null,
        attrs: node.attributes ? (typeof node.attributes === "string" ? node.attributes : stableStringify(node.attributes)) : null,
      });
    }
  }

  insertEntityMention(mention) {
    this.run(`INSERT OR IGNORE INTO entity_mention
      (entity_id, event_id, session_id, record_ordinal, observed_at, role)
      VALUES ($entityId, $eventId, $sessionId, $ordinal, $observedAt, $role)`, {
      entityId: mention.entityId,
      eventId: mention.eventId,
      sessionId: mention.sessionId,
      ordinal: mention.ordinal ?? 0,
      observedAt: mention.observedAt ?? null,
      role: mention.role ?? "MENTIONED",
    });
  }

  insertTemporalFact(fact) {
    this.run(`INSERT INTO temporal_fact
      (id, subject_id, subject_kind, predicate, object_id, object_kind, fact_text, value_json,
       valid_at, invalid_at, created_at, expired_at, valid_from_ordinal, invalid_at_ordinal,
       validity_status, epistemic_status, derivation_rule, source_event_id,
       invalidated_by_event_id, superseded_by_fact_id, evidence_refs_json)
      VALUES ($id, $subjectId, $subjectKind, $predicate, $objectId, $objectKind, $factText, $valueJson,
       $validAt, $invalidAt, $createdAt, $expiredAt, $validFromOrd, $invalidAtOrd,
       $validityStatus, $epistemic, $rule, $sourceEvent, $invalidatedByEvent, $supersededByFact, $refs)`, {
      id: fact.id,
      subjectId: fact.subjectId,
      subjectKind: fact.subjectKind,
      predicate: fact.predicate,
      objectId: fact.objectId ?? null,
      objectKind: fact.objectKind ?? null,
      factText: fact.factText,
      valueJson: typeof fact.value === "string" ? fact.value : stableStringify(fact.value ?? {}),
      validAt: fact.validAt ?? null,
      invalidAt: fact.invalidAt ?? null,
      createdAt: fact.createdAt ?? fact.validAt ?? null,
      expiredAt: fact.expiredAt ?? null,
      validFromOrd: fact.validFromOrdinal ?? 0,
      invalidAtOrd: fact.invalidAtOrdinal ?? null,
      validityStatus: fact.validityStatus ?? "VIGENTE",
      epistemic: fact.epistemic ?? "DIRECT_EVIDENCE",
      rule: fact.rule ?? null,
      sourceEvent: fact.sourceEventId,
      invalidatedByEvent: fact.invalidatedByEventId ?? null,
      supersededByFact: fact.supersededByFactId ?? null,
      refs: typeof fact.refs === "string" ? fact.refs : stableStringify(fact.refs ?? []),
    });
    this.run(`INSERT INTO fact_fts(fact_id, predicate, fact_text, validity_status)
      VALUES ($id, $predicate, $factText, $validityStatus)`, {
      id: fact.id,
      predicate: fact.predicate,
      factText: fact.factText,
      validityStatus: fact.validityStatus ?? "VIGENTE",
    });
  }

  invalidateTemporalFact(factId, { invalidAt = null, expiredAt = null, invalidAtOrdinal = null, validityStatus = "SUPERSEDED", invalidatedByEventId = null, supersededByFactId = null }) {
    this.run(`UPDATE temporal_fact SET
      invalid_at = COALESCE(invalid_at, $invalidAt),
      expired_at = COALESCE(expired_at, $expiredAt),
      invalid_at_ordinal = COALESCE(invalid_at_ordinal, $invalidAtOrd),
      validity_status = CASE WHEN validity_status = 'VIGENTE' THEN $validityStatus ELSE validity_status END,
      invalidated_by_event_id = COALESCE(invalidated_by_event_id, $invalidatedByEvent),
      superseded_by_fact_id = COALESCE(superseded_by_fact_id, $supersededByFact)
      WHERE id = $id AND validity_status = 'VIGENTE'`, {
      id: factId,
      invalidAt,
      expiredAt: expiredAt ?? invalidAt,
      invalidAtOrd: invalidAtOrdinal,
      validityStatus,
      invalidatedByEvent: invalidatedByEventId,
      supersededByFact: supersededByFactId,
    });
  }

  upsertActor(actor) {
    const signature = stableStringify(actor);
    if (this.actorValueCache.get(actor.id) === signature) return;
    this.actorValueCache.set(actor.id, signature);
    this.run(`INSERT INTO actor
      (id,kind,native_id,role,display_name,aliases_json,epistemic_status)
      VALUES ($id,$kind,$nativeId,$role,$display,$aliases,$epistemic)
      ON CONFLICT(id) DO UPDATE SET role=COALESCE(excluded.role,actor.role),
      display_name=COALESCE(excluded.display_name,actor.display_name)`, {
      id: actor.id, kind: actor.kind, nativeId: actor.nativeId ?? null,
      role: actor.role ?? null, display: actor.displayName ?? null,
      aliases: stableStringify(actor.aliases ?? []), epistemic: actor.epistemic,
    });
  }

  insertEvent(event) {
    this.run(`INSERT INTO event
      (id,session_id,source_id,record_ordinal,subordinal,observed_at,time_precision,
       actor_id,kind,subtype,phase,status,native_id,call_id,turn_id,parent_event_id,
       canonical,duplicate_of,input_preview,output_preview,input_blob_sha256,
       output_blob_sha256,metadata_json,epistemic_status)
      VALUES ($id,$sessionId,$sourceId,$ordinal,$subordinal,$observedAt,$precision,
       $actorId,$kind,$subtype,$phase,$status,$nativeId,$callId,$turnId,$parentEventId,
       $canonical,$duplicateOf,$inputPreview,$outputPreview,$inputBlob,$outputBlob,$metadata,$epistemic)`, {
      id: event.id, sessionId: event.sessionId, sourceId: event.sourceId,
      ordinal: event.recordOrdinal, subordinal: event.subordinal ?? 0,
      observedAt: event.observedAt ?? null, precision: event.timePrecision,
      actorId: event.actorId ?? null, kind: event.kind, subtype: event.subtype ?? null,
      phase: event.phase ?? null, status: event.status ?? null,
      nativeId: event.nativeId ?? null, callId: event.callId ?? null,
      turnId: event.turnId ?? null, parentEventId: event.parentEventId ?? null,
      canonical: event.canonical === false ? 0 : 1, duplicateOf: event.duplicateOf ?? null,
      inputPreview: event.inputPreview ?? null, outputPreview: event.outputPreview ?? null,
      inputBlob: event.inputBlobSha256 ?? null, outputBlob: event.outputBlobSha256 ?? null,
      metadata: stableStringify(event.metadata ?? {}), epistemic: event.epistemic,
    });
    this.run(`INSERT INTO event_fts(event_id,kind,input_preview,output_preview)
      VALUES ($id,$kind,$input,$output)`, {
      id: event.id, kind: event.kind, input: event.inputPreview ?? "", output: event.outputPreview ?? "",
    });
  }

  insertEvidenceRef(ref) {
    this.run(`INSERT INTO evidence_ref
      (id,event_id,source_id,record_ordinal,json_pointer,byte_offset,byte_length,
       record_sha256,uri,availability)
      VALUES ($id,$event,$source,$ordinal,$pointer,$offset,$length,$hash,$uri,$availability)`, {
      id: ref.id, event: ref.eventId ?? null, source: ref.sourceId,
      ordinal: ref.recordOrdinal, pointer: ref.jsonPointer ?? "", offset: ref.byteOffset ?? null,
      length: ref.byteLength ?? null, hash: ref.recordSha256, uri: ref.uri,
      availability: ref.availability ?? "AVAILABLE",
    });
  }

  insertWarning(warning) {
    this.run(`INSERT INTO parse_warning
      (id,source_id,record_ordinal,code,message,evidence_ref_id)
      VALUES ($id,$source,$ordinal,$code,$message,$ref)`, {
      id: warning.id, source: warning.sourceId ?? null, ordinal: warning.recordOrdinal ?? null,
      code: warning.code, message: warning.message, ref: warning.evidenceRefId ?? null,
    });
  }

  insertSecretFinding(finding) {
    this.run(`INSERT OR IGNORE INTO secret_finding
      (id,source_id,event_id,kind,fingerprint,projection)
      VALUES ($id,$source,$event,$kind,$fingerprint,$projection)`, finding);
  }

  insertContentBlob(blob) {
    this.run(`INSERT OR IGNORE INTO content_blob
      (sha256,byte_length,extension,storage,inline_data,evidence_path)
      VALUES ($sha,$bytes,$extension,$storage,$data,$path)`, {
      sha: blob.sha256, bytes: blob.byteLength, extension: blob.extension,
      storage: blob.storage, data: blob.inlineData ?? null, path: blob.path ?? null,
    });
  }

  upsertTool(tool) {
    this.run(`INSERT INTO tool_execution
      (id,session_id,actor_id,tool_name,command_text,working_directory,call_event_id,
       result_event_id,started_at,ended_at,status,exit_code,duration_ms,input_blob_sha256,
       output_blob_sha256,semantic_extract,invocation_fingerprint)
      VALUES ($id,$sessionId,$actorId,$toolName,$command,$cwd,$callEvent,$resultEvent,
       $started,$ended,$status,$exitCode,$duration,$inputBlob,$outputBlob,$semantic,$fingerprint)
      ON CONFLICT(id) DO UPDATE SET
       result_event_id=COALESCE(excluded.result_event_id,tool_execution.result_event_id),
       ended_at=COALESCE(excluded.ended_at,tool_execution.ended_at), status=excluded.status,
       exit_code=COALESCE(excluded.exit_code,tool_execution.exit_code),
       duration_ms=COALESCE(excluded.duration_ms,tool_execution.duration_ms),
       output_blob_sha256=COALESCE(excluded.output_blob_sha256,tool_execution.output_blob_sha256),
       semantic_extract=COALESCE(excluded.semantic_extract,tool_execution.semantic_extract)`, tool);
  }

  upsertArtifact(artifact) {
    this.run(`INSERT INTO artifact
      (id,logical_path,kind,workspace_root,current_path,current_status,current_sha256,first_seen_at,last_seen_at)
      VALUES ($id,$logicalPath,$kind,$workspaceRoot,$currentPath,$currentStatus,$currentSha,$firstSeen,$lastSeen)
      ON CONFLICT(id) DO UPDATE SET current_path=COALESCE(excluded.current_path,artifact.current_path),
       current_status=excluded.current_status,current_sha256=COALESCE(excluded.current_sha256,artifact.current_sha256),
       last_seen_at=COALESCE(excluded.last_seen_at,artifact.last_seen_at)`, artifact);
  }

  insertArtifactRevision(revision) {
    this.run(`INSERT OR IGNORE INTO artifact_revision
      (id,artifact_id,producer_event_id,predecessor_revision_id,operation,content_sha256,
       diff_blob_sha256,observed_at,status,evidence_ref_id)
      VALUES ($id,$artifactId,$producerEventId,$predecessor,$operation,$contentSha,$diffSha,
       $observedAt,$status,$evidenceRefId)`, revision);
  }

  insertClaim(claim) {
    this.run(`INSERT OR REPLACE INTO claim
      (id,subject,predicate,object_json,epistemic_status,derivation_rule,
       contradiction_set,source_event_id,evidence_refs_json,current)
      VALUES ($id,$subject,$predicate,$object,$epistemic,$rule,$contradiction,$event,$refs,$current)`, claim);
  }

  insertDecision(decision) {
    this.run(`INSERT OR REPLACE INTO decision_record
      (id,problem,alternatives_json,decision_text,rationale,consequences_json,status,
       source_event_id,epistemic_status,decision_kind,valid_at,invalid_at,
       valid_from_ordinal,invalid_at_ordinal,validity_status,known_facts_json,
       inferred_reasons_json,trigger_event_ids_json,superseded_by_id,evidence_refs_json)
      VALUES ($id,$problem,$alternatives,$decision,$rationale,$consequences,$status,
       $event,$epistemic,$kind,$validAt,$invalidAt,$validFromOrd,$invalidAtOrd,
       $validityStatus,$knownFacts,$inferredReasons,$triggerEvents,$supersededBy,$refs)`, {
      id: decision.id,
      problem: decision.problem ?? null,
      alternatives: typeof decision.alternatives === "string" ? decision.alternatives : stableStringify(decision.alternatives ?? []),
      decision: decision.decision,
      rationale: decision.rationale ?? null,
      consequences: typeof decision.consequences === "string" ? decision.consequences : stableStringify(decision.consequences ?? []),
      status: decision.status ?? "ACTIVE_UNVERIFIED",
      event: decision.event,
      epistemic: decision.epistemic ?? "DIRECT_EVIDENCE",
      kind: decision.decisionKind ?? "EXPLICIT_MARKER",
      validAt: decision.validAt ?? null,
      invalidAt: decision.invalidAt ?? null,
      validFromOrd: decision.validFromOrdinal ?? null,
      invalidAtOrd: decision.invalidAtOrdinal ?? null,
      validityStatus: decision.validityStatus ?? "VIGENTE",
      knownFacts: typeof decision.knownFacts === "string" ? decision.knownFacts : stableStringify(decision.knownFacts ?? []),
      inferredReasons: typeof decision.inferredReasons === "string" ? decision.inferredReasons : stableStringify(decision.inferredReasons ?? []),
      triggerEvents: typeof decision.triggerEvents === "string" ? decision.triggerEvents : stableStringify(decision.triggerEvents ?? []),
      supersededBy: decision.supersededById ?? null,
      refs: typeof decision.refs === "string" ? decision.refs : stableStringify(decision.refs ?? []),
    });
  }

  insertTemporalSealLog(entry) {
    this.run(`INSERT INTO temporal_seal_log
      (fact_id, pre_temporal_identity, pre_graph_identity, post_temporal_identity, post_graph_identity, post_metrics_json, created_at)
      VALUES ($factId, $preTemporal, $preGraph, $postTemporal, $postGraph, $postMetrics, $createdAt)`, {
      factId: entry.factId,
      preTemporal: entry.preTemporalIdentity,
      preGraph: entry.preGraphIdentity,
      postTemporal: entry.postTemporalIdentity,
      postGraph: entry.postGraphIdentity,
      postMetrics: typeof entry.postMetrics === "string" ? entry.postMetrics : stableStringify(entry.postMetrics ?? {}),
      createdAt: entry.createdAt ?? new Date().toISOString(),
    });
  }

  insertContinuationOption(option) {
    this.run(`INSERT OR REPLACE INTO continuation_option
      (id,rank,strategy,title,description,rationale,preconditions_json,
       active_constraints_json,avoided_dead_ends_json,supporting_event_ids_json,
       evidence_refs_json,epistemic_status,recommended)
      VALUES ($id,$rank,$strategy,$title,$description,$rationale,$preconditions,
       $constraints,$deadEnds,$events,$refs,$epistemic,$recommended)`, {
      id: option.id,
      rank: option.rank,
      strategy: option.strategy,
      title: option.title,
      description: option.description,
      rationale: option.rationale,
      preconditions: typeof option.preconditions === "string" ? option.preconditions : stableStringify(option.preconditions ?? []),
      constraints: typeof option.activeConstraints === "string" ? option.activeConstraints : stableStringify(option.activeConstraints ?? []),
      deadEnds: typeof option.avoidedDeadEnds === "string" ? option.avoidedDeadEnds : stableStringify(option.avoidedDeadEnds ?? []),
      events: typeof option.supportingEventIds === "string" ? option.supportingEventIds : stableStringify(option.supportingEventIds ?? []),
      refs: typeof option.evidenceRefs === "string" ? option.evidenceRefs : stableStringify(option.evidenceRefs ?? []),
      epistemic: option.epistemic ?? "INFERRED",
      recommended: option.recommended === false ? 0 : 1,
    });
  }

  insertTask(task) {
    this.run(`INSERT OR REPLACE INTO task
      (id,text,state,priority,requested_event_id,last_event_id,verification_id,epistemic_status)
      VALUES ($id,$text,$state,$priority,$requestedEvent,$lastEvent,$verification,$epistemic)`, task);
  }

  insertValidation(validation) {
    this.run(`INSERT OR REPLACE INTO validation
      (id,target,level,method,command_text,observed_result,observed_at,freshness_sha256,status,evidence_event_id)
      VALUES ($id,$target,$level,$method,$command,$result,$observedAt,$freshness,$status,$event)`, validation);
  }

  insertSnapshot(snapshot) {
    this.run(`INSERT OR REPLACE INTO state_snapshot
      (id,workspace_root,observed_at,git_head,git_branch,git_status,metadata_json,sha256)
      VALUES ($id,$root,$observedAt,$head,$branch,$status,$metadata,$sha)`, snapshot);
  }

  insertHydrationPack(pack) {
    this.run(`INSERT OR REPLACE INTO hydration_pack
      (id,case_hash,token_budget,token_estimate,content_sha256,created_at,generator_version,included_event_ids_json)
      VALUES ($id,$caseHash,$budget,$estimate,$contentSha,$createdAt,$version,$events)`, pack);
  }
}

export function openCase(caseDir, options = {}) {
  return new CaseDatabase(path.join(caseDir, "case.sqlite"), options);
}

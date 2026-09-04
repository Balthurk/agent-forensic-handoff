import { EPISTEMIC } from "./constants.js";
import { shortHash, stableStringify } from "./util.js";

function refsForEvent(db, eventId) {
  return db.all("SELECT uri FROM evidence_ref WHERE event_id=$id ORDER BY id", { id: eventId }).map((row) => row.uri);
}

export function reduceCase(db) {
  const messages = db.all(`SELECT * FROM event WHERE canonical=1 AND kind IN ('message.user','message.agent')
    ORDER BY COALESCE(observed_at,''), source_id, record_ordinal, subordinal`);
  const subagentSessions = new Map(db.all("SELECT id,metadata_json FROM session").map((session) => {
    const metadata = JSON.parse(session.metadata_json || "{}");
    return [session.id, Boolean(metadata.agentPath || metadata.stateMetadata?.agentPath)];
  }));
  const userRequests = messages
    .filter((event) => event.kind === "message.user" && !subagentSessions.get(event.session_id))
    .map((event) => ({ event, text: substantiveUserText(event.input_preview) }))
    .filter((item) => item.text);
  const originalMission = userRequests[0] ?? null;
  const currentMission = userRequests.at(-1) ?? null;

  if (originalMission) {
    const refs = refsForEvent(db, originalMission.event.id);
    db.insertClaim({
      id: `clm-${shortHash(["mission-original", originalMission.event.id])}`,
      subject: "mission",
      predicate: "original_request",
      object: stableStringify({ text: originalMission.text }),
      epistemic: EPISTEMIC.DIRECT,
      rule: "first-substantive-user-message-after-harness-envelope-filter",
      contradiction: null,
      event: originalMission.event.id,
      refs: stableStringify(refs),
      current: 1,
    });
  }
  if (currentMission) {
    db.insertClaim({
      id: `clm-${shortHash(["mission-current", currentMission.event.id])}`,
      subject: "mission", predicate: "current_request",
      object: stableStringify({ text: currentMission.text }), epistemic: EPISTEMIC.DIRECT,
      rule: "latest-substantive-user-message-after-harness-envelope-filter",
      contradiction: null, event: currentMission.event.id,
      refs: stableStringify(refsForEvent(db, currentMission.event.id)), current: 1,
    });
  }

  let priority = 1000;
  for (const { event: message, text } of userRequests) {
    db.insertTask({
      id: `tsk-${shortHash([message.id, text])}`,
      text,
      state: "REQUESTED",
      priority: priority--,
      requestedEvent: message.id,
      lastEvent: message.id,
      verification: null,
      epistemic: EPISTEMIC.DIRECT,
    });
  }

  const decisionPattern = /^(?:decision|decisi[oó]n|chosen approach|enfoque elegido|resoluci[oó]n adoptada)\s*:\s*(.+)$/gim;
  for (const message of messages) {
    const text = message.input_preview ?? "";
    let match;
    while ((match = decisionPattern.exec(text))) {
      const decisionText = match[1].trim();
      db.insertDecision({
        id: `dec-${shortHash([message.id, match.index, decisionText])}`,
        problem: null,
        alternatives: "[]",
        decision: decisionText,
        rationale: null,
        consequences: "[]",
        status: "ACTIVE_UNVERIFIED",
        event: message.id,
        epistemic: EPISTEMIC.DIRECT,
      });
    }
  }

  const completionPattern = /(?:^|\n)\s*(?:done|completed|finished|terminado|completado|finalizado)\b[:\s-]*(.{0,400})/gim;
  for (const message of messages.filter((event) => event.kind === "message.agent")) {
    const text = message.input_preview ?? "";
    let match;
    while ((match = completionPattern.exec(text))) {
      const report = (match[1] || "completion reported").trim();
      db.insertClaim({
        id: `clm-${shortHash(["reported-completion", message.id, match.index])}`,
        subject: "prior_agent",
        predicate: "reported_completion",
        object: stableStringify({ text: report }),
        epistemic: EPISTEMIC.DIRECT,
        rule: "explicit-completion-language; claim is about the report, not verified completion",
        contradiction: null,
        event: message.id,
        refs: stableStringify(refsForEvent(db, message.id)),
        current: 1,
      });
    }
  }

  advanceRequestedTasks(db);
  pairToolEdges(db);
  deriveHistoricalValidations(db);
  detectReportedStateContradictions(db);
  deriveEntityEdges(db);
}

function substantiveUserText(input) {
  let text = String(input ?? "").trim();
  if (!text) return null;
  const realtime = /<realtime_delegation>[\s\S]*?<input>([\s\S]*?)<\/input>[\s\S]*?<\/realtime_delegation>/i.exec(text);
  if (realtime) text = realtime[1].trim();
  const explicitRequest = /(?:^|\n)## My request:\s*([\s\S]*)$/i.exec(text);
  if (explicitRequest) text = explicitRequest[1].trim();
  if (!text) return null;
  if (/^(?:<recommended_plugins>|<environment_context>|<permissions instructions>|<skills_instructions>|<apps_instructions>|<plugins_instructions>|<collaboration_mode>|# Response annotations:)/i.test(text)) return null;
  if (/^<[^>]+>\s*(?:<[^>]+>[\s\S]*<\/[^>]+>\s*)+<\/[^>]+>$/i.test(text) && !/[.!?]\s*$/.test(text)) return null;
  return text;
}

function deriveHistoricalValidations(db) {
  const observed = db.all("SELECT * FROM event WHERE canonical=1 AND kind='tool.observed' ORDER BY COALESCE(observed_at,''),source_id,record_ordinal");
  const observedKeys = new Set(observed.map((event) => {
    const metadata = JSON.parse(event.metadata_json || "{}");
    return historicalCommandKey(event.session_id, metadata.command || event.input_preview);
  }));
  const tools = db.all("SELECT * FROM tool_execution WHERE command_text IS NOT NULL ORDER BY COALESCE(started_at,''),id");
  for (const tool of tools) {
    if (!looksLikeValidation(tool.command_text)) continue;
    if (observedKeys.has(historicalCommandKey(tool.session_id, tool.command_text))) continue;
    const eventId = tool.result_event_id || tool.call_event_id;
    const event = eventId ? db.get("SELECT observed_at FROM event WHERE id=$id", { id: eventId }) : null;
    db.insertValidation({
      id: `val-${shortHash(["historical-tool", eventId || tool.id])}`,
      target: validationTarget(tool.command_text), level: "HISTORICAL",
      method: "recorded tool execution; not rerun by AFH", command: tool.command_text,
      result: tool.semantic_extract || `recorded status=${tool.status}; exit_code=${tool.exit_code ?? "UNAVAILABLE"}`,
      observedAt: event?.observed_at || tool.ended_at || tool.started_at || "ORDER_ONLY",
      freshness: null, status: validationStatus(tool.status, tool.exit_code), event: eventId,
    });
  }
  for (const event of observed) {
    const metadata = JSON.parse(event.metadata_json || "{}");
    const command = metadata.command || event.input_preview;
    if (!looksLikeValidation(command)) continue;
    db.insertValidation({
      id: `val-${shortHash(["historical-observation", event.id])}`,
      target: validationTarget(command), level: "HISTORICAL",
      method: "direct item_completed observation; not rerun by AFH", command,
      result: event.output_preview || `recorded status=${event.status}; exit_code=${metadata.exitCode ?? "UNAVAILABLE"}`,
      observedAt: event.observed_at || "ORDER_ONLY", freshness: null,
      status: validationStatus(event.status, metadata.exitCode), event: event.id,
    });
  }
}

function historicalCommandKey(sessionId, command) {
  return `${sessionId}\0${String(command || "").replace(/\s+/g, " ").trim().toLowerCase()}`;
}

function looksLikeValidation(command) {
  const segments = String(command || "").split(/(?:\r?\n|;|&&|\|\|)/).map((part) => part.trim()).filter(Boolean);
  return segments.some((segment) => /^(?:&\s*)?(?:(?:python|python3|py)\s+(?:-B\s+)?(?:-m\s+(?:pytest|unittest|py_compile)\b|[^\s]*validate[^\s]*\.py\b)|pytest\b|py\.test\b|node\s+(?:--test\b|[^\s]*validate[^\s]*\.m?js\b)|npm\s+(?:test\b|run\s+(?:test|check|lint|build)\b)|pnpm\s+(?:test\b|run\s+(?:test|check|lint|build)\b)|yarn\s+(?:test\b|run\s+(?:test|check|lint|build)\b)|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|mvnw?\s+test\b|gradlew?\s+test\b|ruff\s+(?:check|format)\b|eslint\b|tsc\s+--noEmit\b|git\s+diff\s+--check\b|afh\s+(?:doctor|benchmark|verify-case)\b)/i.test(segment));
}

function validationTarget(command) {
  const compact = String(command).replace(/\s+/g, " ").trim();
  return `historical command: ${compact.slice(0, 180)}`;
}

function validationStatus(status, exitCode) {
  if (Number.isInteger(exitCode)) return exitCode === 0 ? "OBSERVED_PASS" : "OBSERVED_FAIL";
  if (String(status).toUpperCase() === "FAILED") return "OBSERVED_FAIL";
  if (String(status).toUpperCase() === "INCOMPLETE") return "INCOMPLETE";
  return "OBSERVED_PASS";
}

function advanceRequestedTasks(db) {
  const events = db.all(`SELECT * FROM event WHERE canonical=1
    ORDER BY COALESCE(observed_at,''),source_id,record_ordinal,subordinal`);
  const index = new Map(events.map((event, i) => [event.id, i]));
  const tasks = db.all("SELECT * FROM task WHERE state='REQUESTED' ORDER BY priority DESC,id");
  for (const task of tasks) {
    const start = index.get(task.requested_event_id);
    if (start == null) continue;
    const request = events[start];
    let end = events.length;
    for (let i = start + 1; i < events.length; i += 1) {
      if (events[i].session_id === request.session_id && events[i].kind === "message.user") { end = i; break; }
    }
    const activity = events.slice(start + 1, end).filter((event) =>
      event.session_id === request.session_id && ["tool.requested", "filesystem.patch", "mcp.completed"].includes(event.kind));
    if (!activity.length) continue;
    const latest = activity.at(-1);
    db.run("UPDATE task SET state='ATTEMPTED',last_event_id=$event,epistemic_status=$epistemic WHERE id=$id", {
      id: task.id, event: latest.id, epistemic: EPISTEMIC.INFERRED,
    });
  }
}

function detectReportedStateContradictions(db) {
  const ordered = db.all(`SELECT id,session_id FROM event WHERE canonical=1
    ORDER BY COALESCE(observed_at,''),source_id,record_ordinal,subordinal`);
  const order = new Map(ordered.map((event, i) => [event.id, i]));
  const reports = db.all("SELECT * FROM claim WHERE predicate='reported_completion' ORDER BY id");
  const failed = db.all("SELECT * FROM tool_execution WHERE status IN ('FAILED','INCOMPLETE') ORDER BY id");
  const completed = db.all("SELECT * FROM tool_execution WHERE status='COMPLETED' ORDER BY id");

  for (const report of reports) {
    const reportEvent = db.get("SELECT * FROM event WHERE id=$id", { id: report.source_event_id });
    if (!reportEvent) continue;
    const reportText = JSON.parse(report.object_json || "{}").text || "";
    for (const tool of failed) {
      const failureEventId = tool.result_event_id || tool.call_event_id;
      const failureEvent = failureEventId ? db.get("SELECT * FROM event WHERE id=$id", { id: failureEventId }) : null;
      if (!failureEvent || failureEvent.session_id !== reportEvent.session_id) continue;
      if ((order.get(failureEvent.id) ?? Infinity) >= (order.get(reportEvent.id) ?? -1)) continue;
      if (!lexicallyRelated(reportText, `${tool.tool_name} ${tool.command_text || ""}`)) continue;
      const superseded = completed.some((success) => {
        if (success.invocation_fingerprint !== tool.invocation_fingerprint) return false;
        const successId = success.result_event_id || success.call_event_id;
        const successEvent = successId ? db.get("SELECT id,session_id FROM event WHERE id=$id", { id: successId }) : null;
        const successOrder = successEvent ? order.get(successEvent.id) : null;
        return successEvent?.session_id === reportEvent.session_id && successOrder > order.get(failureEvent.id) && successOrder < order.get(reportEvent.id);
      });
      if (superseded) continue;
      const refs = [...new Set([...refsForEvent(db, reportEvent.id), ...refsForEvent(db, failureEvent.id)])];
      db.insertClaim({
        id: `clm-${shortHash(["completion-contradiction", report.id, tool.id])}`,
        subject: "completion_state",
        predicate: "reported_vs_observed",
        object: stableStringify({ reportedText: reportText, conflictingTool: tool.tool_name, conflictingStatus: tool.status }),
        epistemic: EPISTEMIC.CONTRADICTED,
        rule: "lexically-related completion report after failed/incomplete tool with no later matching success",
        contradiction: stableStringify([reportEvent.id, failureEvent.id]),
        event: reportEvent.id,
        refs: stableStringify(refs),
        current: 1,
      });
    }
  }
}

function lexicallyRelated(left, right) {
  const stems = (value) => new Set(String(value).toLowerCase().match(/[a-z0-9_-]{4,}/g)?.map((token) =>
    token.replace(/(?:ments?|ations?|ions?|ing|ed|es|s)$/i, "")).filter((token) => token.length >= 4) ?? []);
  const a = stems(left);
  const b = stems(right);
  for (const token of a) if (b.has(token)) return true;
  return false;
}

function pairToolEdges(db) {
  const tools = db.all("SELECT * FROM tool_execution WHERE call_event_id IS NOT NULL AND result_event_id IS NOT NULL ORDER BY id");
  for (const tool of tools) {
    db.insertEventEdge({
      from: tool.call_event_id, to: tool.result_event_id, type: "RESULT_OF",
      grade: "EXPLICIT", rule: "shared-call-id", epistemic: EPISTEMIC.DIRECT,
      evidenceEventId: tool.result_event_id, metadata: { toolExecutionId: tool.id },
    });
  }
}

function deriveEntityEdges(db) {
  const revisions = db.all("SELECT * FROM artifact_revision ORDER BY artifact_id,observed_at,id");
  const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]));
  for (const revision of revisions) {
    db.insertEntityEdge({
      from: revision.producer_event_id,
      to: revision.artifact_id,
      fromKind: "EVENT",
      toKind: "ARTIFACT",
      type: String(revision.operation).toUpperCase() === "CREATE" ? "PRODUCED" : "MODIFIED",
      grade: "EXPLICIT",
      rule: "artifact-revision-producer",
      epistemic: EPISTEMIC.DIRECT,
      evidenceEventId: revision.producer_event_id,
      metadata: { artifactRevisionId: revision.id, operation: revision.operation, status: revision.status },
    });
    const predecessor = revision.predecessor_revision_id ? revisionsById.get(revision.predecessor_revision_id) : null;
    if (predecessor?.producer_event_id && predecessor.producer_event_id !== revision.producer_event_id) {
      db.insertEntityEdge({
        from: predecessor.producer_event_id,
        to: revision.producer_event_id,
        fromKind: "EVENT",
        toKind: "EVENT",
        type: "SUPERSEDES",
        grade: "DETERMINISTIC_RULE",
        rule: "artifact-revision-chain",
        epistemic: EPISTEMIC.INFERRED,
        evidenceEventId: revision.producer_event_id,
        metadata: { artifactId: revision.artifact_id, predecessorRevisionId: predecessor.id, revisionId: revision.id },
      });
    }
  }

  for (const validation of db.all("SELECT * FROM validation WHERE evidence_event_id IS NOT NULL ORDER BY id")) {
    db.insertEntityEdge({
      from: validation.evidence_event_id,
      to: validation.id,
      fromKind: "EVENT",
      toKind: "VALIDATION",
      type: "VALIDATED",
      grade: "EXPLICIT",
      rule: "recorded-validation-observation",
      epistemic: EPISTEMIC.DIRECT,
      evidenceEventId: validation.evidence_event_id,
      metadata: { level: validation.level, status: validation.status, target: validation.target },
    });
  }

  for (const claim of db.all("SELECT * FROM claim WHERE epistemic_status='CONTRADICTED' AND contradiction_set IS NOT NULL ORDER BY id")) {
    let events = [];
    try { events = JSON.parse(claim.contradiction_set); } catch {}
    if (!Array.isArray(events) || events.length < 2) continue;
    const [reported, conflicting] = events;
    if (!db.get("SELECT id FROM event WHERE id=$id", { id: reported }) || !db.get("SELECT id FROM event WHERE id=$id", { id: conflicting })) continue;
    db.insertEntityEdge({
      from: conflicting,
      to: reported,
      fromKind: "EVENT",
      toKind: "EVENT",
      type: "CONTRADICTS",
      grade: "DETERMINISTIC_RULE",
      rule: claim.derivation_rule || "reported-vs-observed",
      epistemic: EPISTEMIC.CONTRADICTED,
      evidenceEventId: claim.source_event_id,
      metadata: { claimId: claim.id },
    });
  }
}

export function computeCaseMetrics(db) {
  const one = (sql) => Number(db.get(sql)?.n ?? 0);
  const first = db.get("SELECT MIN(observed_at) AS value FROM event WHERE observed_at IS NOT NULL")?.value ?? null;
  const last = db.get("SELECT MAX(observed_at) AS value FROM event WHERE observed_at IS NOT NULL")?.value ?? null;
  return {
    sessions: one("SELECT COUNT(*) n FROM session"),
    sources: one("SELECT COUNT(*) n FROM source"),
    sourceRecords: one("SELECT COUNT(*) n FROM source_record"),
    parsedRecords: one("SELECT COUNT(*) n FROM source_record WHERE parse_status='PARSED'"),
    unparsedRecords: one("SELECT COUNT(*) n FROM source_record WHERE parse_status!='PARSED'"),
    events: one("SELECT COUNT(*) n FROM event"),
    canonicalEvents: one("SELECT COUNT(*) n FROM event WHERE canonical=1"),
    duplicateEvents: one("SELECT COUNT(*) n FROM event WHERE canonical=0"),
    tools: one("SELECT COUNT(*) n FROM tool_execution"),
    failedTools: one("SELECT COUNT(*) n FROM tool_execution WHERE status='FAILED'"),
    incompleteTools: one("SELECT COUNT(*) n FROM tool_execution WHERE result_event_id IS NULL"),
    artifacts: one("SELECT COUNT(*) n FROM artifact"),
    missingArtifacts: one("SELECT COUNT(*) n FROM artifact WHERE current_status='MISSING'"),
    actors: one("SELECT COUNT(*) n FROM actor"),
    externalInterventions: one("SELECT COUNT(*) n FROM event WHERE canonical=1 AND (kind LIKE 'external.%' OR kind LIKE 'mcp.%')"),
    decisions: one("SELECT COUNT(*) n FROM decision_record"),
    tasks: one("SELECT COUNT(*) n FROM task"),
    validations: one("SELECT COUNT(*) n FROM validation"),
    contradictions: one("SELECT COUNT(*) n FROM claim WHERE epistemic_status='CONTRADICTED'"),
    secretFindings: one("SELECT COUNT(*) n FROM secret_finding"),
    warnings: one("SELECT COUNT(*) n FROM parse_warning"),
    graphEdges: one("SELECT (SELECT COUNT(*) FROM event_edge)+(SELECT COUNT(*) FROM session_edge)+(SELECT COUNT(*) FROM entity_edge) n"),
    firstObservedAt: first,
    lastObservedAt: last,
    durationMs: first && last ? Math.max(0, new Date(last) - new Date(first)) : null,
  };
}

export function loopGroups(db) {
  return db.all(`SELECT invocation_fingerprint, tool_name, COUNT(*) AS attempts,
    SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failures,
    MIN(started_at) AS first_at, MAX(COALESCE(ended_at,started_at)) AS last_at,
    MAX(status) AS terminal_status
    FROM tool_execution GROUP BY invocation_fingerprint,tool_name HAVING COUNT(*) >= 3
    ORDER BY attempts DESC, tool_name`);
}

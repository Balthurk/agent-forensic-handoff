import fs from "node:fs";
import path from "node:path";
import { CaseDatabase } from "./database.js";
import { EPISTEMIC } from "./constants.js";
import { atomicWrite, safeJson, shortHash, stableStringify } from "./util.js";
import { computeCaseMetrics, substantiveUserText } from "./reducers.js";
import { readEvidence } from "./render.js";
import {
  computeFactAssertionHash,
  computeFactInvalidationHash,
  computeGraphIdentity,
  computeTemporalIdentity,
} from "./graph.js";

const CONSTRAINT_PATTERNS = [
  /\b(?:must\s+not|do\s+not|don't|never|avoid|without|cannot|can't|prohibited|forbidden|no\s+external|keep\s+[^\n.;]+\s+intact|preserve\s+[^\n.;]+|solo\s+[^\n.;]+|no\s+usar|sin\s+[^\n.;]+)\b[^\n.;]*/gi,
  /\b(?:must|required\s+to|ensure\s+that|need\s+to\s+keep|strictly|hard\s+constraint|invariant)\b[^\n.;]*/gi,
];

const DESIGN_PATTERNS = [
  /\b(?:design|architecture|schema|approach|strategy|pattern|pipeline|invariant|contract|data\s+model|diseño|arquitectura|estructura)\s*(?:is|uses|will\s+be|:|-)\s*([^\n.]{12,240})/gi,
];

const SYMBOL_REGEX = /\b(?:function|class|const|let|def|interface|type)\s+([A-Za-z_][A-Za-z0-9_]{2,64})\b|`([A-Za-z_][A-Za-z0-9_.$]{2,64}(?:\(\))?)`/g;

export const SHARED_ENTITY_KINDS = new Set(["ARTIFACT", "WORKSPACE", "SHARED_ENTITY", "REPOSITORY"]);

function refsForEvent(db, eventId) {
  return db.all("SELECT uri FROM evidence_ref WHERE event_id=$id ORDER BY id", { id: eventId }).map((row) => row.uri);
}

function makeEntityId(kind, canonicalName) {
  return `ent-${shortHash([kind, String(canonicalName || "").trim().toLowerCase()])}`;
}

function makeFactId(subjectId, predicate, objectKey, validFromOrdinal, sourceEventId) {
  return `fct-${shortHash([subjectId, predicate, String(objectKey || ""), validFromOrdinal, sourceEventId])}`;
}

export function buildTemporalKnowledgeGraph(db) {
  const events = db.all(`
    SELECT id, session_id, source_id, record_ordinal, subordinal, observed_at,
           actor_id, kind, subtype, phase, status, native_id, call_id, turn_id,
           input_preview, output_preview, metadata_json, epistemic_status
    FROM event
    WHERE canonical = 1
    ORDER BY session_id, record_ordinal, subordinal, id
  `).map((row) => ({
    ...row,
    metadata: safeJson(row.metadata_json, {}),
    refs: refsForEvent(db, row.id),
  })).filter(event => event.kind !== 'forensic.alternative');

  if (!events.length) return;

  const rolledBackEventIds = new Set();
  const rolledBackByMap = new Map();
  const abortedEventIds = new Set();

  const eventsBySession = new Map();
  for (const ev of events) {
    if (!eventsBySession.has(ev.session_id)) eventsBySession.set(ev.session_id, []);
    eventsBySession.get(ev.session_id).push(ev);
  }

  for (const [, sessionEvents] of eventsBySession) {
    let turnCounter = 0;
    let currentTurnId = null;
    const turns = [];

    for (const ev of sessionEvents) {
      if (ev.kind === "session.meta") continue;

      if (ev.kind === "session.turn_context") {
        turnCounter += 1;
        currentTurnId = ev.turn_id || `turn-${turnCounter}`;
        turns.push({ turnId: currentTurnId, events: [], hasUserMessage: false, rolledBack: false });
      } else if (ev.kind === "message.user" && substantiveUserText(ev.input_preview)) {
        const lastTurn = turns.at(-1);
        if (!lastTurn || lastTurn.hasUserMessage) {
          turnCounter += 1;
          currentTurnId = ev.turn_id || `turn-${turnCounter}`;
          turns.push({ turnId: currentTurnId, events: [], hasUserMessage: true, rolledBack: false });
        } else {
          lastTurn.hasUserMessage = true;
          if (ev.turn_id && !lastTurn.turnId.startsWith("turn_")) {
            currentTurnId = ev.turn_id;
            lastTurn.turnId = currentTurnId;
          }
        }
      } else if (!currentTurnId) {
        turnCounter += 1;
        currentTurnId = ev.turn_id || `turn-${turnCounter}`;
        turns.push({ turnId: currentTurnId, events: [], hasUserMessage: false, rolledBack: false });
      }

      if (currentTurnId && !ev.turn_id) {
        ev.turn_id = currentTurnId;
        db.run("UPDATE event SET turn_id=$turnId WHERE id=$id", { turnId: currentTurnId, id: ev.id });
      }
      if (turns.length > 0) {
        turns.at(-1).events.push(ev);
      }

      if (ev.kind === "session.turn_aborted") {
        const activeTurn = turns.at(-1);
        if (activeTurn) {
          for (const prevEv of activeTurn.events) {
            if (prevEv.id === ev.id || prevEv.record_ordinal >= ev.record_ordinal) continue;
            if (prevEv.kind.startsWith("tool.") || prevEv.kind === "filesystem.patch") {
              abortedEventIds.add(prevEv.id);
              db.insertEventEdge({
                from: prevEv.id,
                to: ev.id,
                type: "ABORTED_BY",
                grade: "EXPLICIT",
                rule: "codex-turn-aborted",
                epistemic: EPISTEMIC.DIRECT,
                evidenceEventId: ev.id,
                metadata: { reason: ev.metadata.reason ?? "interrupted" },
              });
            }
          }
        }
      }

      if (ev.kind === "session.rolled_back") {
        const numTurns = Math.max(1, Number(ev.metadata.numTurns || 1));
        const candidateTurns = turns.filter(
          (t) => !t.rolledBack && t.events.some((e) => e.id !== ev.id && e.record_ordinal < ev.record_ordinal),
        );
        const toRollback = candidateTurns.slice(-numTurns);
        for (const t of toRollback) {
          t.rolledBack = true;
          for (const prevEv of t.events) {
            if (prevEv.id === ev.id || prevEv.record_ordinal >= ev.record_ordinal) continue;
            if (prevEv.kind === "session.turn_context") continue;
            rolledBackEventIds.add(prevEv.id);
            rolledBackByMap.set(prevEv.id, ev);
            db.insertEventEdge({
              from: prevEv.id,
              to: ev.id,
              type: "ROLLED_BACK_BY",
              grade: "EXPLICIT",
              rule: "codex-thread-rolled-back",
              epistemic: EPISTEMIC.DIRECT,
              evidenceEventId: ev.id,
              metadata: { numTurns },
            });
          }
        }
      }
    }
  }

  for (const [, sessionEvents] of eventsBySession) {
    let activeUserEvent = null;
    let activeReasoningEvent = null;
    let pendingObservations = [];
    let lastFailedObservation = null;

    for (const ev of sessionEvents) {
      if (ev.kind === "session.meta" || ev.kind === "session.turn_context") continue;

      if (ev.kind === "message.user") {
        if (substantiveUserText(ev.input_preview)) {
          activeUserEvent = ev;
          activeReasoningEvent = null;
          pendingObservations = [];
        }
        continue;
      }

      if (ev.kind === "reasoning.summary") {
        for (const obs of pendingObservations.slice(-4)) {
          db.insertEventEdge({
            from: obs.id,
            to: ev.id,
            type: "CONSUMED_OBSERVATION",
            grade: "DETERMINISTIC_RULE",
            rule: "causetrace-fan-in-observation-to-reasoning",
            epistemic: EPISTEMIC.INFERRED,
            evidenceEventId: ev.id,
            metadata: { turnId: ev.turn_id },
          });
        }
        pendingObservations = [];
        if (activeUserEvent && activeUserEvent.turn_id === ev.turn_id) {
          db.insertEventEdge({
            from: activeUserEvent.id,
            to: ev.id,
            type: "CAUSED_BY_USER",
            grade: "DETERMINISTIC_RULE",
            rule: "user-prompt-to-reasoning",
            epistemic: EPISTEMIC.INFERRED,
            evidenceEventId: ev.id,
            metadata: { turnId: ev.turn_id },
          });
        }
        activeReasoningEvent = ev;
        continue;
      }

      if (["tool.requested", "filesystem.patch", "plan.updated"].includes(ev.kind)) {
        if (activeReasoningEvent) {
          db.insertEventEdge({
            from: activeReasoningEvent.id,
            to: ev.id,
            type: "MOTIVATED_BY_REASONING",
            grade: "DETERMINISTIC_RULE",
            rule: "causetrace-fan-out-reasoning-to-action",
            epistemic: EPISTEMIC.INFERRED,
            evidenceEventId: ev.id,
            metadata: { turnId: ev.turn_id },
          });
        } else if (activeUserEvent) {
          db.insertEventEdge({
            from: activeUserEvent.id,
            to: ev.id,
            type: "CAUSED_BY_USER",
            grade: "DETERMINISTIC_RULE",
            rule: "causetrace-fan-out-user-to-action",
            epistemic: EPISTEMIC.INFERRED,
            evidenceEventId: ev.id,
            metadata: { turnId: ev.turn_id },
          });
        }

        if (!activeReasoningEvent && pendingObservations.length > 0) {
          for (const obs of pendingObservations.slice(-3)) {
            db.insertEventEdge({
              from: obs.id,
              to: ev.id,
              type: "CONSUMED_OBSERVATION",
              grade: "DETERMINISTIC_RULE",
              rule: "causetrace-fan-in-observation-to-action",
              epistemic: EPISTEMIC.INFERRED,
              evidenceEventId: ev.id,
              metadata: { turnId: ev.turn_id },
            });
          }
          if (ev.kind === "tool.requested") pendingObservations = [];
        }

        if (lastFailedObservation && (ev.kind === "filesystem.patch" || ev.kind === "plan.updated")) {
          db.insertEventEdge({
            from: lastFailedObservation.id,
            to: ev.id,
            type: "TRIGGERED_RECOVERY",
            grade: "DETERMINISTIC_RULE",
            rule: "failure-to-remediation-or-plan",
            epistemic: EPISTEMIC.INFERRED,
            evidenceEventId: ev.id,
            metadata: { failedEventId: lastFailedObservation.id },
          });
          lastFailedObservation = null;
        }
      }

      if (["tool.completed", "tool.observed", "mcp.completed", "mcp.observed"].includes(ev.kind)) {
        pendingObservations.push(ev);
        if (ev.status === "FAILED" || (typeof ev.metadata.exitCode === "number" && ev.metadata.exitCode !== 0)) {
          lastFailedObservation = ev;
        }
      }
    }
  }

  const artifacts = db.all("SELECT * FROM artifact ORDER BY logical_path");
  const artifactRevisions = db.all("SELECT * FROM artifact_revision ORDER BY observed_at, id");
  const tools = db.all("SELECT * FROM tool_execution ORDER BY COALESCE(started_at,''), id");
  const validations = db.all("SELECT * FROM validation ORDER BY observed_at, id");
  const eventById = new Map(events.map((e) => [e.id, e]));

  function registerEntity({
    kind,
    canonicalName,
    summary,
    event,
    role = "MENTIONED",
    validityStatus = "VIGENTE",
    epistemic = EPISTEMIC.DIRECT,
    attributes = {},
  }) {
    const cleanName = String(canonicalName || "").trim();
    if (!cleanName || !event) return null;
    const entityId = makeEntityId(kind, cleanName);
    db.upsertEntityNode({
      id: entityId,
      canonicalName: cleanName.slice(0, 220),
      entityKind: kind,
      summary: String(summary || cleanName).slice(0, 400),
      observedAt: event.observed_at ?? null,
      ordinal: event.record_ordinal ?? 0,
      validityStatus,
      attributes,
      epistemic,
    });
    db.insertEntityMention({
      entityId,
      eventId: event.id,
      sessionId: event.session_id,
      ordinal: event.record_ordinal ?? 0,
      observedAt: event.observed_at ?? null,
      role,
    });
    if (event.kind !== "session.meta" && event.kind !== "session.turn_context") {
      db.insertEntityEdge({
        from: event.id,
        to: entityId,
        fromKind: "EVENT",
        toKind: "ENTITY",
        type: "MENTIONS_ENTITY",
        grade: "DETERMINISTIC_RULE",
        rule: `entity-mention-${role.toLowerCase()}`,
        epistemic,
        evidenceEventId: event.id,
        metadata: { entityKind: kind, role },
      });
    }
    return entityId;
  }

  const artifactById = new Map(artifacts.map((a) => [a.id, a]));
  for (const rev of artifactRevisions) {
    const art = artifactById.get(rev.artifact_id);
    const ev = eventById.get(rev.producer_event_id);
    if (!art || !ev) continue;
    const isRolledBack = rolledBackEventIds.has(ev.id);
    registerEntity({
      kind: "ARTIFACT",
      canonicalName: art.logical_path,
      summary: `Artifact ${art.logical_path} (${rev.operation}, status=${isRolledBack ? "ROLLED_BACK" : art.current_status})`,
      event: ev,
      role: rev.operation || "MODIFIED",
      validityStatus: isRolledBack ? "ROLLED_BACK" : "VIGENTE",
      epistemic: EPISTEMIC.DIRECT,
      attributes: {
        artifactId: art.id,
        logicalPath: art.logical_path,
        operation: rev.operation,
        currentStatus: art.current_status,
      },
    });
  }

  for (const tool of tools) {
    if (!tool.command_text) continue;
    const ev = eventById.get(tool.result_event_id || tool.call_event_id);
    if (!ev) continue;
    const cmd = String(tool.command_text).trim();
    registerEntity({
      kind: "COMMAND",
      canonicalName: cmd.slice(0, 180),
      summary: `Command (${tool.status}): ${cmd.slice(0, 240)}`,
      event: ev,
      role: tool.status === "FAILED" ? "FAILED_COMMAND" : "EXECUTED_COMMAND",
      validityStatus: rolledBackEventIds.has(ev.id) ? "ROLLED_BACK" : "VIGENTE",
      epistemic: EPISTEMIC.DIRECT,
      attributes: {
        toolId: tool.id,
        toolName: tool.tool_name,
        exitCode: tool.exit_code ?? null,
        status: tool.status,
      },
    });
  }

  for (const ev of events) {
    if (ev.kind === "session.meta" || ev.kind === "session.turn_context") continue;
    const rawText = `${ev.input_preview || ""}\n${ev.output_preview || ""}`.trim();
    const userText = ev.kind === "message.user" ? substantiveUserText(ev.input_preview) : null;
    const text = ev.kind === "message.user" ? (userText || "") : rawText;
    const isRolledBack = rolledBackEventIds.has(ev.id);

    if (ev.kind === "message.user" && userText) {
      const cleanText = userText.replace(/\s+/g, " ").slice(0, 240);
      registerEntity({
        kind: "USER_INTENT",
        canonicalName: `intent:${ev.session_id}:${ev.record_ordinal}`,
        summary: cleanText,
        event: ev,
        role: "USER_DIRECTIVE",
        validityStatus: isRolledBack ? "ROLLED_BACK" : "VIGENTE",
        epistemic: EPISTEMIC.DIRECT,
        attributes: { turnId: ev.turn_id, directive: cleanText },
      });

      for (const regex of CONSTRAINT_PATTERNS) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(userText)) !== null) {
          const clause = match[0].trim().replace(/\s+/g, " ").slice(0, 180);
          if (clause.length >= 10) {
            registerEntity({
              kind: "CONSTRAINT",
              canonicalName: clause.toLowerCase(),
              summary: `User constraint: ${clause}`,
              event: ev,
              role: "USER_CONSTRAINT",
              validityStatus: isRolledBack ? "ROLLED_BACK" : "VIGENTE",
              epistemic: EPISTEMIC.DIRECT,
              attributes: { constraint: clause },
            });
          }
        }
      }
    }

    if (ev.kind === "plan.updated" && text) {
      registerEntity({
        kind: "DESIGN_CONCEPT",
        canonicalName: `plan:${ev.session_id}`,
        summary: `Plan update: ${text.replace(/\s+/g, " ").slice(0, 260)}`,
        event: ev,
        role: "PLAN_UPDATE",
        validityStatus: isRolledBack ? "ROLLED_BACK" : "VIGENTE",
        epistemic: EPISTEMIC.DIRECT,
        attributes: { planText: text.slice(0, 500) },
      });
    }

    if (["message.user", "message.agent", "reasoning.summary", "plan.updated"].includes(ev.kind) && text) {
      for (const regex of DESIGN_PATTERNS) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
          const concept = match[0].trim().replace(/\s+/g, " ").slice(0, 200);
          registerEntity({
            kind: "DESIGN_CONCEPT",
            canonicalName: concept.toLowerCase().slice(0, 120),
            summary: concept,
            event: ev,
            role: "DESIGN_STATEMENT",
            validityStatus: isRolledBack ? "ROLLED_BACK" : "VIGENTE",
            epistemic: ev.kind === "reasoning.summary" ? EPISTEMIC.INFERRED : EPISTEMIC.DIRECT,
            attributes: { sourceKind: ev.kind },
          });
        }
      }

      SYMBOL_REGEX.lastIndex = 0;
      let symMatch;
      let symCount = 0;
      while ((symMatch = SYMBOL_REGEX.exec(text)) !== null && symCount < 6) {
        const sym = (symMatch[1] || symMatch[2] || "").trim();
        if (
          sym &&
          sym.length >= 3 &&
          !sym.includes("/") &&
          !["true", "false", "null", "undefined", "npm", "git", "node"].includes(sym.toLowerCase())
        ) {
          symCount += 1;
          registerEntity({
            kind: "SYMBOL",
            canonicalName: sym,
            summary: `Code symbol ${sym}`,
            event: ev,
            role: "SYMBOL_REF",
            validityStatus: isRolledBack ? "ROLLED_BACK" : "VIGENTE",
            epistemic: EPISTEMIC.DIRECT,
            attributes: { symbol: sym },
          });
        }
      }
    }

    if (ev.status === "FAILED" && ["tool.completed", "tool.observed", "mcp.completed"].includes(ev.kind)) {
      const errSnippet = (ev.output_preview || ev.input_preview || "Tool execution failed")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      registerEntity({
        kind: "ERROR_SYMPTOM",
        canonicalName: errSnippet.toLowerCase().slice(0, 120),
        summary: `Failure symptom: ${errSnippet}`,
        event: ev,
        role: "FAILURE_OUTPUT",
        validityStatus: isRolledBack ? "ROLLED_BACK" : "VIGENTE",
        epistemic: EPISTEMIC.DIRECT,
        attributes: { exitCode: ev.metadata.exitCode ?? null, toolName: ev.metadata.toolName ?? null },
      });
    }
  }

  const activeFactsBySlot = new Map();
  const activeValidationFactsBySession = new Map();
  const activeFailureFactsBySession = new Map();
  const allCreatedFacts = [];
  const createdFactById = new Map();

  function invalidateFactRecord(
    fact,
    invalidatingEvent,
    validityStatus,
    supersededByFactId = null,
    customInvalidAt = null,
    customExpiredAt = null,
  ) {
    if (!fact || fact.validityStatus !== "VIGENTE" || !invalidatingEvent) return;
    fact.validityStatus = validityStatus;
    fact.invalidAt = customInvalidAt ?? invalidatingEvent.observed_at ?? fact.validAt ?? null;
    fact.expiredAt = customExpiredAt ?? invalidatingEvent.observed_at ?? fact.createdAt ?? fact.invalidAt ?? null;
    fact.invalidAtOrdinal = invalidatingEvent.record_ordinal ?? fact.validFromOrdinal ?? 0;
    fact.invalidatedByEventId = invalidatingEvent.id;
    fact.supersededByFactId = supersededByFactId;
    db.invalidateTemporalFact(fact.id, {
      invalidAt: fact.invalidAt,
      expiredAt: fact.expiredAt,
      invalidAtOrdinal: fact.invalidAtOrdinal,
      validityStatus,
      invalidatedByEventId: invalidatingEvent.id,
      supersededByFactId,
    });
    const invalidationSha256 = computeFactInvalidationHash(fact);
    db.insertEntityEdge({
      from: invalidatingEvent.id,
      to: fact.id,
      fromKind: "EVENT",
      toKind: "FACT",
      type: "INVALIDATES_FACT",
      grade: "DETERMINISTIC_RULE",
      rule: `temporal-invalidation-${validityStatus.toLowerCase()}`,
      epistemic: EPISTEMIC.DIRECT,
      evidenceEventId: invalidatingEvent.id,
      metadata: { validityStatus, supersededByFactId, invalidationSha256 },
    });
  }

  function createTemporalFact({
    slotKey,
    subjectId,
    subjectKind,
    predicate,
    objectId = null,
    objectKind = null,
    factText,
    value = {},
    event,
    validAt = undefined,
    createdAt = undefined,
    epistemic = EPISTEMIC.DIRECT,
    rule = "bi-temporal-extraction",
    supersedePrevious = true,
    supersedeStatus = "SUPERSEDED",
  }) {
    const effectiveValidAt = validAt !== undefined ? validAt : (event.metadata?.validAt ?? event.observed_at ?? null);
    const effectiveCreatedAt = createdAt !== undefined ? createdAt : (event.metadata?.knownAt ?? event.observed_at ?? null);
    const cleanText = String(factText).slice(0, 400);
    const factId = makeFactId(subjectId, predicate, cleanText, event.record_ordinal, event.id);
    if (createdFactById.has(factId)) {
      return createdFactById.get(factId);
    }

    if (slotKey && supersedePrevious && activeFactsBySlot.has(slotKey)) {
      const priorFact = activeFactsBySlot.get(slotKey);
      invalidateFactRecord(priorFact, event, supersedeStatus, factId, effectiveValidAt, effectiveCreatedAt);
    }

    const fact = {
      id: factId,
      subjectId,
      subjectKind,
      predicate,
      objectId,
      objectKind,
      factText: cleanText,
      value: {
        ...value,
        sessionId: event.session_id,
        entityScope: "SESSION",
        knownAt: effectiveCreatedAt,
        validAt: effectiveValidAt,
      },
      validAt: effectiveValidAt,
      invalidAt: null,
      createdAt: effectiveCreatedAt,
      expiredAt: null,
      validFromOrdinal: event.record_ordinal ?? 0,
      invalidAtOrdinal: null,
      validityStatus: "VIGENTE",
      epistemic,
      rule,
      sourceEventId: event.id,
      invalidatedByEventId: null,
      supersededByFactId: null,
      refs: event.refs,
    };

    db.insertTemporalFact(fact);
    createdFactById.set(factId, fact);
    const factSha256 = computeFactAssertionHash(fact);

    db.insertEntityEdge({
      from: event.id,
      to: factId,
      fromKind: "EVENT",
      toKind: "FACT",
      type: "ASSERTS_FACT",
      grade: "DETERMINISTIC_RULE",
      rule,
      epistemic,
      evidenceEventId: event.id,
      metadata: { predicate, factSha256 },
    });

    if (rolledBackEventIds.has(event.id)) {
      const rbEvent = rolledBackByMap.get(event.id);
      if (rbEvent) {
        invalidateFactRecord(fact, rbEvent, "ROLLED_BACK", null);
      }
    } else if (abortedEventIds.has(event.id)) {
      invalidateFactRecord(fact, event, "INVALIDATED_BY_FAILURE", null);
    } else if (slotKey) {
      activeFactsBySlot.set(slotKey, fact);
    }

    allCreatedFacts.push(fact);
    return fact;
  }

  const revisionsByProducer = new Map();
  for (const rev of artifactRevisions) {
    if (!revisionsByProducer.has(rev.producer_event_id)) revisionsByProducer.set(rev.producer_event_id, []);
    revisionsByProducer.get(rev.producer_event_id).push(rev);
  }

  const validationsByEvent = new Map();
  for (const val of validations) {
    if (!val.evidence_event_id) continue;
    if (!validationsByEvent.has(val.evidence_event_id)) validationsByEvent.set(val.evidence_event_id, []);
    validationsByEvent.get(val.evidence_event_id).push(val);
  }

  for (const ev of events) {
    const rawText = (ev.input_preview || ev.output_preview || "").trim();
    const text = ev.kind === "message.user" ? (substantiveUserText(ev.input_preview) || "") : rawText;

    if (!activeValidationFactsBySession.has(ev.session_id)) {
      activeValidationFactsBySession.set(ev.session_id, new Set());
    }
    if (!activeFailureFactsBySession.has(ev.session_id)) {
      activeFailureFactsBySession.set(ev.session_id, new Set());
    }
    const sessionValFacts = activeValidationFactsBySession.get(ev.session_id);
    const sessionFailFacts = activeFailureFactsBySession.get(ev.session_id);

    if ((ev.kind === "message.user" || ev.kind === "session.goal_updated") && text) {
      const cleanMission = text.replace(/\s+/g, " ").slice(0, 260);
      createTemporalFact({
        slotKey: `mission:${ev.session_id}`,
        subjectId: ev.session_id,
        subjectKind: "SESSION",
        predicate: "HAS_MISSION",
        factText: `Session directive: ${cleanMission}`,
        value: { directive: cleanMission, turnId: ev.turn_id },
        event: ev,
        epistemic: EPISTEMIC.DIRECT,
        rule: "user-mission-progression",
        supersedePrevious: true,
        supersedeStatus: "SUPERSEDED",
      });

      if (ev.kind === "message.user") {
        for (const regex of CONSTRAINT_PATTERNS) {
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(text)) !== null) {
            const clause = match[0].trim().replace(/\s+/g, " ").slice(0, 180);
            if (clause.length >= 10) {
              const constraintEntityId = makeEntityId("CONSTRAINT", clause.toLowerCase());
              createTemporalFact({
                slotKey: `constraint:${ev.session_id}:${clause.toLowerCase()}`,
                subjectId: ev.session_id,
                subjectKind: "SESSION",
                predicate: "ENFORCES_CONSTRAINT",
                objectId: constraintEntityId,
                objectKind: "ENTITY",
                factText: `Active constraint: ${clause}`,
                value: { constraint: clause },
                event: ev,
                epistemic: EPISTEMIC.DIRECT,
                rule: "explicit-user-constraint",
                supersedePrevious: true,
              });
            }
          }
        }
      }
    }

    if (ev.kind === "plan.updated" && text) {
      const planEntityId = makeEntityId("DESIGN_CONCEPT", `plan:${ev.session_id}`);
      createTemporalFact({
        slotKey: `plan:${ev.session_id}`,
        subjectId: ev.session_id,
        subjectKind: "SESSION",
        predicate: "ACTIVE_PLAN",
        objectId: planEntityId,
        objectKind: "ENTITY",
        factText: `Execution plan: ${text.replace(/\s+/g, " ").slice(0, 260)}`,
        value: { planText: text },
        event: ev,
        epistemic: EPISTEMIC.DIRECT,
        rule: "plan-item-update",
        supersedePrevious: true,
      });
    }

    const producedRevs = revisionsByProducer.get(ev.id) || [];
    for (const rev of producedRevs) {
      const art = artifactById.get(rev.artifact_id);
      if (!art) continue;
      const artEntityId = makeEntityId("ARTIFACT", art.logical_path);
      createTemporalFact({
        slotKey: `artifact:${ev.session_id}:${art.id}`,
        subjectId: art.id,
        subjectKind: "ARTIFACT",
        predicate: "ARTIFACT_STATE",
        objectId: artEntityId,
        objectKind: "ENTITY",
        factText: `Artifact ${art.logical_path} ${rev.operation} (status=${art.current_status})`,
        value: {
          artifactId: art.id,
          logicalPath: art.logical_path,
          revisionId: rev.id,
          operation: rev.operation,
          status: art.current_status,
        },
        event: ev,
        epistemic: EPISTEMIC.DIRECT,
        rule: "artifact-revision-state",
        supersedePrevious: true,
        supersedeStatus: "SUPERSEDED",
      });

      for (const valFact of sessionValFacts) {
        if (valFact.validFromOrdinal < ev.record_ordinal) {
          invalidateFactRecord(valFact, ev, "STALE", null);
        }
      }
    }

    const evValidations = validationsByEvent.get(ev.id) || [];
    for (const val of evValidations) {
      const valFact = createTemporalFact({
        slotKey: `validation:${ev.session_id}:${val.command_text || val.target}`,
        subjectId: val.id,
        subjectKind: "VALIDATION",
        predicate: "VALIDATION_STATE",
        factText: `Validation ${val.status}: ${val.target} (${val.observed_result.slice(0, 160)})`,
        value: {
          validationId: val.id,
          command: val.command_text,
          status: val.status,
          result: val.observed_result,
        },
        event: ev,
        epistemic: val.status === "OBSERVED_PASS" ? EPISTEMIC.CORROBORATED : EPISTEMIC.DIRECT,
        rule: "historical-validation-observation",
        supersedePrevious: true,
        supersedeStatus: "SUPERSEDED",
      });
      sessionValFacts.add(valFact);

      if (val.status === "OBSERVED_PASS") {
        for (const failFact of sessionFailFacts) {
          invalidateFactRecord(failFact, ev, "SUPERSEDED", valFact.id);
        }
        sessionFailFacts.clear();
      } else if (val.status === "OBSERVED_FAIL") {
        sessionFailFacts.add(valFact);
      }
    }

    if (
      ev.status === "FAILED" &&
      ["tool.completed", "tool.observed", "mcp.completed"].includes(ev.kind) &&
      evValidations.length === 0
    ) {
      const failSnippet = (ev.output_preview || ev.input_preview || "Tool failed").replace(/\s+/g, " ").slice(0, 200);
      const failFact = createTemporalFact({
        slotKey: `tool_failure:${ev.session_id}:${ev.metadata.toolName || ev.subtype || "tool"}`,
        subjectId: ev.session_id,
        subjectKind: "SESSION",
        predicate: "TOOL_FAILURE",
        factText: `Tool failure (${ev.metadata.toolName || ev.subtype || "tool"}): ${failSnippet}`,
        value: {
          toolName: ev.metadata.toolName || ev.subtype,
          exitCode: ev.metadata.exitCode ?? null,
          output: failSnippet,
        },
        event: ev,
        epistemic: EPISTEMIC.DIRECT,
        rule: "failed-tool-observation",
        supersedePrevious: true,
      });
      sessionFailFacts.add(failFact);
    }

    if (ev.kind === "session.world_state" && text) {
      createTemporalFact({
        slotKey: `world_state:${ev.session_id}`,
        subjectId: ev.session_id,
        subjectKind: "SESSION",
        predicate: "WORLD_STATE_SETTING",
        factText: `World state: ${text.slice(0, 240)}`,
        value: ev.metadata.stateSnapshot || { summary: text },
        event: ev,
        epistemic: EPISTEMIC.DIRECT,
        rule: "codex-world-state",
        supersedePrevious: true,
      });
    }

    if (ev.kind === "external.review" && (ev.output_preview || ev.input_preview)) {
      const revText = (ev.output_preview || ev.input_preview || "").replace(/\s+/g, " ").slice(0, 240);
      createTemporalFact({
        slotKey: `review:${ev.session_id}`,
        subjectId: ev.session_id,
        subjectKind: "SESSION",
        predicate: "REVIEW_FINDING",
        factText: `Review (${ev.status}): ${revText}`,
        value: { status: ev.status, reviewOutput: ev.metadata.reviewOutput ?? revText },
        event: ev,
        epistemic: EPISTEMIC.DIRECT,
        rule: "codex-review-mode",
        supersedePrevious: true,
      });
    }
  }

  const contradictedClaims = db.all("SELECT * FROM claim WHERE epistemic_status='CONTRADICTED' ORDER BY id");
  for (const clm of contradictedClaims) {
    const ev = eventById.get(clm.source_event_id);
    if (!ev) continue;
    const payload = safeJson(clm.object_json, {});
    const fact = createTemporalFact({
      slotKey: null,
      subjectId: clm.id,
      subjectKind: "CLAIM",
      predicate: "REPORTED_COMPLETION_CONTRADICTED",
      factText: `Contradicted completion claim: "${payload.reportedText || "done"}" while ${payload.conflictingTool || "tool"} was ${payload.conflictingStatus || "FAILED"}`,
      value: payload,
      event: ev,
      epistemic: EPISTEMIC.CONTRADICTED,
      rule: clm.derivation_rule || "reported-vs-observed",
      supersedePrevious: false,
    });
    invalidateFactRecord(fact, ev, "CONTRADICTED", null);
  }

  const decisions = db.all(`
    SELECT d.*, e.session_id, e.turn_id, e.record_ordinal, e.observed_at
    FROM decision_record d
    JOIN event e ON e.id = d.source_event_id
    ORDER BY e.record_ordinal ASC, d.id ASC
  `);

  for (let i = 0; i < decisions.length; i += 1) {
    const dec = decisions[i];
    const ord = dec.record_ordinal ?? 0;
    const ev = eventById.get(dec.source_event_id);

    const knownFactsAtMoment = allCreatedFacts
      .filter(
        (f) =>
          f.value?.sessionId === dec.session_id &&
          f.validFromOrdinal <= ord &&
          (f.invalidAtOrdinal === null || f.invalidAtOrdinal > ord) &&
          (f.epistemic === EPISTEMIC.DIRECT || f.epistemic === EPISTEMIC.CORROBORATED),
      )
      .slice(-8)
      .map((f) => ({
        factId: f.id,
        predicate: f.predicate,
        factText: f.factText,
        epistemicStatus: f.epistemic,
        evidenceUri: f.refs?.[0] ?? null,
      }));

    const inferredReasonsAtMoment = events
      .filter(
        (e) =>
          e.session_id === dec.session_id &&
          e.kind === "reasoning.summary" &&
          e.record_ordinal <= ord &&
          e.record_ordinal >= Math.max(0, ord - 10) &&
          Boolean(e.input_preview),
      )
      .map((e) => ({
        eventId: e.id,
        ordinal: e.record_ordinal,
        summary: e.input_preview.slice(0, 260),
        epistemicStatus: EPISTEMIC.INFERRED,
        evidenceUri: e.refs?.[0] ?? null,
      }));

    const causalParents = db.all(
      `SELECT from_event_id, edge_type, rule_id FROM event_edge WHERE to_event_id = $id`,
      { id: dec.source_event_id },
    );
    const triggerEventIds = causalParents.map((p) => p.from_event_id);

    let validityStatus = "VIGENTE";
    let invalidAt = null;
    let invalidAtOrdinal = null;
    let supersededById = null;

    if (rolledBackEventIds.has(dec.source_event_id)) {
      const rbEv = rolledBackByMap.get(dec.source_event_id);
      validityStatus = "ROLLED_BACK";
      invalidAt = rbEv?.observed_at ?? dec.observed_at ?? null;
      invalidAtOrdinal = rbEv?.record_ordinal ?? ord;
    } else if (i < decisions.length - 1) {
      const laterPivot = decisions.slice(i + 1).find(
        (later) =>
          later.session_id === dec.session_id &&
          !rolledBackEventIds.has(later.source_event_id) &&
          /\b(?:instead|replace|pivot|switch\s+to|abandon|revert|supersede|en\s+vez\s+de|cambiar\s+a)\b/i.test(
            `${later.decision_text} ${later.rationale || ""}`,
          ),
      );
      if (laterPivot) {
        validityStatus = "SUPERSEDED";
        invalidAt = laterPivot.observed_at ?? null;
        invalidAtOrdinal = laterPivot.record_ordinal ?? null;
        supersededById = laterPivot.id;
        db.insertEntityEdge({
          from: laterPivot.id,
          to: dec.id,
          fromKind: "DECISION",
          toKind: "DECISION",
          type: "SUPERSEDES_DECISION",
          grade: "DETERMINISTIC_RULE",
          rule: "decision-pivot-supersession",
          epistemic: EPISTEMIC.INFERRED,
          evidenceEventId: laterPivot.source_event_id,
          metadata: { supersededDecisionId: dec.id },
        });
      }
    }

    const refs = Array.from(
      new Set([
        ...(ev?.refs || []),
        ...knownFactsAtMoment.map((f) => f.evidenceUri).filter(Boolean),
        ...inferredReasonsAtMoment.map((r) => r.evidenceUri).filter(Boolean),
      ]),
    );

    const parsedRationale =
      dec.rationale ||
      (/\bbecause\s+(.+)$/i.exec(dec.decision_text)?.[1]?.trim() ??
        inferredReasonsAtMoment.at(-1)?.summary ??
        null);

    db.insertDecision({
      id: dec.id,
      problem: dec.problem,
      alternatives: safeJson(dec.alternatives_json, []),
      decision: dec.decision_text,
      rationale: parsedRationale,
      consequences: safeJson(dec.consequences_json, []),
      status: validityStatus === "VIGENTE" ? dec.status : validityStatus,
      event: dec.source_event_id,
      epistemic: dec.epistemic_status,
      decisionKind: dec.decision_kind || "EXPLICIT_MARKER",
      validAt: dec.observed_at ?? null,
      invalidAt,
      validFromOrdinal: ord,
      invalidAtOrdinal,
      validityStatus,
      knownFacts: knownFactsAtMoment,
      inferredReasons: inferredReasonsAtMoment,
      triggerEvents: triggerEventIds,
      supersededById,
      refs,
    });

    if (ev) {
      const decFact = createTemporalFact({
        slotKey: null,
        subjectId: dec.id,
        subjectKind: "DECISION",
        predicate: "DECISION_IN_FORCE",
        objectId: dec.id,
        objectKind: "DECISION",
        factText: `Decision (VIGENTE): ${dec.decision_text}`,
        value: {
          decisionId: dec.id,
          decisionText: dec.decision_text,
          rationale: parsedRationale,
        },
        event: ev,
        epistemic: dec.epistemic_status,
        rule: "explicit-decision-record",
        supersedePrevious: false,
      });
      if (validityStatus !== "VIGENTE") {
        const invEventId = supersededById
          ? decisions.find((d) => d.id === supersededById)?.source_event_id ?? null
          : rolledBackByMap.get(dec.source_event_id)?.id ?? ev.id;
        const invEvent = eventById.get(invEventId) || ev;
        invalidateFactRecord(decFact, invEvent, validityStatus, null, invalidAt, invalidAt);
      }
    }
  }
}

export function resolveAsOfBound(db, value) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const ordinal = Number(raw);
    const row = db.get(
      "SELECT MAX(observed_at) AS ts FROM event WHERE canonical=1 AND record_ordinal <= $ord",
      { ord: ordinal },
    );
    return { mode: "ordinal", maxOrdinal: ordinal, timestamp: row?.ts ?? null };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid temporal coordinate: ${raw}`);
  }
  const iso = parsed.toISOString();
  const row = db.get(
    "SELECT MAX(record_ordinal) AS max_ord FROM event WHERE canonical=1 AND observed_at <= $ts",
    { ts: iso },
  );
  return {
    mode: "timestamp",
    maxOrdinal: row?.max_ord != null ? Number(row.max_ord) : -1,
    timestamp: iso,
  };
}

export function resolveBiTemporalCut(db, { asOf = null, validAt = null, knownAt = null } = {}) {
  const asOfBound = resolveAsOfBound(db, asOf);
  const validAtBound = validAt != null ? resolveAsOfBound(db, validAt) : asOfBound;
  const knownAtBound = knownAt != null ? resolveAsOfBound(db, knownAt) : asOfBound;
  return {
    asOfBound,
    validAtBound,
    knownAtBound,
    hasCut: Boolean(asOfBound || validAtBound || knownAtBound),
  };
}

export function evaluateFactAtBiTemporalCut(row, { validAtBound = null, knownAtBound = null } = {}) {
  if (knownAtBound) {
    if (knownAtBound.mode === "ordinal" && knownAtBound.maxOrdinal != null) {
      if (row.valid_from_ordinal > knownAtBound.maxOrdinal) return { included: false, effectiveValidity: null };
    } else if (knownAtBound.timestamp) {
      if (row.created_at && row.created_at > knownAtBound.timestamp) {
        return { included: false, effectiveValidity: null };
      }
      if (!row.created_at && knownAtBound.maxOrdinal != null && row.valid_from_ordinal > knownAtBound.maxOrdinal) {
        return { included: false, effectiveValidity: null };
      }
    }
  }

  if (validAtBound) {
    if (validAtBound.mode === "ordinal" && validAtBound.maxOrdinal != null) {
      if (row.valid_from_ordinal > validAtBound.maxOrdinal) return { included: false, effectiveValidity: null };
    } else if (validAtBound.timestamp) {
      if (row.valid_at && row.valid_at > validAtBound.timestamp) {
        return { included: false, effectiveValidity: null };
      }
      if (!row.valid_at && validAtBound.maxOrdinal != null && row.valid_from_ordinal > validAtBound.maxOrdinal) {
        return { included: false, effectiveValidity: null };
      }
    }
  }

  let invalidatedByValidAxis = row.validity_status !== "VIGENTE";
  if (validAtBound && invalidatedByValidAxis) {
    if (validAtBound.mode === "ordinal" && validAtBound.maxOrdinal != null) {
      if (row.invalid_at_ordinal != null && row.invalid_at_ordinal > validAtBound.maxOrdinal) {
        invalidatedByValidAxis = false;
      }
    } else if (validAtBound.timestamp) {
      if (row.invalid_at && row.invalid_at > validAtBound.timestamp) {
        invalidatedByValidAxis = false;
      } else if (!row.invalid_at && validAtBound.maxOrdinal != null && row.invalid_at_ordinal != null && row.invalid_at_ordinal > validAtBound.maxOrdinal) {
        invalidatedByValidAxis = false;
      }
    }
  }

  let invalidationKnownByKnownAxis = true;
  if (knownAtBound && row.validity_status !== "VIGENTE") {
    if (knownAtBound.mode === "ordinal" && knownAtBound.maxOrdinal != null) {
      if (row.invalid_at_ordinal != null && row.invalid_at_ordinal > knownAtBound.maxOrdinal) {
        invalidationKnownByKnownAxis = false;
      }
    } else if (knownAtBound.timestamp) {
      if (row.expired_at && row.expired_at > knownAtBound.timestamp) {
        invalidationKnownByKnownAxis = false;
      } else if (!row.expired_at && knownAtBound.maxOrdinal != null && row.invalid_at_ordinal != null && row.invalid_at_ordinal > knownAtBound.maxOrdinal) {
        invalidationKnownByKnownAxis = false;
      }
    }
  }

  const effectiveValidity =
    invalidatedByValidAxis && invalidationKnownByKnownAxis
      ? row.validity_status === "VIGENTE"
        ? "SUPERSEDED"
        : row.validity_status
      : "VIGENTE";

  return { included: true, effectiveValidity };
}

export function evaluateEntityAtBiTemporalCut(entity, { asOfBound = null, validAtBound = null, knownAtBound = null } = {}) {
  const bounds = [asOfBound, validAtBound, knownAtBound].filter(Boolean);
  for (const bound of bounds) {
    if (bound.mode === "ordinal" && bound.maxOrdinal != null) {
      if (Number(entity.first_ordinal ?? 0) > bound.maxOrdinal) return false;
    } else if (bound.mode === "timestamp" && bound.timestamp) {
      if (entity.first_seen_at && entity.first_seen_at > bound.timestamp) return false;
      if (bound.maxOrdinal != null && Number(entity.first_ordinal ?? 0) > bound.maxOrdinal) return false;
    }
  }
  return true;
}

export function evaluateDecisionAtBiTemporalCut(decision, { asOfBound = null, validAtBound = null, knownAtBound = null } = {}) {
  const bounds = [asOfBound, validAtBound, knownAtBound].filter(Boolean);
  for (const bound of bounds) {
    if (bound.mode === "ordinal" && bound.maxOrdinal != null) {
      if (Number(decision.valid_from_ordinal ?? 0) > bound.maxOrdinal) return false;
    } else if (bound.mode === "timestamp" && bound.timestamp) {
      if (decision.valid_at && decision.valid_at > bound.timestamp) return false;
      if (bound.maxOrdinal != null && Number(decision.valid_from_ordinal ?? 0) > bound.maxOrdinal) return false;
    }
  }
  return true;
}

function assertStringOrNull(value, fieldName, { allowNull = true, allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (!allowNull) throw new Error(`Invalid ${fieldName}: required non-empty string`);
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid ${fieldName}: expected string, got ${typeof value}`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    throw new Error(`Invalid ${fieldName}: string cannot be empty`);
  }
  return trimmed;
}

function verifyAllFactEdgeHashesAndProvenance(db) {
  const facts = db.all("SELECT * FROM temporal_fact ORDER BY id");
  for (const fact of facts) {
    const assertEdge = db.get(
      "SELECT metadata_json FROM entity_edge WHERE from_node_id=$from AND to_node_id=$to AND edge_type='ASSERTS_FACT' LIMIT 1",
      { from: fact.source_event_id, to: fact.id },
    );
    const meta = safeJson(assertEdge?.metadata_json, {});
    if (!assertEdge || !meta.factSha256 || meta.factSha256 !== computeFactAssertionHash(fact)) {
      throw new Error(`CASE_INTEGRITY_FAILED: Pre-existing temporal fact ${fact.id} failed assertion hash check.`);
    }
    if (fact.validity_status !== "VIGENTE" && fact.invalidated_by_event_id) {
      const invEdge = db.get(
        "SELECT metadata_json FROM entity_edge WHERE from_node_id=$from AND to_node_id=$to AND edge_type='INVALIDATES_FACT' ORDER BY rowid DESC LIMIT 1",
        { from: fact.invalidated_by_event_id, to: fact.id },
      );
      const invMeta = safeJson(invEdge?.metadata_json, {});
      if (!invEdge || !invMeta.invalidationSha256 || invMeta.invalidationSha256 !== computeFactInvalidationHash(fact)) {
        throw new Error(`CASE_INTEGRITY_FAILED: Pre-existing temporal fact ${fact.id} failed invalidation hash check.`);
      }
    }
    const ev = db.get("SELECT id, observed_at, record_ordinal FROM event WHERE id=$id", { id: fact.source_event_id });
    if (!ev || Number(fact.valid_from_ordinal) !== Number(ev.record_ordinal)) {
      throw new Error(`CASE_INTEGRITY_FAILED: Pre-existing temporal fact ${fact.id} failed provenance event check.`);
    }
    if (ev.observed_at && fact.created_at && Date.parse(fact.created_at) < Date.parse(ev.observed_at)) {
      throw new Error(`CASE_INTEGRITY_FAILED: Pre-existing temporal fact ${fact.id} has created_at preceding source event.`);
    }
  }
}

function tryRecoverManifestFromSealLog(db, manifest, actualTemporalIdentity, actualGraphIdentity, currentMetrics) {
  const hasSealTable = db.get("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='temporal_seal_log'");
  if (!hasSealTable) return null;
  const sealRows = db.all("SELECT * FROM temporal_seal_log ORDER BY seq ASC");
  if (!sealRows.length) return null;

  let curTemporal = manifest.temporalIdentity;
  let curGraph = manifest.graphIdentity;
  let matchedAny = false;
  let lastMatchedRow = null;

  for (const row of sealRows) {
    if (row.pre_temporal_identity === curTemporal && row.pre_graph_identity === curGraph) {
      curTemporal = row.post_temporal_identity;
      curGraph = row.post_graph_identity;
      matchedAny = true;
      lastMatchedRow = row;
      if (curTemporal === actualTemporalIdentity && curGraph === actualGraphIdentity) {
        break;
      }
    }
  }

  if (!matchedAny || curTemporal !== actualTemporalIdentity || curGraph !== actualGraphIdentity || !lastMatchedRow) {
    return null;
  }

  const loggedMetrics = safeJson(lastMatchedRow.post_metrics_json, null);
  if (!loggedMetrics) return null;
  for (const key of ["events", "tools", "artifacts", "decisions", "entities", "temporalFacts", "vigenteFacts", "staleFacts"]) {
    if (loggedMetrics[key] != null && Number(currentMetrics[key]) !== Number(loggedMetrics[key])) {
      return null;
    }
  }
  return {
    temporalIdentity: actualTemporalIdentity,
    graphIdentity: actualGraphIdentity,
    metrics: currentMetrics,
  };
}

function assertPreAppendIntegrity(db, root) {
  const manifestPath = path.join(root, "case.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("CASE_INTEGRITY_FAILED: Cannot append governed temporal fact because case.json is missing.");
  }
  const manifest = safeJson(fs.readFileSync(manifestPath, "utf8"), null);
  if (!manifest || manifest.status !== "COMPLETE") {
    throw new Error("CASE_INTEGRITY_FAILED: Cannot append governed temporal fact to an incomplete case.");
  }

  verifyAllFactEdgeHashesAndProvenance(db);

  const actualTemporalIdentity = computeTemporalIdentity(db);
  const actualGraphIdentity = computeGraphIdentity(db);
  const currentMetrics = computeCaseMetrics(db);

  const temporalMismatch = manifest.temporalIdentity != null && actualTemporalIdentity !== manifest.temporalIdentity;
  const graphMismatch = manifest.graphIdentity != null && actualGraphIdentity !== manifest.graphIdentity;
  let metricMismatch = false;
  if (manifest.metrics) {
    for (const key of ["events", "tools", "artifacts", "decisions", "entities", "temporalFacts", "vigenteFacts", "staleFacts"]) {
      if (manifest.metrics[key] != null && Number(currentMetrics[key]) !== Number(manifest.metrics[key])) {
        metricMismatch = true;
        break;
      }
    }
  }

  let recoveredManifest = false;
  if (temporalMismatch || graphMismatch || metricMismatch) {
    const recovered = tryRecoverManifestFromSealLog(db, manifest, actualTemporalIdentity, actualGraphIdentity, currentMetrics);
    if (!recovered) {
      if (temporalMismatch) {
        throw new Error(
          `CASE_INTEGRITY_FAILED: Pre-existing temporal state is tampered (actual=${actualTemporalIdentity} !== expected=${manifest.temporalIdentity}). Refusing to append or reseal.`,
        );
      }
      if (graphMismatch) {
        throw new Error(
          `CASE_INTEGRITY_FAILED: Pre-existing graph state is tampered (actual=${actualGraphIdentity} !== expected=${manifest.graphIdentity}). Refusing to append or reseal.`,
        );
      }
      throw new Error("CASE_INTEGRITY_FAILED: Pre-existing case metrics do not match manifest.");
    }
    manifest.temporalIdentity = recovered.temporalIdentity;
    manifest.graphIdentity = recovered.graphIdentity;
    manifest.metrics = recovered.metrics;
    atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    recoveredManifest = true;
  }

  return {
    manifest,
    manifestPath,
    preTemporalIdentity: actualTemporalIdentity,
    preGraphIdentity: actualGraphIdentity,
    recoveredManifest,
  };
}

export function recoverTemporalManifest(caseDir) {
  const root = path.resolve(caseDir);
  const db = new CaseDatabase(path.join(root, "case.sqlite"), { readOnly: true });
  try {
    const { manifest, recoveredManifest } = assertPreAppendIntegrity(db, root);
    return {
      caseDir: root,
      recovered: recoveredManifest,
      temporalIdentity: manifest.temporalIdentity,
      graphIdentity: manifest.graphIdentity,
    };
  } finally {
    db.close();
  }
}

export function appendGovernedTemporalFact(caseDir, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid input: expected an object");
  }
  const root = path.resolve(caseDir);
  if (
    input.authority ||
    input.manualAuthority ||
    input.authorityTier ||
    input.authority_tier ||
    input.trustTier ||
    input.trust_tier ||
    input.verified === true ||
    input.trusted === true ||
    input.corroborated === true
  ) {
    throw new Error("MANUAL_AUTHORITY_REJECTED: Temporal assertions cannot inject manual authority or bypass cold evidence verification.");
  }

  const rawEpistemic = input.epistemic ?? input.epistemicStatus ?? input.epistemic_status ?? input.status ?? null;
  if (rawEpistemic != null) {
    if (typeof rawEpistemic !== "string") {
      throw new Error("MANUAL_AUTHORITY_REJECTED: Invalid epistemic status type");
    }
    const upper = rawEpistemic.trim().toUpperCase();
    if (
      upper === "CORROBORATED" ||
      upper === "VERIFIED" ||
      upper === "MANUAL_AUTHORITY" ||
      upper === "AUTHORITATIVE" ||
      upper === "TRUSTED" ||
      !["DIRECT_EVIDENCE", "INFERRED", "UNCERTAIN", "CONTRADICTED"].includes(upper)
    ) {
      throw new Error(`MANUAL_AUTHORITY_REJECTED: Governed temporal assertions cannot self-assign ${upper} authority without independent verification.`);
    }
  }
  const epistemic = rawEpistemic ? rawEpistemic.trim().toUpperCase() : EPISTEMIC.DIRECT;

  // Upfront strict validation of all scalar fields before opening or mutating SQLite
  const requestedId = assertStringOrNull(input.id !== undefined ? input.id : input.factId, "id");
  const sourceEventId = assertStringOrNull(
    input.sourceEventId ?? input.source_event_id ?? input.eventId ?? input.event_id,
    "sourceEventId",
    { allowNull: true },
  );
  if (!sourceEventId) {
    throw new Error("MANUAL_AUTHORITY_REJECTED: A registered sourceEventId is required for governed temporal facts.");
  }
  const explicitSession = assertStringOrNull(input.sessionId !== undefined ? input.sessionId : input.session_id, "sessionId");
  const explicitSubjectId = assertStringOrNull(input.subjectId !== undefined ? input.subjectId : input.subject_id, "subjectId");
  const explicitSubjectKind = assertStringOrNull(input.subjectKind !== undefined ? input.subjectKind : input.subject_kind, "subjectKind");
  const predicate = assertStringOrNull(input.predicate !== undefined ? input.predicate : "ASSERTED_FACT", "predicate", { allowNull: false });
  const objectId = assertStringOrNull(input.objectId !== undefined ? input.objectId : input.object_id, "objectId");
  const objectKind = assertStringOrNull(input.objectKind !== undefined ? input.objectKind : input.object_kind, "objectKind");
  const supersedesFactIdInput = assertStringOrNull(
    input.supersedesFactId !== undefined ? input.supersedesFactId : input.supersedes_fact_id,
    "supersedesFactId",
  );
  const rule = assertStringOrNull(input.rule !== undefined ? input.rule : "governed-bitemporal-append", "rule", { allowNull: false });

  const rawFactText = input.factText !== undefined ? input.factText : (input.fact_text !== undefined ? input.fact_text : input.text);
  const factText = assertStringOrNull(rawFactText, "factText", { allowNull: false });

  if (input.value !== undefined && input.value !== null && (typeof input.value !== "object" || Array.isArray(input.value))) {
    throw new Error("Invalid value: must be a plain object or null");
  }

  const validAtRaw = input.validAt ?? input.valid_at ?? null;
  const knownAtRaw = input.knownAt ?? input.known_at ?? input.createdAt ?? input.created_at ?? null;
  if (validAtRaw != null && (typeof validAtRaw !== "string" && typeof validAtRaw !== "number" || Number.isNaN(Date.parse(String(validAtRaw))))) {
    throw new Error(`Invalid validAt timestamp: ${validAtRaw}`);
  }
  if (knownAtRaw != null && (typeof knownAtRaw !== "string" && typeof knownAtRaw !== "number" || Number.isNaN(Date.parse(String(knownAtRaw))))) {
    throw new Error(`Invalid knownAt timestamp: ${knownAtRaw}`);
  }

  const db = new CaseDatabase(path.join(root, "case.sqlite"));
  try {
    // Verify pre-append case integrity (and auto-recover unsealed temporal_seal_log transactions if a prior case.json write failed)
    const {
      manifest,
      manifestPath,
      preTemporalIdentity,
      preGraphIdentity,
      recoveredManifest,
    } = assertPreAppendIntegrity(db, root);

    const event = db.get("SELECT * FROM event WHERE id = $id", { id: sourceEventId });
    if (!event) {
      throw new Error(`MANUAL_AUTHORITY_REJECTED: Source event not found in case: ${sourceEventId}`);
    }

    if (explicitSession && explicitSession !== event.session_id) {
      throw new Error(
        `MANUAL_AUTHORITY_REJECTED: PROVENANCE_SESSION_MISMATCH: sessionId (${explicitSession}) does not match sourceEventId session (${event.session_id}).`,
      );
    }

    const registeredRefs = refsForEvent(db, sourceEventId);
    if (!registeredRefs.length) {
      throw new Error("MANUAL_AUTHORITY_REJECTED: Source event has no registered cold evidence references.");
    }
    const registeredRefSet = new Set(registeredRefs);

    const callerRefCandidates = [];
    for (const key of ["evidenceRefs", "evidence_refs", "refs"]) {
      if (input[key] !== undefined && input[key] !== null) {
        if (!Array.isArray(input[key])) throw new Error(`Invalid ${key}: expected array of URI strings`);
        callerRefCandidates.push(...input[key]);
      }
    }
    for (const key of ["evidenceUri", "evidence_uri", "uri"]) {
      if (input[key] !== undefined && input[key] !== null) callerRefCandidates.push(input[key]);
    }

    const providedRefs = callerRefCandidates.length ? callerRefCandidates : registeredRefs;
    if (!providedRefs.length) {
      throw new Error("MANUAL_AUTHORITY_REJECTED: At least one registered afh://evidence/sha256/... URI is required.");
    }

    for (const uri of providedRefs) {
      if (typeof uri !== "string" || !registeredRefSet.has(uri)) {
        throw new Error(
          `MANUAL_AUTHORITY_REJECTED: PROVENANCE_MISMATCH: Evidence URI (${uri}) does not belong to cited sourceEventId (${sourceEventId}).`,
        );
      }
      const resolved = readEvidence(root, uri);
      if (!resolved || !resolved.recordSha256) {
        throw new Error(`MANUAL_AUTHORITY_REJECTED: Unresolvable evidence URI: ${uri}`);
      }
    }

    const validAt = validAtRaw ? new Date(validAtRaw).toISOString() : (event.observed_at ?? null);
    const knownAt = knownAtRaw ? new Date(knownAtRaw).toISOString() : (event.observed_at ?? null);

    if (event.observed_at && knownAt && Date.parse(knownAt) < Date.parse(event.observed_at)) {
      throw new Error(
        `MANUAL_AUTHORITY_REJECTED: TEMPORAL_PROVENANCE_VIOLATION: knownAt (${knownAt}) cannot precede cited evidence event observed_at (${event.observed_at}).`,
      );
    }
    const knownOrdinal = input.knownOrdinal ?? input.known_ordinal ?? null;
    if (knownOrdinal != null && Number(knownOrdinal) < Number(event.record_ordinal)) {
      throw new Error(
        `MANUAL_AUTHORITY_REJECTED: TEMPORAL_PROVENANCE_VIOLATION: knownOrdinal (${knownOrdinal}) cannot precede cited evidence event record_ordinal (${event.record_ordinal}).`,
      );
    }

    const subjectId = explicitSubjectId || event.session_id;
    const subjectKind = (explicitSubjectKind || "SESSION").toUpperCase();

    const isSharedScope =
      (input.scope === "shared" || input.scope === "global" || input.sharedEntity === true) &&
      SHARED_ENTITY_KINDS.has(subjectKind);

    const userValue = input.value && typeof input.value === "object" ? input.value : {};
    const cleanFactText = factText.slice(0, 400);

    const deterministicFactId = makeFactId(
      subjectId,
      predicate,
      `${cleanFactText}:${validAt}:${knownAt}:${stableStringify(userValue)}`,
      event.record_ordinal,
      event.id,
    );
    const lookupId = requestedId || deterministicFactId;

    const existingForLogicalId = db.all(
      `SELECT tf.*, e.session_id
       FROM temporal_fact tf
       JOIN event e ON e.id = tf.source_event_id
       WHERE (tf.id = $id OR json_extract(tf.value_json, '$.logicalId') = $id)
         AND ($isShared = 1 OR e.session_id = $sessionId)
       ORDER BY tf.valid_from_ordinal ASC, COALESCE(tf.created_at, '') ASC, tf.id ASC`,
      { id: lookupId, isShared: isSharedScope ? 1 : 0, sessionId: event.session_id },
    );

    const nextRevisionNumber = existingForLogicalId.length + 1;
    const candidateValue = {
      ...userValue,
      sessionId: event.session_id,
      entityScope: isSharedScope ? "SHARED" : "SESSION",
      validAt,
      knownAt,
      ...(requestedId ? { logicalId: requestedId, revision: nextRevisionNumber } : {}),
    };

    if (existingForLogicalId.length > 0) {
      const latest = existingForLogicalId.at(-1);
      const latestVal = safeJson(latest.value_json, {});
      const sameUserPayload =
        stableStringify({ ...userValue }) ===
        stableStringify(
          Object.fromEntries(
            Object.entries(latestVal).filter(
              ([k]) => !["sessionId", "entityScope", "validAt", "knownAt", "logicalId", "revision"].includes(k),
            ),
          ),
        );
      if (
        latest.subject_id === subjectId &&
        latest.predicate === predicate &&
        latest.fact_text === cleanFactText &&
        latest.valid_at === validAt &&
        latest.created_at === knownAt &&
        latest.source_event_id === event.id &&
        latest.object_id === objectId &&
        latest.object_kind === objectKind &&
        sameUserPayload
      ) {
        return {
          id: latest.id,
          logicalId: requestedId || latest.id,
          subjectId,
          subjectKind,
          predicate,
          factText: latest.fact_text,
          validAt,
          knownAt,
          epistemicStatus: latest.epistemic_status,
          entityScope: isSharedScope ? "SHARED" : "SESSION",
          supersededFactId: null,
          supersededFactIds: [],
          evidenceRefs: safeJson(latest.evidence_refs_json, providedRefs),
          reused: true,
          recoveredManifest,
        };
      }
    }

    let factId;
    if (!requestedId) {
      factId = deterministicFactId;
      if (db.get("SELECT 1 ok FROM temporal_fact WHERE id = $id", { id: factId })) {
        const count = Number(db.get("SELECT COUNT(*) n FROM temporal_fact").n || 0);
        factId = `${factId}-v${count + 1}`;
      }
    } else {
      const collision = db.get("SELECT id FROM temporal_fact WHERE id = $id", { id: requestedId });
      if (!collision) {
        factId = requestedId;
      } else if (existingForLogicalId.length > 0) {
        const candidateVersionId = `${requestedId}#v${nextRevisionNumber}`;
        factId = db.get("SELECT 1 ok FROM temporal_fact WHERE id = $id", { id: candidateVersionId })
          ? `${requestedId}#v${nextRevisionNumber}-${shortHash([event.id, cleanFactText, validAt, knownAt], 8)}`
          : candidateVersionId;
      } else {
        factId = `${requestedId}@${shortHash([event.session_id, event.id, cleanFactText, validAt, knownAt], 10)}`;
      }
    }

    const toSupersedeMap = new Map();
    for (const row of existingForLogicalId) {
      if (row.validity_status === "VIGENTE") {
        toSupersedeMap.set(row.id, row);
      }
    }

    if (supersedesFactIdInput) {
      let explicitPrior = db.get(
        `SELECT tf.*, e.session_id
         FROM temporal_fact tf
         JOIN event e ON e.id = tf.source_event_id
         WHERE tf.id = $id`,
        { id: supersedesFactIdInput },
      );
      if (!explicitPrior) {
        throw new Error(`Supersession target fact not found: ${supersedesFactIdInput}`);
      }
      if (!isSharedScope && explicitPrior.session_id !== event.session_id) {
        throw new Error(
          `MANUAL_AUTHORITY_REJECTED: CROSS_SESSION_SUPERSESSION_FORBIDDEN: Cannot supersede session ${explicitPrior.session_id} fact from session ${event.session_id} without shared entity scope.`,
        );
      }
      const seenChain = new Set([explicitPrior.id]);
      while (explicitPrior && explicitPrior.validity_status !== "VIGENTE" && explicitPrior.superseded_by_fact_id) {
        if (seenChain.has(explicitPrior.superseded_by_fact_id)) break;
        seenChain.add(explicitPrior.superseded_by_fact_id);
        const nextRow = db.get(
          `SELECT tf.*, e.session_id
           FROM temporal_fact tf
           JOIN event e ON e.id = tf.source_event_id
           WHERE tf.id = $id`,
          { id: explicitPrior.superseded_by_fact_id },
        );
        if (!nextRow) break;
        explicitPrior = nextRow;
      }
      if (explicitPrior && explicitPrior.validity_status === "VIGENTE") {
        toSupersedeMap.set(explicitPrior.id, explicitPrior);
      }
    }

    if (input.supersedePrevious !== false) {
      const priorVigenteRows = db.all(
        `SELECT tf.*, e.session_id
         FROM temporal_fact tf
         JOIN event e ON e.id = tf.source_event_id
         WHERE tf.subject_id = $subjectId
           AND tf.predicate = $predicate
           AND tf.validity_status = 'VIGENTE'
           AND ($isShared = 1 OR e.session_id = $sessionId)
         ORDER BY tf.valid_from_ordinal DESC, tf.id DESC`,
        {
          subjectId,
          predicate,
          isShared: isSharedScope ? 1 : 0,
          sessionId: event.session_id,
        },
      );
      for (const row of priorVigenteRows) {
        if (row.validity_status === "VIGENTE") {
          toSupersedeMap.set(row.id, row);
        }
      }
    }

    const supersededFactIds = [];
    let postMetrics;
    let postGraphIdentity;
    let postTemporalIdentity;

    db.begin();
    try {
      const newFactObj = {
        id: factId,
        subjectId,
        subjectKind,
        predicate,
        objectId,
        objectKind,
        factText: cleanFactText,
        value: candidateValue,
        validAt,
        invalidAt: null,
        createdAt: knownAt,
        expiredAt: null,
        validFromOrdinal: event.record_ordinal,
        invalidAtOrdinal: null,
        validityStatus: "VIGENTE",
        epistemic,
        rule,
        sourceEventId: event.id,
        invalidatedByEventId: null,
        supersededByFactId: null,
        refs: providedRefs,
      };
      db.insertTemporalFact(newFactObj);

      const factSha256 = computeFactAssertionHash(newFactObj);
      db.insertEntityEdge({
        from: event.id,
        to: factId,
        fromKind: "EVENT",
        toKind: "FACT",
        type: "ASSERTS_FACT",
        grade: "DETERMINISTIC_RULE",
        rule,
        epistemic,
        evidenceEventId: event.id,
        metadata: { predicate, factSha256 },
      });

      for (const prior of toSupersedeMap.values()) {
        if (prior.id === factId || prior.validity_status !== "VIGENTE") continue;
        db.invalidateTemporalFact(prior.id, {
          invalidAt: validAt,
          expiredAt: knownAt,
          invalidAtOrdinal: event.record_ordinal,
          validityStatus: "SUPERSEDED",
          invalidatedByEventId: event.id,
          supersededByFactId: factId,
        });
        const updatedPrior = db.get("SELECT * FROM temporal_fact WHERE id = $id", { id: prior.id });
        const invalidationSha256 = computeFactInvalidationHash(updatedPrior || prior);
        db.insertEntityEdge({
          from: event.id,
          to: prior.id,
          fromKind: "EVENT",
          toKind: "FACT",
          type: "INVALIDATES_FACT",
          grade: "DETERMINISTIC_RULE",
          rule: "temporal-invalidation-superseded",
          epistemic: EPISTEMIC.DIRECT,
          evidenceEventId: event.id,
          metadata: { validityStatus: "SUPERSEDED", supersededByFactId: factId, invalidationSha256 },
        });
        supersededFactIds.push(prior.id);
      }

      postMetrics = computeCaseMetrics(db);
      postGraphIdentity = computeGraphIdentity(db);
      postTemporalIdentity = computeTemporalIdentity(db);

      db.insertTemporalSealLog({
        factId,
        preTemporalIdentity,
        preGraphIdentity,
        postTemporalIdentity,
        postGraphIdentity,
        postMetrics,
        createdAt: new Date().toISOString(),
      });

      db.commit();
    } catch (txError) {
      try { db.rollback(); } catch {}
      throw txError;
    }

    manifest.metrics = postMetrics;
    manifest.graphIdentity = postGraphIdentity;
    manifest.temporalIdentity = postTemporalIdentity;
    atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    return {
      id: factId,
      logicalId: requestedId || factId,
      subjectId,
      subjectKind,
      predicate,
      factText: cleanFactText,
      validAt,
      knownAt,
      epistemicStatus: epistemic,
      entityScope: isSharedScope ? "SHARED" : "SESSION",
      supersededFactId: supersededFactIds[0] ?? null,
      supersededFactIds,
      evidenceRefs: providedRefs,
      recoveredManifest,
    };
  } finally {
    db.close();
  }
}

export function reconstructStateAtMoment(caseDir, options = {}) {
  const db = new CaseDatabase(path.join(path.resolve(caseDir), "case.sqlite"), { readOnly: true });
  try {
    const cut = resolveBiTemporalCut(db, {
      asOf: options.asOf,
      validAt: options.validAt,
      knownAt: options.knownAt,
    });
    const validityFilter = String(options.validity || "all").toLowerCase();
    const sessionFilter = options.session || null;

    if (sessionFilter && String(sessionFilter).startsWith("UNRESOLVED_SESSION:")) {
      return {
        asOf: cut.asOfBound || { mode: "latest", maxOrdinal: null, timestamp: null },
        validAt: cut.validAtBound || null,
        knownAt: cut.knownAtBound || null,
        counts: { vigenteFacts: 0, staleFacts: 0, decisions: 0, entities: 0 },
        vigenteFacts: [],
        staleFacts: [],
        facts: [],
        decisions: [],
        entities: [],
      };
    }

    const rawFacts = db.all(`
      SELECT tf.*, e.session_id
      FROM temporal_fact tf
      JOIN event e ON e.id = tf.source_event_id
      WHERE ($session IS NULL OR e.session_id = $session)
      ORDER BY tf.valid_from_ordinal ASC, tf.id ASC
    `, { session: sessionFilter });

    const allFacts = [];
    for (const row of rawFacts) {
      const evalResult = cut.hasCut
        ? evaluateFactAtBiTemporalCut(row, cut)
        : { included: true, effectiveValidity: row.validity_status };
      if (!evalResult.included) continue;
      allFacts.push({
        ...row,
        known_at: row.created_at,
        effective_validity_status: evalResult.effectiveValidity,
        value: safeJson(row.value_json, {}),
        evidence_refs: safeJson(row.evidence_refs_json, []),
      });
    }

    const vigenteFacts = allFacts.filter((f) => f.effective_validity_status === "VIGENTE");
    const staleFacts = allFacts.filter((f) => f.effective_validity_status !== "VIGENTE");

    const maxOrd = cut.validAtBound?.maxOrdinal ?? cut.knownAtBound?.maxOrdinal ?? cut.asOfBound?.maxOrdinal ?? null;
    const decisions = db
      .all(`
        SELECT d.*, e.session_id
        FROM decision_record d
        JOIN event e ON e.id = d.source_event_id
        WHERE ($session IS NULL OR e.session_id = $session)
        ORDER BY COALESCE(d.valid_from_ordinal, 0) ASC, d.id ASC
      `, { session: sessionFilter })
      .filter((d) => (cut.hasCut ? evaluateDecisionAtBiTemporalCut(d, cut) : true))
      .map((d) => {
        const effectiveValidity =
          maxOrd != null && d.invalid_at_ordinal != null && d.invalid_at_ordinal > maxOrd
            ? "VIGENTE"
            : d.validity_status;
        return {
          ...d,
          effective_validity_status: effectiveValidity,
          known_facts: safeJson(d.known_facts_json, []),
          inferred_reasons: safeJson(d.inferred_reasons_json, []),
          trigger_event_ids: safeJson(d.trigger_event_ids_json, []),
          evidence_refs: safeJson(d.evidence_refs_json, []),
        };
      });

    const entities = db
      .all(`
        SELECT en.*
        FROM entity_node en
        WHERE ($session IS NULL OR EXISTS (
          SELECT 1 FROM entity_mention em WHERE em.entity_id = en.id AND em.session_id = $session
        ))
        ORDER BY en.mention_count DESC, COALESCE(en.first_ordinal, 0) ASC
      `, { session: sessionFilter })
      .filter((e) => (cut.hasCut ? evaluateEntityAtBiTemporalCut(e, cut) : true))
      .map((e) => ({
        ...e,
        attributes: safeJson(e.attributes_json, {}),
      }));

    const filteredFacts =
      validityFilter === "vigente" || validityFilter === "active"
        ? vigenteFacts
        : validityFilter === "stale" || validityFilter === "invalidated"
          ? staleFacts
          : allFacts;

    return {
      asOf: cut.asOfBound || { mode: "latest", maxOrdinal: null, timestamp: null },
      validAt: cut.validAtBound || null,
      knownAt: cut.knownAtBound || null,
      counts: {
        vigenteFacts: vigenteFacts.length,
        staleFacts: staleFacts.length,
        decisions: decisions.length,
        entities: entities.length,
      },
      vigenteFacts,
      staleFacts,
      facts: filteredFacts,
      decisions,
      entities,
    };
  } finally {
    db.close();
  }
}

export function traceWhy(caseDir, targetId, options = {}) {
  const maxDepth = Math.min(Number(options.depth || 6), 15);
  const db = new CaseDatabase(path.join(path.resolve(caseDir), "case.sqlite"), { readOnly: true });
  try {
    let seedEventId = null;
    let targetRecord = null;

    const decision = db.get(
      "SELECT * FROM decision_record WHERE id = $id OR source_event_id = $id LIMIT 1",
      { id: targetId },
    );
    if (decision) {
      seedEventId = decision.source_event_id;
      targetRecord = {
        targetKind: "DECISION",
        id: decision.id,
        eventId: decision.source_event_id,
        summary: decision.decision_text,
        rationale: decision.rationale,
        validityStatus: decision.validity_status,
        epistemicStatus: decision.epistemic_status,
        knownFacts: safeJson(decision.known_facts_json, []),
        inferredReasons: safeJson(decision.inferred_reasons_json, []),
      };
    }

    if (!seedEventId) {
      const fact = db.get("SELECT * FROM temporal_fact WHERE id = $id LIMIT 1", { id: targetId });
      if (fact) {
        seedEventId = fact.source_event_id;
        targetRecord = {
          targetKind: "FACT",
          id: fact.id,
          eventId: fact.source_event_id,
          summary: fact.fact_text,
          validityStatus: fact.validity_status,
          epistemicStatus: fact.epistemic_status,
        };
      }
    }

    if (!seedEventId) {
      const ev = db.get("SELECT * FROM event WHERE id = $id LIMIT 1", { id: targetId });
      if (ev) {
        seedEventId = ev.id;
        targetRecord = {
          targetKind: "EVENT",
          id: ev.id,
          eventId: ev.id,
          ordinal: ev.record_ordinal,
          kind: ev.kind,
          summary: ev.input_preview || ev.output_preview || ev.kind,
          epistemicStatus: ev.epistemic_status,
        };
      }
    }

    if (!seedEventId) {
      const entity = db.get(
        "SELECT * FROM entity_node WHERE id = $id OR LOWER(canonical_name) = LOWER($id) LIMIT 1",
        { id: String(targetId) },
      );
      if (entity) {
        const lastMention = db.get(
          "SELECT event_id FROM entity_mention WHERE entity_id = $id ORDER BY record_ordinal DESC LIMIT 1",
          { id: entity.id },
        );
        seedEventId = lastMention?.event_id ?? null;
        targetRecord = {
          targetKind: "ENTITY",
          id: entity.id,
          eventId: seedEventId,
          summary: `${entity.entity_kind}: ${entity.canonical_name} — ${entity.summary || ""}`,
          validityStatus: entity.validity_status,
          epistemicStatus: entity.epistemic_status,
        };
      }
    }

    if (!seedEventId) {
      return { found: false, targetId, error: `Target not found: ${targetId}` };
    }

    const seedEvent = db.get("SELECT * FROM event WHERE id = $id", { id: seedEventId });
    const ordinal = seedEvent?.record_ordinal ?? 0;

    const causalEdges = [];
    const visitedEvents = new Map();
    if (seedEvent) {
      visitedEvents.set(seedEvent.id, {
        id: seedEvent.id,
        record_ordinal: seedEvent.record_ordinal,
        observed_at: seedEvent.observed_at,
        kind: seedEvent.kind,
        subtype: seedEvent.subtype,
        status: seedEvent.status,
        summary: (seedEvent.input_preview || seedEvent.output_preview || "").slice(0, 300),
        epistemic_status: seedEvent.epistemic_status,
        evidence: refsForEvent(db, seedEvent.id),
        depth: 0,
      });
    }

    const queue = [{ eventId: seedEventId, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= maxDepth) continue;
      const parents = db.all(
        `SELECT ee.*, e.record_ordinal, e.observed_at, e.kind, e.subtype, e.status,
                e.input_preview, e.output_preview, e.epistemic_status AS event_epistemic
         FROM event_edge ee
         JOIN event e ON e.id = ee.from_event_id
         WHERE ee.to_event_id = $id
         ORDER BY e.record_ordinal DESC`,
        { id: current.eventId },
      );

      for (const p of parents) {
        causalEdges.push({
          fromEventId: p.from_event_id,
          toEventId: p.to_event_id,
          edgeType: p.edge_type,
          grade: p.grade,
          ruleId: p.rule_id,
          epistemicStatus: p.epistemic_status,
          evidenceEventId: p.evidence_event_id,
        });
        if (!visitedEvents.has(p.from_event_id)) {
          visitedEvents.set(p.from_event_id, {
            id: p.from_event_id,
            record_ordinal: p.record_ordinal,
            observed_at: p.observed_at,
            kind: p.kind,
            subtype: p.subtype,
            status: p.status,
            summary: (p.input_preview || p.output_preview || "").slice(0, 300),
            epistemic_status: p.event_epistemic,
            evidence: refsForEvent(db, p.from_event_id),
            depth: current.depth + 1,
          });
          queue.push({ eventId: p.from_event_id, depth: current.depth + 1 });
        }
      }
    }

    const knownEmpiricalFactsAtMoment = db
      .all(
        `SELECT tf.id, tf.predicate, tf.fact_text, tf.epistemic_status, tf.validity_status,
                tf.valid_from_ordinal, tf.invalid_at_ordinal, tf.evidence_refs_json
         FROM temporal_fact tf
         JOIN event e ON e.id = tf.source_event_id
         WHERE e.session_id = $sessionId
           AND tf.valid_from_ordinal <= $ord
           AND (tf.invalid_at_ordinal IS NULL OR tf.invalid_at_ordinal > $ord)
           AND tf.epistemic_status IN ('DIRECT_EVIDENCE', 'CORROBORATED')
         ORDER BY tf.valid_from_ordinal DESC
         LIMIT 12`,
        { sessionId: seedEvent?.session_id ?? "", ord: ordinal },
      )
      .map((f) => ({
        ...f,
        evidence_refs: safeJson(f.evidence_refs_json, []),
      }));

    const inferredReasoningAtMoment = db
      .all(
        `SELECT id, record_ordinal, observed_at, input_preview, epistemic_status
         FROM event
         WHERE canonical = 1
           AND session_id = $sessionId
           AND kind = 'reasoning.summary'
           AND record_ordinal <= $ord
           AND record_ordinal >= $minOrd
         ORDER BY record_ordinal DESC
         LIMIT 6`,
        { sessionId: seedEvent?.session_id ?? "", ord: ordinal, minOrd: Math.max(0, ordinal - 12) },
      )
      .filter((r) => Boolean(r.input_preview))
      .map((r) => ({
        eventId: r.id,
        ordinal: r.record_ordinal,
        observedAt: r.observed_at,
        reasoning: r.input_preview.slice(0, 320),
        epistemicStatus: EPISTEMIC.INFERRED,
        evidence: refsForEvent(db, r.id),
      }));

    return {
      found: true,
      target: targetRecord,
      moment: {
        eventId: seedEventId,
        ordinal,
        observedAt: seedEvent?.observed_at ?? null,
      },
      causalChain: Array.from(visitedEvents.values()).sort((a, b) => a.record_ordinal - b.record_ordinal),
      causalEdges,
      knownEmpiricalFactsAtMoment,
      inferredReasoningAtMoment,
    };
  } finally {
    db.close();
  }
}

export function listEntities(caseDir, options = {}) {
  const db = new CaseDatabase(path.join(path.resolve(caseDir), "case.sqlite"), { readOnly: true });
  try {
    const kindFilter = options.kind ? String(options.kind).toUpperCase() : null;
    const sessionFilter = options.session || null;
    if (sessionFilter && String(sessionFilter).startsWith("UNRESOLVED_SESSION:")) {
      return [];
    }
    const cut = resolveBiTemporalCut(db, {
      asOf: options.asOf,
      validAt: options.validAt,
      knownAt: options.knownAt,
    });
    const limit = Math.min(Math.max(1, Number(options.limit || 50)), 500);
    const rows = db.all(
      `SELECT en.*
       FROM entity_node en
       WHERE ($kind IS NULL OR en.entity_kind = $kind)
         AND ($session IS NULL OR EXISTS (
           SELECT 1 FROM entity_mention em WHERE em.entity_id = en.id AND em.session_id = $session
         ))
       ORDER BY en.mention_count DESC, COALESCE(en.first_ordinal,0) ASC`,
      { kind: kindFilter, session: sessionFilter },
    );

    const filtered = rows
      .filter((row) => (cut.hasCut ? evaluateEntityAtBiTemporalCut(row, cut) : true))
      .slice(0, limit);

    return filtered.map((row) => ({
      ...row,
      attributes: safeJson(row.attributes_json, {}),
      recentMentions: db.all(
        `SELECT entity_id, event_id, session_id, record_ordinal, observed_at, role
         FROM entity_mention
         WHERE entity_id = $id
         ORDER BY record_ordinal DESC
         LIMIT 5`,
        { id: row.id },
      ),
    }));
  } finally {
    db.close();
  }
}

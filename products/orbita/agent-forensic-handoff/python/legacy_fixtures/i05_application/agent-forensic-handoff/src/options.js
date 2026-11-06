import path from "node:path";
import { CaseDatabase } from "./database.js";
import { EPISTEMIC } from "./constants.js";
import { safeJson, shortHash } from "./util.js";

export function composeContinuationOptions(db) {
  const vigenteFacts = db.all(
    "SELECT * FROM temporal_fact WHERE validity_status = 'VIGENTE' ORDER BY valid_from_ordinal DESC, id ASC",
  );
  const staleFacts = db.all(
    "SELECT * FROM temporal_fact WHERE validity_status != 'VIGENTE' ORDER BY valid_from_ordinal DESC, id ASC",
  );
  const decisions = db.all(
    "SELECT * FROM decision_record ORDER BY COALESCE(valid_from_ordinal, 0) DESC, id ASC",
  );

  const activeConstraints = vigenteFacts
    .filter((f) => f.predicate === "ENFORCES_CONSTRAINT")
    .map((f) => safeJson(f.value_json, {}).constraint || f.fact_text);

  const deadEnds = [
    ...staleFacts
      .filter((f) =>
        ["ROLLED_BACK", "INVALIDATED_BY_FAILURE", "CONTRADICTED", "SUPERSEDED"].includes(
          f.validity_status,
        ) &&
        ["DECISION_IN_FORCE", "ARTIFACT_STATE", "TOOL_FAILURE", "REPORTED_COMPLETION_CONTRADICTED"].includes(
          f.predicate,
        ),
      )
      .slice(0, 6)
      .map((f) => ({
        id: f.id,
        eventId: f.source_event_id,
        status: f.validity_status,
        summary: `${f.validity_status}: ${f.fact_text}`,
        refs: safeJson(f.evidence_refs_json, []),
      })),
    ...decisions
      .filter((d) => d.validity_status !== "VIGENTE")
      .slice(0, 4)
      .map((d) => ({
        id: d.id,
        eventId: d.source_event_id,
        status: d.validity_status,
        summary: `Decision (${d.validity_status}): ${d.decision_text}`,
        refs: safeJson(d.evidence_refs_json, []),
      })),
  ];

  const options = [];

  function registerOption({
    strategy,
    title,
    description,
    rationale,
    preconditions = [],
    supportingFacts = [],
    supportingEventIds = [],
    evidenceRefs = [],
    epistemic = EPISTEMIC.INFERRED,
    recommended = true,
  }) {
    const rank = options.length + 1;
    const id = `opt-${shortHash([rank, strategy, title])}`;
    const eventIds = Array.from(
      new Set([...supportingEventIds, ...supportingFacts.map((f) => f.source_event_id)].filter(Boolean)),
    );
    const refs = Array.from(
      new Set([
        ...evidenceRefs,
        ...supportingFacts.flatMap((f) => safeJson(f.evidence_refs_json, [])),
      ].filter(Boolean)),
    );
    const option = {
      id,
      rank,
      strategy,
      title: String(title).slice(0, 220),
      description: String(description).slice(0, 450),
      rationale: String(rationale).slice(0, 500),
      preconditions,
      activeConstraints,
      avoidedDeadEnds: deadEnds.map((d) => d.summary),
      supportingEventIds: eventIds,
      evidenceRefs: refs,
      epistemic,
      recommended,
    };
    db.insertContinuationOption(option);

    for (const fact of supportingFacts) {
      db.insertEntityEdge({
        from: id,
        to: fact.id,
        fromKind: "OPTION",
        toKind: "FACT",
        type: "SUPPORTED_BY_FACT",
        grade: "DETERMINISTIC_RULE",
        rule: "continuation-option-grounding",
        epistemic,
        evidenceEventId: fact.source_event_id,
        metadata: { strategy, rank },
      });
    }
    options.push(option);
  }

  const activeFailures = vigenteFacts.filter(
    (f) =>
      f.predicate === "TOOL_FAILURE" ||
      (f.predicate === "VALIDATION_STATE" && safeJson(f.value_json, {}).status === "OBSERVED_FAIL"),
  );
  const activeArtifacts = vigenteFacts.filter((f) => f.predicate === "ARTIFACT_STATE");

  if (activeFailures.length > 0) {
    const primaryFail = activeFailures[0];
    const touchedPaths = activeArtifacts
      .slice(0, 3)
      .map((f) => safeJson(f.value_json, {}).logicalPath)
      .filter(Boolean);
    registerOption({
      strategy: "RESOLVE_ACTIVE_FAILURE",
      title: `Diagnose and remediate active failure: ${primaryFail.fact_text.slice(0, 120)}`,
      description: touchedPaths.length
        ? `Inspect cold evidence for the failure, remediate affected artifact(s) (${touchedPaths.join(", ")}), and re-run verification.`
        : `Inspect cold evidence for "${primaryFail.fact_text.slice(0, 120)}" to isolate the root cause and re-run verification.`,
      rationale: `The session has ${activeFailures.length} unresolved VIGENTE failure(s). Proceeding with feature additions before resolving empirical failures risks compounding broken state.`,
      preconditions: [
        "Inspect exact failure output via `afh evidence` before editing.",
        ...activeConstraints.map((c) => `Respect active constraint: ${c}`),
      ],
      supportingFacts: activeFailures.slice(0, 4),
      epistemic: EPISTEMIC.DIRECT,
      recommended: true,
    });
  }

  const staleValidations = staleFacts.filter(
    (f) => f.predicate === "VALIDATION_STATE" && f.validity_status === "STALE",
  );
  const contradictedClaims = staleFacts.filter((f) => f.validity_status === "CONTRADICTED");

  if (staleValidations.length > 0 || contradictedClaims.length > 0) {
    const sample = staleValidations[0] || contradictedClaims[0];
    const cmd = safeJson(sample.value_json, {}).command || sample.fact_text;
    registerOption({
      strategy: "REVERIFY_STALE_OR_CONTRADICTED",
      title: staleValidations.length
        ? `Re-run stale validation after subsequent artifact modifications (${String(cmd).slice(0, 90)})`
        : `Verify actual state to resolve contradicted completion report`,
      description: staleValidations.length
        ? `Re-execute validation command (${cmd}) against the latest artifact revisions to upgrade state from STALE to CORROBORATED.`
        : `Run independent verification to resolve the discrepancy between reported completion and observed tool failure.`,
      rationale: staleValidations.length
        ? `Validation "${sample.fact_text}" was marked STALE because artifacts were modified at a later ordinal (${sample.invalid_at_ordinal}).`
        : `Prior agent reported completion while an underlying tool execution remained failed/incomplete.`,
      preconditions: ["Verify current workspace tree matches latest VIGENTE artifact revisions."],
      supportingFacts: [...staleValidations.slice(0, 3), ...contradictedClaims.slice(0, 3)],
      epistemic: EPISTEMIC.CORROBORATED,
      recommended: activeFailures.length === 0,
    });
  }

  const activeMission = vigenteFacts.find((f) => f.predicate === "HAS_MISSION");
  const activePlan = vigenteFacts.find((f) => f.predicate === "ACTIVE_PLAN");
  const activeReview = vigenteFacts.find((f) => f.predicate === "REVIEW_FINDING");
  const activeDecisions = decisions.filter((d) => d.validity_status === "VIGENTE");

  if (activePlan || activeReview || activeMission) {
    const supporting = [activeMission, activePlan, activeReview].filter(Boolean);
    const decisionNote = activeDecisions.length
      ? `aligned with active decision "${activeDecisions[0].decision_text}"`
      : "aligned with the latest user directive";
    registerOption({
      strategy: "PRIMARY_CONTINUATION",
      title: activeReview
        ? `Address code review finding: ${activeReview.fact_text.slice(0, 110)}`
        : activePlan
          ? `Continue active plan: ${activePlan.fact_text.slice(0, 110)}`
          : `Advance active mission: ${activeMission.fact_text.slice(0, 110)}`,
      description: activePlan
        ? `Execute remaining steps in the active plan (${activePlan.fact_text.slice(0, 200)}) while honoring ${activeConstraints.length} active constraint(s).`
        : activeReview
          ? `Apply fixes for review finding (${activeReview.fact_text.slice(0, 200)}) and verify.`
          : `Continue implementation of "${activeMission.fact_text.slice(0, 200)}" across tracked artifacts.`,
      rationale: `Derived from VIGENTE session state (${decisionNote}) and ${activeArtifacts.length} active artifact state(s).`,
      preconditions: [
        ...activeDecisions.slice(0, 3).map((d) => `Maintain decision in force: ${d.decision_text}`),
        ...activeConstraints.slice(0, 4).map((c) => `Enforce constraint: ${c}`),
      ],
      supportingFacts: supporting,
      supportingEventIds: activeDecisions.map((d) => d.source_event_id),
      evidenceRefs: activeDecisions.flatMap((d) => safeJson(d.evidence_refs_json, [])),
      epistemic: EPISTEMIC.DIRECT,
      recommended: activeFailures.length === 0 && staleValidations.length === 0,
    });
  }

  if (deadEnds.length > 0) {
    registerOption({
      strategy: "GUARDRAIL_AVOID_DEAD_ENDS",
      title: `Guardrail: Do not repeat ${deadEnds.length} invalidated/rolled-back path(s)`,
      description: `Explicitly exclude rolled-back turns, superseded decisions, and contradicted claims from continuation work.`,
      rationale: `Historical trajectory contains ${deadEnds.length} invalidated state(s): ${deadEnds
        .map((d) => d.summary)
        .join(" | ")
        .slice(0, 320)}`,
      preconditions: ["Run `afh why <id>` before revisiting any superseded decision or rolled-back turn."],
      supportingFacts: [],
      supportingEventIds: deadEnds.map((d) => d.eventId).filter(Boolean),
      evidenceRefs: deadEnds.flatMap((d) => d.refs),
      epistemic: EPISTEMIC.CORROBORATED,
      recommended: false,
    });
  }

  return options;
}

export function getContinuationOptions(caseDir) {
  const db = new CaseDatabase(path.join(path.resolve(caseDir), "case.sqlite"), { readOnly: true });
  try {
    return db.all("SELECT * FROM continuation_option ORDER BY rank ASC").map((row) => ({
      ...row,
      recommended: Boolean(row.recommended),
      preconditions: safeJson(row.preconditions_json, []),
      activeConstraints: safeJson(row.active_constraints_json, []),
      avoidedDeadEnds: safeJson(row.avoided_dead_ends_json, []),
      supportingEventIds: safeJson(row.supporting_event_ids_json, []),
      evidenceRefs: safeJson(row.evidence_refs_json, []),
    }));
  } finally {
    db.close();
  }
}

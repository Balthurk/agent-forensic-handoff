# Skill Improvement Log

## Entries

### 2026-09-04 — agent-forensic-handoff v0.2.0

- Trigger: the skill's v0.1 output preserved the raw conversation but failed to project modern Codex record families, a standalone delegated task, file-change artifacts, historical validations, and the latest substantive mission.
- Change: require whole-case integrity verification before consequential reliance; expose causal-coverage warnings; select the latest substantive user mission; retrieve progressively from hot, warm, then exact cold evidence; retain the no-historical-execution boundary.
- Implementation influence: the skill contract drove the new modern fixture, causal child acquisition, `verify-case`, source-pointer storage, mission filtering, and documentation of historical-vs-current validation.
- Evidence: `docs/evaluation-v0.2.0.md`, `benchmarks/release-v0.2.0.json`, and the passing release gates recorded in `docs/ops/OPERATION_TRACE.md`.

### 2026-09-04 — agent-forensic-handoff v0.3.0

- Task context: recover concepts, causal paths, and safe negative conclusions from very large agent cases without loading the transcript into a prompt or weakening cold-evidence authority.
- What worked: v0.2 source accounting, exact evidence URIs, bounded child closure, redacted previews, integrity checks, and lexical compatibility provided a stable authority layer.
- What was missing: paraphrase/cross-language retrieval, cross-entity provenance paths, explicit retrieval receipts/coverage states, projection/model integrity, and production-scale embedding performance evidence.
- Concrete improvement: add optional offline multilingual semantic sidecars, schema-v3 evidence-bearing graph edges, deterministic hybrid RRF, structured filters, four safe assessment states, memory-bounded copy-on-write builds, and quick/deep projection verification.
- Priority: `P0`; status: `IMPLEMENTED_AND_RELEASE_GATED`.
- Evidence: `docs/improvement-plan-v0.3.0.md`, `docs/evaluation-v0.3.0.md`, `docs/vector-runtime-decision-v0.3.0.md`, `benchmarks/release-v0.3.0.json`, and TRACE-011 through TRACE-014.

### 2026-09-04 — skill-evolution-loop

- Task context: the skill under evaluation was also the principal workflow shaping the implementation and needed an explicit feedback loop.
- What worked: requiring a named task context, observed strengths, missing behavior, concrete change, priority, and status prevented the skill update from becoming an undocumented prompt-only change.
- What was missing: the generic loop does not define performance or evidence-quality gates for a forensic retrieval skill.
- Concrete improvement: when evolving forensic/audit skills, require factual, negative-state, integrity, scale, privacy, compatibility, and rollback evidence in addition to the normal six fields.
- Priority: `P1`; status: `ADOPTED_AS_PROJECT_BEST_PRACTICE`.

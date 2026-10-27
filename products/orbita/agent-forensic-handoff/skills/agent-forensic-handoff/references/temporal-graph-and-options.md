# Bi-temporal knowledge graph, causal DAG, and continuation option synthesis

## 1. Three-tier knowledge graph architecture

Adapted from Zep's Graphiti architecture (`arXiv:2501.13956`), `U2` bi-temporal governance (`valid_at` / `known_at`), and multi-parent causal tracing (`CauseTrace`):

1. **Episodic Subgraph (`event`, `event_edge`, `session_edge`):**
   - Preserves every canonical rollout record with exact `record_ordinal`, `subordinal`, `turn_id`, `observed_at`, and byte-exact `afh://evidence/sha256/...` pointers.
   - Identical messages across distinct turns, sessions, or native identifiers are preserved as separate canonical events (`canonical = 1`); only dual-channel representations of the same turn/message are deduplicated.
   - Tool executions (`tool_execution`) are strictly scoped by `(session_id, call_id)` so identical `call_id` values across different sessions never merge.
   - Multi-parent Causal DAG edges connect events within each session:
     - `CAUSED_BY_USER`: Fan-out from substantive `message.user` directives to reasoning, tool invocations, patches, and plan updates in the same turn.
     - `MOTIVATED_BY_REASONING`: Fan-out from visible model reasoning (`reasoning.summary`) to subsequent tool calls, file patches, and plan updates.
     - `CONSUMED_OBSERVATION`: Fan-in from completed/observed tool outputs (`tool.completed`, `tool.observed`, `mcp.completed`) into subsequent reasoning blocks or follow-up actions.
     - `TRIGGERED_RECOVERY`: Connects a failed tool/validation observation to the remediation patch or plan update that followed it.
     - `RESULT_OF`: Explicit correlation (`call_id`) between `tool.requested` and `tool.completed`.
     - `ROLLED_BACK_BY` and `ABORTED_BY`: Explicit invalidation edges emitted when `thread_rolled_back` (`num_turns`) or `turn_aborted` occurs in a Codex rollout.

2. **Semantic Entity Subgraph (`entity_node`, `entity_mention`, `entity_fts`):**
   - Canonicalizes entities across the session into seven kinds: `ARTIFACT`, `COMMAND`, `USER_INTENT`, `CONSTRAINT`, `DESIGN_CONCEPT`, `SYMBOL`, and `ERROR_SYMPTOM`.

3. **Bi-Temporal Fact Ledger (`temporal_fact`, `fact_fts`):**
   - Every state assertion carries two independent temporal axes:
     - **Validity axis (`valid_at`, `invalid_at`, `valid_from_ordinal`, `invalid_at_ordinal`):** When the fact was valid in the workspace/domain.
     - **Knowledge / Transaction axis (`created_at` / `known_at`, `expired_at`):** When the fact or its superseding correction was recorded in the evidence stream.
   - Distinguishes `VIGENTE` facts from `SUPERSEDED`, `STALE`, `ROLLED_BACK`, `INVALIDATED_BY_FAILURE`, and `CONTRADICTED` facts.
   - Rejects manual authority (`MANUAL_AUTHORITY_REJECTED`): no temporal fact or claim can assert manual/trusted authority or omit a registered, hash-verified `afh://evidence/sha256/...` reference.

## 2. Point-in-time epistemic reconstruction (`--as-of`, `--valid-at`, `--known-at`, and `afh why`)

- **Pre-limit filtering:** Session (`--session`) and temporal bounds (`--as-of`, `--valid-at`, `--known-at`, `--from`, `--to`) are pushed into SQL `WHERE` before `ORDER BY` and before applying `--limit`, guaranteeing that historical facts are never truncated by newer records and non-existent sessions return zero facts.
- **2D bi-temporal queries:** `afh state` and `afh query` evaluate facts against both `--valid-at` and `--known-at` independently (or jointly via `--as-of`).
- **Causal provenance (`afh why <id>`):** Reconstructs `knownEmpiricalFactsAtMoment`, `inferredReasoningAtMoment`, and the upstream multi-parent `causalChain` at the exact ordinal of the target decision, fact, entity, or event.

## 3. Retrieval rerankers

`afh query` supports four deterministic reranking strategies (`--rerank`): `rrf` (default), `mmr`, `mentions`, and `node-distance`.

## 4. Continuation option synthesis (`afh options`)

`composeContinuationOptions` synthesizes ranked options in `continuation_option` (`views/continuation-options.md`): `RESOLVE_ACTIVE_FAILURE`, `REVERIFY_STALE_OR_CONTRADICTED`, `PRIMARY_CONTINUATION`, and `GUARDRAIL_AVOID_DEAD_ENDS`.

## Session vs. Shared Entity Supersession Scope

- **Default Session Scope (`entityScope: "SESSION"`)**: Facts extracted from or appended to a session (`SESSION`, `USER_INTENT`, `CONSTRAINT`, `DESIGN_CONCEPT`, `CONFIGURATION`, `VALIDATION`, `DECISION`, `CLAIM`) are scoped to their originating `session_id`. A new assertion with the same `(subject_id, predicate)` in Session B will **not** supersede a `VIGENTE` fact in Session A.
- **Explicit Shared Scope (`entityScope: "SHARED"`)**: Cross-session supersession occurs only when the subject represents a shared workspace resource (`subjectKind` in `ARTIFACT`, `WORKSPACE`, `SHARED_ENTITY`, `REPOSITORY`) **and** the assertion explicitly declares `scope: "shared"` (or `sharedEntity: true`).
- **Revision Preservation on Same Fact ID**: Calling `appendGovernedTemporalFact` multiple times with the same `id` and different values never overwrites prior rows in `temporal_fact`; the prior row is marked `SUPERSEDED` and retained in the ledger while the new revision receives a versioned physical ID (`<id>#v2`) linked via `logicalId` and `superseded_by_fact_id`.

## Temporal Integrity & Provenance Enforcement (`verify-case`)

1. **`temporal.identity`**: `case.json` seals a deterministic SHA-256 (`temporalIdentity`) over `temporal_fact`, `entity_node`, and `decision_record`. Any out-of-band SQLite edit to fact text, dates, values, or validity statuses fails `afh verify-case`.
2. **`temporal.fact_integrity`**: Every `ASSERTS_FACT` edge in `entity_edge` stores `factSha256`, and every `INVALIDATES_FACT` edge stores `invalidationSha256`.
3. **`temporal.fact_provenance`**: Governed facts must reference an existing `sourceEventId`, cite only `evidence_ref` URIs belonging to that exact event, never self-assign `CORROBORATED` or manual authority, and never place `knownAt` (`created_at`) before the cited event's `observed_at` timestamp.

## Context

event.observed_at y claim.current no describen correcciones bitemporales; una orden posterior igual elimina contradicciones sin binding al objetivo, y el grafo legado mezcla orientación de supersession.

Purpose and global integration: Versionar vigencia y conocimiento de afirmaciones, relaciones y artefactos para reconstruir qué ocurrió, qué se sabía en cada corte y qué causalidad está demostrada.

## Goals / Non-Goals

Benefit: Evita usar estado futuro en consultas históricas y permite investigar intentos, patches, revisiones descartadas y validaciones con la cadena exacta de evidencia.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: writer, reader; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Seleccionar última revisión conocida por assertion_id+branch_id, nunca por sujeto; evaluar después vigencia de TODOS los tramos. Corregir pares de frontera como batch único con expected_revision_id. Query SQL usa recorded_seq<=published_seq y recorded_at<=known_at con comparación temporal normalizada que conserva precision. Relaciones llevan extremos tipados, grade/regla/version/evidence y dirección v4 uniforme. Crear SUPPORTS/VALIDATES solo con target revision/hash explícito; misma orden/adyacencia no prueba reparación. Ingerir patches unificados y apply_patch add/update/delete/move como evidencia descriptiva; Git parent/tree/blob solo de objetos o resultados persistidos con object_format/OID comprobados, sin ejecutar el histórico.

Interfaces: graph.neighbors, graph.path, event.show, query temporal, stats effects. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

Una afirmación temporal es un tramo independiente, y la revisión correctiva modifica lo conocido sobre ese tramo. Sin esa distinción el algoritmo latest-row elimina pasado legítimo. El vínculo de validación debe referirse a contenido/objetivo, no a una coincidencia de comando.

Rechazados: usar fecha de evento como known_at; última fila por sesión; MAX timestamp como autoridad; revocar por posterioridad; reconstruir contenido de patch incompleto como si fuese exacto.

### Persistence, concurrency and idempotence

Temporal revisions y relation revisions append-only con commit_seq común. Proyecciones de intervalo son derivadas; current legacy solo vista. Direcciones RESULT_OF=result→call y SUPERSEDES=new→old; conversión legacy documentada en receipt. Índices por assertion/branch/recorded_seq y extremos/time/scope.

### Integration and dependencies

Selector único suministra 05/06/07/09. Grafo Plata cubre entidades no promovidas; Oro selecciona vistas sin alterar edges originales. Utilidad agrega execution→artifact revision→validation→task criterion. Core temporal assertions use temporal.select directly at04; public query/context consumers are only accepted when available per acceptance_policy. The interfaces list describes integration surfaces, not permission to implement a future consumer early. AFH-M04-INTEGRATION-SCOPE-01: integrate the existing engine dispatch, ledger consumers, writer storage/exact verification, association revisions and occurrence facts only as required by04. Reuse canonical03 identity recipes and native read-only/publication controls. wire-validation.cjs and wire-build.json may change only as generated outputs when an authorized04 schema change requires them; do not edit generated wire code manually. This alignment does not authorize consumers owned by05/07 or a new framework. AFH-M04-INTEGRATION-SCOPE-02: coordinator explicitly authorizes reader-observation.js only for the graph.neighbors consumer and its native request/response binding. Preserve old operation checks, handle/SQL/row/DURING guarantees, unsupported-operation rejection, and existing SHM/WAL controls. Calibrate with an actual native graph-table reader, not relabeled event.show evidence. No new framework or relaxation of active-writer inventory. AFH-M04-INTEGRATION-SCOPE-03: explicit coordinator authorization for acceptance-only Windows local SHM observation at the first paused native association_row_insert. Existing afh-04 harness and reader-observation control surfaces may admit an INTERNAL_FUNCTION_CALL ledger.association_pair only with actual SQL/rows/published cut, bound writer PID/job/worker/progress and complete inventory. A separately identified private acceptance helper may use readonly mapped SHM with exact executable/helper hashes and exact arguments/root in process controls; no arbitrary Python, global dependency, runtime mapping service or remote/coherence guarantee. Full and auxiliary inventory phases share the provider and record explicit phase/native-call/boundary/attestation IDs. Preserve existing ledger/WAL ordinary reads, SHM/WAL0 exception guards, nonempty WAL protection and fail-closed identity/length/read/handle/write checks. Two positives and26 negatives plus justified affected regressions precede independent integrated review; no control or product acceptance follows merely from feasibility. AFH-03-T11 scoped runtime integration: stats uses the opened publication and known_at to select persisted occurrence revisions, canonical identity bindings and representation classes at the same knowledge cut. It reuses temporal.select for validity; from/to is a half-open validity-overlap window, optionally intersected with valid_at. Unknown validity is included only with include_uncertain and disclosed in receipt warnings and unknown counts. mentions counts distinct message occurrences (all message roles), never text tokens, execution records or repeated representations. Scope session IDs intersect temporally selected explicit project associations; no unrecorded membership is inferred. group_id, project/day grouping, latency and effects retain honest NOT_IMPLEMENTED until their owning integration. SQL aggregation retains group-local representation totals. No writer migration or timestamp inference from message text is introduced. AFH04 graph.neighbors runtime integration: persist IN_SESSION for canonical event records and SPAWNED for explicitly acquired native parent/child identities in existing relation_version; deduplicate full establishing RAW references per typed relation, never substitute session metadata for a spawn record. Occurrence source derivation accepts an explicit graph version. New occurrence publications declare ledger_changes.occurrence_graph_version=1; absent means historical03 relation derivation and any other value fails closed. Deep verification/recovery reproduce the declared recipe, while upgrade appends graph facts at the new commit without rewriting old manifests, identities or occurrence counts. Graph reads real versioned relations/events/sessions under one publication/known_at cut and shared temporal selection before bounded traversal. Session node provenance comes from the selected acquired session manifest and its metadata record. Missing endpoints are not invented. BFS follows requested direction/types/hops, visits each node once, returns connected paths and typed endpoints; reaching max_nodes is conservatively truncated without a completeness claim. graph.path remains NOT_IMPLEMENTED in this component until separately integrated with its native read control. No public schema fields or global dependency are added. Graph.neighbors on a pre-extension knowledge/publication cut returns NOT_IMPLEMENTED with PRE_GRAPH_EXTENSION; a later graph upgrade never changes that old availability. Once version1 is published, later occurrence publications cannot downgrade the graph recipe. Provenance04 runtime uses the existing pure capture/selection boundary: caller authenticates RAW bytes before supplying decoded records; the component validates bounded plain JSON and exact acquired-reference/occurrence/session/native-call bindings, not an invented serialization hash of decoded JSON. Maximum100000 records/occurrences and8MiB canonical capture, depth32. Selected records and occurrences obey publication/known_at and temporal uncertainty. Descriptive apply_patch/unified-diff headers must match the artifact operation/path; complete captured postimages are hashed, partial patches never invent full bytes. Predecessors require the same artifact and independently comparable source lineage/order or explicit binding. Passing criterion verification requires exact target revision and content hash matching a captured artifact; unresolved conflicting reported outcomes of the same explicit criterion retain CONTRADICTS without supersession. Human DISCARD retains the prior bytes and binds its recorded event. Git native header/type/length/format-specific hash and parsed parents are checked before typed same-repository/same-format COMMIT_PARENT. Missing-object reports remain uncertain. No filesystem, subprocess, network/model calls or scenario/fixture lookup inside deriveProvenance. A captured headerless hunk fragment with no complete postimage remains an UNKNOWN artifact assertion bound to its real call/result; it cannot prove operation/path execution or invent content bytes. Complete headers that contradict reported operation/path reject. Producer identity must match its occurrence temporal subject and session, failed producers cannot verify an artifact, and duplicate/conflicting captured-reference identities reject before derivation.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger. One writer executes the full ordered program.

## Migration Plan

Casos schema1-3 siguen leídos según semántica histórica y aliases; nueva proyección v4 declara conversiones y límites. No mutar source/git objects ni reescribir revisiones rechazadas.

Crash durante batch temporal debe exponer a1/b1 o a2/b2, nunca frontera mixta. Clock regression bloquea nueva publicación; no retrodatar conocimiento. Readers paralelos mantienen su corte durante publicación.

Expected write set: src/archive/temporal.js, src/archive/provenance.js, src/graph.js, src/reducers.js, schemas/, test/acceptance/afh-04.test.mjs, test/acceptance/afh-01.test.mjs, test/acceptance/afh-03.test.mjs, src/archive/engine.js, src/archive/ledger.js, src/archive/storage.js, src/archive/verify.js, src/archive/associations.js, src/archive/occurrences.js, src/archive/wire-validation.cjs, src/archive/wire-build.json, src/archive/reader-observation.js.

## Risks / Trade-offs

Times unknown/open o relojes no comparables producen incertidumbre. Edge inferida puede ser útil para descubrimiento pero no corroboración independiente. Un patch sin preimage no acredita bytes finales.

## Entry and exit

Entry:
- Complete 14-change package reviewed with no material gaps.
- Scope authorization active; one writer; applicable snapshot review and schema/OpenSpec validation.
- Every earlier acceptance milestone is MILESTONE_GREEN with its exact due obligations; future owner integrations remain DEFERRED_NOT_RUN.01 has no predecessor.
- Concrete test harness and immutable fixture/oracle available; absent API labeled NOT_IMPLEMENTED.

Exit:
- All CHANGE_EXIT obligations due at this milestone (including incoming integrations) pass their complete oracles and evidence classes. Later owner scenarios remain explicitly DEFERRED_NOT_RUN, mandatory at their assigned milestone. No diagnostic GREEN substitutes for acceptance.
- Legacy baseline remains green; source/case inventories unchanged; new API responses meet schema and relational invariants.
- Evidence resolves to actual candidate/inputs; semantic review satisfactory and work trace appended.

## TDD contracts

25 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

## Acceptance milestone 4

Due full acceptance: AFH-01-T10, AFH-01-T11, AFH-01-T12, AFH-01-T14, AFH-03-T11, AFH-03-T16, AFH-04-T01, AFH-04-T02, AFH-04-T03, AFH-04-T04, AFH-04-T05, AFH-04-T06, AFH-04-T07, AFH-04-T08, AFH-04-T09, AFH-04-T10, AFH-04-T11, AFH-04-T12, AFH-04-T13, AFH-04-T14, AFH-04-T15, AFH-04-T16, AFH-04-T18, AFH-04-T19, AFH-04-T20, AFH-04-T21, AFH-04-T22, AFH-04-T23, AFH-04-T24, AFH-04-T25.

Owned obligations deferred (not GREEN): AFH-04-T17 -> 7 CHANGE_EXIT.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

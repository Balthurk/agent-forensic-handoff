## Context

Audit no emite callback por fase y semantic-index oculta progreso con --json; Reader tuvo preparación costosa sin subfases observables.

Purpose and global integration: Medir y exponer el coste real por fases de captura, indexación y recuperación con progreso JSON y ETA honestos, presupuestos reproducibles y cobertura de recursos.

## Goals / Non-Goals

Benefit: Permite decidir mejoras por coste medido, detectar procesos incompletos y estimar fase sin inventar porcentajes o extrapolaciones del corpus.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: core; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Instrumentar reloj monotónico process.hrtime.bigint por fase y elapsed total; preservar timestamp wall por separado. Eventos START/PROGRESS/END con secuencia y contadores; stdout un único JSON final, stderr NDJSON solo al pedir progress-json. callback API usa mismo objeto. ETA con total conocido, cinco muestras positivas y cinco segundos, EWMA0.25; invalidar al cambiar total/fase/reiniciar o rate0. Supervisor de benchmarks muestrea RSS de procesos hijos propios cada100ms y captura CPU/OS/Node/config/dataset. Comparaciones separan process-new, model-load, resident, DB-only y cache OS UNKNOWN.

Interfaces: onProgress, --progress-json, archive.ingest, semantic.build, query, benchmark. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

Medir fases reduce decisiones basadas en suposiciones y hace visible que verificación de prefijo puede seguir leyendo todo aunque reuso compute sea incremental.

Rechazados: porcentaje por tamaño de archivo sin accounting; ETA de fase como promesa total; llamar cold a primer proceso sin control de caché OS; ocultar progreso para mantener stdout JSON.

### Persistence, concurrency and idempotence

Progreso a stream y receipt final; opcional log privado append-only asociado al job, nunca transcripts/comandos/args. Baselines/metric samples inmutables por corrida con sha/entorno. Counters se reconstruyen del checkpoint, no se reinician fingiendo mismo proceso.

### Integration and dependencies

Fases cubren módulos01-07 y alimentan experimentos09/13/14. Progreso no modifica conocimiento/autoridad ni prueba terminación del objetivo por sí mismo.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval. One writer executes the full ordered program.

## Migration Plan

--json de legacy mantiene stdout parseable; --progress-json aditivo y stderr separado. Ausencia de listener no añade dependencia residente. Métricas históricas siguen citadas como previas y subfases UNAVAILABLE.

Interrupción emite CANCELLED si proceso puede finalizar; kill sin flush queda observado externamente como INTERRUPTED. Resume abre nueva attempt sequence y enlaza checkpoint; no continúa clock monotónico de un proceso muerto.

Expected write set: src/cli.js, src/archive/progress.js, src/audit.js, src/semantic.js, src/retrieval.js, benchmarks/, test/acceptance/afh-08.test.mjs.

## Risks / Trade-offs

Runtime nativo puede bloquear event loop; heartbeat supervisor indica elapsed sin incrementar completed. RSS muestreado no es pico exacto y reporta periodo/cota. Comparación inválida conserva gate pendiente.

## Entry and exit

Entry:
- Complete 14-change package reviewed with no material gaps.
- Scope authorization active; one writer; applicable snapshot review and schema/OpenSpec validation.
- Every earlier sequential change GREEN on applicable candidate; 01 has no predecessor GREEN requirement.
- Concrete test harness and immutable fixture/oracle available; absent API labeled NOT_IMPLEMENTED.

Exit:
- All listed scenarios and inherited checks pass with correct evidence class; no skip/unavailable/mechanical substituted.
- Legacy baseline remains green; source/case inventories unchanged; new API responses meet schema and relational invariants.
- Evidence resolves to actual candidate/inputs; semantic review satisfactory and work trace appended.

## TDD contracts

18 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

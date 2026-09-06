## Context

processTool fusiona por comando y toolId solo por callId; validationStatus infiere PASS y loopGroups usa MAX(status). Los probes verificaron los fallos en runtime 0.3.0.

Purpose and global integration: Reconstruir una bitácora íntegra de actos observables y sus representaciones, con recuentos exactos, resultados desconocidos honestos y payloads compartibles sin perder ejecuciones reales.

## Goals / Non-Goals

Benefit: Permite saber cuántos intentos hubo, qué salió de cada uno y qué sigue incompleto, evitando repetir soluciones descartadas o atribuir éxitos ajenos.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: writer; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Correlacionar por session+origin+harness+native call/item+epoch/turn; terminal y siguiente inicio explícito abren ciclo nuevo si se reutiliza ID. Usar tabla representation con raw refs; pares técnicos se unen solo por vínculo nativo/regla versionada exacta. Fallback conserva actos inciertos separados. Una ejecución agrupa request/start/fragments/terminal; conserva input JSON/raw, cwd, actor, output refs, stdout/stderr y duration provenance. El fingerprint de comando se usa solo para GROUP BY. Terminal de grupo usa último acto por orden comparable dentro del ámbito y conserva empate/unknown. validationStatus exige éxito explícito y retiene UNKNOWN si falta evidencia; no perder la fila.

Interfaces: auditSession, archive.ingest, event.show, stats. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

La identidad de acto evita que almacenamiento compacto cambie el significado del historial. La ausencia de error es compatible con un resultado no persistido y no demuestra PASS.

Rechazados: emparejar con último comando igual; dedup por ventana de 20 records y texto; callId global; MAX(status); eliminar validaciones desconocidas para evitar falso PASS.

### Persistence, concurrency and idempotence

Una ocurrencia por acto y revisiones por nuevos fragmentos/terminales; solicitud/resultados son eventos distintos con RESULT_OF result→call. Contenido idéntico comparte CAS; stdout y stderr solo se combinan para una vista, conservando los roles originales. Índices SQL por scope/time/status y occurrence_id.

### Integration and dependencies

Depende de identidad y captura; provee recuentos SQL a 07, tiempo de ejecución a 04, errores útiles a 05/13 y fases a 08. Adapters no invocan modelo ni convierten instrucciones en autoridad.

Dependencies: afh-01-native-identity, afh-02-incremental-archive. One writer executes the full ordered program.

## Migration Plan

Corregir nuevas capturas audit para que los probes se vuelvan GREEN; campos/status aditivos sin reescribir casos viejos. Pairs legacy pasan a alias de representación en import-case. Mantener UNKNOWN en validaciones nuevas y limitar cambio de reporte a esos hechos.

Cada delta compromete ocurrencia+eventos+refs en la misma transacción. Resultado tardío añade revisión; readers de snapshot anterior siguen viendo INCOMPLETE. Repetir entrega técnica no duplica acto. Recovery posterior a terminal no mezcla con siguiente reutilización del ID.

Expected write set: src/adapters.js, src/audit.js, src/reducers.js, src/database.js, src/archive/ledger.js, src/archive/occurrences.js, test/acceptance/afh-03.test.mjs, test/acceptance/afh-02.test.mjs, src/archive/engine.js, src/archive/storage.js, src/archive/verify.js, src/archive/reader-observation.js.

## Risks / Trade-offs

Harnesses sin IDs o con IDs reutilizados ambiguamente requieren AMBIGUOUS_CORRELATION y grupos no resueltos. Duración de reloj distinto o missing output queda unknown; no convertir precisión aparente en medida.

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

22 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

## Acceptance milestone 3

Due full acceptance: AFH-02-T04, AFH-02-T07, AFH-03-T01, AFH-03-T02, AFH-03-T03, AFH-03-T04, AFH-03-T05, AFH-03-T06, AFH-03-T07, AFH-03-T08, AFH-03-T09, AFH-03-T10, AFH-03-T12, AFH-03-T13, AFH-03-T14, AFH-03-T15, AFH-03-T17, AFH-03-T18, AFH-03-T19, AFH-03-T21, AFH-03-T22.

Owned obligations deferred (not GREEN): AFH-03-T11 -> 4 CHANGE_EXIT, AFH-03-T16 -> 4 CHANGE_EXIT, AFH-03-T20 -> 6 CHANGE_EXIT.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

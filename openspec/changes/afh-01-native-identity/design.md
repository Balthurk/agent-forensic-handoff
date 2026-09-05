## Context

El adaptador Codex prioriza session_id compartido sobre payload.id; session.cwd es un campo actual único. El probe AFH-01-T01 confirma atribución errónea aun con integridad profunda verde.

Purpose and global integration: Conservar la identidad nativa de cada hilo y su historial de proyecto/workspace/checkout para que agentes y consultas no atribuyan trabajo de un hijo a su padre ni reasignen su pasado.

## Goals / Non-Goals

Benefit: Establece claves correctas para incremental, ocurrencias, grafo, contexto y partición por ámbito; evita duplicar conversaciones al cambiar de ubicación.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: writer; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Codex session_meta.payload.id es ID nativo; session_id diferente se guarda como grouping_native_id y parent_thread_id como enlace explícito. Cualificar por harness/origin_domain; aliases legacy ses:codex:ID solo cuando son unívocos. source_lineage persiste independiente de ruta/hash de snapshot. Añadir entidades project/workspace/checkout y association_id por tramo. association.record identifica expected_revision_id de cada tramo y publica corrections en un único batch. El selector conocido-vigente conserva todos los tramos; nunca particiona por session_id para elegir uno antes de valid_at. Resolver contexto activo solo desde observaciones verificables; conflicto devuelve candidatos y no elige.

Interfaces: auditSession, archiveRequest association.record, archiveRequest scope.resolve. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

Los productores ya exponen identidad nativa. Separar la agrupación conserva relaciones sin falsear autoría; los tramos independientes permiten movilidad e historial. La identidad de proyecto explícita evita asumir que remote Git o ruta es el único propietario lógico.

Rechazados: usar hash de transcript como sesión estable; reemplazar cwd y atribuirlo al pasado; unir por nombre de proyecto o remote; replicar cada hilo en una base por proyecto.

### Persistence, concurrency and idempotence

Tablas append-only de native_session, alias y association_version en schema4. Nuevas capturas legacy reciben corrección aditiva de native_id. Escritura y CAS mediante writer común; scope.resolve solo lee. Idempotencia se comprueba por request digest, y conflicto de revisión aborta todos los tramos.

### Integration and dependencies

El módulo de identidad es hoja compartida para archive/ledger/graph. No depende de embeddings, Gold ni resident. Se prueban adapters a través de auditSession actual y asociaciones mediante API v4 cuando exista.

Dependencies: none. One writer executes the full ordered program.

## Migration Plan

Casos viejos conservan IDs y DB; import-case construye alias a nueva identidad. La lectura vieja no se presenta como normalización corregida. Paths Windows mantienen forma original y semántica de volumen observada; UNC y worktrees no se fusionan por basename.

La identidad/alias y batch de asociaciones comprometen en el mismo commit_seq. Crash antes de publication deja la revisión anterior; recovery reutiliza IDs persistidos de staging, sin asignar otra sesión al mismo acto.

Expected write set: src/adapters.js, src/discovery.js, src/audit.js, src/archive/identity.js, src/archive/associations.js, schemas/, test/acceptance/afh-01.test.mjs.

## Risks / Trade-offs

IDs sin dominio/origen y transiciones sin timestamp exacto permanecen UNCERTAIN. Inferencia de pertenencia aparece separada de observación; un filtro de proyecto no equivale a control de acceso entre usuarios.

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

## Acceptance milestone 1

Due full acceptance: AFH-01-T01, AFH-01-T03, AFH-01-T19, AFH-01-T21, AFH-01-T22.

Owned obligations deferred (not GREEN): AFH-01-T02 -> 2 CHANGE_EXIT, AFH-01-T04 -> 2 CHANGE_EXIT, AFH-01-T05 -> 2 CHANGE_EXIT, AFH-01-T06 -> 2 CHANGE_EXIT, AFH-01-T07 -> 7 CHANGE_EXIT, AFH-01-T08 -> 2 CHANGE_EXIT, AFH-01-T09 -> 2 CHANGE_EXIT, AFH-01-T10 -> 4 CHANGE_EXIT, AFH-01-T11 -> 4 CHANGE_EXIT, AFH-01-T12 -> 4 CHANGE_EXIT, AFH-01-T13 -> 2 CHANGE_EXIT, AFH-01-T14 -> 4 CHANGE_EXIT, AFH-01-T15 -> 7 CHANGE_EXIT, AFH-01-T16 -> 2 CHANGE_EXIT, AFH-01-T17 -> 2 CHANGE_EXIT, AFH-01-T18 -> 2 CHANGE_EXIT, AFH-01-T20 -> 2 CHANGE_EXIT.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

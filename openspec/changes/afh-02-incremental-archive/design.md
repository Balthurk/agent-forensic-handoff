## Context

Los IDs actuales incorporan hash de transcript completo; al crecer la fuente cambia sourceId/eventId. Casos inmutables son válidos pero no ofrecen archivo incremental entre snapshots.

Purpose and global integration: Mantener Bronce y snapshots de archivo con actualizaciones incrementales verificables, reutilizando bytes y normalización sin invalidar evidencia ni identidades históricas.

## Goals / Non-Goals

Benefit: Reduce normalización e indexación repetidas y conserva continuidad verificable sin prometer IO sublineal cuando hay que verificar el prefijo.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: writer; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Fijar límite de cada fuente, leer/hash streaming, chunk raw en 4MiB y manifest contiguo. Para append, verificar todo prefijo previo; reutilizar record mapping y occurrence IDs del prefijo, parsear delta completo; retener tail incompleto como representación con estado. Rewrite/truncation/compaction abre revisión divergente y epoch desde primer record afectado. Fuentes compressed conservan raw y vista decoded diferenciada. CAS comparte solo bytes idénticos dentro del access_domain. Legacy aliases resuelven por manifest virtual con hash raw original y rangos decoded según convención original.

Interfaces: archive.init, archive.ingest, archive.import_case, archive.verify, archive.recover, evidence.read. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

El contrato de integridad exige demostrar continuidad, no confiar solo en mtime/tamaño. La reducción de compute/almacenamiento puede medirse aunque leer el prefijo siga siendo lineal.

Rechazados: modificar caso viejo; usar mtime como proof; copiar corpus por proyecto; rehash/text similarity para unir actos tras rewrite; hardlinks a originales mutables.

### Persistence, concurrency and idempotence

archive.json publica pointer a revision manifest inmutable; ledger nuevo schema4 y objetos CAS duraderos antes de publicación. Registros append-only, checkpoint de record boundary, parser/config/source identities. Fuente ajena nunca se abre para escribir. No GC automático.

### Integration and dependencies

Depende de identidad 01; suministra Bronce/IDs a Plata 03 y semántica 06. Reader consume pinned published_seq; no inicia reingesta ni repara durante lectura.

Dependencies: afh-01-native-identity. One writer executes the full ordered program.

## Migration Plan

Importar 0.1/0.2/0.3 a destino vacío sin modificar originales; verificar inventario before/after y todas las URIs incluidas. Nueva lectura conserva URI vieja aunque cambie raíz. audit clásico sigue haciendo nuevos casos snapshots.

Inyectar terminación de proceso después de objects_fsync, ledger_commit, revision_manifest y pointer_replace. Reiniciar, validar checkpoint y recuperar una sola revisión sin duplicados. Disk-full/rename Windows deja staging; último pointer sano permanece. Rechazar lock vivo y checkpoint adulterado.

Expected write set: src/archive/, src/evidence.js, src/integrity.js, schemas/, test/acceptance/afh-02.test.mjs, test/acceptance/afh-01.test.mjs, src/index.js.

## Risks / Trade-offs

Verificar prefijo cuesta IO completo y debe contarse. Compressed append puede requerir decodificación completa. Captura congelada no incluye bytes añadidos después del boundary; receipt expone esa limitación.

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

20 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

## Acceptance milestone 2

Due full acceptance: AFH-01-T02, AFH-01-T04, AFH-01-T05, AFH-01-T06, AFH-01-T08, AFH-01-T09, AFH-01-T13, AFH-01-T16, AFH-01-T17, AFH-01-T18, AFH-01-T20, AFH-02-T01, AFH-02-T02, AFH-02-T03, AFH-02-T05, AFH-02-T06, AFH-02-T08, AFH-02-T09, AFH-02-T10, AFH-02-T11, AFH-02-T12, AFH-02-T13, AFH-02-T14, AFH-02-T15, AFH-02-T16, AFH-02-T17, AFH-02-T18, AFH-02-T19, AFH-02-T20.

Owned obligations deferred (not GREEN): AFH-02-T04 -> 3 CHANGE_EXIT, AFH-02-T07 -> 3 CHANGE_EXIT.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

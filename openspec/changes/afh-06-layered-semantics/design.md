## Context

La release actual deduplica dentro de una proyección y carga un modelo por proceso; no ofrece reutilización fiable entre snapshots ni continuidad de build interrumpido.

Purpose and global integration: Indexar Plata y Oro explícitamente con embeddings locales versionados, reuso compatible y checkpoints que preserven cobertura y privacidad al actualizar el archivo.

## Goals / Non-Goals

Benefit: Reduce trabajo repetido sin ocultar intentos no promovidos ni mezclar embeddings de identidades incompatibles; prepara retrieval recurrente y residente.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: writer, semantic; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Indexar previews/redacted text de event/claim/decision/artifact metadata en Plata y texto seleccionado de Gold, con layer/scope/revision/ref por chunk. No raw Bronce como índice principal; excludes reasoning privado/binary/unknown sin texto/secret span se cuentan. Chunk 2000 codepoints overlap200, tokenizer truncation efectiva explícita. Clave reuse SHA256 cjson de normalized_text, normalizer, chunking, redaction digest, model/revision/digest, runtime/version, tokenizer digest, dimension, compute/vector dtype, pooling, normalization, access_domain y scope digest. Layer vive en chunk link y coverage; compartir vector entre layers solo cuando todos los demás campos y política permiten compartir, sin perder ambos links. Batch <=16 y <=16000 chars por defecto. Un chunk mayor que char budget se subdivide con nueva identidad, no supera límite.

Interfaces: semantic.build, semantic.verify, semantic-index, verify-projection. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

El objeto vector no es la ocurrencia ni su autoridad; reutilizar bytes de vector con clave exacta ahorra compute, manteniendo links y visibilidad temporal independientes.

Rechazados: caché solo por text hash; mezclar modelos con mismas dimensiones; indexar solo Oro; subir Bronce a API; silent fallback; reindexar todo Reader sin necesidad experimental.

### Persistence, concurrency and idempotence

Sidecar sqlite-vec existente con metadata de clave/cobertura/modelo/source revision, links por layer. Checkpoint por batch verificado, staging privado. Publish de manifest de proyección y ledger link en generación nueva; vector finito/f32/dimensión/hash verificados antes.

### Integration and dependencies

Consume Plata y Gold; expone cobertura por capa a planner07 y handles a resident09. No decide promociones, autoridad ni recuentos por similitud. Preserva selector temporal sobre links/chunks antes de ranking.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context. One writer executes the full ordered program.

## Migration Plan

Mantener semantic-index/query legacy y sidecars schema3 read-only; nuevos sidecars v4 separados. Modelo por defecto conserva snapshot multilingüe fijado si disponible. Descarga solo en comando explícito actual, normal builds offline.

Crash después de batch durable reusa únicamente filas verificadas y clave exacta. Reanudación config/modelo/redaction distinta falla PROJECTION_UNAVAILABLE con incompatibilidad; no retorna REUSED. Corrupción aislada no contamina Bronce/Plata publicados.

Expected write set: src/semantic.js, src/semantic-model.js, src/archive/projections.js, src/context/chunking.js, test/acceptance/afh-06.test.mjs, test/acceptance/afh-03.test.mjs.

## Risks / Trade-offs

Chunk/preview redacción puede excluir detalle relevante; coverage lo cuantifica y evidence exacta sigue disponible. Modelos reales deben medirse; proveedores fixture solo prueban plumbing, no calidad multilingüe ni rendimiento real.

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

## Acceptance milestone 6

Due full acceptance: AFH-03-T20, AFH-06-T02, AFH-06-T04, AFH-06-T05, AFH-06-T06, AFH-06-T07, AFH-06-T08, AFH-06-T10, AFH-06-T11, AFH-06-T12, AFH-06-T13, AFH-06-T14, AFH-06-T15, AFH-06-T19, AFH-06-T20.

Owned obligations deferred (not GREEN): AFH-06-T01 -> 7 CHANGE_EXIT, AFH-06-T03 -> 7 CHANGE_EXIT, AFH-06-T09 -> 7 CHANGE_EXIT, AFH-06-T16 -> 7 CHANGE_EXIT, AFH-06-T17 -> 7 CHANGE_EXIT, AFH-06-T18 -> 7 CHANGE_EXIT.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

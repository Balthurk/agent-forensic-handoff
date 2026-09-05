## Context

La búsqueda actual puede devolver texto temático antiguo y no alcanzar respuestas terminales desde entidades de sesión; sus scores no miden la corrección de una respuesta compuesta.

Purpose and global integration: Responder preguntas y construir context packs que combinen proyecto y tarea mediante SQL/FTS, semántica de Plata/Oro y grafo temporal, con presupuestos y evidencia verificables.

## Goals / Non-Goals

Benefit: Permite a un agente retomar objetivos, decisiones y pendientes concretos con cronología y referencias, incluyendo resultados negativos honestos y cuentas exactas.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: reader, semantic; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

kind es explícito en API: exact usa IDs/SQL/FTS, count usa SQL y nunca embeddings, conceptual usa mode solicitado, relational siembra entidades de scope/IDs/aliases además de hits textuales y recorre SPAWNED/IN_SESSION/REPLIES_TO hacia terminales; temporal/current_state/mission usan selector de assertion revisions antes de búsqueda. Cada layer obtiene máximo50 candidatos, graph200 nodos default, hard caps comunes. FTS usa bm25 ascendente; híbrido RRF k=60 por lista léxica/Silver/Gold sobre logical_event IDs únicos. Duplicados técnicos no aportan votos. Para current_state se prioriza la revisión visible no revocada y terminal de tarea, conservando conflictos; recencia solo desempata pertinencia compatible, nunca decide verdad. Generar AnswerUnits deterministas con IDs/refs y resolver evidencia de toda unidad consecuencial antes de render. Pack por cuotas/budget definido en API; informe de omisiones en receipt.

Interfaces: query, stats, context.build, graph.neighbors, graph.path, event.show, evidence.read. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

Las preguntas de relación requieren entidades aunque ninguna frase coincida. Un contador estructurado no puede delegarse a similitud. La respuesta compuesta se valida por claims críticos y no por hash del primer hit.

Rechazados: solo nearest neighbors; seed solo event hits; timestamp más nuevo como cierre; sumar votos de dos encodings; tratar ausencia de top-k como ausencia universal; resolver scope con nombre cercano.

### Persistence, concurrency and idempotence

Operaciones read-only bajo snapshot pinned y mismas identidades de índices. pack_id/digest se calculan en memoria; guardar pack requiere comando writer separado y no ocurre al consultar. Aplicar filtros antes de KNN/FTS/graph donde sea posible; cualquier post-filter necesario declara coverage y no rellena con hits de otro scope.

### Integration and dependencies

Compone 01-06; expone mismo resultado al CLI/API/worker09. La skill abre evidence y reconcilia hechos de workspace actual mediante acciones autorizadas, no los infiere del archivo.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics. One writer executes the full ordered program.

## Migration Plan

query legacy mantiene léxico default y opciones existentes. Nuevos kind/layers/receipt son aditivos. No cambia modelo automáticamente ni reconstruye sidecars desde reader. Layout hot/warm/cold compatible con disclosures explícitos.

AbortSignal/timeout devuelve error sin mutación; modelo no disponible devuelve UNAVAILABLE. Fuente/ref corrupta impide unidad con EVIDENCE_RESOLVED; partial pack muestra la unidad como gap y no la sustituye por una afirmación inventada. Reader sobre generación vieja termina con esa identidad.

Expected write set: src/retrieval.js, src/render.js, src/context/planner.js, src/context/pack.js, src/archive/stats.js, test/acceptance/afh-07.test.mjs.

## Risks / Trade-offs

No se promete conocimiento universal ni QA semántico perfecto. Presupuesto estimado no es hard token cap; tokenizer local identificado es requisito para ese modo. Calidad y continuidad reales se evalúan en13.

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

27 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

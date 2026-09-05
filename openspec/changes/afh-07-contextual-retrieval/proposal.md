## Why

La búsqueda actual puede devolver texto temático antiguo y no alcanzar respuestas terminales desde entidades de sesión; sus scores no miden la corrección de una respuesta compuesta.

Permite a un agente retomar objetivos, decisiones y pendientes concretos con cronología y referencias, incluyendo resultados negativos honestos y cuentas exactas.

## What Changes

Responder preguntas y construir context packs que combinen proyecto y tarea mediante SQL/FTS, semántica de Plata/Oro y grafo temporal, con presupuestos y evidencia verificables.

## Capabilities

### New Capabilities

- `contextual-retrieval`: Responder preguntas y construir context packs que combinen proyecto y tarea mediante SQL/FTS, semántica de Plata/Oro y grafo temporal, con presupuestos y evidencia verificables.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: query, stats, context.build, graph.neighbors, graph.path, event.show, evidence.read. Write set: src/retrieval.js, src/render.js, src/context/planner.js, src/context/pack.js, src/archive/stats.js, test/acceptance/afh-07.test.mjs. Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics. All shared profiles are normative: reader, semantic.

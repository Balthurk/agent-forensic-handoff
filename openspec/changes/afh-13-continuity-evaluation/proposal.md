## Why

Un score de ranking, test unitario o resumen acertado no acredita que otro agente pueda retomar el trabajo correcto con restricciones y evidencia suficientes.

Permite comparar versiones sobre tareas y datos idénticos y descubrir regresiones que solo aparecen con muchas sesiones, deltas e índices locales reales.

## What Changes

Acreditar recuperación y continuación útil mediante respuestas compuestas con oráculos independientes, ensayos ciegos reales y escala sostenida reproducible que incluyan fallos, memoria y cobertura.

## Capabilities

### New Capabilities

- `continuity-evaluation`: Acreditar recuperación y continuación útil mediante respuestas compuestas con oráculos independientes, ensayos ciegos reales y escala sostenida reproducible que incluyan fallos, memoria y cobertura.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: query, context.build, archive.verify, node tools/evaluation/run.mjs --manifest <file>. Write set: test/acceptance/afh-13.test.mjs, tools/evaluation/, docs/evaluation.md, schemas/evaluation-v1.schema.json. Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance, afh-09-resident-reader, afh-10-compatibility-matrix, afh-11-portable-bundles, afh-12-prospective-capture. All shared profiles are normative: reader, semantic.

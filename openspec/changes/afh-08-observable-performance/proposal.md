## Why

Audit no emite callback por fase y semantic-index oculta progreso con --json; Reader tuvo preparación costosa sin subfases observables.

Permite decidir mejoras por coste medido, detectar procesos incompletos y estimar fase sin inventar porcentajes o extrapolaciones del corpus.

## What Changes

Medir y exponer el coste real por fases de captura, indexación y recuperación con progreso JSON y ETA honestos, presupuestos reproducibles y cobertura de recursos.

## Capabilities

### New Capabilities

- `observable-performance`: Medir y exponer el coste real por fases de captura, indexación y recuperación con progreso JSON y ETA honestos, presupuestos reproducibles y cobertura de recursos.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: onProgress, --progress-json, archive.ingest, semantic.build, query, benchmark. Write set: src/cli.js, src/archive/progress.js, src/audit.js, src/semantic.js, src/retrieval.js, benchmarks/, test/acceptance/afh-08.test.mjs. Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval. All shared profiles are normative: core.

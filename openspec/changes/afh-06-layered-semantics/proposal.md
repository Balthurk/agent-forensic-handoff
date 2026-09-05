## Why

La release actual deduplica dentro de una proyección y carga un modelo por proceso; no ofrece reutilización fiable entre snapshots ni continuidad de build interrumpido.

Reduce trabajo repetido sin ocultar intentos no promovidos ni mezclar embeddings de identidades incompatibles; prepara retrieval recurrente y residente.

## What Changes

Indexar Plata y Oro explícitamente con embeddings locales versionados, reuso compatible y checkpoints que preserven cobertura y privacidad al actualizar el archivo.

## Capabilities

### New Capabilities

- `layered-semantics`: Indexar Plata y Oro explícitamente con embeddings locales versionados, reuso compatible y checkpoints que preserven cobertura y privacidad al actualizar el archivo.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: semantic.build, semantic.verify, semantic-index, verify-projection. Write set: src/semantic.js, src/semantic-model.js, src/archive/projections.js, src/context/chunking.js, test/acceptance/afh-06.test.mjs, test/acceptance/afh-03.test.mjs. Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context. All shared profiles are normative: writer, semantic.

## Why

event.observed_at y claim.current no describen correcciones bitemporales; una orden posterior igual elimina contradicciones sin binding al objetivo, y el grafo legado mezcla orientación de supersession.

Evita usar estado futuro en consultas históricas y permite investigar intentos, patches, revisiones descartadas y validaciones con la cadena exacta de evidencia.

## What Changes

Versionar vigencia y conocimiento de afirmaciones, relaciones y artefactos para reconstruir qué ocurrió, qué se sabía en cada corte y qué causalidad está demostrada.

## Capabilities

### New Capabilities

- `temporal-provenance`: Versionar vigencia y conocimiento de afirmaciones, relaciones y artefactos para reconstruir qué ocurrió, qué se sabía en cada corte y qué causalidad está demostrada.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: graph.neighbors, graph.path, event.show, query temporal, stats effects. Write set: src/archive/temporal.js, src/archive/provenance.js, src/graph.js, src/reducers.js, schemas/, test/acceptance/afh-04.test.mjs, test/acceptance/afh-01.test.mjs, test/acceptance/afh-03.test.mjs, src/archive/engine.js, src/archive/ledger.js, src/archive/storage.js, src/archive/verify.js, src/archive/associations.js, src/archive/occurrences.js, src/archive/wire-validation.cjs, src/archive/wire-build.json, src/archive/reader-observation.js. Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger. All shared profiles are normative: writer, reader.

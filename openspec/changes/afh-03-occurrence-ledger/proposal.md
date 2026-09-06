## Why

processTool fusiona por comando y toolId solo por callId; validationStatus infiere PASS y loopGroups usa MAX(status). Los probes verificaron los fallos en runtime 0.3.0.

Permite saber cuántos intentos hubo, qué salió de cada uno y qué sigue incompleto, evitando repetir soluciones descartadas o atribuir éxitos ajenos.

## What Changes

Reconstruir una bitácora íntegra de actos observables y sus representaciones, con recuentos exactos, resultados desconocidos honestos y payloads compartibles sin perder ejecuciones reales.

## Capabilities

### New Capabilities

- `occurrence-ledger`: Reconstruir una bitácora íntegra de actos observables y sus representaciones, con recuentos exactos, resultados desconocidos honestos y payloads compartibles sin perder ejecuciones reales.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: auditSession, archive.ingest, event.show, stats. Write set: src/adapters.js, src/audit.js, src/reducers.js, src/database.js, src/archive/ledger.js, src/archive/occurrences.js, test/acceptance/afh-03.test.mjs, test/acceptance/afh-02.test.mjs, src/archive/engine.js, src/archive/storage.js, src/archive/verify.js, src/archive/reader-observation.js. Dependencies: afh-01-native-identity, afh-02-incremental-archive. All shared profiles are normative: writer.

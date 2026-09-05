## Why

Los IDs actuales incorporan hash de transcript completo; al crecer la fuente cambia sourceId/eventId. Casos inmutables son válidos pero no ofrecen archivo incremental entre snapshots.

Reduce normalización e indexación repetidas y conserva continuidad verificable sin prometer IO sublineal cuando hay que verificar el prefijo.

## What Changes

Mantener Bronce y snapshots de archivo con actualizaciones incrementales verificables, reutilizando bytes y normalización sin invalidar evidencia ni identidades históricas.

## Capabilities

### New Capabilities

- `incremental-archive`: Mantener Bronce y snapshots de archivo con actualizaciones incrementales verificables, reutilizando bytes y normalización sin invalidar evidencia ni identidades históricas.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: archive.init, archive.ingest, archive.import_case, archive.verify, archive.recover, evidence.read. Write set: src/archive/, src/evidence.js, src/integrity.js, schemas/, test/acceptance/afh-02.test.mjs. Dependencies: afh-01-native-identity. All shared profiles are normative: writer.

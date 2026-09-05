## Why

Hay adaptadores Codex/Claude/Antigravity pero no matriz de versiones explícita; macOS x64/arm64 y Linux arm64 se declaraban por disponibilidad de paquetes, no por pruebas de release.

Evita equiparar JSON parseable con normalización válida o paquete instalable con compatibilidad observada en esa arquitectura.

## What Changes

Definir y comprobar contratos de harness/formato/versión y plataformas soportadas con fixtures públicos seguros y evidencia real de cada combinación requerida.

## Capabilities

### New Capabilities

- `compatibility-matrix`: Definir y comprobar contratos de harness/formato/versión y plataformas soportadas con fixtures públicos seguros y evidencia real de cada combinación requerida.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: afh doctor, adapters, archive.import_case, CI matrix. Write set: schemas/harness-compatibility.json, test/fixtures/, test/acceptance/afh-10.test.mjs, .github/workflows/ci.yml, docs/compatibility.md. Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance, afh-09-resident-reader. All shared profiles are normative: release.

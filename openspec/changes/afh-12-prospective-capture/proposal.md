## Why

La captura retrospectiva no puede recuperar herramientas/resultados no persistidos; hacen falta vías prospectivas opcionales sin hacer obligatoria otra plataforma.

Mejora evidencia futura de comandos/tiempos/causalidad y cobertura, manteniendo archivo/CLI utilizables sin hooks ni collector remoto.

## What Changes

Capturar actividad futura autorizada mediante hook local e importación OTLP/OpenInference/AppServer, preservando límites, pérdidas y procedencia sin reejecutar ni reinventar historia ausente.

## Capabilities

### New Capabilities

- `prospective-capture`: Capturar actividad futura autorizada mediante hook local e importación OTLP/OpenInference/AppServer, preservando límites, pérdidas y procedencia sin reejecutar ni reinventar historia ausente.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: capture.init, capture.append, capture.status, afh capture append --request params.json. Write set: src/capture/, schemas/capture-v1.schema.json, src/cli.js, docs/capture.md, test/acceptance/afh-12.test.mjs. Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-08-observable-performance, afh-10-compatibility-matrix. All shared profiles are normative: writer.

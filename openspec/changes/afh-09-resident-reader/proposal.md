## Why

La carga de modelo en cada CLI agrega segundos; añadir un servidor sin medir o con otro ranking crearía divergencia y superficie de escritura innecesaria.

Reduce la latencia recurrente de consultas privadas cuando se usa residencia, conservando CLI embebido y archivo legible sin servicio.

## What Changes

Ofrecer un reader local opcional que mantenga modelos/handles residentes y ejecute el mismo núcleo de consulta con aislamiento, límites y paridad verificables.

## Capabilities

### New Capabilities

- `resident-reader`: Ofrecer un reader local opcional que mantenga modelos/handles residentes y ejecute el mismo núcleo de consulta con aislamiento, límites y paridad verificables.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: afh serve, resident.status, resident.stop, reader-only archiveRequest over IPC. Write set: src/resident/, src/cli.js, test/acceptance/afh-09.test.mjs, test/acceptance/afh-08.test.mjs. Dependencies: afh-02-incremental-archive, afh-04-temporal-provenance, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance. All shared profiles are normative: reader, semantic.

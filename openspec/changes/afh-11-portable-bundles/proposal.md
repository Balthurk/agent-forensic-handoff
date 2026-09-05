## Why

Los casos locales actuales conservan hash e integridad, pero no tienen transporte cifrado/firmado completo ni contrato de importación relocation-safe.

Permite copia/entrega privada con detección de adulteración y origen del firmante conocido, sin publicar casos ni depender de paths de la máquina original.

## What Changes

Transportar archivos forenses privados mediante bundles cifrados y firmados verificables que preserven referencias/identidades al relocalizarse y rechacen corrupción o destinos inseguros.

## Capabilities

### New Capabilities

- `portable-bundles`: Transportar archivos forenses privados mediante bundles cifrados y firmados verificables que preserven referencias/identidades al relocalizarse y rechacen corrupción o destinos inseguros.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: bundle.export, bundle.import, evidence.read. Write set: src/bundle/, schemas/bundle-v1.schema.json, src/cli.js, test/acceptance/afh-11.test.mjs. Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-04-temporal-provenance, afh-06-layered-semantics, afh-10-compatibility-matrix. All shared profiles are normative: writer, release.

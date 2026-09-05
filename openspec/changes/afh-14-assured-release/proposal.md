## Why

Tests verdes locales o artefactos empaquetados no acreditan compatibilidad global, privacidad, instalación, firma o disponibilidad de la release publicada.

Cierra el programa completo con identidad de candidato/artefacto y rollback claro, manteniendo disponible la instalación activa mientras se verifica la nueva.

## What Changes

Entregar AFH0.4.0 como release verificable y reversible con documentación/skill coherentes, CI real, fuzzing, cadena de suministro y comprobación de instalación aislada/publicación exacta.

## Capabilities

### New Capabilities

- `assured-release`: Entregar AFH0.4.0 como release verificable y reversible con documentación/skill coherentes, CI real, fuzzing, cadena de suministro y comprobación de instalación aislada/publicación exacta.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: npm pack --json, afh --version, afh archive verify, GitHub Releases API. Write set: package.json, package-lock.json, SKILL.md, README.md, docs/, schemas/, test/acceptance/afh-14.test.mjs, tools/release/, .github/workflows/. Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance, afh-09-resident-reader, afh-10-compatibility-matrix, afh-11-portable-bundles, afh-12-prospective-capture, afh-13-continuity-evaluation. All shared profiles are normative: release, writer.

## Context

Hay adaptadores Codex/Claude/Antigravity pero no matriz de versiones explícita; macOS x64/arm64 y Linux arm64 se declaraban por disponibilidad de paquetes, no por pruebas de release.

Purpose and global integration: Definir y comprobar contratos de harness/formato/versión y plataformas soportadas con fixtures públicos seguros y evidencia real de cada combinación requerida.

## Goals / Non-Goals

Benefit: Evita equiparar JSON parseable con normalización válida o paquete instalable con compatibilidad observada en esa arquitectura.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: release; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Crear registry versionado por harness, producer_version/range, format_profile, schema_digest, adapter_version, fixture digests, supported record types, capabilities, exclusions y observed status. Profiles iniciales: codex-rollout-2026-09 y AppServer generado por codex-cli0.144.5 observado; Claude baseline JSONL, Antigravity generic export y generic-v1 con producer_version UNKNOWN hasta evidencia. No publicar rangos de vendor no medidos. Obtener schema AppServer con CLI local exacto en raíz de test e incluir extractos sintéticos mínimos; inspeccionar estructuras fuera de corpus privado. Para UNKNOWN_VERSION preservar records, marcar cobertura parcial y no afirmar normalización completa. CI requerida: Windows x64/Linux x64/Linux arm64/macOS x64/macOS arm64, Node22 y24; registrar node/process.arch/OS y carga sqlite-vec/modelo real en cada objetivo.

Interfaces: afh doctor, adapters, archive.import_case, CI matrix. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

El formato y versión son parte de la interpretación forense. Tener un binario arm64 publicado no equivale a ejecutar el contrato en arm64.

Rechazados: universal compatibility por sniffing; copiar transcripts reales en CI; marcar macOS verde con Linux; emulación sin etiqueta como ejecución nativa; elevar Node sin demostrar necesidad.

### Persistence, concurrency and idempotence

Registry/fixtures sintéticos versionados en repo, receipts por commit/runner/artifact en CI. Paths/control characters/windows_reserved incluidos. No almacenar state sqlite real ni home de usuario. Descarga explícita del modelo público en CI aislado registra digest y no usa datos privados.

### Integration and dependencies

Verifica normalización01/03, legacy02 y semántica06/resident09 en la matriz. Controla packaging/release14 y límites informados al planner.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance, afh-09-resident-reader. One writer executes the full ordered program.

## Migration Plan

Mantener casos1/2/3 legibles y perfiles antiguos aunque nuevos adapters mejoren precisión. Version range se amplía solo con fixtures/evidencia, no por estética de números schema. Generic conserva modo limitado si producer desconocido.

Fallo/missing runner/model/network produce UNAVAILABLE y bloquea la aceptación de plataforma requerida. Repetir job aislado es seguro; no editar expected data después de observar error para forzar PASS.

Expected write set: schemas/harness-compatibility.json, test/fixtures/, test/acceptance/afh-10.test.mjs, .github/workflows/ci.yml, docs/compatibility.md.

## Risks / Trade-offs

Runner labels y schemas de proveedor cambian; el implementador registra SHA/imagen realmente usadas y valida arch al inicio. Un test sintético demuestra el contrato publicado, no cobertura universal de todas las sesiones de esa versión.

## Entry and exit

Entry:
- Complete 14-change package reviewed with no material gaps.
- Scope authorization active; one writer; applicable snapshot review and schema/OpenSpec validation.
- Every earlier sequential change GREEN on applicable candidate; 01 has no predecessor GREEN requirement.
- Concrete test harness and immutable fixture/oracle available; absent API labeled NOT_IMPLEMENTED.

Exit:
- All listed scenarios and inherited checks pass with correct evidence class; no skip/unavailable/mechanical substituted.
- Legacy baseline remains green; source/case inventories unchanged; new API responses meet schema and relational invariants.
- Evidence resolves to actual candidate/inputs; semantic review satisfactory and work trace appended.

## TDD contracts

16 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

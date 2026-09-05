## Context

Tests verdes locales o artefactos empaquetados no acreditan compatibilidad global, privacidad, instalación, firma o disponibilidad de la release publicada.

Purpose and global integration: Entregar AFH0.4.0 como release verificable y reversible con documentación/skill coherentes, CI real, fuzzing, cadena de suministro y comprobación de instalación aislada/publicación exacta.

## Goals / Non-Goals

Benefit: Cierra el programa completo con identidad de candidato/artefacto y rollback claro, manteniendo disponible la instalación activa mientras se verifica la nueva.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: release, writer; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Congelar candidato después de01–13 aceptados. Ejecutar CI nativa de10, baseline legacy,14 harnesses y cobertura de13. Fuzz determinista seed404:10000 casos por parser/ingesta/query/bundle/capture con bytes/rutas/UTF8/depth/frame/IDs alterados; límite de caso5s/RSS512MiB y total2h, corpus/crashes/minimización preservados. Generar npm pack con manifest exhaustivo allowlist, tar parser seguro y SHA256; SBOM CycloneDX JSON1.6 con dependencies/transitives/licenses/versions y lock digest. Emitir procedencia in-toto statement v1 con subject tgz digest, source commit/tag, builder/workflow digest y materiales. GitHub Actions OIDC firma attestations de artefactos (sin clave privada persistida); gh attestation verify identifica repositorio/workflow/ref y subject. Crear tag anotado v0.4.0 sobre candidato limpio tras gates, GitHub draft release con activos tgz/SHA256SUMS/SBOM/provenance/evidence y attestations, descargar assets del draft y verificar. Promover draft solo con todos gates, descargar publicación de nuevo y comparar hashes/firma/instalación aislada. Official references: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations and https://cyclonedx.org/docs/1.6/json/ . Freeze exact action/CLI version and workflow commit during release implementation; do not infer successful signing from specification.

Interfaces: npm pack --json, afh --version, afh archive verify, GitHub Releases API. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

GitHub Release es el canal existente confirmado para0.3.0; npm pack solo construye el paquete, no autoriza ni exige publicar en npm registry. La identidad de artefacto y procedencia verificable une revisión/CI/contenido entregado.

Rechazados: publicar antes de CI; instalar sobre la skill activa para probar; etiquetar candidato diferente del probado; firmas sin identidad confiada; SBOM inferido solo de package.json; tratar attestation como prueba funcional; promover pese a macOS/ARM ausentes.

### Persistence, concurrency and idempotence

Release-evidence referencia paquete OpenSpec/commit candidato/CI10/13/trials/artefactos/installer receipts exactos. Artefactos públicos contienen solo código/docs/fixtures revisados, nunca fuentes privadas/keys/node_modules de tooling. Cada instalación usa prefix y CODEX_HOME nuevos bajo RUN; inventario de instalación activa before/after se compara sin escribirla. Mantener release0.3.0 accesible y procedimiento de selección explícita de versión.

### Integration and dependencies

Gate derivado de revisiones y receipts exactos01–13 más checks14. CI usa fixtures públicos y permisos mínimos. Whole-program spec/review válida y autorización vigente por alcance; cambio de bytes invalida evidencia afectada sin pedir otra aprobación rutinaria. Ejecutar publicación solo desde la tarea de implementación autorizada por coordinador. Release readiness requires every CHANGE_EXIT integration; only the two frozen published-artifact/final-close scenarios require POST_PUBLICATION completion. See acceptance_policy and generated tasks.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance, afh-09-resident-reader, afh-10-compatibility-matrix, afh-11-portable-bundles, afh-12-prospective-capture, afh-13-continuity-evaluation. One writer executes the full ordered program.

## Migration Plan

Actualizar engine/skill/docs/CLI help juntos: local archive, medallion, scope/history, counts, semantic explicit, capture opt-in, bundles/resident y limitaciones. Preservar formatos y comandos legados; migraciones solo a nuevos archivos con alias. Requerida instalación desde tgz y GitHub descargado en cinco targets de10; no nueva publicación npm ni global install.

Antes de promover, fallo deja draft diagnosticable, no borra activos previos. Después de publicar, defecto material pausa promoción/uso y marca release con advisory descriptivo; no reescribir tag ni reemplazar tgz firmado. Nuevo patch requiere nueva identidad/CI. Rollback selecciona0.3.0 en instalación aislada y verifica smoke/old cases; no downgrade destructivo de archivo4.

Expected write set: package.json, package-lock.json, SKILL.md, README.md, docs/, schemas/, test/acceptance/afh-14.test.mjs, tools/release/, .github/workflows/.

## Risks / Trade-offs

Tooling de GitHub/attestation debe fijar versión real y workflow digest; disponibilidad/credenciales ausentes son UNAVAILABLE y bloquean publicación, sin inventar firma. Auditoría criptográfica del bundle es revisión específica requerida11; ni esta especificación ni firma supply-chain la sustituyen.

## Entry and exit

Entry:
- Complete 14-change package reviewed with no material gaps.
- Scope authorization active; one writer; applicable snapshot review and schema/OpenSpec validation.
- Every earlier acceptance milestone is MILESTONE_GREEN with its exact due obligations; future owner integrations remain DEFERRED_NOT_RUN.01 has no predecessor.
- Concrete test harness and immutable fixture/oracle available; absent API labeled NOT_IMPLEMENTED.

Exit:
- All CHANGE_EXIT obligations due at this milestone (including incoming integrations) pass their complete oracles and evidence classes. Later owner scenarios remain explicitly DEFERRED_NOT_RUN, mandatory at their assigned milestone. No diagnostic GREEN substitutes for acceptance.
- Legacy baseline remains green; source/case inventories unchanged; new API responses meet schema and relational invariants.
- Evidence resolves to actual candidate/inputs; semantic review satisfactory and work trace appended.

## TDD contracts

20 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

## Acceptance milestone 14

Due full acceptance: AFH-14-T01, AFH-14-T02, AFH-14-T03, AFH-14-T04, AFH-14-T05, AFH-14-T06, AFH-14-T07, AFH-14-T08, AFH-14-T09, AFH-14-T10, AFH-14-T11, AFH-14-T12, AFH-14-T13, AFH-14-T14, AFH-14-T15, AFH-14-T16, AFH-14-T18, AFH-14-T19.

Owned obligations deferred (not GREEN): AFH-14-T17 -> 14 POST_PUBLICATION, AFH-14-T20 -> 14 POST_PUBLICATION.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

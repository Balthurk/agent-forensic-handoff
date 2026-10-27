# Revisión de coordinador y gates

Generated from specification/contracts.json by validate-package.mjs --generate. Edit the canonical registry, not this view.

## Comprobaciones automatizables

- [ ] validate-package pasó sobre el digest exacto, sin referencias vacías, rotas o cíclicas.
- [ ] OpenSpec 1.12.0 validate --all --strict pasó para todos los cambios y baseline.
- [ ] Schemas v4 y registry, oráculos negativos, clasificación de evidencia y tests del gate pasaron.
- [ ] Runtime/producto intacto en fase de especificación; datos públicos sintéticos y revisados.

## Revisión semántica requerida

- [ ] Cada requisito tiene propósito, contrato y oráculo falsable que conserva información en negativos.
- [ ] Revisar el programa completo: R1 segmentos temporales; R2 protocolo/frame/presupuesto; R3 registro; R4 probes; R5 ownership; R6 gates y autorización persistente.
- [ ] Confirmar las 22 decisiones y que ninguna capacidad pendiente se omitió por esfuerzo o prioridad.
- [ ] Confirmar blind trials con independencia real, límites de cobertura y criterios medidos de release.
- [ ] Emitir review_ref con snapshot_sha256, reviewer, source_ref resoluble, resultado SATISFACTORY o CHANGES_REQUESTED, findings y hora observada.

## Secuencia y entrada por cambio

| Cambio | Predecesores semánticos | Write set | Pruebas |
|---|---|---|---|
| afh-01-native-identity | ninguno | src/adapters.js, src/discovery.js, src/audit.js, src/archive/identity.js, src/archive/associations.js, schemas/, test/acceptance/afh-01.test.mjs | AFH-01-T01, AFH-01-T02, AFH-01-T03, AFH-01-T04, AFH-01-T05, AFH-01-T06, AFH-01-T07, AFH-01-T08, AFH-01-T09, AFH-01-T10, AFH-01-T11, AFH-01-T12, AFH-01-T13, AFH-01-T14, AFH-01-T15, AFH-01-T16, AFH-01-T17, AFH-01-T18, AFH-01-T19, AFH-01-T20, AFH-01-T21, AFH-01-T22 |
| afh-02-incremental-archive | afh-01-native-identity | src/archive/, src/evidence.js, src/integrity.js, schemas/, test/acceptance/afh-02.test.mjs, test/acceptance/afh-01.test.mjs, src/index.js | AFH-02-T01, AFH-02-T02, AFH-02-T03, AFH-02-T04, AFH-02-T05, AFH-02-T06, AFH-02-T07, AFH-02-T08, AFH-02-T09, AFH-02-T10, AFH-02-T11, AFH-02-T12, AFH-02-T13, AFH-02-T14, AFH-02-T15, AFH-02-T16, AFH-02-T17, AFH-02-T18, AFH-02-T19, AFH-02-T20 |
| afh-03-occurrence-ledger | afh-01-native-identity, afh-02-incremental-archive | src/adapters.js, src/audit.js, src/reducers.js, src/database.js, src/archive/ledger.js, src/archive/occurrences.js, test/acceptance/afh-03.test.mjs, test/acceptance/afh-02.test.mjs, src/archive/engine.js, src/archive/storage.js, src/archive/verify.js, src/archive/reader-observation.js | AFH-03-T01, AFH-03-T02, AFH-03-T03, AFH-03-T04, AFH-03-T05, AFH-03-T06, AFH-03-T07, AFH-03-T08, AFH-03-T09, AFH-03-T10, AFH-03-T11, AFH-03-T12, AFH-03-T13, AFH-03-T14, AFH-03-T15, AFH-03-T16, AFH-03-T17, AFH-03-T18, AFH-03-T19, AFH-03-T20, AFH-03-T21, AFH-03-T22 |
| afh-04-temporal-provenance | afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger | src/archive/temporal.js, src/archive/provenance.js, src/graph.js, src/reducers.js, schemas/, test/acceptance/afh-04.test.mjs, test/acceptance/afh-01.test.mjs, test/acceptance/afh-03.test.mjs, src/archive/engine.js, src/archive/ledger.js, src/archive/storage.js, src/archive/verify.js, src/archive/associations.js, src/archive/occurrences.js, src/archive/wire-validation.cjs, src/archive/wire-build.json, src/archive/reader-observation.js | AFH-04-T01, AFH-04-T02, AFH-04-T03, AFH-04-T04, AFH-04-T05, AFH-04-T06, AFH-04-T07, AFH-04-T08, AFH-04-T09, AFH-04-T10, AFH-04-T11, AFH-04-T12, AFH-04-T13, AFH-04-T14, AFH-04-T15, AFH-04-T16, AFH-04-T17, AFH-04-T18, AFH-04-T19, AFH-04-T20, AFH-04-T21, AFH-04-T22, AFH-04-T23, AFH-04-T24, AFH-04-T25 |
| afh-05-governed-context | afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance | src/reducers.js, src/render.js, src/context/intent.js, src/context/gold.js, skills/agent-forensic-handoff/, test/acceptance/afh-05.test.mjs | AFH-05-T01, AFH-05-T02, AFH-05-T03, AFH-05-T04, AFH-05-T05, AFH-05-T06, AFH-05-T07, AFH-05-T08, AFH-05-T09, AFH-05-T10, AFH-05-T11, AFH-05-T12, AFH-05-T13, AFH-05-T14, AFH-05-T15, AFH-05-T16, AFH-05-T17, AFH-05-T18, AFH-05-T19, AFH-05-T20, AFH-05-T21, AFH-05-T22, AFH-05-T23 |
| afh-06-layered-semantics | afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context | src/semantic.js, src/semantic-model.js, src/archive/projections.js, src/context/chunking.js, test/acceptance/afh-06.test.mjs, test/acceptance/afh-03.test.mjs | AFH-06-T01, AFH-06-T02, AFH-06-T03, AFH-06-T04, AFH-06-T05, AFH-06-T06, AFH-06-T07, AFH-06-T08, AFH-06-T09, AFH-06-T10, AFH-06-T11, AFH-06-T12, AFH-06-T13, AFH-06-T14, AFH-06-T15, AFH-06-T16, AFH-06-T17, AFH-06-T18, AFH-06-T19, AFH-06-T20 |
| afh-07-contextual-retrieval | afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics | src/retrieval.js, src/render.js, src/context/planner.js, src/context/pack.js, src/archive/stats.js, test/acceptance/afh-07.test.mjs, test/acceptance/afh-01.test.mjs, test/acceptance/afh-04.test.mjs, test/acceptance/afh-05.test.mjs, test/acceptance/afh-06.test.mjs | AFH-07-T01, AFH-07-T02, AFH-07-T03, AFH-07-T04, AFH-07-T05, AFH-07-T06, AFH-07-T07, AFH-07-T08, AFH-07-T09, AFH-07-T10, AFH-07-T11, AFH-07-T12, AFH-07-T13, AFH-07-T14, AFH-07-T15, AFH-07-T16, AFH-07-T17, AFH-07-T18, AFH-07-T19, AFH-07-T20, AFH-07-T21, AFH-07-T22, AFH-07-T23, AFH-07-T24, AFH-07-T25, AFH-07-T26, AFH-07-T27 |
| afh-08-observable-performance | afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval | src/cli.js, src/archive/progress.js, src/audit.js, src/semantic.js, src/retrieval.js, benchmarks/, test/acceptance/afh-08.test.mjs | AFH-08-T01, AFH-08-T02, AFH-08-T03, AFH-08-T04, AFH-08-T05, AFH-08-T06, AFH-08-T07, AFH-08-T08, AFH-08-T09, AFH-08-T10, AFH-08-T11, AFH-08-T12, AFH-08-T13, AFH-08-T14, AFH-08-T15, AFH-08-T16, AFH-08-T17, AFH-08-T18 |
| afh-09-resident-reader | afh-02-incremental-archive, afh-04-temporal-provenance, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance | src/resident/, src/cli.js, test/acceptance/afh-09.test.mjs, test/acceptance/afh-08.test.mjs | AFH-09-T01, AFH-09-T02, AFH-09-T03, AFH-09-T04, AFH-09-T05, AFH-09-T06, AFH-09-T07, AFH-09-T08, AFH-09-T09, AFH-09-T10, AFH-09-T11, AFH-09-T12, AFH-09-T13, AFH-09-T14, AFH-09-T15, AFH-09-T16, AFH-09-T17, AFH-09-T18 |
| afh-10-compatibility-matrix | afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance, afh-09-resident-reader | schemas/harness-compatibility.json, test/fixtures/, test/acceptance/afh-10.test.mjs, .github/workflows/ci.yml, docs/compatibility.md | AFH-10-T01, AFH-10-T02, AFH-10-T03, AFH-10-T04, AFH-10-T05, AFH-10-T06, AFH-10-T07, AFH-10-T08, AFH-10-T09, AFH-10-T10, AFH-10-T11, AFH-10-T12, AFH-10-T13, AFH-10-T14, AFH-10-T15, AFH-10-T16 |
| afh-11-portable-bundles | afh-01-native-identity, afh-02-incremental-archive, afh-04-temporal-provenance, afh-06-layered-semantics, afh-10-compatibility-matrix | src/bundle/, schemas/bundle-v1.schema.json, src/cli.js, test/acceptance/afh-11.test.mjs | AFH-11-T01, AFH-11-T02, AFH-11-T03, AFH-11-T04, AFH-11-T05, AFH-11-T06, AFH-11-T07, AFH-11-T08, AFH-11-T09, AFH-11-T10, AFH-11-T11, AFH-11-T12, AFH-11-T13, AFH-11-T14, AFH-11-T15, AFH-11-T16, AFH-11-T17, AFH-11-T18, AFH-11-T19 |
| afh-12-prospective-capture | afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-08-observable-performance, afh-10-compatibility-matrix | src/capture/, schemas/capture-v1.schema.json, src/cli.js, docs/capture.md, test/acceptance/afh-12.test.mjs | AFH-12-T01, AFH-12-T02, AFH-12-T03, AFH-12-T04, AFH-12-T05, AFH-12-T06, AFH-12-T07, AFH-12-T08, AFH-12-T09, AFH-12-T10, AFH-12-T11, AFH-12-T12, AFH-12-T13, AFH-12-T14, AFH-12-T15, AFH-12-T16, AFH-12-T17, AFH-12-T18 |
| afh-13-continuity-evaluation | afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance, afh-09-resident-reader, afh-10-compatibility-matrix, afh-11-portable-bundles, afh-12-prospective-capture | test/acceptance/afh-13.test.mjs, tools/evaluation/, docs/evaluation.md, schemas/evaluation-v1.schema.json | AFH-13-T01, AFH-13-T02, AFH-13-T03, AFH-13-T04, AFH-13-T05, AFH-13-T06, AFH-13-T07, AFH-13-T08, AFH-13-T09, AFH-13-T10, AFH-13-T11, AFH-13-T12, AFH-13-T13, AFH-13-T14, AFH-13-T15, AFH-13-T16, AFH-13-T17, AFH-13-T18, AFH-13-T19, AFH-13-T20 |
| afh-14-assured-release | afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance, afh-09-resident-reader, afh-10-compatibility-matrix, afh-11-portable-bundles, afh-12-prospective-capture, afh-13-continuity-evaluation | package.json, package-lock.json, SKILL.md, README.md, docs/, schemas/, test/acceptance/afh-14.test.mjs, tools/release/, .github/workflows/ | AFH-14-T01, AFH-14-T02, AFH-14-T03, AFH-14-T04, AFH-14-T05, AFH-14-T06, AFH-14-T07, AFH-14-T08, AFH-14-T09, AFH-14-T10, AFH-14-T11, AFH-14-T12, AFH-14-T13, AFH-14-T14, AFH-14-T15, AFH-14-T16, AFH-14-T17, AFH-14-T18, AFH-14-T19, AFH-14-T20 |

SPECIFICATION_READY exige revisión semántica satisfactoria del paquete exacto. READY_FOR_COORDINATOR_REVIEW es solo entrega pendiente de esa revisión. IMPLEMENTATION_READY(01) no exige 14 GREEN; exige el paquete completo revisado y sus propios predecesores. Autorización de alcance persiste entre ediciones ordinarias: cambiar digest invalida evidencia/review afectada, no exige otra aprobación humana por sí mismo. PAUSED/revocación sí bloquean. Ver TESTING.md y la función evaluateGate.

## Canonical acceptance assignment

Normal scenarios inherit OWNER_CHANGE / CHANGE_EXIT. Explicit execution consumers determine the earliest valid integration milestone; no obligation is removed. Full release completion includes POST_PUBLICATION checks.

| Scenario | Owner | Due milestone | Stage | Required consumers | Entrypoint coverage |
|---|---|---|---|---|---|
| AFH-01-T01 | 1 | 1 | CHANGE_EXIT | capability.native-identity, legacy.audit, legacy.show, legacy.evidence | BASELINE_DIAGNOSTIC; full acceptance contract-only |
| AFH-01-T02 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-01-T03 | 1 | 1 | CHANGE_EXIT | capability.native-identity | Full declared scenario contract |
| AFH-01-T04 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-01-T05 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-01-T06 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-01-T07 | 1 | 7 | CHANGE_EXIT | capability.native-identity, association.record, context.build | Full declared scenario contract |
| AFH-01-T08 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-01-T09 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-01-T10 | 1 | 4 | CHANGE_EXIT | capability.native-identity, association.record, temporal.select | Full declared scenario contract |
| AFH-01-T11 | 1 | 4 | CHANGE_EXIT | capability.native-identity, association.record, temporal.select | Full declared scenario contract |
| AFH-01-T12 | 1 | 4 | CHANGE_EXIT | capability.native-identity, association.record, temporal.select | Full declared scenario contract |
| AFH-01-T13 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-01-T14 | 1 | 4 | CHANGE_EXIT | capability.native-identity, association.record, temporal.select | Full declared scenario contract |
| AFH-01-T15 | 1 | 7 | CHANGE_EXIT | capability.native-identity, scope.resolve, query | Full declared scenario contract |
| AFH-01-T16 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-01-T17 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-01-T18 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-01-T19 | 1 | 1 | CHANGE_EXIT | capability.native-identity, legacy.audit | Full declared scenario contract |
| AFH-01-T20 | 1 | 2 | CHANGE_EXIT | capability.native-identity, archive.ingest, association.record, scope.resolve | Full declared scenario contract |
| AFH-02-T01 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T02 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T03 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T04 | 2 | 3 | CHANGE_EXIT | capability.incremental-archive, archive.ingest, ledger.occurrences | Full declared scenario contract |
| AFH-02-T05 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T06 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T07 | 2 | 3 | CHANGE_EXIT | capability.incremental-archive, archive.ingest, ledger.occurrences | Full declared scenario contract |
| AFH-02-T08 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T09 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T10 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T11 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T12 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T13 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T14 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T15 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T16 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T17 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T18 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T19 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-02-T20 | 2 | 2 | CHANGE_EXIT | capability.incremental-archive | Full declared scenario contract |
| AFH-03-T01 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger, legacy.audit, legacy.show, legacy.evidence | BASELINE_DIAGNOSTIC; full acceptance contract-only |
| AFH-03-T02 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T03 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger, legacy.audit, legacy.show, legacy.evidence | BASELINE_DIAGNOSTIC; full acceptance contract-only |
| AFH-03-T04 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger, legacy.audit, legacy.show, legacy.evidence | BASELINE_DIAGNOSTIC; full acceptance contract-only |
| AFH-03-T05 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T06 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T07 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger, legacy.audit, legacy.show, legacy.evidence | BASELINE_DIAGNOSTIC; full acceptance contract-only |
| AFH-03-T08 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T09 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger, legacy.audit, legacy.show, legacy.evidence | BASELINE_DIAGNOSTIC; full acceptance contract-only |
| AFH-03-T10 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T11 | 3 | 4 | CHANGE_EXIT | capability.occurrence-ledger, stats, temporal.select | Full declared scenario contract |
| AFH-03-T12 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T13 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T14 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T15 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T16 | 3 | 4 | CHANGE_EXIT | capability.occurrence-ledger, stats, temporal.select | Full declared scenario contract |
| AFH-03-T17 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T18 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T19 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T20 | 3 | 6 | CHANGE_EXIT | capability.occurrence-ledger, archive.ingest, semantic.build | Full declared scenario contract |
| AFH-03-T21 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-03-T22 | 3 | 3 | CHANGE_EXIT | capability.occurrence-ledger | Full declared scenario contract |
| AFH-04-T01 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T02 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T03 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T04 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T05 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T06 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T07 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance, legacy.audit, legacy.show, legacy.evidence | BASELINE_DIAGNOSTIC; full acceptance contract-only |
| AFH-04-T08 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T09 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T10 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T11 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T12 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T13 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T14 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T15 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T16 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T17 | 4 | 7 | CHANGE_EXIT | capability.temporal-provenance, temporal.select, graph.neighbors, gold.view, query, context.build | Full declared scenario contract |
| AFH-04-T18 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T19 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-04-T20 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance | Full declared scenario contract |
| AFH-05-T01 | 5 | 5 | CHANGE_EXIT | capability.governed-context, legacy.audit, legacy.show, legacy.evidence | BASELINE_DIAGNOSTIC; full acceptance contract-only |
| AFH-05-T02 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T03 | 5 | 5 | CHANGE_EXIT | capability.governed-context, legacy.audit, legacy.show, legacy.evidence | BASELINE_DIAGNOSTIC; full acceptance contract-only |
| AFH-05-T04 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T05 | 5 | 7 | CHANGE_EXIT | capability.governed-context, intent.extract, gold.view, query, context.build | Full declared scenario contract |
| AFH-05-T06 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T07 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T08 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T09 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T10 | 5 | 7 | CHANGE_EXIT | capability.governed-context, intent.extract, gold.view, query, context.build | Full declared scenario contract |
| AFH-05-T11 | 5 | 7 | CHANGE_EXIT | capability.governed-context, intent.extract, gold.view, query, context.build | Full declared scenario contract |
| AFH-05-T12 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T13 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T14 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T15 | 5 | 5 | CHANGE_EXIT | capability.governed-context, intent.extract, gold.view | Full declared scenario contract |
| AFH-05-T16 | 5 | 7 | CHANGE_EXIT | capability.governed-context, intent.extract, gold.view, query, context.build | Full declared scenario contract |
| AFH-05-T17 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T18 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-05-T19 | 5 | 7 | CHANGE_EXIT | capability.governed-context, intent.extract, gold.view, query, context.build | Full declared scenario contract |
| AFH-05-T20 | 5 | 5 | CHANGE_EXIT | capability.governed-context | Full declared scenario contract |
| AFH-06-T01 | 6 | 7 | CHANGE_EXIT | capability.layered-semantics, semantic.build, semantic.verify, query | Full declared scenario contract |
| AFH-06-T02 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T03 | 6 | 7 | CHANGE_EXIT | capability.layered-semantics, semantic.build, semantic.verify, query | Full declared scenario contract |
| AFH-06-T04 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T05 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T06 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T07 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T08 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T09 | 6 | 7 | CHANGE_EXIT | capability.layered-semantics, semantic.build, semantic.verify, query | Full declared scenario contract |
| AFH-06-T10 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T11 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T12 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T13 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T14 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T15 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T16 | 6 | 7 | CHANGE_EXIT | capability.layered-semantics, semantic.build, semantic.verify, query | Full declared scenario contract |
| AFH-06-T17 | 6 | 7 | CHANGE_EXIT | capability.layered-semantics, semantic.build, semantic.verify, query | Full declared scenario contract |
| AFH-06-T18 | 6 | 7 | CHANGE_EXIT | capability.layered-semantics, semantic.build, semantic.verify, query | Full declared scenario contract |
| AFH-06-T19 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-06-T20 | 6 | 6 | CHANGE_EXIT | capability.layered-semantics | Full declared scenario contract |
| AFH-07-T01 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T02 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T03 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T04 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T05 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T06 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T07 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T08 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T09 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T10 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T11 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T12 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T13 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T14 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T15 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T16 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T17 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T18 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T19 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-07-T20 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval | Full declared scenario contract |
| AFH-08-T01 | 8 | 8 | CHANGE_EXIT | capability.observable-performance, legacy.audit, legacy.show, legacy.evidence | BASELINE_DIAGNOSTIC; full acceptance contract-only |
| AFH-08-T02 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T03 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T04 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T05 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T06 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T07 | 8 | 9 | CHANGE_EXIT | capability.observable-performance, progress.observe, semantic.build, resident.query | Full declared scenario contract |
| AFH-08-T08 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T09 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T10 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T11 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T12 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T13 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T14 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T15 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T16 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T17 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-08-T18 | 8 | 8 | CHANGE_EXIT | capability.observable-performance | Full declared scenario contract |
| AFH-09-T01 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T02 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T03 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T04 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T05 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T06 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T07 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T08 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T09 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T10 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T11 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T12 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T13 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T14 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T15 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T16 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T17 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-09-T18 | 9 | 9 | CHANGE_EXIT | capability.resident-reader | Full declared scenario contract |
| AFH-10-T01 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T02 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T03 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T04 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T05 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T06 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T07 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T08 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T09 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T10 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T11 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T12 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T13 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T14 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T15 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-10-T16 | 10 | 10 | CHANGE_EXIT | capability.compatibility-matrix | Full declared scenario contract |
| AFH-11-T01 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T02 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T03 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T04 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T05 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T06 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T07 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T08 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T09 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T10 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T11 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T12 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T13 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T14 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T15 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T16 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T17 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-11-T18 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |
| AFH-12-T01 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T02 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T03 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T04 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T05 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T06 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T07 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T08 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T09 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T10 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T11 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T12 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T13 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T14 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T15 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T16 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T17 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-12-T18 | 12 | 12 | CHANGE_EXIT | capability.prospective-capture | Full declared scenario contract |
| AFH-13-T01 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T02 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T03 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T04 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T05 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T06 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T07 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T08 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T09 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T10 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T11 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T12 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T13 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T14 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T15 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T16 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T17 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T18 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T19 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-13-T20 | 13 | 13 | CHANGE_EXIT | capability.continuity-evaluation | Full declared scenario contract |
| AFH-14-T01 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T02 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T03 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T04 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T05 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T06 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T07 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T08 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T09 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T10 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T11 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T12 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T13 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T14 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T15 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T16 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T17 | 14 | 14 | POST_PUBLICATION | capability.assured-release, release.publish, release.verify_published | Full declared scenario contract |
| AFH-14-T18 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T19 | 14 | 14 | CHANGE_EXIT | capability.assured-release | Full declared scenario contract |
| AFH-14-T20 | 14 | 14 | POST_PUBLICATION | capability.assured-release, release.publish, release.verify_published | Full declared scenario contract |
| AFH-04-T21 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance, package.checks, package.temporal_wire_checks | Full declared scenario contract |
| AFH-04-T22 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance, package.checks, package.temporal_wire_checks | Full declared scenario contract |
| AFH-04-T23 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance, package.checks, package.temporal_wire_checks | Full declared scenario contract |
| AFH-04-T24 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance, package.checks, package.temporal_wire_checks | Full declared scenario contract |
| AFH-04-T25 | 4 | 4 | CHANGE_EXIT | capability.temporal-provenance, package.checks, package.temporal_wire_checks | Full declared scenario contract |
| AFH-05-T21 | 5 | 5 | CHANGE_EXIT | capability.governed-context, package.checks, package.provenance_checks | Full declared scenario contract |
| AFH-05-T22 | 5 | 5 | CHANGE_EXIT | capability.governed-context, package.checks, package.provenance_checks | Full declared scenario contract |
| AFH-05-T23 | 5 | 5 | CHANGE_EXIT | capability.governed-context, package.checks, package.provenance_checks | Full declared scenario contract |
| AFH-07-T21 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval, package.checks, package.wire_checks | Full declared scenario contract |
| AFH-07-T22 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval, package.checks, package.wire_checks | Full declared scenario contract |
| AFH-07-T23 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval, package.checks, package.wire_checks | Full declared scenario contract |
| AFH-07-T24 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval, package.checks, package.wire_checks | Full declared scenario contract |
| AFH-07-T25 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval, package.checks, package.wire_checks | Full declared scenario contract |
| AFH-07-T26 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval, package.checks, package.wire_checks | Full declared scenario contract |
| AFH-07-T27 | 7 | 7 | CHANGE_EXIT | capability.contextual-retrieval, package.checks, package.wire_checks | Full declared scenario contract |
| AFH-01-T21 | 1 | 1 | CHANGE_EXIT | capability.native-identity, package.checks, package.runtime_inventory | Full declared scenario contract |
| AFH-01-T22 | 1 | 1 | CHANGE_EXIT | capability.native-identity, package.checks, package.runtime_inventory | Full declared scenario contract |
| AFH-11-T19 | 11 | 11 | CHANGE_EXIT | capability.portable-bundles | Full declared scenario contract |

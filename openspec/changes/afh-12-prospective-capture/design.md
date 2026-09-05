## Context

La captura retrospectiva no puede recuperar herramientas/resultados no persistidos; hacen falta vías prospectivas opcionales sin hacer obligatoria otra plataforma.

Purpose and global integration: Capturar actividad futura autorizada mediante hook local e importación OTLP/OpenInference/AppServer, preservando límites, pérdidas y procedencia sin reejecutar ni reinventar historia ausente.

## Goals / Non-Goals

Benefit: Mejora evidencia futura de comandos/tiempos/causalidad y cobertura, manteniendo archivo/CLI utilizables sin hooks ni collector remoto.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: writer; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

capture.init crea configuración local desactivada por defecto; enabled=true requiere consentimiento actual scope/adapter/output explícito registrado como evidencia nueva. Hook recibe JSON por stdin, nunca ejecuta su payload: capture_version1, producer/session/event ID, sequence, kind (message/tool.start/tool.output/tool.end/artifact/decision), timestamp/clock_domain y payload. Append spool con length+digest+record, fsync por batch<=100 o1s, delivery_id idempotente. OTLP JSON1.11 import resourceSpans/scopeSpans/spans, trace/span/parent IDs, ns timestamps, events/status/attributes; missing end se conserva INCOMPLETE. Status OK de span es reporte de instrumentation, no exit0 ni task validation. OpenInference es OTLP con attrs openinference.span.kind/input.value/output.value/llm.*; redacción antes de proyección, raw privado y exclusiones visibles. AppServer0.144.5: importar eventos documentados item started/completed y thread/turn ids con schema digest. No iniciar/desplegar agentes ni interceptar memoria privada; datos se entregan por harness/hook opt-in.

Interfaces: capture.init, capture.append, capture.status, afh capture append --request params.json. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

Un spool local acotado es suficiente para persistir eventos disponibles del productor. Los formatos compartidos no exigen collector remoto ni convertir AFH en plataforma de telemetría.

Rechazados: capturar todo sistema por defecto; instalar hooks globales sin opt-in; inferir eventos antiguos ausentes; autoejecutar acciones transmitidas; convertir un span OK en prueba de objetivo logrado.

### Persistence, concurrency and idempotence

Spool privado segmentado256MiB, total4GiB, append-only con consent/config digest, source producer/version y clock domain. Full spool rechaza y cuenta delivery rechazada; dropped unknown si productor no informó. Ingester usa mismo archive writer e identidades/occurrence mapping. No mantener otra base principal.

### Integration and dependencies

Utiliza identity01/archive02/ledger03/temporal04, progress08 y compatibility10; datos de captura se interpretan como evidencia, no comandos del agente actual. La skill explica habilitación y límites observables.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-08-observable-performance, afh-10-compatibility-matrix. One writer executes the full ordered program.

## Migration Plan

Sin configuración, producto funciona en retrospectivo como antes. Formatos desconocidos se preservan con warning. Hooks genéricos invocables por cualquier harness sin plugin obligatorio; AppServer/version exactos no se universalizan a otros releases.

Torn last frame se conserva/reportado, último offset fsync es checkpoint. Reenvío mismo delivery_id+hash no duplica evento; mismo ID/diferentes bytes -> IDEMPOTENCY_CONFLICT. Crash/restart no inventa herramienta final ni continúa un clock domain distinto.

Expected write set: src/capture/, schemas/capture-v1.schema.json, src/cli.js, docs/capture.md, test/acceptance/afh-12.test.mjs.

## Risks / Trade-offs

Pérdidas antes de entrada al hook o collector inexistente son desconocidas. Timestamps de procesos distintos no acreditan duración comparable. Inputs/outputs pueden contener secretos: spool privado, redacción en proyecciones y exclusiones auditables.

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

18 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

## Context

La carga de modelo en cada CLI agrega segundos; añadir un servidor sin medir o con otro ranking crearía divergencia y superficie de escritura innecesaria.

Purpose and global integration: Ofrecer un reader local opcional que mantenga modelos/handles residentes y ejecute el mismo núcleo de consulta con aislamiento, límites y paridad verificables.

## Goals / Non-Goals

Benefit: Reduce la latencia recurrente de consultas privadas cuando se usa residencia, conservando CLI embebido y archivo legible sin servicio.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: reader, semantic; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Proceso explícito serve con named pipe Windows de usuario o socket Unix0600; handshake token de archivo owner-only y negociación exacta protocol4.0. Allowlist cerrada: query,stats,context.build,event.show,evidence.read,graph.neighbors,graph.path,archive.verify,semantic.verify,scope.resolve. Todos invocan el mismo archiveRequest reader. Negar mutaciones antes de abrir rutas. Máximo4 requests activas/16 queue/1 embedding batch, deadline30s, idle900s, lifecycle STARTING→READY→DRAINING→STOPPED. Open/verify pinned archive and projection identity antes de READY; nueva publicación abre handles verificados, in-flight mantiene generación vieja. Frame medido <=8MiB común.

Interfaces: afh serve, resident.status, resident.stop, reader-only archiveRequest over IPC. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

Compartir proceso/modelo elimina cold-start repetido sin cambiar autoridad ni arquitectura de datos. IPC local limita exposición y evita HTTP/MCP obligatorios.

Rechazados: daemon de sistema autoarrancado; bind0.0.0.0; servidor con writer/index API; ranking residente alternativo; token en logs o argumentos shell públicos.

### Persistence, concurrency and idempotence

Servicio no escribe corpus ni proyecciones. Solo archivos de endpoint/token/log privado con permisos de propietario y lifecycle propio. Token aleatorio se borra al cierre limpio de su propio endpoint; no tocar endpoints ajenos. Read-only inventory debe permanecer igual.

### Integration and dependencies

Depende del planner07 y métricas08; no imports de archive writer/context mutation modules. Architecture tests sobre archivos reales nuevos deben demostrar allowlist y ausencia de ciclos nuevos.

Dependencies: afh-02-incremental-archive, afh-04-temporal-provenance, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance. One writer executes the full ordered program.

## Migration Plan

CLI directo siempre funciona si no hay servicio. Servicio caído retorna UNAVAILABLE si se pidió explícitamente; fallback a direct-cli solo mediante flag visible y con mismo request. No instalación global ni servicio OS obligatorio.

Crash del reader no cambia archivo. Reinicio vuelve a verificar identidad. Rotación de endpoint por owner verificado; stop drena hasta30s y cancela pendientes con IDs, sin matar procesos ajenos. Saturación devuelve BUSY con retryable true y cola acotada.

Expected write set: src/resident/, src/cli.js, test/acceptance/afh-09.test.mjs.

## Risks / Trade-offs

Protección Windows requiere prueba de ACL/named pipe de mismo usuario; si runtime no puede imponerla, no publica READY. Servicio reduce carga de modelo, no elimina coste de verificación/IO ni garantiza velocidad sin medición real.

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

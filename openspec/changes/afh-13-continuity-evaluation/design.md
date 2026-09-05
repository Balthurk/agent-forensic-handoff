## Context

Un score de ranking, test unitario o resumen acertado no acredita que otro agente pueda retomar el trabajo correcto con restricciones y evidencia suficientes.

Purpose and global integration: Acreditar recuperación y continuación útil mediante respuestas compuestas con oráculos independientes, ensayos ciegos reales y escala sostenida reproducible que incluyan fallos, memoria y cobertura.

## Goals / Non-Goals

Benefit: Permite comparar versiones sobre tareas y datos idénticos y descubrir regresiones que solo aparecen con muchas sesiones, deltas e índices locales reales.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: reader, semantic; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Dos cohortes de12 tareas emparejadas por dificultad (exactitud, relaciones, temporalidad, misión, fallos y estado;2 de cada tipo). Cohorte pública valida scoring; una persona/coordinador independiente prepara12 casos y soluciones ocultas antes de congelar candidato. Custodio guarda hashes/manifests/soluciones fuera del checkout; implementador no las ve. Por tarea y brazo baseline0.3/candidate, crear agente nuevo con historial vacío, mismo modelo/revisión/parámetros, presupuesto máximo32000 tokens y30min, sin red y solo copia del workspace sintético, AFH elegido y prompt de objetivo sin solución. No reutilizar agentes entre brazos/tareas. Cada agente entrega cambio/acción y evidencia; evaluador independiente desconoce brazo hasta sellar resultados. Son24 ejecuciones ciegas reales; contratos/fixtures no sustituyen agente. Réplicas inválidas por entorno se preservan y se repiten identificadas, sin seleccionar mejores. Escala:3 runs independientes de1m registros semilla404,7 deltas de1000 cada uno y100 queries fijas por fase; corpus recipe/bytes/model/config idénticos por brazo. Materializar fuera de Git, medir proceso y archivos, verificar integridad y negativos después de cada delta/crash.

Interfaces: query, context.build, archive.verify, node tools/evaluation/run.mjs --manifest <file>. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

El protocolo separa capacidad semántica, corrección del scoring y rendimiento del producto. Una solución guardada antes del candidato reduce contaminación; fallos de agente y fallos de entorno quedan distinguibles.

Rechazados: continuaciones escritas por el implementador; llamar ciego a un fixture; inferir éxito por retrieval score; eliminar intentos fallidos; convertir benchmark corto en escala sostenida; comparar tiempos con diferentes modelos/scope sin estratificar.

### Persistence, concurrency and idempotence

Manifests versionados con corpus/revision/task/model/tokenizer digests, instrucciones, límites, candidate commit, orden aleatorio semilla404, entregables y traces privados. Informe público solo agregado y fixtures sintéticos revisados. Resultados por tarea y categoría conservan denominadores, invalid trials y cada afirmación/evidencia. Sin datos de conversaciones reales en Git/CI.

### Integration and dependencies

Aplica contratos01–12 y operaciones medibles. Thresholds por categoría: critical recall1, precision>=.95, unsupported claim rate0, provenance/timeline accuracy1. Continuation success>=11/12 tareas por brazo candidato y ningún incumplimiento crítico de autorización/preservación. Comparación pareada se publica completa; no se promete significancia estadística con12 tareas. Escala requiere límites de OPERATIONS y sin crecimiento acumulativo no acotado tras7 deltas.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance, afh-05-governed-context, afh-06-layered-semantics, afh-07-contextual-retrieval, afh-08-observable-performance, afh-09-resident-reader, afh-10-compatibility-matrix, afh-11-portable-bundles, afh-12-prospective-capture. One writer executes the full ordered program.

## Migration Plan

Baseline0.3 usa API/CLI disponibles, no adapter que añada funciones nuevas. Limitaciones se reportan; scoring común mide resultado observable de tarea. Fixtures de proveedor prueban mecánica aparte; el benchmark semántico usa modelo real local idéntico y offline.

Crash de índice o proceso de benchmark conserva receipt parcial, RSS pico hasta interrupción y trabajo confirmado; repetir con run_id nuevo. Corrupción/integridad fallida bloquea toda aceptación, no se excluye del promedio. Falta de24 agentes/trials o runner/modelo obliga estado UNAVAILABLE/INCOMPLETE.

Expected write set: test/acceptance/afh-13.test.mjs, tools/evaluation/, docs/evaluation.md, schemas/evaluation-v1.schema.json.

## Risks / Trade-offs

Juez LLM puede equivocarse: la verdad del fixture es determinista y cada desacuerdo crítico requiere revisión independiente conservada. Una tarea resuelta no generaliza a todo harness/dominio. Agentes nuevos solo se crean en fase de implementación/evaluación por el coordinador autorizado, nunca se simulan en este paquete.

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

20 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

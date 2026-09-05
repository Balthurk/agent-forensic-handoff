## Context

event.observed_at y claim.current no describen correcciones bitemporales; una orden posterior igual elimina contradicciones sin binding al objetivo, y el grafo legado mezcla orientación de supersession.

Purpose and global integration: Versionar vigencia y conocimiento de afirmaciones, relaciones y artefactos para reconstruir qué ocurrió, qué se sabía en cada corte y qué causalidad está demostrada.

## Goals / Non-Goals

Benefit: Evita usar estado futuro en consultas históricas y permite investigar intentos, patches, revisiones descartadas y validaciones con la cadena exacta de evidencia.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: writer, reader; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

Seleccionar última revisión conocida por assertion_id+branch_id, nunca por sujeto; evaluar después vigencia de TODOS los tramos. Corregir pares de frontera como batch único con expected_revision_id. Query SQL usa recorded_seq<=published_seq y recorded_at<=known_at con comparación temporal normalizada que conserva precision. Relaciones llevan extremos tipados, grade/regla/version/evidence y dirección v4 uniforme. Crear SUPPORTS/VALIDATES solo con target revision/hash explícito; misma orden/adyacencia no prueba reparación. Ingerir patches unificados y apply_patch add/update/delete/move como evidencia descriptiva; Git parent/tree/blob solo de objetos o resultados persistidos con object_format/OID comprobados, sin ejecutar el histórico.

Interfaces: graph.neighbors, graph.path, event.show, query temporal, stats effects. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

Una afirmación temporal es un tramo independiente, y la revisión correctiva modifica lo conocido sobre ese tramo. Sin esa distinción el algoritmo latest-row elimina pasado legítimo. El vínculo de validación debe referirse a contenido/objetivo, no a una coincidencia de comando.

Rechazados: usar fecha de evento como known_at; última fila por sesión; MAX timestamp como autoridad; revocar por posterioridad; reconstruir contenido de patch incompleto como si fuese exacto.

### Persistence, concurrency and idempotence

Temporal revisions y relation revisions append-only con commit_seq común. Proyecciones de intervalo son derivadas; current legacy solo vista. Direcciones RESULT_OF=result→call y SUPERSEDES=new→old; conversión legacy documentada en receipt. Índices por assertion/branch/recorded_seq y extremos/time/scope.

### Integration and dependencies

Selector único suministra 05/06/07/09. Grafo Plata cubre entidades no promovidas; Oro selecciona vistas sin alterar edges originales. Utilidad agrega execution→artifact revision→validation→task criterion.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger. One writer executes the full ordered program.

## Migration Plan

Casos schema1-3 siguen leídos según semántica histórica y aliases; nueva proyección v4 declara conversiones y límites. No mutar source/git objects ni reescribir revisiones rechazadas.

Crash durante batch temporal debe exponer a1/b1 o a2/b2, nunca frontera mixta. Clock regression bloquea nueva publicación; no retrodatar conocimiento. Readers paralelos mantienen su corte durante publicación.

Expected write set: src/archive/temporal.js, src/archive/provenance.js, src/graph.js, src/reducers.js, schemas/, test/acceptance/afh-04.test.mjs.

## Risks / Trade-offs

Times unknown/open o relojes no comparables producen incertidumbre. Edge inferida puede ser útil para descubrimiento pero no corroboración independiente. Un patch sin preimage no acredita bytes finales.

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

25 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

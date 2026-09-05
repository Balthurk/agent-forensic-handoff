## Context

El reducer actual toma el último mensaje humano como misión y solo reconoce marcadores literales; una delegación en tool output desaparece del hot context.

Purpose and global integration: Separar conocimiento seleccionado de proyecto e intención vigente de tarea, conservando misión, decisiones, cambios humanos y delegaciones con evidencia y versiones históricas.

## Goals / Non-Goals

Benefit: Un agente sucesor recibe el objetivo correcto y sus límites sin convertir una petición incidental o una frase de un agente en autoridad humana.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: writer; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

afh-intent-v1 extrae el primer encargo sustantivo y declaraciones explícitas de cambio/cancelación sin exigir Decision:. Para texto ES/EN reconoce verbos imperativos y frases de elección (usa/use, conserva/preserve, elijo/choose, prefiero/prefer, cambia/change, cancela/cancel) con sujeto/objeto y rango exacto; otros mensajes humanos se conservan como candidatos de intención sin decidir automáticamente su alcance. Sin cambio explícito de programa, petición nueva crea assignment/incidental asociado y no sustituye PROGRAM_MISSION. Parsear envelopes codex_delegation desde result con límites de profundidad/bytes, enlazar source_thread_id/target/call/result; verificar cada hop humano→delegación→transmisión→review. Origin ausente produce AGENT_ATTRIBUTED/UNKNOWN y UNRESOLVED, preservando assignment candidato. Gold acepta origen directo/resuelto o review actual con evidencia; no promueve interpretaciones como hechos de software.

Interfaces: intent.extract, intent.review, gold.promote, gold.revise, context.build, auditSession. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

Toda decisión humana sustantiva debe seguir recuperable aunque la extracción no interprete su intención con certeza. Conservar candidatos en Plata minimiza pérdida y la cadena permite distinguir autoridad de una atribución no sustentada.

Rechazados: latest-user-message sustituye programa; regex Decision: como único detector; resumen de agente como aprobación humana; ranking/repetición como promoción automática; usar LLM remoto obligatorio para normalizar.

### Persistence, concurrency and idempotence

intent_version y gold_promotion tienen assertion_id por tramo, branch/revision, evidence y valid/known. Regla versionada, texto original y transformación LITERAL/EXTRACTED/INTERPRETED. En nuevas capturas legacy la proyección claim subject=mission,predicate=task_assignment expone object_json text/recipient_session_id/origin_session_id/origin_status/authority_chain:[{event_id,evidence_uri}]; evidence_refs_json contiene refs de transmisión. Origen no adquirido => origin_status=UNRESOLVED, nunca HUMAN_VERIFIED.

### Integration and dependencies

Usa identidad 01, bitácora 03 y temporal 04. Provee chunks Oro a 06 y packs a 07; información no promovida permanece en Plata. Procedimiento de skill exige abrir evidencia consecuencial y reconciliar estado actual antes de escribir en un proyecto.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance. One writer executes the full ordered program.

## Migration Plan

Hot/warm/cold siguen accesibles. Capturas nuevas incluyen program_mission/task_assignment por separado; paquetes viejos no se reescriben. Skill cambia en copia versionada y se prueba aislada; instalación global no se actualiza en esta entrega.

Extracción/promoción se aplica idempotente por rule_version+input revisions; cambio de reglas genera otra vista sin borrar anterior. Batch de revisión de intención y Gold coherente con selector temporal y publication único.

Expected write set: src/reducers.js, src/render.js, src/context/intent.js, src/context/gold.js, skills/agent-forensic-handoff/, test/acceptance/afh-05.test.mjs.

## Risks / Trade-offs

Lenguaje ambiguo no permite clasificación completa automática; receipt expone extracción y candidatos sin resolver. El sistema prueba origen de instrucciones, no autenticidad universal ni vigencia de permiso de un agente fuera del encargo actual.

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

23 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

## Acceptance milestone 5

Due full acceptance: AFH-05-T01, AFH-05-T02, AFH-05-T03, AFH-05-T04, AFH-05-T06, AFH-05-T07, AFH-05-T08, AFH-05-T09, AFH-05-T12, AFH-05-T13, AFH-05-T14, AFH-05-T15, AFH-05-T17, AFH-05-T18, AFH-05-T20, AFH-05-T21, AFH-05-T22, AFH-05-T23.

Owned obligations deferred (not GREEN): AFH-05-T05 -> 7 CHANGE_EXIT, AFH-05-T10 -> 7 CHANGE_EXIT, AFH-05-T11 -> 7 CHANGE_EXIT, AFH-05-T16 -> 7 CHANGE_EXIT, AFH-05-T19 -> 7 CHANGE_EXIT.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

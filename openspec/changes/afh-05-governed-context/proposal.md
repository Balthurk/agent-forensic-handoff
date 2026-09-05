## Why

El reducer actual toma el último mensaje humano como misión y solo reconoce marcadores literales; una delegación en tool output desaparece del hot context.

Un agente sucesor recibe el objetivo correcto y sus límites sin convertir una petición incidental o una frase de un agente en autoridad humana.

## What Changes

Separar conocimiento seleccionado de proyecto e intención vigente de tarea, conservando misión, decisiones, cambios humanos y delegaciones con evidencia y versiones históricas.

## Capabilities

### New Capabilities

- `governed-context`: Separar conocimiento seleccionado de proyecto e intención vigente de tarea, conservando misión, decisiones, cambios humanos y delegaciones con evidencia y versiones históricas.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: intent.extract, intent.review, gold.promote, gold.revise, context.build, auditSession. Write set: src/reducers.js, src/render.js, src/context/intent.js, src/context/gold.js, skills/agent-forensic-handoff/, test/acceptance/afh-05.test.mjs. Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-03-occurrence-ledger, afh-04-temporal-provenance. All shared profiles are normative: writer.

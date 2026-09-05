## Why

El adaptador Codex prioriza session_id compartido sobre payload.id; session.cwd es un campo actual único. El probe AFH-01-T01 confirma atribución errónea aun con integridad profunda verde.

Establece claves correctas para incremental, ocurrencias, grafo, contexto y partición por ámbito; evita duplicar conversaciones al cambiar de ubicación.

## What Changes

Conservar la identidad nativa de cada hilo y su historial de proyecto/workspace/checkout para que agentes y consultas no atribuyan trabajo de un hijo a su padre ni reasignen su pasado.

## Capabilities

### New Capabilities

- `native-identity`: Conservar la identidad nativa de cada hilo y su historial de proyecto/workspace/checkout para que agentes y consultas no atribuyan trabajo de un hijo a su padre ni reasignen su pasado.

### Modified Capabilities

No existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.

## Impact

Interfaces: auditSession, archiveRequest association.record, archiveRequest scope.resolve. Write set: src/adapters.js, src/discovery.js, src/audit.js, src/archive/identity.js, src/archive/associations.js, schemas/, test/acceptance/afh-01.test.mjs. Dependencies: none. All shared profiles are normative: writer.

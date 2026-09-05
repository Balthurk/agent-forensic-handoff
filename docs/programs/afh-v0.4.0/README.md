# AFH 0.4.0 — programa de evolución

Este paquete especifica y prepara TDD. **El runtime sigue en 0.3.0.** La preparación documental, los tests del paquete y un RED observado son estados diferentes de la aceptación del producto.

## Resultado que se construye

Un mismo núcleo local mantiene un archivo incremental y recupera contexto verificable para agentes. La ingesta conserva evidencia inmutable, estructura todas las ocurrencias observables y versiona asociaciones, decisiones y relaciones. La recuperación combina el conocimiento seleccionado del proyecto con el encargo vigente de la tarea, sus restricciones, resultados comprobados, fallos y pendientes. Dos interfaces comparten SQLite y contratos; el servicio residente es opcional.

La unidad estable es la sesión nativa dentro de su harness. Proyecto lógico, workspace, checkout, agrupación, padre/hijo, captura, evento, ocurrencia y representación técnica son entidades diferentes. El modelo preserva sus relaciones históricas. Bronce conserva bytes; Plata normaliza y enlaza; Oro selecciona y versiona. Ninguna capa convierte una afirmación en verdad por repetición o similitud.

## Lectura normativa y precedencia

1. Este índice, `SCOPE.md` y `GLOSSARY.md`: objetivo, límites y significados.
2. `ARCHITECTURE.md`, `DATA-CONTRACT.md`, `API-CONTRACT.md`, `OPERATIONS.md`: decisiones comunes que cada cambio hereda.
3. `openspec/changes/afh-01-*` a `afh-14-*`: propuesta, comportamiento observable, diseño y tareas ordenadas por capacidad.
4. `specification/contracts.json`, `specification/fixtures/` y `TESTING.md`: inputs, oráculos y evidencia exigida.
5. `REQUIREMENTS.md`, `RECOMMENDATIONS.md`, `REVIEW-CHECKLIST.md`, `HANDOFF.md`: cobertura, revisión y entrega.

Los IDs de requisitos son `AFH-01-R01`… y los de escenario/test `AFH-01-T01`…. Un test puede cubrir varias cláusulas, pero cada cláusula tiene un oráculo verificable. Las definiciones comunes forman parte de **cada** especificación; no se reinterpretan por capacidad. Si dos contratos se contradicen, el cambio queda `CHANGES_REQUESTED` hasta corregir el paquete; no se elige silenciosamente el texto conveniente.

Las especificaciones actuales en `openspec/specs/legacy-case-access` describen únicamente el baseline revalidado. Los cambios propuestos quedan bajo `openspec/changes` hasta GREEN, revisión y archive. Se usa el esquema oficial `spec-driven`. `isPlanningComplete` solo informa existencia de artefactos.

## Orden del programa

| Orden | Capacidad | Aporta al resultado |
|---|---|---|
| 01 | native-identity | Hilos y asociaciones correctas, sin atribuir hijos al padre |
| 02 | incremental-archive | Bronce/CAS, revisiones y continuidad de IDs y URIs |
| 03 | occurrence-ledger | Bitácora completa, ejecuciones y recuentos exactos |
| 04 | temporal-provenance | Vigencia/conocimiento y grafo causal verificable |
| 05 | governed-context | Misión, autoridad, decisiones y Oro versionado |
| 06 | layered-semantics | Embeddings de Plata/Oro con reuso y checkpoints |
| 07 | contextual-retrieval | Planes de consulta, respuestas y context packs |
| 08 | observable-performance | Progreso, ETA y presupuestos medidos |
| 09 | resident-reader | Worker local opcional y paridad CLI/API |
| 10 | compatibility-matrix | Harness/version y cinco plataformas verificadas |
| 11 | portable-bundles | Exportación cifrada, firmada y relocalizable |
| 12 | prospective-capture | Captura futura opt-in con límites observables |
| 13 | continuity-evaluation | Calidad compuesta, continuación ciega y escala sostenida |
| 14 | assured-release | Fuzzing, SBOM, firma, instalación y publicación comprobada |

El orden es secuencial para un único implementador. Las dependencias semánticas se registran por cambio; que dos cambios sean independientes no habilita otro escritor. Todo el programa se define y revisa antes de implementar 01.

## Punto de partida y herramientas

Repositorio: https://github.com/Balthurk/agent-forensic-handoff.git. Base observada `8560c48f1e81c16feb8f2149841d835175e0ba58`, rama remota `main`, producto 0.3.0. El tag 0.3.0 apunta al commit de release `c513a21465dc92423d8d6160da7dd6785a40a983`; el commit posterior documenta activación. Versión objetivo 0.4.0, CLI legado compatible y nuevo archivo schema 4. Matriz Node 22.15+/24.

OpenSpec npm `@fission-ai/openspec@1.12.0`, Node observado `24.15.0`, npm `11.12.1`. Herramienta privada de desarrollo en `tools/specification`; el producto no depende de ella. Comandos:

```powershell
npm ci --ignore-scripts
npm ci --prefix tools/specification --ignore-scripts
$env:OPENSPEC_TELEMETRY='0'
$env:DO_NOT_TRACK='1'
node tools/specification/node_modules/@fission-ai/openspec/bin/openspec.js validate --all --strict --no-interactive --json
node specification/validate-package.mjs
```

Documentación primaria consultada el 2026-09-05: [OpenSpec 1.12.0](https://github.com/Fission-AI/OpenSpec/tree/v1.12.0), [referencia CLI](https://github.com/Fission-AI/OpenSpec/blob/v1.12.0/docs/cli.md) y [esquema spec-driven](https://github.com/Fission-AI/OpenSpec/blob/v1.12.0/schemas/spec-driven/schema.yaml). El CLI comprueba estructura; los contratos y pruebas adicionales de AFH comprueban precisión y comportamiento.

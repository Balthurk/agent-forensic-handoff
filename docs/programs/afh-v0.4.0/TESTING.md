# TDD, evidencia y aceptación

## Qué acredita cada ejecución

El registro `specification/contracts.json` es la fuente de requisitos, escenarios, fixtures/oráculos y checks heredados. `validate-package.mjs --generate` produce explícitamente las vistas y los14 cambios OpenSpec. El modo predeterminado solo lee: comprueba schema, referencias/digests, cobertura en ambas direcciones, ejemplos normativos, herencia y dependencias sin ciclos y coherencia de vistas. No corrige ni genera en secreto. La identidad del paquete es SHA256 del inventario ordenado que devuelve packageSnapshot; el commit identifica además el checkout. Los reportes se escriben fuera del paquete para evitar autorreferencia.

`node --test specification/validate-package.test.mjs` comprueba el validador y los oráculos con positivos y contraejemplos. Es PACKAGE_VALIDATION, no aceptación del motor4.0. Los escenarios `CONTRACT_ONLY` tienen entrada futura exacta, fixture/recipe, precondiciones, resultado esperado y clase de evidencia; el implementador materializa primero ese harness sin cambiar el oráculo. Archivo/API ausente es NOT_IMPLEMENTED. Tras materializarlo y verificar sus precondiciones, un assert que falla por comportamiento observado es RED_BEHAVIOR. Error de import/schema/SQL/IO/config/provider o pérdida de fixture es ERROR_MECHANICAL_OR_PRECONDITION y no cuenta como RED útil ni GREEN.

Baseline0.3.0: `npm run check` se ejecutó realmente en Windows/x64, Node24.15.0 sobre8560c48f1e81c16feb8f2149841d835175e0ba58;30 tests,29 PASS,0 FAIL y1 SKIP por permisos de symlink. Ese skip no acredita seguridad de symlinks. Pruebas de skill y paquetes son checks separados. No existe aún evidencia de los cinco targets ni de continuación/escala4.0.

## Reproducción aislada

Desde el checkout, instalar dependencias de producto y `tools/specification` con `npm ci --ignore-scripts`. Fijar `TEMP`, `TMP` y `npm_config_cache` a subdirectorios privados NUEVOS del RUN antes de pruebas; no apuntar al caso fuente. OpenSpec usa OPENSPEC_TELEMETRY=0 y DO_NOT_TRACK=1. Comandos principales:

```powershell
node specification/validate-package.mjs
node --test specification/validate-package.test.mjs
node tools/specification/node_modules/@fission-ai/openspec/bin/openspec.js validate --all --strict --no-interactive --json
npm run check
node specification/regression-probes.mjs --expect-red --out '<NEW_PRIVATE_RUN>'
```

`--expect-red` sirve solo para observar el baseline defectuoso: exit0 significa que todos los probes seleccionados fallaron por comportamiento y ninguno por mecánica. Sin esa opción, exit0 exige todos GREEN. `--only AFH-05-T01` limita a un probe. Un selector inexistente o inventario inestable devuelve error. Ningún comando histórico del corpus se ejecuta. El archivo report.json se crea una sola vez en un RUN ausente, nunca se sobreescribe.

Cada run conserva HEAD real before/after, product version, archivos propios efectivos de src/bin/schemas/manifests incluso untracked, SHA256 before/after, runner/helper, inputs/case hashes, Node/OS/arch y tres ejes independientes: input_class, runtime_class y provider_class. Cambios de alta/baja/bytes durante la corrida implican EVIDENCE_UNSTABLE y bloquean aceptación. El inventario no incluye vendor; package-lock y la identidad real del proveedor/modelo declaran dependencias. Comparar snapshots no prueba ausencia de una modificación que se revirtió entre ambas lecturas; el único escritor y la exclusión de procesos mutadores siguen siendo precondiciones explícitas.

## Oráculos que no pierden información

Cada negativo conserva la entidad/ocurrencia y sus referencias, incluso UNKNOWN/INCOMPLETE; cero filas no equivale a estado desconocido. Counts exactos se prueban junto a identidad/status/exit de cada fila. La procedencia de misión verifica event_id y URI registrados en el mismo caso, abre bytes mediante readEvidence y verifica misión, destinatario y transmisión. Un sobre del hijo sin evento humano del padre conserva origen UNRESOLVED. Tests del oráculo construyen una claim de prueba para validar la comprobación; no insertan esa claim en producto ni la presentan como extracción implementada.

Rangos temporales se comparan a nanosegundos con incertidumbre explícita según DATA-CONTRACT. Los tests lógicos A/B verifican el resultado esperado del fixture; el GREEN funcional exige consultas contra el selector real y todos sus consumidores. El schema y checks transversales validan cada request, response, progress y receipt. evidence.read exige además request/response/manifest/cursor: identidad, offset, bytes, remaining y frame íntegro UTF8 incluido base64. El estimador /3 se etiqueta estimado; hard cap exige tokenizer identificado y conteo real. JSON/schema por sí solo no acredita relaciones entre registros.

## Secuencia por cambio

1. Validar paquete completo y gate IMPLEMENTATION_READY(change). La entrada01 no exige GREEN de14; exige paquete revisado, autorización vigente y writer exclusivo. La entrada02 exige01 GREEN, y así sucesivamente. `depends_on` añade relaciones semánticas, sin habilitar concurrencia.
2. Congelar fixture/oráculo y materializar el test file indicado. Ejecutar positivos de precondiciones/preservación, baseline y nuevos escenarios. Conservar RED conductuales y ausencias/mecánica por separado antes de editar producción.
3. Implementar el mínimo dentro del write set, manteniendo la misma API/semántica. Obtener GREEN real en todos los escenarios del cambio con sus clases de evidencia y checks heredados; integrar anteriores.
4. Refactorizar después de GREEN. Architecture tests enumeran módulos reales y dependencias nuevas; conjunto vacío es NOT_IMPLEMENTED. Repetir checks afectados, baseline, integridad y privacidad; registrar commit, review y evidencia antes del siguiente cambio.

Los tests de proceso/crash usan procesos propios, failpoints enumerados, directorios nuevos y verificación before/after. Los de provider fixture no acreditan semántica real. El identificador REAL_LOCAL exige modelo/revisión/digests/runtime/dtype/dimensions/pooling/normalización/chunking/redacción observados; no basta imprimir su nombre. Cualquier condición requerida UNAVAILABLE, skip, timeout o parser error bloquea su gate hasta tener evidencia adecuada.

## Continuación ciega y escala

AFH13 define12 tareas por brazo (24 agentes nuevos), con custodia de labels anterior al candidato y evaluación independiente. El implementador no diseña sus propios casos ocultos ni ve soluciones. Se congelan prompt/seed/model/parametrización/budget/inputs; cada agente recibe solo objetivo, copia sintética y versión asignada. No hay historial compartido entre brazos. El evaluador sella resultados antes de revelar brazo. Deben guardarse traces reales y artefactos, fallos y repeticiones justificadas. Los nombres de tareas/agentes, modelo observado y disponibilidad de herramientas se registran. Si no pueden ejecutarse esos agentes, el resultado permanece UNAVAILABLE. Los fixtures públicos prueban el scoring y no sustituyen esta evidencia. El custodio/coordinador organiza estos ensayos en la fase de implementación autorizada; este paquete no los ejecuta ni delega agentes.

Los thresholds de13 son criterios de esta release: critical recall1, precision>=.95, unsupported claim rate0, provenance y timeline1; continuación>=11/12 tareas y cero violaciones críticas. Se publican resultados por categoría y pares, sin afirmar significancia con12 tareas. Para escala se requieren3 runs reales de1m registros,7 deltas/run y100 preguntas fijas/fase con modelo local idéntico, mediciones de OPERATIONS, integridad y conteos exactos. Semilla/receta permiten recrear datos privados grandes; no se versionan gigabytes de fixtures. Los resultados históricos Reader son contexto, no baseline intercambiable con este corpus/configuración.

## Estado derivado y revisión

`evaluateGate` consume validación actual, snapshot y un contexto con authorization_ref, review_ref y evidence. No busca permisos dentro de un rollout ni confía en instrucciones del corpus. La revisión debe ser del coordinador/revisor designado, con identidad, resultado SATISFACTORY, source_ref resoluble, digest del paquete y cero findings materiales. Las evidencias openspec/schema/package_tests/traceability/oracle_review se ligan al mismo snapshot, ejecución real y resultado; referencias son atestaciones que el coordinador debe abrir y comprobar, no prueba de autenticidad por tener un string. El evaluador no despacha tareas ni concede autoridad.

La autorización lleva status ACTIVE, source_ref y scope que contiene afh-v0.4.0. Su vigencia es por alcance; no expira por cambios ordinarios de digest. Revisión/evidencia desactualizadas sí impiden entrar hasta revalidación aplicable. PAUSED/revocación prevalecen. Writer incluye task_id, exclusive=true y write_set exacto. Cada predecesor lleva change_id, package_sha256, candidate_commit, evidence_ref, status GREEN, required_tests_passed=true y mechanical_errors=0; el coordinador comprueba que su commit es ancestro del candidato actual y que una edición posterior no invalidó esos resultados.

READY_FOR_COORDINATOR_REVIEW indica paquete entregado con revisión semántica global pendiente. SPECIFICATION_READY exige esa revisión; IMPLEMENTATION_READY(change) añade writer/predecesores. Ninguno significa PRODUCT_ACCEPTED o RELEASE_READY. Pruebas del gate rechazan paquetes vacíos, referencias rotas, ciclos, evidence stale, fixture como real, errores mecánicos y PAUSED. No se genera evidencia SATISFACTORY ficticia para hacer pasar un gate de entrega.

## Purpose

Acreditar recuperación y continuación útil mediante respuestas compuestas con oráculos independientes, ensayos ciegos reales y escala sostenida reproducible que incluyan fallos, memoria y cobertura.

## ADDED Requirements

### Requirement: AFH-13-R01 Respuestas compuestas con verdad declarada

AFH SHALL evaluar unidades y composición completa contra gold labels independientes, conservando omisiones, afirmaciones no soportadas y evidencia verificable por unidad.

#### Scenario: AFH-13-T01 Respuesta multi-hijo completa
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Respuesta multi-hijo completa: {"required_children":2,"one_final_missing":true}.
- **WHEN** Puntuar respuesta con ambos hijos, refs y final faltante explícito.
- **THEN** Resultado exacto {"precision":1,"critical_recall":1,"unsupported_claims":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T01.

#### Scenario: AFH-13-T02 Respuesta omite hijo incómodo
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Respuesta omite hijo incómodo: {"answer_children":1,"required_children":2}.
- **WHEN** Aplicar mismo scoring con ausencia del hijo sin terminal.
- **THEN** Resultado exacto {"critical_recall":0.5,"acceptance":"BLOCKED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T02.

#### Scenario: AFH-13-T03 Afirmación sin evidencia
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Afirmación sin evidencia: {"invented_claim":"All reviews approved."}.
- **WHEN** Añadir afirmación no soportada y comprobar su penalización aunque el resto sea correcto.
- **THEN** Resultado exacto {"unsupported_claims":1,"acceptance":"BLOCKED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T03.

### Requirement: AFH-13-R02 Métricas con denominadores

AFH SHALL calcular precision/recall crítico/provenance/timeline/unsupported claim rate por categoría y agregado, con denominadores exactos y undefined explícito.

#### Scenario: AFH-13-T04 Denominadores exactos
- **GIVEN** Dataset quality (synthetic, seed 404), variante Denominadores exactos: {"true_positive":19,"false_positive":1,"false_negative":1}.
- **WHEN** Calcular métricas desde unidades etiquetadas sin promediar porcentajes incompatibles.
- **THEN** Resultado exacto {"precision":0.95,"recall":0.95}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T04.

#### Scenario: AFH-13-T05 Denominador cero
- **GIVEN** Dataset quality (synthetic, seed 404), variante Denominador cero: {"predictions":0,"expected":0}.
- **WHEN** Puntuar categoría vacía y conservar undefined, no éxito perfecto.
- **THEN** Resultado exacto {"precision":null,"recall":null,"undefined_reason":"ZERO_DENOMINATOR"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T05.

#### Scenario: AFH-13-T06 Futuro contamina respuesta
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Futuro contamina respuesta: {"known_at":"2026-01-20T00:00:00Z","answer_uses":"b2"}.
- **WHEN** Puntuar consulta que cita corrección conocida solo en febrero.
- **THEN** Resultado exacto {"timeline_accuracy":0,"acceptance":"BLOCKED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T06.

### Requirement: AFH-13-R03 Continuación ciega independiente

AFH SHALL completar24 trials de12 tareas/brazo con agentes nuevos y evaluador/custodio independientes del implementador, preservando instrucciones, artefactos y resultados de todos los intentos.

#### Scenario: AFH-13-T07 Cohorte ciega real completa
- **GIVEN** Dataset quality (synthetic, seed 404), variante Cohorte ciega real completa: {"tasks":12,"arms":2,"new_agents":24}.
- **WHEN** Custodio/evaluador distintos sellan manifiestos; ejecutar24 agentes nuevos y abrir sus entregables.
- **THEN** Resultado exacto {"required_trials":24,"contamination":0,"candidate_success_min":11}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T07.

#### Scenario: AFH-13-T08 Fixture presentado como agente
- **GIVEN** Dataset quality (synthetic, seed 404), variante Fixture presentado como agente: {"runner":"fixture-script","declared":"blind-agent"}.
- **WHEN** Evaluar receipt sin tareas/agentes reales ni traces independientes.
- **THEN** Resultado exacto {"acceptance":"BLOCKED","reason":"NO_AGENT_EVIDENCE"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T08.

#### Scenario: AFH-13-T09 Contaminación entre brazos
- **GIVEN** Dataset quality (synthetic, seed 404), variante Contaminación entre brazos: {"same_agent_for_both_arms":true}.
- **WHEN** Revisar historial/model/contexto de un agente reutilizado.
- **THEN** Resultado exacto {"trial_valid":false,"reason":"CROSS_ARM_HISTORY"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T09.

#### Scenario: AFH-13-T10 Ensayo fallido conservado
- **GIVEN** Dataset quality (synthetic, seed 404), variante Ensayo fallido conservado: {"trial_failures":2,"retries":2}.
- **WHEN** Preservar intentos originales y repetir solo fallos de entorno justificados con nuevos IDs.
- **THEN** Resultado exacto {"original_failures_retained":2,"total_attempts":26,"cherry_pick":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T10.

### Requirement: AFH-13-R04 Escala sostenida y recursos

AFH SHALL ejecutar3 runs de1m registros,7 deltas por run y queries fijadas con modelo local real, tiempos/RSS/bytes/cobertura medidos e integridad después de cada fase.

#### Scenario: AFH-13-T11 Escala real sostenida
- **GIVEN** Dataset quality (synthetic, seed 404), variante Escala real sostenida: {"records":1000000,"runs":3,"deltas":7,"delta_records":1000}.
- **WHEN** Materializar y ejecutar matriz sostenida según manifest, medir cada fase y query.
- **THEN** Resultado exacto {"final_records_each":1007000,"deep_integrity":true,"measurements_complete":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T11.

#### Scenario: AFH-13-T12 Delta idempotente de escala
- **GIVEN** Dataset quality (synthetic, seed 404), variante Delta idempotente de escala: {"repeat_delta":7}.
- **WHEN** Reingerir/reindexar último delta idéntico después de mediciones.
- **THEN** Resultado exacto {"extra_records":0,"extra_embeddings":0,"all_occurrences_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T12.

#### Scenario: AFH-13-T13 Pico RSS sobre límite
- **GIVEN** Dataset quality (synthetic, seed 404), variante Pico RSS sobre límite: {"peak_rss_bytes":2684354561,"limit":2684354560}.
- **WHEN** Evaluar receipt medido por monitor externo con RSS superior al límite.
- **THEN** Resultado exacto {"acceptance":"BLOCKED","reason":"RESOURCE_LIMIT"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T13.

#### Scenario: AFH-13-T14 Corrupción tras delta
- **GIVEN** Dataset quality (synthetic, seed 404), variante Corrupción tras delta: {"corrupt_object_after_delta":4}.
- **WHEN** Corromper copia de objeto en RUN y verificar gate, sin tocar fuentes.
- **THEN** Resultado exacto {"verify_passed":false,"acceptance":"BLOCKED","run_retained":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T14.

### Requirement: AFH-13-R05 Comparación reproducible y offline

AFH SHALL fijar baseline/candidato/corpus/modelo/parámetros por brazo, distinguir fixture de real y publicar limitaciones sin afirmar caché OS fría no comprobada.

#### Scenario: AFH-13-T15 Modelo real idéntico
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Modelo real idéntico: {"same_model_identity":true,"offline":true}.
- **WHEN** Ejecutar ambos brazos con identidad local fijada y monitor de red.
- **THEN** Resultado exacto {"provider_class":"REAL_LOCAL","network_requests":0,"comparable":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T15.

#### Scenario: AFH-13-T16 Baseline distinta configuración
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Baseline distinta configuración: {"pooling_baseline":"mean","pooling_candidate":"cls"}.
- **WHEN** Validar comparación cuyo modelo tiene config distinta.
- **THEN** Resultado exacto {"comparison":"NOT_COMPARABLE","silent_aggregate":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T16.

#### Scenario: AFH-13-T17 Caché OS no observada
- **GIVEN** Dataset operational (synthetic, seed 404), variante Caché OS no observada: {"new_process":true,"os_cache_flush_evidence":null}.
- **WHEN** Publicar medición con proceso nuevo sin acreditar page-cache cold.
- **THEN** Resultado exacto {"os_cache":"UNKNOWN","cold_os_claim":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T17.

### Requirement: AFH-13-R06 Umbrales y evidencia íntegra

AFH MUST bloquear aceptación ante incumplimiento crítico, pérdida de datos, trials ausentes o evidencia mecánica/simulada, conservando todo intento fallido y la evaluación sellada.

#### Scenario: AFH-13-T18 Umbrales satisfechos con evidencia
- **GIVEN** Dataset quality (synthetic, seed 404), variante Umbrales satisfechos con evidencia: {"precision":0.95,"critical_recall":1,"unsupported":0,"provenance":1,"timeline":1,"continuation_success":11,"total_tasks":12}.
- **WHEN** Evaluar métricas vinculadas a receipts/trials completos y revisión independiente.
- **THEN** Resultado exacto {"quality_gate":"PASS"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T18.

#### Scenario: AFH-13-T19 Violación crítica con promedio alto
- **GIVEN** Dataset quality (synthetic, seed 404), variante Violación crítica con promedio alto: {"continuation_success":12,"total_tasks":12,"source_mutations":1}.
- **WHEN** Evaluar una continuación que resuelve objetivo pero modifica una fuente protegida.
- **THEN** Resultado exacto {"acceptance":"BLOCKED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T19; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T19.

#### Scenario: AFH-13-T20 Trial ausente
- **GIVEN** Dataset quality (synthetic, seed 404), variante Trial ausente: {"required_trials":24,"present_trials":23}.
- **WHEN** Evaluar manifiesto con una ejecución ausente, sin imputar resultado.
- **THEN** Resultado exacto {"acceptance":"BLOCKED","status":"INCOMPLETE"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-13-T20; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-13-T20.

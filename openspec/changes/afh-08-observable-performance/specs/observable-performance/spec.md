## Purpose

Medir y exponer el coste real por fases de captura, indexación y recuperación con progreso JSON y ETA honestos, presupuestos reproducibles y cobertura de recursos.

## ADDED Requirements

### Requirement: AFH-08-R01 Fases monotónicas reales

AFH SHALL emitir progreso API con fases/tiempos/contadores reales, distinguir fases concurrentes y métricas no observadas sin inventar duraciones.

#### Scenario: AFH-08-T01 Callback audit por fase
- **GIVEN** Dataset operational (synthetic, seed 404), variante Callback audit por fase: {"operation":"auditSession","records":2}.
- **WHEN** Ejecutar probe onProgress sobre captura sintética real.
- **THEN** Resultado exacto {"normalization_event":true,"elapsed_ms_finite":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T01.

#### Scenario: AFH-08-T02 Tiempo por fase sin sumar paralelos
- **GIVEN** Dataset operational (synthetic, seed 404), variante Tiempo por fase sin sumar paralelos: {"parallel_intervals":[[0,100],[20,80]]}.
- **WHEN** Ejecutar harness de reloj controlado y validar receipt.
- **THEN** Resultado exacto {"elapsed_total_ms":100,"sum_as_wall_ms":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T02.

#### Scenario: AFH-08-T03 Fase no instrumentada
- **GIVEN** Dataset operational (synthetic, seed 404), variante Fase no instrumentada: {"phase_unavailable":"model_load"}.
- **WHEN** Importar baseline anterior sin métrica por subfase.
- **THEN** Resultado exacto {"value":null,"status":"UNAVAILABLE","inferred_duration":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T03.

### Requirement: AFH-08-R02 JSON y ETA estables

AFH SHALL ofrecer stderr NDJSON versionado junto a stdout JSON final y ETA solo bajo muestras/total suficientes, reiniciando su estimación al cambiar condiciones.

#### Scenario: AFH-08-T04 stdout JSON stderr NDJSON
- **GIVEN** Dataset operational (synthetic, seed 404), variante stdout JSON stderr NDJSON: {"flags":["--json","--progress-json"]}.
- **WHEN** Lanzar proceso CLI real y parsear streams por separado.
- **THEN** Resultado exacto {"stdout_json_documents":1,"stderr_progress_valid":true,"stream_mixing":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T04.

#### Scenario: AFH-08-T05 ETA tras calentamiento
- **GIVEN** Dataset operational (synthetic, seed 404), variante ETA tras calentamiento: {"times_ms":[0,1000,2000,3000,4000,5000,6000],"completed":[0,10,20,30,40,50,60],"total":100}.
- **WHEN** Usar clock fijo y validar EWMA alpha0.25 a rate10 items/s.
- **THEN** Resultado exacto {"before_5s":"UNAVAILABLE","after_6s_eta_ms":4000}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T05.

#### Scenario: AFH-08-T06 ETA total cambia o rate cero
- **GIVEN** Dataset operational (synthetic, seed 404), variante ETA total cambia o rate cero: {"total_changes":[100,200],"stalled":true}.
- **WHEN** Cambiar total y dejar tasa cero; comprobar reinicio de ventana.
- **THEN** Resultado exacto {"eta_status":"UNAVAILABLE","negative_eta":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T06.

### Requirement: AFH-08-R03 Baseline comparable

AFH SHALL separar preparación inicial/retrieval, proceso nuevo/residente, lectura DB/CLI y caché OS, registrando entorno/inputs/identidades en muestras reproducibles.

#### Scenario: AFH-08-T07 Comparar fresh y resident
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Comparar fresh y resident: {"samples":10,"warmups":2,"model":"REAL_LOCAL"}.
- **WHEN** Medir proceso nuevo y proceso residente con idénticos inputs.
- **THEN** Resultado exacto {"separate_model_load":true,"os_cache":"UNKNOWN","raw_samples":10}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T07.

#### Scenario: AFH-08-T08 DB directa frente a CLI
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante DB directa frente a CLI: {"method":["db-read-only","fresh-cli"]}.
- **WHEN** Ejecutar misma consulta FTS con reader DB y CLI independientes.
- **THEN** Resultado exacto {"separate_metrics":true,"cli_cost_not_db_cost":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T08.

#### Scenario: AFH-08-T09 Baseline Reader no repetido
- **GIVEN** Dataset quality (synthetic, seed 404), variante Baseline Reader no repetido: {"historical_index_ms":3804071.84,"subphases_missing":true}.
- **WHEN** Generar reporte desde métricas históricas agregadas sin lanzar indexación.
- **THEN** Resultado exacto {"label":"HISTORICAL","missing":"UNAVAILABLE","full_reindex_required":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T09.

### Requirement: AFH-08-R04 Presupuestos medidos

AFH SHALL evaluar latencia/throughput/RSS/espacio/reuso/compresión con numeradores y denominadores, límites de OPERATIONS y evidencia no disponible marcada UNAVAILABLE.

#### Scenario: AFH-08-T10 Percentil y throughput
- **GIVEN** Dataset operational (synthetic, seed 404), variante Percentil y throughput: {"samples_ms":[1,2,3,4,5,6,7,8,9,10],"records":100}.
- **WHEN** Calcular métricas de harness sobre muestra fijada.
- **THEN** Resultado exacto {"median_ms":5.5,"p95_ms":10,"formula":"nearest-rank"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T10.

#### Scenario: AFH-08-T11 Delta compute versus prefijo IO
- **GIVEN** Dataset archive (synthetic, seed 404), variante Delta compute versus prefijo IO: {"prefix_records":100,"delta_records":10}.
- **WHEN** Medir una ingesta incremental y separar bytes verificados de normalizados.
- **THEN** Resultado exacto {"prefix_bytes_reported":true,"new_records":10,"claimed_sublinear_io":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T11.

#### Scenario: AFH-08-T12 Compresión incomprimible
- **GIVEN** Dataset archive (synthetic, seed 404), variante Compresión incomprimible: {"random_bytes_seed":404,"size":65536}.
- **WHEN** Medir codec sobre bytes pseudoaleatorios deterministas.
- **THEN** Resultado exacto {"both_byte_counts":true,"compression_guarantee":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T12.

#### Scenario: AFH-08-T13 Memoria supera límite
- **GIVEN** Dataset operational (synthetic, seed 404), variante Memoria supera límite: {"rss_bytes":3000000000,"limit_bytes":2684354560}.
- **WHEN** Evaluar receipt medido superior al límite de 2.5GiB.
- **THEN** Resultado exacto {"resource_gate":"FAIL","raised_threshold_after_run":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T13.

### Requirement: AFH-08-R05 Límite útil de hijos

AFH SHALL informar hijos adquiridos/omitidos conocidos, universo desconocido, límite y siguiente comando de nueva captura sin mutar el caso anterior.

#### Scenario: AFH-08-T14 Hijos omitidos conocidos
- **GIVEN** Dataset identity (synthetic, seed 404), variante Hijos omitidos conocidos: {"known_children":56,"limit":32}.
- **WHEN** Capturar cierre sintético con límite32; emitir command argv para out nuevo.
- **THEN** Resultado exacto {"acquired_children":32,"omitted_known":24,"recommended_limit":64,"new_capture_command":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T14.

#### Scenario: AFH-08-T15 Universo no descubierto
- **GIVEN** Dataset identity (synthetic, seed 404), variante Universo no descubierto: {"known_children":56,"incomplete_discovery":true}.
- **WHEN** Repetir límite con discovery incompleto y conservar incertidumbre.
- **THEN** Resultado exacto {"universe_total":null,"omitted_known":24,"claim_complete":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T15.

### Requirement: AFH-08-R06 Progreso seguro y recuperable

AFH MUST preservar identidad de intento al reiniciar y evitar secretos, instrucciones históricas o resultados ficticios en logs de progreso.

#### Scenario: AFH-08-T16 Crash no fabrica final
- **GIVEN** Dataset operational (synthetic, seed 404), variante Crash no fabrica final: {"kill_before_final":true}.
- **WHEN** Terminar proceso durante fase y revisar supervisor/receipt.
- **THEN** Resultado exacto {"final_status":"INTERRUPTED","completed_claim":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T16.

#### Scenario: AFH-08-T17 Resume nueva attempt
- **GIVEN** Dataset operational (synthetic, seed 404), variante Resume nueva attempt: {"attempts":2,"checkpoint_completed":50}.
- **WHEN** Reanudar job en proceso nuevo desde checkpoint50.
- **THEN** Resultado exacto {"attempt_clock_reset":true,"total_completed_resume":50,"old_logs_unchanged":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T17.

#### Scenario: AFH-08-T18 Secretos no entran en progreso
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Secretos no entran en progreso: {"secret_canary":"SYNTHETIC_SECRET_404","command_contains_canary":true}.
- **WHEN** Capturar y escanear ambos streams y receipt de progreso.
- **THEN** Resultado exacto {"progress_canary_occurrences":0,"raw_evidence_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-08-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-08-T18.

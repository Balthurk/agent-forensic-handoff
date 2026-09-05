## Purpose

Ofrecer un reader local opcional que mantenga modelos/handles residentes y ejecute el mismo núcleo de consulta con aislamiento, límites y paridad verificables.

## ADDED Requirements

### Requirement: AFH-09-R01 Servicio opt-in local

AFH SHALL iniciar residente solo mediante comando explícito, con IPC local y control de usuario/owner, sin exponer HTTP ni instalar servicio global.

#### Scenario: AFH-09-T01 Inicio y cierre explícitos
- **GIVEN** Dataset operational (synthetic, seed 404), variante Inicio y cierre explícitos: {"start_command":"serve","idle_seconds":900}.
- **WHEN** Lanzar resident en raíz nueva, observar READY y cerrar con owner token.
- **THEN** Resultado exacto {"auto_started":false,"ready_after_verify":true,"stopped_on_idle":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T01.

#### Scenario: AFH-09-T02 Otro usuario o token
- **GIVEN** Dataset operational (synthetic, seed 404), variante Otro usuario o token: {"wrong_token":true,"foreign_owner":true}.
- **WHEN** Conectar a endpoint de prueba con token erróneo y principal no autorizado.
- **THEN** Resultado exacto {"access_denied":true,"corpus_reads":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T02.

#### Scenario: AFH-09-T03 Sin residente disponible
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Sin residente disponible: {"requested_transport":"ipc","service_running":false}.
- **WHEN** Consultar endpoint inexistente sin flag de fallback.
- **THEN** Resultado exacto {"status":"UNAVAILABLE","silent_direct_fallback":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T03.

### Requirement: AFH-09-R02 Reader sin efectos

AFH MUST limitar IPC a operaciones de lectura y reutilizar el mismo planner, prohibiendo mutaciones/indexación/captura y rankings alternativos.

#### Scenario: AFH-09-T04 Mutation RPC rechazada
- **GIVEN** Dataset intent (synthetic, seed 404), variante Mutation RPC rechazada: {"operation":"gold.promote","transport":"ipc"}.
- **WHEN** Enviar request de escritura al residente y comparar inventario.
- **THEN** Resultado exacto {"error":"INVALID_REQUEST","writes":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T04.

#### Scenario: AFH-09-T05 Mismo ranking
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Mismo ranking: {"request_same":true,"transports":["api","cli","ipc"]}.
- **WHEN** Comparar resultados normalizados de las tres superficies.
- **THEN** Resultado exacto {"candidate_order_identical":true,"answer_units_identical":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T05.

#### Scenario: AFH-09-T06 Imports de writer prohibidos
- **GIVEN** Dataset operational (synthetic, seed 404), variante Imports de writer prohibidos: {"new_modules":"src/resident","forbidden_dependency":"src/archive/writer"}.
- **WHEN** Analizar imports reales de módulos nuevos; resultado vacío NOT_IMPLEMENTED.
- **THEN** Resultado exacto {"forbidden_edges":0,"module_count_gt":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T06.

### Requirement: AFH-09-R03 Identidad y generaciones

AFH SHALL verificar archive/projection/model antes de READY y fijar cada request a una generación consistente durante publicación.

#### Scenario: AFH-09-T07 Manifest/model mismatch
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Manifest/model mismatch: {"archive_expected":"a1","actual":"a2","model_digest_mismatch":true}.
- **WHEN** Arrancar service con identidad equivocada.
- **THEN** Resultado exacto {"ready":false,"status":"UNAVAILABLE"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T07.

#### Scenario: AFH-09-T08 Switch de generación
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Switch de generación: {"request1":"p1","publish":"p2","request2":"p2"}.
- **WHEN** Publicar p2 desde writer independiente autorizado mientras reader procesa p1.
- **THEN** Resultado exacto {"request1_model":"p1","request2_model":"p2","mixed":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T08.

#### Scenario: AFH-09-T09 Proyección corrupta
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Proyección corrupta: {"tamper_projection":true}.
- **WHEN** Arrancar sobre copia de sidecar adulterada.
- **THEN** Resultado exacto {"ready":false,"unverified_results":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T09.

### Requirement: AFH-09-R04 Lifecycle y recursos

AFH SHALL acotar concurrencia/cola/frame/timeout/idle y cerrar/reiniciar con errores explícitos sin afectar otros procesos o archivos.

#### Scenario: AFH-09-T10 Saturación y cola
- **GIVEN** Dataset operational (synthetic, seed 404), variante Saturación y cola: {"concurrent_requests":21,"active_limit":4,"queue_limit":16}.
- **WHEN** Enviar21 consultas lentas acotadas y observar BUSY.
- **THEN** Resultado exacto {"active_max":4,"queued_max":16,"busy_count_gte":1}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T10.

#### Scenario: AFH-09-T11 Stop drena y cancela
- **GIVEN** Dataset operational (synthetic, seed 404), variante Stop drena y cancela: {"deadline_ms":30000,"pending_requests":2}.
- **WHEN** Solicitar stop con owner válido y revisar cierre.
- **THEN** Resultado exacto {"drain_lte_ms":30000,"pending_ids_reported":true,"foreign_process_killed":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T11.

#### Scenario: AFH-09-T12 Crash y reinicio real
- **GIVEN** Dataset operational (synthetic, seed 404), variante Crash y reinicio real: {"terminate_reader":true}.
- **WHEN** Matar proceso reader propio, reiniciar y consultar.
- **THEN** Resultado exacto {"corpus_inventory_unchanged":true,"reverify_on_restart":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T12.

### Requirement: AFH-09-R05 Paridad completa

AFH SHALL producir mismas unidades/refs/scope/time y fragmentación en API/CLI/IPC, negociando protocolo antes de efectos.

#### Scenario: AFH-09-T13 Frame exacto y continuaciones
- **GIVEN** Dataset operational (synthetic, seed 404), variante Frame exacto y continuaciones: {"evidence_bytes":16777216,"transport":"ipc"}.
- **WHEN** Leer evidencia grande por IPC y comparar con API/CLI.
- **THEN** Resultado exacto {"frames_lte":8388608,"roundtrip_bytes_equal":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T13.

#### Scenario: AFH-09-T14 Protocolo no negociado
- **GIVEN** Dataset operational (synthetic, seed 404), variante Protocolo no negociado: {"offered":["4.1"],"supported":["4.0"]}.
- **WHEN** Handshake sin intersección de versiones.
- **THEN** Resultado exacto {"error":"PROTOCOL_INCOMPATIBLE","request_effects":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T14.

#### Scenario: AFH-09-T15 Readonly verify sin index
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Readonly verify sin index: {"operation":"semantic.verify","missing_projection":true}.
- **WHEN** Verificar dependencia ausente desde reader y comprobar ausencia de sidecars nuevos.
- **THEN** Resultado exacto {"status":"UNAVAILABLE","builder_calls":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T15.

### Requirement: AFH-09-R06 Beneficio medido y arquitectura

AFH SHALL verificar con modelo real el objetivo de latencia recurrente y architecture tests no vacíos sin usar fixtures como aceptación de modelo/plataforma.

#### Scenario: AFH-09-T16 Latencia recurrente real
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Latencia recurrente real: {"fresh_samples":10,"resident_samples":10,"ratio_max":0.6,"p95_ms_max":2000}.
- **WHEN** Medir ambos procesos con modelo local real y mismo dataset/cobertura.
- **THEN** Resultado exacto {"ratio_gate":true,"absolute_reference_gate":true,"provider":"REAL_LOCAL"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T16.

#### Scenario: AFH-09-T17 Modelo fixture no acredita mejora
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Modelo fixture no acredita mejora: {"provider":"fixture/concepts"}.
- **WHEN** Evaluar receipt de performance de provider falso como si fuera real.
- **THEN** Resultado exacto {"real_performance_acceptance":"BLOCKED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T17.

#### Scenario: AFH-09-T18 Core funciona sin daemon
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Core funciona sin daemon: {"service_removed":true,"mode":"lexical"}.
- **WHEN** Ejecutar CLI embebido con endpoint ausente.
- **THEN** Resultado exacto {"direct_cli_works":true,"service_required":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-09-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-09-T18.

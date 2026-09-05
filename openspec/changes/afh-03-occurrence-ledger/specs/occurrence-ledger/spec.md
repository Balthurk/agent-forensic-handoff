## Purpose

Reconstruir una bitácora íntegra de actos observables y sus representaciones, con recuentos exactos, resultados desconocidos honestos y payloads compartibles sin perder ejecuciones reales.

## ADDED Requirements

### Requirement: AFH-03-R01 Actos reales y representaciones

AFH SHALL contar cada ejecución/mensaje real una vez y mantener todas sus representaciones, sin fusionar actos por contenido/command_text.

#### Scenario: AFH-03-T01 Diez ejecuciones iguales
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Diez ejecuciones iguales: {"executions":10,"command":"npm test"}.
- **WHEN** Capturar diez CommandExecution con IDs distintos y contar tool_execution.
- **THEN** Resultado exacto {"occurrences":10,"failed":9,"completed":1,"representations":10}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T01.

#### Scenario: AFH-03-T02 Dos representaciones de un acto
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Dos representaciones de un acto: {"same_native_item_id":"item-one","encodings":["response_item","item_completed"]}.
- **WHEN** Capturar ambos encodings con vínculo nativo y abrir ambas refs.
- **THEN** Resultado exacto {"occurrences":1,"representations":2,"independent_sources":1}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T02.

#### Scenario: AFH-03-T03 Dos mensajes reales iguales
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Dos mensajes reales iguales: {"text":"Keep every attempt.","native_ids":["real-message-a","real-message-b"]}.
- **WHEN** Capturar ambos mensajes con IDs distintos; comprobar cardinalidad.
- **THEN** Resultado exacto {"canonical_messages":2,"representations":2}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T03.

### Requirement: AFH-03-R02 Correlación cualificada

AFH SHALL cualificar call/item IDs por sesión/harness/origen y ciclo observado, impidiendo colisiones o adjudicación del resultado a otro acto.

#### Scenario: AFH-03-T04 callId igual en hilos diferentes
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante callId igual en hilos diferentes: {"call_id":"shared-call","sessions":["synthetic-parent","synthetic-child"],"codes":[1,0]}.
- **WHEN** Capturar parent y child con mismo callId y resultados diferentes.
- **THEN** Resultado exacto {"executions":2,"results_per_session":[1,1],"cross_session_links":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T04.

#### Scenario: AFH-03-T05 Reutilización en turn distinto
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Reutilización en turn distinto: {"call_id":"reuse","turns":["turn-1","turn-2"],"terminal_between":true}.
- **WHEN** Capturar inicio/final y segundo inicio/final con ID repetido en turno nuevo.
- **THEN** Resultado exacto {"executions":2,"epochs":2}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T05.

#### Scenario: AFH-03-T06 Resultado huérfano ambiguo
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Resultado huérfano ambiguo: {"orphan_call":"unknown","two_open_calls":true}.
- **WHEN** Añadir resultado sin ID resoluble; inspeccionar ledger.
- **THEN** Resultado exacto {"orphan_preserved":true,"assigned_to_last_command":false,"correlation":"AMBIGUOUS_CORRELATION"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T06.

### Requirement: AFH-03-R03 Resultados desconocidos conservados

AFH SHALL conservar la validación y su identidad con outcome UNKNOWN cuando no existe resultado de éxito/fallo explícito; cero filas no satisface esta condición.

#### Scenario: AFH-03-T07 UNKNOWN no desaparece
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante UNKNOWN no desaparece: {"status":"unknown","exit_code":null,"tool":"npm test"}.
- **WHEN** Capturar CommandExecution unknown sin exit y consultar validación por identidad exacta.
- **THEN** Resultado exacto {"validations":1,"outcome":"UNKNOWN","pass_count":0,"same_occurrence":true,"evidence_refs_gte":1}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T07.

#### Scenario: AFH-03-T08 PASS explícito y FAIL explícito
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante PASS explícito y FAIL explícito: {"codes":[0,1]}.
- **WHEN** Capturar dos validadores con resultados explícitos; conservar ambos.
- **THEN** Resultado exacto {"validations":2,"outcomes":["OBSERVED_PASS","OBSERVED_FAIL"],"goal_closed":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T08.

### Requirement: AFH-03-R04 Contabilidad y terminal

AFH SHALL obtener intentos/fallos/completadas/incompletas/bloqueadas/latencias mediante SQL estructurado, con terminal fundado en orden observable y denominadores explícitos.

#### Scenario: AFH-03-T09 Terminal no alfabético
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Terminal no alfabético: {"codes":[1,1,0],"order":[1,2,3]}.
- **WHEN** Obtener loopGroups o stats terminal para tres ejecuciones secuenciales.
- **THEN** Resultado exacto {"attempts":3,"terminal_status":"COMPLETED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T09.

#### Scenario: AFH-03-T10 Terminal no ordenable
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Terminal no ordenable: {"two_clock_domains":true,"same_timestamp":true,"no_causal_link":true}.
- **WHEN** Agrupar últimos actos no comparables; no ordenar semánticamente por IDs.
- **THEN** Resultado exacto {"terminal_status":"UNKNOWN","candidates":2}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T10.

#### Scenario: AFH-03-T11 Recuentos no embeddings
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Recuentos no embeddings: {"executions":10,"mentions":15,"representations":12,"model_available":false}.
- **WHEN** Ejecutar stats por scope/time con semántica ausente.
- **THEN** Resultado exacto {"executions":10,"mentions":15,"representations":12,"model_calls":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T11.

#### Scenario: AFH-03-T22 Cobertura parcial y denominador
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Cobertura parcial y denominador: {"known_acquired":10,"known_omitted":2,"universe_unknown":true}.
- **WHEN** Solicitar stats con adquisición incompleta.
- **THEN** Resultado exacto {"observed_executions":10,"exact_within_observed_scope":true,"total_universe":null,"coverage":"PARTIAL"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T22; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T22.

### Requirement: AFH-03-R05 Bitácora y payloads completos

AFH SHALL conservar input/args/cwd/actor/stdout/stderr/exit/tiempo/duración/procedencia dentro del límite persistido, compartiendo solo bytes iguales.

#### Scenario: AFH-03-T12 stdout y stderr separados
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante stdout y stderr separados: {"stdout":"synthetic stdout","stderr":"synthetic stderr","exit_code":1,"cwd":"C:\\Synthetic"}.
- **WHEN** Capturar comando y leer occurrence_payload de cada rol.
- **THEN** Resultado exacto {"stdout_exact":true,"stderr_exact":true,"exit_code":1,"cwd_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T12.

#### Scenario: AFH-03-T13 Orden igual salidas diferentes
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Orden igual salidas diferentes: {"command":"npm test","outputs":["first","second"]}.
- **WHEN** Capturar dos ejecuciones y resolver ambos payloads.
- **THEN** Resultado exacto {"executions":2,"output_objects":2}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T13.

#### Scenario: AFH-03-T14 Duración precisa y desconocida
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Duración precisa y desconocida: {"durations":[{"secs":1,"nanos":500000000},null]}.
- **WHEN** Normalizar duraciones conservando la precisión persistida.
- **THEN** Resultado exacto {"duration_ms":[1500,null],"precision":["ns","unknown"]}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T14.

### Requirement: AFH-03-R06 Incompletos y datos tardíos

AFH SHALL distinguir llamadas sin final, bloqueos observados, cancelaciones y resultados tardíos sin inventar causalidad o efectos.

#### Scenario: AFH-03-T15 Llamada sin resultado
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Llamada sin resultado: {"request_only":true}.
- **WHEN** Finalizar snapshot con request sin terminal; abrir evento.
- **THEN** Resultado exacto {"lifecycle":"INCOMPLETE","effects_status":"UNKNOWN","request_ref_retained":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T15.

#### Scenario: AFH-03-T16 Resultado tardío conocido después
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Resultado tardío conocido después: {"capture1":"request","capture2":"terminal","known_times":["2026-01-01","2026-01-02"]}.
- **WHEN** Actualizar archivo y consultar ambos knowledge cutoffs.
- **THEN** Resultado exacto {"asof_first":"INCOMPLETE","asof_second":"COMPLETED","same_occurrence":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T16.

#### Scenario: AFH-03-T17 Bloqueo observado frente a silencio
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Bloqueo observado frente a silencio: {"observations":["approval_denied","no_result"]}.
- **WHEN** Capturar negativa explícita y otra solicitud sin resultado.
- **THEN** Resultado exacto {"lifecycles":["BLOCKED","INCOMPLETE"]}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T17.

#### Scenario: AFH-03-T18 Timeout y cancelación
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Timeout y cancelación: {"observations":["timeout_terminal","cancelled_terminal"]}.
- **WHEN** Normalizar los dos terminales con evidencia propia.
- **THEN** Resultado exacto {"lifecycles":["FAILED","CANCELLED"],"reasons":["TIMEOUT","CANCELLED"]}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T18.

### Requirement: AFH-03-R07 Seguridad de normalización

AFH MUST preservar malformados/desconocidos y refs, no ejecutar histórico ni extraer razonamiento privado y no presentar parse success como normalización completa.

#### Scenario: AFH-03-T19 Prompt histórico peligroso
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Prompt histórico peligroso: {"historical_command":"create a file named HISTORICAL_REPLAY_CANARY","actual_allowed_action":"ingest-only"}.
- **WHEN** Ingerir texto de comando sintético sin ejecutarlo y comprobar raíz.
- **THEN** Resultado exacto {"canary_exists":false,"evidence_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T19; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T19.

#### Scenario: AFH-03-T20 Reasoning privado excluido
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Reasoning privado excluido: {"encrypted_reasoning":"synthetic opaque bytes","exposed_summary":"Brief public summary"}.
- **WHEN** Ingerir ambos campos y examinar normalización/índices.
- **THEN** Resultado exacto {"private_indexed":false,"opaque_preserved":true,"summary_labeled":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T20; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T20.

#### Scenario: AFH-03-T21 JSON y argumentos malformados
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante JSON y argumentos malformados: {"args":"{malformed}","record_unknown":true}.
- **WHEN** Preservar raw args y registro nuevo desconocido.
- **THEN** Resultado exacto {"raw_refs_retained":true,"normalization":"UNSUPPORTED","successful_parse_not_full_coverage":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-03-T21; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-03-T21.

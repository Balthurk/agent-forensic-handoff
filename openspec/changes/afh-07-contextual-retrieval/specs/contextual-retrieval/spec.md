## Purpose

Responder preguntas y construir context packs que combinen proyecto y tarea mediante SQL/FTS, semántica de Plata/Oro y grafo temporal, con presupuestos y evidencia verificables.

## ADDED Requirements

### Requirement: AFH-07-R01 Planes por tipo de pregunta

AFH SHALL ejecutar un plan explícito para exact/conceptual/relational/temporal/count/mission/current_state, con SQL para recuentos y cobertura diferenciada.

#### Scenario: AFH-07-T01 Exacto por ID
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Exacto por ID: {"kind":"exact","id":"final-a","mode":"lexical"}.
- **WHEN** Consultar ID exacto con show/evidence y comparar el texto original.
- **THEN** Resultado exacto {"selected":["final-a"],"model_calls":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T01.

#### Scenario: AFH-07-T02 Recuento exacto con modelos ausentes
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Recuento exacto con modelos ausentes: {"kind":"count","metric":"executions","model_available":false}.
- **WHEN** Preguntar cuántas ejecuciones hubo por scope/periodo.
- **THEN** Resultado exacto {"executions":10,"method":"SQL","model_calls":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T02.

#### Scenario: AFH-07-T03 Conceptual multilingüe
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Conceptual multilingüe: {"kind":"conceptual","mode":"hybrid","question":"¿Por qué falló el lector?"}.
- **WHEN** Ejecutar pregunta conceptual con modelo local real y refs.
- **THEN** Resultado exacto {"target_recalled":true,"plan_declared":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T03.

### Requirement: AFH-07-R02 Scope y tiempo antes de ranking

AFH MUST filtrar scope/revisión/known_at/valid_at en todos los candidatos y edges, sin mostrar datos futuros ni antiguos como estado vigente.

#### Scenario: AFH-07-T04 No futuro en todas las listas
- **GIVEN** Dataset temporal (synthetic, seed 404), variante No futuro en todas las listas: {"known_at":"2026-01-20T00:00:00Z","valid_at":"2026-01-09T00:00:00Z","layers":["silver","gold"]}.
- **WHEN** Consultar léxico/semántica/híbrido y grafo con el mismo corte.
- **THEN** Resultado exacto {"match":"A","future_revision_b2":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T04.

#### Scenario: AFH-07-T05 Último estado frente a distractor
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Último estado frente a distractor: {"kind":"current_state","distractor":"older-themed","terminal":"final-a"}.
- **WHEN** Consultar estado actual de hijo con mensaje antiguo temáticamente próximo.
- **THEN** Resultado exacto {"state":"CHANGES_REQUESTED","old_completion_labeled_historical":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T05.

#### Scenario: AFH-07-T06 Dos ámbitos no se mezclan
- **GIVEN** Dataset identity (synthetic, seed 404), variante Dos ámbitos no se mezclan: {"project_filter":"project-a","semantic_neighbor_project":"project-b"}.
- **WHEN** Ejecutar hybrid donde mejor vecino no pertenece al scope.
- **THEN** Resultado exacto {"cross_project_candidates":0,"effective_scope":"project-a"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T06.

### Requirement: AFH-07-R03 Relaciones hasta terminales

AFH SHALL recuperar hijos y su última respuesta terminal observada mediante entidades/grafo, declarando NO_TERMINAL_RESPONSE_CAPTURED cuando corresponda.

#### Scenario: AFH-07-T07 Pregunta hijos y respuestas
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Pregunta hijos y respuestas: {"question":"Which children reviewed the parser and what did they return?","no_lexical_hits":true}.
- **WHEN** Sembrar session entity desde scope y recorrer grafo hasta finales.
- **THEN** Resultado exacto {"children":2,"terminal_answers":1,"missing_terminal":1,"spawn_refs":2}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T07.

#### Scenario: AFH-07-T08 Respuesta terminal conocida tarde
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Respuesta terminal conocida tarde: {"child":"synthetic-child-b","final_acquired_later":true}.
- **WHEN** Consultar antes/después de la nueva captura usando mismo hilo lógico.
- **THEN** Resultado exacto {"before":"NO_TERMINAL_RESPONSE_CAPTURED","after":"terminal_observed"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T08.

#### Scenario: AFH-07-T09 Límite de recorrido
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Límite de recorrido: {"max_nodes":1,"hops":1}.
- **WHEN** Acotar graph expansion y revisar gaps de respuesta.
- **THEN** Resultado exacto {"truncated":true,"claim_all_children":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T09.

### Requirement: AFH-07-R04 Contexto compuesto presupuestado

AFH SHALL incluir misión/encargo/restricciones/decisiones/trabajo/artefactos/fallos/pendientes/conflictos/huecos con refs y omisiones explícitas según budget_kind.

#### Scenario: AFH-07-T10 Pack de proyecto y tarea
- **GIVEN** Dataset intent (synthetic, seed 404), variante Pack de proyecto y tarea: {"budget_tokens":6000,"program":true,"assignment":true,"failures":2,"pending":1}.
- **WHEN** Construir pack completo y resolver cada AnswerUnit.
- **THEN** Resultado exacto {"mandatory_sections_present":true,"failures_retained":2,"uncertainty_visible":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T10.

#### Scenario: AFH-07-T11 Presupuesto estimado
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Presupuesto estimado: {"budget_kind":"estimated","budget_tokens":6000,"unicode_heavy":true}.
- **WHEN** Construir pack y medir bytes/estimación/metadata sin tokenizer.
- **THEN** Resultado exacto {"estimator":"afh-utf8-estimate-v1","estimate_lte":6000,"hard_token_guarantee":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T11.

#### Scenario: AFH-07-T12 Hard cap con tokenizer identificado
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Hard cap con tokenizer identificado: {"budget_kind":"tokenizer","budget_tokens":6000,"tokenizer_available":true}.
- **WHEN** Contar pack serializado con tokenizer local exacto y comparar.
- **THEN** Resultado exacto {"actual_tokens_lte":6000,"tokenizer_identity_present":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T12.

#### Scenario: AFH-07-T13 Tokenizer ausente y mínimo imposible
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Tokenizer ausente y mínimo imposible: {"variants":["missing_tokenizer","essential_content_over_budget"]}.
- **WHEN** Construir ambos negativos conservando misión/cobertura en diagnóstico.
- **THEN** Resultado exacto {"errors":["TOKENIZER_UNAVAILABLE","BUDGET_TOO_SMALL"],"silent_truncation":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T13.

### Requirement: AFH-07-R05 Ranking y ausencia honestos

AFH SHALL deduplicar representaciones, preservar modos explícitos y distinguir presencia/cobertura/epistemología; RRF y similitud no expresan verdad.

#### Scenario: AFH-07-T14 Representaciones no suman voto
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Representaciones no suman voto: {"same_event_two_encodings":true}.
- **WHEN** Comparar ranking antes/después de añadir encoding duplicado.
- **THEN** Resultado exacto {"candidate_count":1,"original_refs":2,"rrf_votes_from_duplicates":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T14.

#### Scenario: AFH-07-T15 Sin candidato con cobertura completa
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Sin candidato con cobertura completa: {"question":"unrelated nonexistent synthetic item","coverage":"COMPLETE_WITHIN_OBSERVED_BOUNDARY"}.
- **WHEN** Consultar término inexistente dentro de fixture completo.
- **THEN** Resultado exacto {"presence":"NOT_OBSERVED_IN_CAPTURED_EVIDENCE","universal_absence_claim":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T15.

#### Scenario: AFH-07-T16 Sin candidato con cobertura parcial
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Sin candidato con cobertura parcial: {"question":"unobserved child result","omitted_child":1}.
- **WHEN** Consultar con fuente hija conocida no adquirida.
- **THEN** Resultado exacto {"status":"INCONCLUSIVE_COVERAGE","gaps_gte":1}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T16.

#### Scenario: AFH-07-T17 Sin fallback oculto
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Sin fallback oculto: {"mode":"semantic","projection_missing":true}.
- **WHEN** Consultar sin proyección ni flag de fallback.
- **THEN** Resultado exacto {"status":"UNAVAILABLE","effective_mode":"unavailable"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T17.

### Requirement: AFH-07-R06 Respuestas verificadas y paridad

AFH SHALL resolver cada referencia consecuencial y producir AnswerUnits coherentes en API/CLI, con errores/continuaciones/estimadores conforme al schema común.

#### Scenario: AFH-07-T18 Referencia consecuencial corrupta
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Referencia consecuencial corrupta: {"selected_ref":"final-a","tamper":true}.
- **WHEN** Corromper copia de objeto; componer respuesta y revisar estado.
- **THEN** Resultado exacto {"verification_status":"EVIDENCE_UNAVAILABLE","unsupported_answer_units":0,"original_candidate_retained_as_gap":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T18.

#### Scenario: AFH-07-T19 Paridad API y CLI
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Paridad API y CLI: {"same_request":true,"pinned_revision":true}.
- **WHEN** Comparar JSON normalizado de archiveRequest y CLI, excluyendo solo timings/request_id.
- **THEN** Resultado exacto {"same_units":true,"same_refs":true,"same_scope_time":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T19; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T19.

#### Scenario: AFH-07-T20 Consulta FTS malformada
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Consulta FTS malformada: {"query":"\"unterminated","kind":"exact"}.
- **WHEN** Enviar FTS inválido y comprobar error del catálogo.
- **THEN** Resultado exacto {"error":"INVALID_QUERY","substituted_empty_query":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-07-T20; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T20.

#### Scenario: AFH-07-T21 Normative examples validate
- **GIVEN** Synthetic case AFH-07-T21: {"example":"API-CONTRACT context.build"}
- **WHEN** Run node --test --test-name-pattern=AFH-07-T21 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"valid_request":true,"kind":"request","operation":"context.build"}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-07-T21; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T21.

#### Scenario: AFH-07-T22 Missing or wrong discriminator rejected
- **GIVEN** Synthetic case AFH-07-T22: {"mutations":["missing kind","kind=response","missing protocol","protocol=4.1","unknown param"]}
- **WHEN** Run node --test --test-name-pattern=AFH-07-T22 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"all_rejected":true}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-07-T22; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T22.

#### Scenario: AFH-07-T23 One byte cannot skip to99
- **GIVEN** Synthetic case AFH-07-T23: {"offset":0,"bytes_returned":1,"next_offset":99}
- **WHEN** Run node --test --test-name-pattern=AFH-07-T23 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"rejected":"NEXT_OFFSET_MISMATCH"}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-07-T23; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T23.

#### Scenario: AFH-07-T24 Continuation and final exact extent
- **GIVEN** Synthetic case AFH-07-T24: {"extent_bytes":3,"fragments":[1,2]}
- **WHEN** Run node --test --test-name-pattern=AFH-07-T24 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"bytes_concatenated":3,"final_cursor":null,"wrong_remaining_rejected":true,"zero_progress_rejected":true}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-07-T24; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T24.

#### Scenario: AFH-07-T25 Cursor identity bound both directions
- **GIVEN** Synthetic case AFH-07-T25: {"mutations":["archive","revision","source","uri","format","digest","remaining"]}
- **WHEN** Run node --test --test-name-pattern=AFH-07-T25 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"all_mismatches_rejected":true}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-07-T25; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T25.

#### Scenario: AFH-07-T26 16MiB request bounded by full8MiB envelopes
- **GIVEN** Synthetic case AFH-07-T26: {"request_bytes":16777216,"oversize_base64_bytes":8388608}
- **WHEN** Run node --test --test-name-pattern=AFH-07-T26 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"oversize_with_overhead_rejected":true,"complete_payload_reassembled":16777216,"each_full_frame_max":8388608}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-07-T26; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T26.

#### Scenario: AFH-07-T27 Captured and original unknown extents distinguished
- **GIVEN** Synthetic case AFH-07-T27: {"captured_extent":3,"original_extent":null}
- **WHEN** Run node --test --test-name-pattern=AFH-07-T27 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"transport_remaining_known":true,"original_extent_not_invented":true}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-07-T27; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-07-T27.

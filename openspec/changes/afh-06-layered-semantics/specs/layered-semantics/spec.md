## Purpose

Indexar Plata y Oro explícitamente con embeddings locales versionados, reuso compatible y checkpoints que preserven cobertura y privacidad al actualizar el archivo.

## ADDED Requirements

### Requirement: AFH-06-R01 Dos capas explícitas

AFH SHALL construir y consultar embeddings separados por links de Plata y Oro con ámbito/versión/cobertura y conservar resultados de Plata no promovida.

#### Scenario: AFH-06-T01 Plata y Oro indexados
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Plata y Oro indexados: {"layers":["silver","gold"],"silver_only_fact":true}.
- **WHEN** Construir ambas capas y consultar frase exclusiva de Plata.
- **THEN** Resultado exacto {"coverage_layers":2,"silver_only_result":true,"gold_required_for_silver":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T01.

#### Scenario: AFH-06-T02 Plata con Oro vacío
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Plata con Oro vacío: {"layers":["silver"],"gold_rows":0}.
- **WHEN** Construir únicamente Plata y comprobar receipt explícito.
- **THEN** Resultado exacto {"silver_indexed":true,"gold_coverage":"NOT_REQUESTED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T02.

#### Scenario: AFH-06-T03 Visibilidad temporal de chunks
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Visibilidad temporal de chunks: {"new_chunk_known_at":"2026-02-01","known_at":"2026-01-20"}.
- **WHEN** Consultar semántica histórica antes de incorporación del chunk.
- **THEN** Resultado exacto {"future_candidates":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T03.

### Requirement: AFH-06-R02 Identidad completa de reuso

AFH SHALL reutilizar embeddings solo bajo clave completa compatible de contenido/config/modelo/runtime/tokenizer/dimensión/dtype/pooling/redacción/ámbito/dominio.

#### Scenario: AFH-06-T04 Delta con reuso exacto
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Delta con reuso exacto: {"new_unique":800,"reusable":200}.
- **WHEN** Añadir delta fijado y contar llamadas/items reales al proveedor de prueba.
- **THEN** Resultado exacto {"provider_inputs":800,"reused":200,"missing_links":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T04.

#### Scenario: AFH-06-T05 Cambiar cada campo de identidad
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Cambiar cada campo de identidad: {"mutate_each":["model_digest","revision","runtime_version","dimensions","compute_dtype","pooling","normalization","chunking_version","redaction_policy_digest","tokenizer_digest","scope_digest","access_domain_id"]}.
- **WHEN** Crear variantes una por vez manteniendo texto; comprobar que ninguna usa vector incompatible.
- **THEN** Resultado exacto {"reused_in_each_variant":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T05.

#### Scenario: AFH-06-T06 Payload común múltiples ocurrencias
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Payload común múltiples ocurrencias: {"occurrences":10,"same_normalized_text":true}.
- **WHEN** Indexar diez ocurrencias con identical key y consultar todos sus IDs.
- **THEN** Resultado exacto {"embeddings":1,"occurrence_links":10}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T06.

### Requirement: AFH-06-R03 Checkpoint y publicación

AFH SHALL reanudar batches verificados sin duplicación, rechazar checkpoints/identidades incompatibles y publicar generaciones coherentes tras crash real.

#### Scenario: AFH-06-T07 Crash a mitad de batch
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Crash a mitad de batch: {"batches":4,"terminate_after_durable_batch":2}.
- **WHEN** Terminar proceso nativo del builder y reiniciar con checkpoint verificado.
- **THEN** Resultado exacto {"recomputed_completed_batches":0,"final_links_equal":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T07.

#### Scenario: AFH-06-T08 Checkpoint adulterado
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Checkpoint adulterado: {"checkpoint_hash_mismatch":true}.
- **WHEN** Alterar checkpoint en copia privada y reanudar.
- **THEN** Resultado exacto {"error":"INTEGRITY_FAILED","reused":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T08.

#### Scenario: AFH-06-T09 Reader durante nueva generación
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Reader durante nueva generación: {"old_projection":"p1","publishing":"p2"}.
- **WHEN** Ejecutar reader concurrente mientras se publica p2.
- **THEN** Resultado exacto {"mixed_identity":false,"old_request_finishes_p1":true,"new_request_uses_p2":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T09.

### Requirement: AFH-06-R04 Recursos y privacidad

AFH MUST limitar elementos y caracteres por batch, redacción/segmentación con cobertura y operación offline sin indexar razonamiento privado ni secretos.

#### Scenario: AFH-06-T10 Límites simultáneos de batch
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Límites simultáneos de batch: {"texts":40,"characters_each":3000,"batch_size":16,"max_batch_chars":16000}.
- **WHEN** Instrumentar provider input counts y chars sin desactivar ninguno de los dos límites.
- **THEN** Resultado exacto {"max_items_lte":16,"max_chars_lte":16000}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T10.

#### Scenario: AFH-06-T11 Secretos no embebidos
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Secretos no embebidos: {"secret_canary":"SYNTHETIC_SECRET_404","private_reasoning":true}.
- **WHEN** Construir índice con provider spy y abrir coverage; raw fuente sigue privada.
- **THEN** Resultado exacto {"provider_contains_canary":false,"reasoning_embedded":false,"excluded_count_gte":2}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T11.

#### Scenario: AFH-06-T12 UTF8 y chunking boundary
- **GIVEN** Dataset semantic (synthetic, seed 404), variante UTF8 y chunking boundary: {"text":"😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀","chunk_codepoints":2000,"overlap":200}.
- **WHEN** Segmentar y verificar texto/rangos con hashes estables.
- **THEN** Resultado exacto {"broken_surrogates":0,"chunk_count":2,"overlap_codepoints":200}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T12.

#### Scenario: AFH-06-T13 Sin red en index/query
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Sin red en index/query: {"model_missing":true,"network_observed":true}.
- **WHEN** Ejecutar builder con model-home vacío y monitor de red del proceso.
- **THEN** Resultado exacto {"error":"MODEL_UNAVAILABLE","network_requests":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T13.

### Requirement: AFH-06-R05 Verificación fail-closed

AFH SHALL rechazar vectores/dimensiones/modelos/proyecciones corruptos o ausentes, conservando léxico disponible y sin fallback silencioso.

#### Scenario: AFH-06-T14 Vector no finito
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Vector no finito: {"vector":[1,0,"NaN"]}.
- **WHEN** Devolver vector no finito desde provider fixture etiquetado.
- **THEN** Resultado exacto {"error":"INTEGRITY_FAILED","published_projection":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T14.

#### Scenario: AFH-06-T15 Dimensión equivocada
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Dimensión equivocada: {"expected_dimension":384,"actual_dimension":383}.
- **WHEN** Construir batch con dimensión incorrecta y conservar último índice sano.
- **THEN** Resultado exacto {"error":"INTEGRITY_FAILED","vector_index_rows_added":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T15.

#### Scenario: AFH-06-T16 Semántica ausente sin fallback
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Semántica ausente sin fallback: {"mode":"hybrid","projection_missing":true,"allow_fallback":false}.
- **WHEN** Consultar híbrido sin sidecar compatible.
- **THEN** Resultado exacto {"status":"UNAVAILABLE","effective_mode":"unavailable","lexical_silently_used":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T16.

#### Scenario: AFH-06-T17 Fallback explícito rotulado
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Fallback explícito rotulado: {"mode":"hybrid","projection_missing":true,"allow_fallback":true}.
- **WHEN** Repetir consulta con aceptación explícita de modo léxico.
- **THEN** Resultado exacto {"effective_mode":"lexical","requested_mode":"hybrid","fallback_disclosed":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T17.

### Requirement: AFH-06-R06 Evidencia y medida real

AFH SHALL distinguir fixtures de proveedor/modelo real y medir preparación/delta/retrieval con identidad completa sin extrapolar el benchmark histórico.

#### Scenario: AFH-06-T18 Modelo local multilingüe real
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Modelo local multilingüe real: {"query":"¿Por qué falló el lector?","target":"El parser excedió el plazo.","provider":"REAL_LOCAL"}.
- **WHEN** Cargar snapshot local real y evaluar consulta ES/EN fijada.
- **THEN** Resultado exacto {"critical_target_recalled":true,"all_refs_resolve":true,"model_identity_recorded":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T18.

#### Scenario: AFH-06-T19 Fixture no demuestra calidad real
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Fixture no demuestra calidad real: {"provider":"fixture/concepts","claim":"real-model-acceptance"}.
- **WHEN** Intentar producir receipt de calidad real desde provider fixture.
- **THEN** Resultado exacto {"acceptance":"BLOCKED","reason":"FIXTURE_AS_REAL_MODEL"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T19; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T19.

#### Scenario: AFH-06-T20 No reindex sin delta
- **GIVEN** Dataset semantic (synthetic, seed 404), variante No reindex sin delta: {"same_source_revision":true,"same_config":true}.
- **WHEN** Repetir build compatible y verificar sidecar antes de anunciar reuse.
- **THEN** Resultado exacto {"provider_inputs":0,"status":"REUSED","verification_required":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-06-T20; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-06-T20.

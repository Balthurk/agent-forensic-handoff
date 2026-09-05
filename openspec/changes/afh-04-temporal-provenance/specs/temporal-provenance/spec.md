## Purpose

Versionar vigencia y conocimiento de afirmaciones, relaciones y artefactos para reconstruir qué ocurrió, qué se sabía en cada corte y qué causalidad está demostrada.

## ADDED Requirements

### Requirement: AFH-04-R01 Bitemporalidad por afirmación

AFH SHALL seleccionar revisiones conocidas por afirmación/rama y evaluar todos sus tramos de vigencia con correcciones atómicas y sin fuga de conocimiento futuro.

#### Scenario: AFH-04-T01 A/B cuatro cortes
- **GIVEN** Dataset temporal (synthetic, seed 404), variante A/B cuatro cortes: {"queries":[0,1,2,3]}.
- **WHEN** Publicar ambos tramos y su corrección; consultar known_at/valid_at mediante API temporal.
- **THEN** Resultado exacto {"matches":[["A"],["B"],["A"],["B"]]}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T01.

#### Scenario: AFH-04-T02 No futuro antes de adquisición
- **GIVEN** Dataset temporal (synthetic, seed 404), variante No futuro antes de adquisición: {"known_at":"2026-01-19T23:59:59Z","valid_at":"2026-01-05T00:00:00Z"}.
- **WHEN** Consultar antes de recorded_at inicial, conservando receipt de cobertura.
- **THEN** Resultado exacto {"matches":[],"presence":"NOT_OBSERVED_IN_CAPTURED_EVIDENCE"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T02.

### Requirement: AFH-04-R02 Precisión y tiempo incierto

AFH SHALL distinguir puntos/duración de ejecución de vigencia, conservar zonas/precisión y aplicar lógica TRUE/FALSE/UNKNOWN a límites incompletos.

#### Scenario: AFH-04-T03 Frontera half-open
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Frontera half-open: {"queries":[4,5]}.
- **WHEN** Consultar inicio exacto de B en cada revisión conocida.
- **THEN** Resultado exacto {"matches":[["B"],["B"]],"overlap":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T03.

#### Scenario: AFH-04-T04 Unknown y zona ausente
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Unknown y zona ausente: {"from_kind":"unknown","timestamp_local":"2026-01-05 12:00:00"}.
- **WHEN** Ingerir timestamp sin zona y evaluar valid_at UTC.
- **THEN** Resultado exacto {"match":"UNKNOWN","utc_invented":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T04.

#### Scenario: AFH-04-T20 Duración no es vigencia
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Duración no es vigencia: {"execution_duration_ms":1500,"decision_end":null}.
- **WHEN** Consultar una decisión emitida durante una ejecución breve.
- **THEN** Resultado exacto {"decision_end":"unknown","execution_duration_ms":1500,"revocation_inferred":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T20; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T20.

#### Scenario: AFH-04-T21 Subnanosecond inversion
- **GIVEN** Synthetic case AFH-04-T21: {"from":"2026-01-01T00:00:00.000000002Z","to":"2026-01-01T00:00:00.000000001Z"}
- **WHEN** Run node --test --test-name-pattern=AFH-04-T21 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"rejected":"INVALID_TEMPORAL_RANGE"}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-04-T21; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T21.

#### Scenario: AFH-04-T22 Open start forbidden
- **GIVEN** Synthetic case AFH-04-T22: {"from_kind":"open","to_kind":"known"}
- **WHEN** Run node --test --test-name-pattern=AFH-04-T22 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"schema_valid":false,"checker_rejects":true}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-04-T22; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T22.

#### Scenario: AFH-04-T23 Calendar and precision errors
- **GIVEN** Synthetic case AFH-04-T23: {"invalid_dates":["2026-02-30","2025-02-29"],"fraction_digits":4,"precision":"ms"}
- **WHEN** Run node --test --test-name-pattern=AFH-04-T23 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"calendar_errors_rejected":true,"precision_mismatch_rejected":true}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-04-T23; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T23.

#### Scenario: AFH-04-T24 Exact zones and valid boundaries
- **GIVEN** Synthetic case AFH-04-T24: {"offsets":["+01:00","Z","-01:00"],"leap_day":"2024-02-29"}
- **WHEN** Run node --test --test-name-pattern=AFH-04-T24 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"equivalent_instants":true,"empty_interval_valid":true,"leap_day_duration_ns":"86400000000000"}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-04-T24; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T24.

#### Scenario: AFH-04-T25 Uncertain precision and unknown offset
- **GIVEN** Synthetic case AFH-04-T25: {"precision":"day","offset":"-00:00","leap_second":"unverified"}
- **WHEN** Run node --test --test-name-pattern=AFH-04-T25 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"overlap":"UNKNOWN_PRECISION_OVERLAP","unknown_not_exact":true}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-04-T25; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T25.

### Requirement: AFH-04-R03 Grafo sustentado y acotado

AFH SHALL mantener grafo lógico Plata con extremos/dirección/grade/regla/evidencia/tiempo, sin tratar adyacencia como causalidad ni corroboración.

#### Scenario: AFH-04-T05 Spawn y respuesta propia
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Spawn y respuesta propia: {"root":"synthetic-parent","hops":3}.
- **WHEN** Recorrer parent→SPAWNED→child→IN_SESSION inverso→respuesta terminal.
- **THEN** Resultado exacto {"children":2,"final_refs":["final-a"],"missing_terminal":["synthetic-child-b"]}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T05.

#### Scenario: AFH-04-T06 Ciclo y límite
- **GIVEN** Dataset retrieval (synthetic, seed 404), variante Ciclo y límite: {"cycle":["a","b","a"],"max_nodes":2}.
- **WHEN** Consultar grafo cíclico con max_nodes 2.
- **THEN** Resultado exacto {"visited_lte":2,"truncated":true,"infinite_loop":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T06.

### Requirement: AFH-04-R04 Utilidad y reparación probada

AFH MUST retener fallo/contradicción si un éxito posterior no prueba el mismo objetivo y artefacto/revisión; exit 0 o fingerprint igual no revocan el fallo.

#### Scenario: AFH-04-T07 Éxito ajeno no repara fallo
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Éxito ajeno no repara fallo: {"failed_target":"parser-alpha","later_success_target":"parser-beta","same_command":true}.
- **WHEN** Capturar fallo, cambio de objetivo, éxito y reporte de cierre del objetivo antiguo.
- **THEN** Resultado exacto {"failure_retained":true,"contradictions":1,"superseded":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T07.

#### Scenario: AFH-04-T08 Reparación del mismo artefacto
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Reparación del mismo artefacto: {"failed_revision":"artifact-r1","fixed_revision":"artifact-r2","validation_target":"artifact-r2","criterion":"parser handles truncation","criterion_pass":true}.
- **WHEN** Crear cadena explícita execution→patch→r2→validator→criterio con hashes resolubles.
- **THEN** Resultado exacto {"old_failure_retained":true,"resolution_link":true,"task_criterion":"VERIFIED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T08.

#### Scenario: AFH-04-T09 Mismo cwd distinto contenido
- **GIVEN** Dataset occurrences (synthetic, seed 404), variante Mismo cwd distinto contenido: {"cwd":".","head_before":"commit-a","head_after":"commit-b","binding_absent":true}.
- **WHEN** Capturar dos comandos iguales separados por cambio de checkout/content.
- **THEN** Resultado exacto {"goal_closed":false,"unresolved_failure":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T09.

### Requirement: AFH-04-R05 Provenance de artifacts y patches

AFH SHALL conservar add/update/delete/move/discard y pre/post hashes cuando estén observados, sin aplicar patches históricos ni inventar contenido faltante.

#### Scenario: AFH-04-T10 Patch completo y move
- **GIVEN** Dataset archive (synthetic, seed 404), variante Patch completo y move: {"operations":["ADD","UPDATE","MOVE","DELETE"],"from":"src/a.js","to":"src/b.js"}.
- **WHEN** Normalizar variantes de apply_patch/FileChange sin ejecutarlas.
- **THEN** Resultado exacto {"revisions":4,"move_link":true,"source_executions":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T10.

#### Scenario: AFH-04-T11 Patch truncado
- **GIVEN** Dataset archive (synthetic, seed 404), variante Patch truncado: {"unified_diff":"@@ incomplete","preimage_available":false}.
- **WHEN** Ingerir diff incompleto; consultar artifact revision.
- **THEN** Resultado exacto {"content_sha256":null,"status":"UNKNOWN","patch_ref_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T11.

#### Scenario: AFH-04-T12 Solución descartada
- **GIVEN** Dataset intent (synthetic, seed 404), variante Solución descartada: {"artifact":"attempt-a","discard_event":"human-discard-1"}.
- **WHEN** Registrar descarte explícito y recuperar intento en Plata.
- **THEN** Resultado exacto {"disposition":"DISCARD","old_bytes_resolve":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T12.

### Requirement: AFH-04-R06 Linaje Git y contradicción

AFH SHALL registrar objetos/parents/trees/blobs comprobables y contradicciones/revocaciones explícitas conservando cada versión histórica.

#### Scenario: AFH-04-T13 Git sha1 y sha256
- **GIVEN** Dataset archive (synthetic, seed 404), variante Git sha1 y sha256: {"formats":["sha1","sha256"],"native_objects":true}.
- **WHEN** Usar repositorios sintéticos con objetos reales y leer linaje mediante allowlisted lectura actual.
- **THEN** Resultado exacto {"formats_separate":true,"parent_links_verified":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T13.

#### Scenario: AFH-04-T14 Nombre de rama no prueba linaje
- **GIVEN** Dataset archive (synthetic, seed 404), variante Nombre de rama no prueba linaje: {"reported_branch":"main","git_object_missing":true}.
- **WHEN** Ingerir mención de branch sin objeto/OID comprobable.
- **THEN** Resultado exacto {"parent_link":false,"epistemic":"UNCERTAIN"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T14.

#### Scenario: AFH-04-T15 Contradicciones simultáneas
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Contradicciones simultáneas: {"branches":["branch-a","branch-b"],"same_subject":true,"incompatible_values":true}.
- **WHEN** Consultar dos afirmaciones vigentes incompatibles con evidencia propia.
- **THEN** Resultado exacto {"matches":2,"conflict":true,"winner":null}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T15.

#### Scenario: AFH-04-T16 Revocación conocida tarde
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Revocación conocida tarde: {"revoke_valid_at":"2026-01-08T00:00:00Z","known_at":"2026-02-01T00:00:00Z"}.
- **WHEN** Añadir revocación retrospectiva y consultar ambos cortes.
- **THEN** Resultado exacto {"before_knowledge":"old_view","after_knowledge":"revoked_view","old_revision_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T16.

### Requirement: AFH-04-R07 Paridad de selector y recuperación

AFH SHALL aplicar igual selector temporal a asociaciones, consulta, grafo, Gold y contexto, manteniendo coherencia de lectores y atomicidad bajo crash/restart.

#### Scenario: AFH-04-T17 Paridad temporal cinco consumidores
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Paridad temporal cinco consumidores: {"consumers":["association","query","graph","context","gold"],"queries":[0,1,2,3,4,5]}.
- **WHEN** Ejecutar las seis consultas por cada consumidor y comparar IDs/evidencia.
- **THEN** Resultado exacto {"every_consumer_matches_oracle":true,"future_aliases":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T17.

#### Scenario: AFH-04-T18 Crash entre correcciones
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Crash entre correcciones: {"terminate_between_rows":true}.
- **WHEN** Matar proceso writer durante batch y abrir reader/recovery.
- **THEN** Resultado exacto {"visible_pairs":[["a1","b1"],["a2","b2"]],"mixed_pair":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T18.

#### Scenario: AFH-04-T19 Reloj de conocimiento retrocede
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Reloj de conocimiento retrocede: {"last_recorded_at":"2026-02-01T00:00:00Z","clock_now":"2026-01-31T23:59:59Z"}.
- **WHEN** Intentar publicar revisión con reloj inyectado regresivo; última revisión intacta.
- **THEN** Resultado exacto {"error":"CLOCK_REGRESSION","invented_time":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-04-T19; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-04-T19.

## Purpose

Capturar actividad futura autorizada mediante hook local e importación OTLP/OpenInference/AppServer, preservando límites, pérdidas y procedencia sin reejecutar ni reinventar historia ausente.

## ADDED Requirements

### Requirement: AFH-12-R01 Opt-in acotado

AFH MUST habilitar captura futura solo con configuración/consentimiento explícitos de scope/output/adapter, sin instalar hooks globales ni requerir servicio externo.

#### Scenario: AFH-12-T01 Captura desactivada
- **GIVEN** Dataset capture (synthetic, seed 404), variante Captura desactivada: {"config_absent":true}.
- **WHEN** Ejecutar AFH sin capture.init y comprobar ausencia de hook.
- **THEN** Resultado exacto {"captured_events":0,"background_services_started":0,"retrospective_cli_available":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T01.

#### Scenario: AFH-12-T02 Opt-in específico
- **GIVEN** Dataset capture (synthetic, seed 404), variante Opt-in específico: {"enabled":true,"scope":"project-a","adapter":"hook-v1","output":"private-run"}.
- **WHEN** Inicializar configuración explícita y enviar evento dentro/fuera del scope.
- **THEN** Resultado exacto {"consent_recorded":true,"other_projects_captured":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T02.

#### Scenario: AFH-12-T03 Scope omitido
- **GIVEN** Dataset capture (synthetic, seed 404), variante Scope omitido: {"consent_scope":null}.
- **WHEN** Intentar capture.init sin ámbito autorizado.
- **THEN** Resultado exacto {"error":"INVALID_REQUEST","capture_enabled":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T03.

### Requirement: AFH-12-R02 Hook genérico y formato fiel

AFH SHALL conservar los eventos entregados por hook con identidad/sequence/clock/payload y correlación explícita, sin ejecutar contenidos históricos.

#### Scenario: AFH-12-T04 Hook start/output/end
- **GIVEN** Dataset capture (synthetic, seed 404), variante Hook start/output/end: {"events":["tool.start","tool.output","tool.end"],"same_call_id":true}.
- **WHEN** Enviar eventos por stdin al CLI real y después ingerir spool.
- **THEN** Resultado exacto {"occurrences":1,"representations":3,"stdout_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T04.

#### Scenario: AFH-12-T05 Comando como dato
- **GIVEN** Dataset capture (synthetic, seed 404), variante Comando como dato: {"payload_command":"create HISTORICAL_REPLAY_CANARY"}.
- **WHEN** Capturar comando sin ejecutarlo; comprobar canario ausente.
- **THEN** Resultado exacto {"historical_execution_count":0,"payload_ref_resolves":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T05.

#### Scenario: AFH-12-T06 Clock domains distintos
- **GIVEN** Dataset capture (synthetic, seed 404), variante Clock domains distintos: {"start_domain":"a","end_domain":"b"}.
- **WHEN** Normalizar inicio/fin de relojes no comparables.
- **THEN** Resultado exacto {"duration_ms":null,"precision":"unknown","both_events_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T06.

### Requirement: AFH-12-R03 OTLP y OpenInference

AFH SHALL importar spans/events/attributes OTLP y OpenInference con precisión/provenance/cobertura, sin equiparar instrumentation status OK a PASS de proceso/objetivo.

#### Scenario: AFH-12-T07 OTLP nanosegundos
- **GIVEN** Dataset capture (synthetic, seed 404), variante OTLP nanosegundos: {"format":"otlp-json-v1","start_ns":"1767225600000000000","end_ns":"1767225601000000000"}.
- **WHEN** Importar resourceSpans fixture y comparar tiempos exactos.
- **THEN** Resultado exacto {"duration_ns":"1000000000","trace_and_span_ids_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T07.

#### Scenario: AFH-12-T08 OpenInference attrs
- **GIVEN** Dataset capture (synthetic, seed 404), variante OpenInference attrs: {"format":"openinference-v1","span_kind":"TOOL","input":"synthetic input","output":"synthetic output"}.
- **WHEN** Importar atributos y resolver payloads preservados.
- **THEN** Resultado exacto {"kind":"tool","input_ref":true,"output_ref":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T08.

#### Scenario: AFH-12-T09 Span OK no prueba test
- **GIVEN** Dataset capture (synthetic, seed 404), variante Span OK no prueba test: {"span_status":"OK","process_exit_code":null,"criterion_binding":null}.
- **WHEN** Normalizar span y consultar validación/estado de tarea.
- **THEN** Resultado exacto {"process_validation":"UNKNOWN","goal_closed":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T09.

### Requirement: AFH-12-R04 AppServer versionado

AFH SHALL aceptar el perfil AppServer probado con thread/turn/item IDs y schema digest, preservando eventos desconocidos y límites de captura.

#### Scenario: AFH-12-T10 Item AppServer completado
- **GIVEN** Dataset platform (synthetic, seed 404), variante Item AppServer completado: {"profile":"codex-app-server-0.144.5","item_type":"CommandExecution","thread_id":"s","turn_id":"t","item_id":"i"}.
- **WHEN** Validar evento contra schema fijado e ingerir.
- **THEN** Resultado exacto {"ids_preserved":true,"normalization_supported":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T10.

#### Scenario: AFH-12-T11 Evento AppServer futuro
- **GIVEN** Dataset platform (synthetic, seed 404), variante Evento AppServer futuro: {"unknown_type":"FutureItemV99"}.
- **WHEN** Importar tipo fuera del registry sin descartar contenido.
- **THEN** Resultado exacto {"raw_preserved":true,"coverage":"PARTIAL","normalized_as_known":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T11.

#### Scenario: AFH-12-T12 AppServer captura parcial
- **GIVEN** Dataset capture (synthetic, seed 404), variante AppServer captura parcial: {"missing_events":["tool.end"]}.
- **WHEN** Importar secuencia sin terminal y consultar receipt.
- **THEN** Resultado exacto {"lifecycle":"INCOMPLETE","retrospective_invention":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T12.

### Requirement: AFH-12-R05 Spool seguro y recuperable

AFH SHALL limitar espacio/batches, registrar pérdidas conocidas/desconocidas y reanudar entregas idempotentes tras crash/torn frame sin duplicar actos.

#### Scenario: AFH-12-T13 Delivery duplicada
- **GIVEN** Dataset capture (synthetic, seed 404), variante Delivery duplicada: {"delivery_id":"d1","same_bytes_twice":true}.
- **WHEN** Reenviar exactamente el mismo frame tras reinicio.
- **THEN** Resultado exacto {"acquired":1,"duplicate_deliveries":1,"occurrences":1}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T13.

#### Scenario: AFH-12-T14 Mismo ID diferente payload
- **GIVEN** Dataset capture (synthetic, seed 404), variante Mismo ID diferente payload: {"delivery_id":"d1","payloads":["one","two"]}.
- **WHEN** Reutilizar delivery_id con otros bytes.
- **THEN** Resultado exacto {"error":"IDEMPOTENCY_CONFLICT","first_frame_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T14.

#### Scenario: AFH-12-T15 Spool lleno y pérdida
- **GIVEN** Dataset capture (synthetic, seed 404), variante Spool lleno y pérdida: {"spool_limit_bytes":1024,"input_bytes":1025}.
- **WHEN** Usar límite reducido en test y comprobar counters/receipt.
- **THEN** Resultado exacto {"rejected":1,"dropped_known":1,"universe_dropped":null}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T15.

#### Scenario: AFH-12-T16 Torn frame y restart
- **GIVEN** Dataset capture (synthetic, seed 404), variante Torn frame y restart: {"truncate_last_frame":true}.
- **WHEN** Interrumpir writer real del spool, reiniciar y comprobar último offset.
- **THEN** Resultado exacto {"durable_frames_preserved":true,"torn_frame_reported":true,"phantom_terminal":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T16.

### Requirement: AFH-12-R06 Privacidad y límite retrospectivo

AFH MUST mantener spool/derivados privados, redacción explícita y ninguna promesa de recuperar bytes/eventos/razonamiento que no llegaron al productor.

#### Scenario: AFH-12-T17 Redacción y secreto de fixture
- **GIVEN** Dataset capture (synthetic, seed 404), variante Redacción y secreto de fixture: {"secret_canary":"SYNTHETIC_SECRET_404"}.
- **WHEN** Capturar dato con patrón de secreto y revisar proyección/spool.
- **THEN** Resultado exacto {"raw_private":true,"projection_canary":false,"coverage_exclusions_recorded":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T17.

#### Scenario: AFH-12-T18 No recuperable antes del hook
- **GIVEN** Dataset capture (synthetic, seed 404), variante No recuperable antes del hook: {"event_precedes_enable":true,"producer_did_not_persist":true}.
- **WHEN** Consultar evento no recibido y comprobar límite explícito.
- **THEN** Resultado exacto {"availability":"UNAVAILABLE","reconstructed":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-12-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-12-T18.

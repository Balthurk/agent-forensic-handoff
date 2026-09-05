## Purpose

Definir y comprobar contratos de harness/formato/versión y plataformas soportadas con fixtures públicos seguros y evidencia real de cada combinación requerida.

## ADDED Requirements

### Requirement: AFH-10-R01 Registro por versión y perfil

AFH SHALL publicar matriz de harness/producer/formato/adapter/schema/fixtures y capacidades observadas, con UNKNOWN explícito fuera del rango probado.

#### Scenario: AFH-10-T01 Registro de versión soportada
- **GIVEN** Dataset platform (synthetic, seed 404), variante Registro de versión soportada: {"harness":"codex","profile":"codex-rollout-2026-09","schema_digest_required":true}.
- **WHEN** Consultar registry y normalizar fixtures exactos enlazados por digest.
- **THEN** Resultado exacto {"profile_matched":true,"adapter_version_present":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T01.

#### Scenario: AFH-10-T02 Versión no registrada
- **GIVEN** Dataset platform (synthetic, seed 404), variante Versión no registrada: {"producer_version":"future-unregistered"}.
- **WHEN** Capturar un record válido de versión fuera de matriz.
- **THEN** Resultado exacto {"normalization_coverage":"PARTIAL","unknown_version_warning":true,"raw_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T02.

#### Scenario: AFH-10-T03 Producer UNKNOWN honesto
- **GIVEN** Dataset platform (synthetic, seed 404), variante Producer UNKNOWN honesto: {"harness":"antigravity","producer_version":null}.
- **WHEN** Consultar matriz y receipt del export generic.
- **THEN** Resultado exacto {"producer_version":"UNKNOWN","universal_support_claim":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T03.

### Requirement: AFH-10-R02 Fixtures fieles y contabilidad

AFH SHALL probar variantes Codex AppServer/JSONL, Claude, Antigravity y generic con fixtures sintéticos/redactados y cobertura de tipos/errores/normalización.

#### Scenario: AFH-10-T04 AppServer schema fijado
- **GIVEN** Dataset platform (synthetic, seed 404), variante AppServer schema fijado: {"cli_version":"0.144.5","fixture_types":["UserMessage","AgentMessage","CommandExecution","McpToolCall","FileChange"]}.
- **WHEN** Generar schema con CLI local identificado y validar fixtures mínimos públicos.
- **THEN** Resultado exacto {"supported_types":5,"schema_digest_checked":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T04.

#### Scenario: AFH-10-T05 Claude y Antigravity limitados
- **GIVEN** Dataset platform (synthetic, seed 404), variante Claude y Antigravity limitados: {"profiles":["claude-baseline-jsonl","antigravity-generic-export"]}.
- **WHEN** Ejecutar normalización y evidence resolution para ambos perfiles.
- **THEN** Resultado exacto {"known_types_preserved":true,"unknown_types_counted":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T05.

#### Scenario: AFH-10-T06 Malformed y variantes incompletas
- **GIVEN** Dataset archive (synthetic, seed 404), variante Malformed y variantes incompletas: {"records":["invalid JSON","valid unsupported type","tool missing output"]}.
- **WHEN** Probar corpus mixto por perfil y no equiparar parsed con normalized.
- **THEN** Resultado exacto {"unparsed":1,"unsupported":1,"incomplete":1}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T06.

### Requirement: AFH-10-R03 Cinco plataformas reales

AFH SHALL ejecutar matriz requerida Windows x64, Linux x64/arm64 y macOS x64/arm64 con Node22/24 y evidencia de runtime real, sin simular aceptación.

#### Scenario: AFH-10-T07 Windows y Linux x64
- **GIVEN** Dataset platform (synthetic, seed 404), variante Windows y Linux x64: {"targets":["windows-x64","linux-x64"],"node":[22,24]}.
- **WHEN** Ejecutar CI real y conservar receipts con Node/OS/model/digests.
- **THEN** Resultado exacto {"native_jobs":4,"actual_arch":"x64","core_and_semantic_smoke":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T07.

#### Scenario: AFH-10-T08 Linux arm64 nativo
- **GIVEN** Dataset platform (synthetic, seed 404), variante Linux arm64 nativo: {"targets":["linux-arm64"],"node":[22,24]}.
- **WHEN** Ejecutar runner arm64 y modelo local real; no reemplazar por x64.
- **THEN** Resultado exacto {"native_jobs":2,"actual_arch":"arm64","sqlite_vec_loaded":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T08.

#### Scenario: AFH-10-T09 macOS x64 y arm64 nativos
- **GIVEN** Dataset platform (synthetic, seed 404), variante macOS x64 y arm64 nativos: {"targets":["macos-x64","macos-arm64"],"node":[22,24]}.
- **WHEN** Ejecutar ambas arquitecturas macOS y conservar evidencia.
- **THEN** Resultado exacto {"native_jobs":4,"architectures_verified":true,"semantic_smoke":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T09.

#### Scenario: AFH-10-T10 Runner ausente
- **GIVEN** Dataset platform (synthetic, seed 404), variante Runner ausente: {"target":"macos-arm64","available":false}.
- **WHEN** Evaluar matriz sin resultado del target requerido.
- **THEN** Resultado exacto {"status":"UNAVAILABLE","release_gate":"BLOCKED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T10.

### Requirement: AFH-10-R04 Legacy y rutas

AFH SHALL conservar CLI y casos1/2/3, UTF8/CRLF/rutas Windows/UNC/permisos/reparse y límites de compresión conforme a cada plataforma.

#### Scenario: AFH-10-T11 Casos legacy en matriz
- **GIVEN** Dataset archive (synthetic, seed 404), variante Casos legacy en matriz: {"schemas":[1,2,3]}.
- **WHEN** Abrir/importar fixtures legacy en cada target y comparar hashes before/after.
- **THEN** Resultado exacto {"old_cases_unchanged":true,"legacy_uri_resolution":1}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T11.

#### Scenario: AFH-10-T12 Symlink y permisos
- **GIVEN** Dataset identity (synthetic, seed 404), variante Symlink y permisos: {"reparse":true,"permission_denied":true}.
- **WHEN** Crear fixtures de rutas/permisos en targets que los soportan; un skip no prueba esa propiedad.
- **THEN** Resultado exacto {"external_read":false,"explicit_error":true,"source_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T12.

#### Scenario: AFH-10-T13 Zstd no disponible en runtime
- **GIVEN** Dataset archive (synthetic, seed 404), variante Zstd no disponible en runtime: {"zstd_available":false,"input_codec":"zstd"}.
- **WHEN** Solicitar lectura comprimida en runtime sin codec y conservar archivo.
- **THEN** Resultado exacto {"status":"UNAVAILABLE","raw_preserved":true,"implicit_codec_conversion":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T13.

### Requirement: AFH-10-R05 CI segura y fail-closed

AFH MUST impedir datos privados en CI y distinguir skips/missing dependencies de PASS, vinculando resultados a commit/runner/modelo/fixtures exactos.

#### Scenario: AFH-10-T14 Privacidad de CI
- **GIVEN** Dataset intent (synthetic, seed 404), variante Privacidad de CI: {"private_canary_path":"outside-checkout","fixture_secret":"SYNTHETIC_SECRET_404"}.
- **WHEN** Escanear manifest de artefactos y fixtures públicos antes de upload.
- **THEN** Resultado exacto {"private_paths_in_upload":0,"real_transcripts_in_ci":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T14.

#### Scenario: AFH-10-T15 Métrica fixture etiquetada real
- **GIVEN** Dataset platform (synthetic, seed 404), variante Métrica fixture etiquetada real: {"result_provider":"FIXTURE","claim":"REAL_MODEL"}.
- **WHEN** Validar receipt de plataforma incompatible con su evidencia.
- **THEN** Resultado exacto {"acceptance":"BLOCKED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T15.

#### Scenario: AFH-10-T16 Commit de CI distinto
- **GIVEN** Dataset release (synthetic, seed 404), variante Commit de CI distinto: {"candidate_commit":"new","ci_commit":"old"}.
- **WHEN** Comprobar gate con CI verde que corresponde a otro candidato.
- **THEN** Resultado exacto {"acceptance":"BLOCKED","reason":"STALE_EVIDENCE"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-10-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-10-T16.

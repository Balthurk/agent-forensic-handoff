## Purpose

Conservar la identidad nativa de cada hilo y su historial de proyecto/workspace/checkout para que agentes y consultas no atribuyan trabajo de un hijo a su padre ni reasignen su pasado.

## ADDED Requirements

### Requirement: AFH-01-R01 Identidad nativa y agrupación

AFH SHALL atribuir cada evento al ID nativo dentro de harness/origen, conservar grouping y padre/hijo por separado y rechazar aliases ambiguos.

#### Scenario: AFH-01-T01 Hijo con agrupación del padre
- **GIVEN** Dataset identity (synthetic, seed 404), variante Hijo con agrupación del padre: {"native_id":"synthetic-child","shared_id":"synthetic-parent"}.
- **WHEN** Capturar mediante auditSession el session_meta y mensaje sintéticos del probe.
- **THEN** Resultado exacto {"event_session":"synthetic-child","grouping":"synthetic-parent"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T01.

#### Scenario: AFH-01-T02 Dos hijos y padre
- **GIVEN** Dataset identity (synthetic, seed 404), variante Dos hijos y padre: {"native_ids":["parent","child-a","child-b"],"shared_id":"parent"}.
- **WHEN** Ingerir tres fuentes con dos edges SPAWNED explícitos; filtrar cada session_id.
- **THEN** Resultado exacto {"sessions":3,"owners_per_source":1,"groupings":1}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T02.

#### Scenario: AFH-01-T03 Alias ambiguo rechazado
- **GIVEN** Dataset identity (synthetic, seed 404), variante Alias ambiguo rechazado: {"alias":"ses:codex:repeat","origins":["origin-a","origin-b"]}.
- **WHEN** Resolver alias legado sin origin_domain.
- **THEN** Resultado exacto {"error":"AMBIGUOUS_IDENTITY","candidates":2,"selected":null}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T03.

### Requirement: AFH-01-R02 Origen, alias y fallback

AFH SHALL separar IDs iguales de distintos orígenes/harnesses, registrar aliases demostrados y mantener identidad provisional explícita cuando falta ID nativo.

#### Scenario: AFH-01-T04 Mismo ID en dos harnesses
- **GIVEN** Dataset identity (synthetic, seed 404), variante Mismo ID en dos harnesses: {"native_id":"same","harnesses":["codex","claude"]}.
- **WHEN** Ingerir ambas fuentes en un archivo y consultar sus IDs completos.
- **THEN** Resultado exacto {"native_sessions":2,"collision":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T04.

#### Scenario: AFH-01-T05 Origen ausente
- **GIVEN** Dataset identity (synthetic, seed 404), variante Origen ausente: {"native_id":null,"path":"C:\\synthetic\\one.jsonl"}.
- **WHEN** Ingerir fuente genérica sin identidad y consultar evento con evidencia.
- **THEN** Resultado exacto {"identity_status":"UNCERTAIN","provisional":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T05.

#### Scenario: AFH-01-T06 Alias de relocación explícito
- **GIVEN** Dataset identity (synthetic, seed 404), variante Alias de relocación explícito: {"lineage":"lineage-a","from":"C:\\Project A","to":"D:\\Relocated A","same_source_hash":true}.
- **WHEN** Registrar relocación con identidad de fuente y referencia verificable.
- **THEN** Resultado exacto {"lineages":1,"location_observations":2}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T06.

### Requirement: AFH-01-R03 Proyecto, workspace y checkout

AFH SHALL modelar proyecto lógico, ubicación y checkout como entidades diferentes con alias/relocación versionados, sin mover ni duplicar payload histórico.

#### Scenario: AFH-01-T07 Un proyecto dos worktrees
- **GIVEN** Dataset identity (synthetic, seed 404), variante Un proyecto dos worktrees: {"project_id":"project-a","worktrees":["wt-1","wt-2"],"same_remote":true}.
- **WHEN** Registrar dos checkouts y recuperar contexto por cada uno.
- **THEN** Resultado exacto {"projects":1,"checkouts":2}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T07.

#### Scenario: AFH-01-T08 Un remote dos proyectos
- **GIVEN** Dataset identity (synthetic, seed 404), variante Un remote dos proyectos: {"remote":"synthetic-repo","projects":["project-a","project-b"]}.
- **WHEN** Registrar proyectos explícitos compartiendo remote; resolver scope por proyecto.
- **THEN** Resultado exacto {"projects":2,"auto_merge":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T08.

#### Scenario: AFH-01-T09 Nombre parecido no alias
- **GIVEN** Dataset identity (synthetic, seed 404), variante Nombre parecido no alias: {"names":["Parser","parser-copy"],"evidence":null}.
- **WHEN** Ingerir observaciones sin declaración de alias.
- **THEN** Resultado exacto {"auto_merge":false,"projects":2}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T09.

### Requirement: AFH-01-R04 Asociaciones por tramos

AFH SHALL preservar cada tramo temporal y aplicar correcciones de frontera atómicas con expected_revision_id explícito, incluyendo estados projectless/no_workspace/unknown.

#### Scenario: AFH-01-T10 Tramos A/B conocidos
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Tramos A/B conocidos: {"queries":[0,1,2,3]}.
- **WHEN** Ejecutar las cuatro consultas known_at/valid_at del dataset sobre asociaciones.
- **THEN** Resultado exacto {"matches":[["A"],["B"],["A"],["B"]]}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T10.

#### Scenario: AFH-01-T11 Fronteras exactas
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Fronteras exactas: {"queries":[4,5]}.
- **WHEN** Consultar la frontera original y la corregida con intervalos half-open.
- **THEN** Resultado exacto {"matches":[["B"],["B"]]}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T11.

#### Scenario: AFH-01-T12 Batch de corrección stale
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Batch de corrección stale: {"changes":["a2","b2"],"expected_b":"b0"}.
- **WHEN** Corregir ambos tramos con revisión esperada incorrecta en b.
- **THEN** Resultado exacto {"error":"REVISION_CONFLICT","published":["a1","b1"],"partial_correction":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T12.

#### Scenario: AFH-01-T13 Sin workspace versus projectless
- **GIVEN** Dataset identity (synthetic, seed 404), variante Sin workspace versus projectless: {"states":["projectless","no_workspace","unknown"]}.
- **WHEN** Registrar y consultar las tres asociaciones sin colapsarlas a null genérico.
- **THEN** Resultado exacto {"distinct_states":3,"invented_project":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T13.

#### Scenario: AFH-01-T14 Hueco y solapamiento
- **GIVEN** Dataset temporal (synthetic, seed 404), variante Hueco y solapamiento: {"gap":["2026-01-08","2026-01-10"],"overlap":["2026-01-10","2026-01-12"]}.
- **WHEN** Consultar 9 enero en variante gap y 11 enero en variante overlap.
- **THEN** Resultado exacto {"gap":"NO_ASSOCIATION_OBSERVED","overlap":"CONFLICT","overlap_matches":2}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T14.

### Requirement: AFH-01-R05 Ámbito explícito y grupos

AFH SHALL permitir scope por proyecto/hilo/grupo/periodo e intersectar filtros, declarando contexto inferido o ambiguo sin mezclar proyectos silenciosamente.

#### Scenario: AFH-01-T15 Grupo explícito y periodo
- **GIVEN** Dataset identity (synthetic, seed 404), variante Grupo explícito y periodo: {"group":["synthetic-child-a","synthetic-child-b"],"from":"2026-01-01T00:00:00Z","to":"2026-01-02T00:00:00Z"}.
- **WHEN** Resolver grupo y ejecutar query con periodo.
- **THEN** Resultado exacto {"included_sessions":2,"unrelated":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T15.

#### Scenario: AFH-01-T16 Ámbito ajeno explícito
- **GIVEN** Dataset identity (synthetic, seed 404), variante Ámbito ajeno explícito: {"active":"project-a","explicit":"project-b"}.
- **WHEN** Solicitar otro proyecto dentro del mismo dominio de acceso.
- **THEN** Resultado exacto {"effective":"project-b","disclosed":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T16.

#### Scenario: AFH-01-T17 Ámbito inferido incierto
- **GIVEN** Dataset identity (synthetic, seed 404), variante Ámbito inferido incierto: {"path":"C:\\Project A","project_evidence":"ambiguous"}.
- **WHEN** Resolver contexto sin proyecto explícito y con dos candidatos.
- **THEN** Resultado exacto {"resolution":"AMBIGUOUS","selected":null}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T17.

### Requirement: AFH-01-R06 Límites de identidad y plataforma

AFH MUST conservar rutas/bytes originales y sus límites de interpretación, impedir escapes/reparse por defecto y validar contratos antes de efectos. Test receipts MUST identify effective owned runtime bytes including untracked files before/after execution and reject unstable evidence.

#### Scenario: AFH-01-T18 Windows Unicode y UNC
- **GIVEN** Dataset identity (synthetic, seed 404), variante Windows Unicode y UNC: {"paths":["C:\\Árbol con espacios","\\\\host\\share\\Árbol"],"case_mode":"unknown"}.
- **WHEN** Registrar y serializar ambas rutas sin ejecutar ni explorar el host UNC.
- **THEN** Resultado exacto {"original_paths_preserved":true,"auto_case_fold":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T18.

#### Scenario: AFH-01-T19 Ruta reparse fuera de raíz
- **GIVEN** Dataset identity (synthetic, seed 404), variante Ruta reparse fuera de raíz: {"reparse_target":"outside-authorized-root"}.
- **WHEN** Intentar adquisición con un symlink creado solo en raíz sintética de prueba.
- **THEN** Resultado exacto {"error":"INVALID_REQUEST","external_reads":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T19; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T19.

#### Scenario: AFH-01-T20 Protocolo incompatible
- **GIVEN** Dataset identity (synthetic, seed 404), variante Protocolo incompatible: {"protocol_version":"4.1"}.
- **WHEN** Enviar association.record con versión no negociada.
- **THEN** Resultado exacto {"error":"PROTOCOL_INCOMPATIBLE","writes":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-01-T20; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T20.

#### Scenario: AFH-01-T21 Owned untracked runtime sensitivity
- **GIVEN** Synthetic case AFH-01-T21: {"new_file":"src/archive/selector.js","git_tracked":false}
- **WHEN** Run node --test --test-name-pattern=AFH-01-T21 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"runtime_digest_changes":true,"file_in_inventory":true}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-01-T21; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T21.

#### Scenario: AFH-01-T22 Runtime instability detects changes and deletion
- **GIVEN** Synthetic case AFH-01-T22: {"changes":["modify source","delete source"]}
- **WHEN** Run node --test --test-name-pattern=AFH-01-T22 specification/validate-package.test.mjs.
- **THEN** Exact package oracle result {"stable":false,"acceptance_blocked":true,"unchanged_pair_stable":true}; this does not certify future product implementation.
- **AND** test contract: specification/contracts.json scenario AFH-01-T22; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-01-T22.

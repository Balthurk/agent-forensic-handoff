## Purpose

Mantener Bronce y snapshots de archivo con actualizaciones incrementales verificables, reutilizando bytes y normalización sin invalidar evidencia ni identidades históricas.

## ADDED Requirements

### Requirement: AFH-02-R01 Evidencia inmutable direccionada

AFH SHALL conservar bytes originales y manifiestos exactos con hashes/rangos resolubles, compartiendo contenido idéntico solo bajo dominio de acceso compatible.

#### Scenario: AFH-02-T01 CAS de bytes idénticos
- **GIVEN** Dataset archive (synthetic, seed 404), variante CAS de bytes idénticos: {"copies":10,"bytes":"same payload"}.
- **WHEN** Ingerir diez fuentes explícitas con mismos bytes; inspeccionar CAS y manifest.
- **THEN** Resultado exacto {"payload_objects":1,"source_references":10}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T01.

#### Scenario: AFH-02-T02 Payload distinto no colapsa
- **GIVEN** Dataset archive (synthetic, seed 404), variante Payload distinto no colapsa: {"payloads":["result-a","result-b"]}.
- **WHEN** Ingerir y resolver las dos salidas diferentes.
- **THEN** Resultado exacto {"payload_objects":2,"roundtrip":["result-a","result-b"]}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T02.

#### Scenario: AFH-02-T03 CRLF y UTF8 exactos
- **GIVEN** Dataset archive (synthetic, seed 404), variante CRLF y UTF8 exactos: {"bytes_utf8":"árbol\r\n{\"x\":1}\n"}.
- **WHEN** Adquirir raw y leer el rango total mediante evidence.read base64.
- **THEN** Resultado exacto {"byte_identical":true,"digest_match":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T03.

### Requirement: AFH-02-R02 Incremental y estabilidad

AFH SHALL distinguir append/rewrite/truncation/compaction y conservar IDs lógicos comprobados y aliases de casos anteriores sin basarse en mtime o similitud.

#### Scenario: AFH-02-T04 Append verificado
- **GIVEN** Dataset archive (synthetic, seed 404), variante Append verificado: {"initial":100,"append":10}.
- **WHEN** Capturar initial, añadir 10 records y actualizar el mismo lineage.
- **THEN** Resultado exacto {"old_occurrence_ids_unchanged":100,"new_records":10,"prefix_verified":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T04.

#### Scenario: AFH-02-T05 Rewrite con mismo tamaño/mtime
- **GIVEN** Dataset archive (synthetic, seed 404), variante Rewrite con mismo tamaño/mtime: {"rewrite_record":40,"preserve_size":true,"preserve_mtime":true}.
- **WHEN** Cambiar bytes del record 40 y volver a ingerir.
- **THEN** Resultado exacto {"divergent":true,"reuse_prefix_records":39,"old_revision_unchanged":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T05.

#### Scenario: AFH-02-T06 Truncation y compaction
- **GIVEN** Dataset archive (synthetic, seed 404), variante Truncation y compaction: {"initial":100,"new_records":30,"mode":"replace_with_compacted_history"}.
- **WHEN** Reemplazar fuente sintética por versión compactada de 30 records.
- **THEN** Resultado exacto {"old_records_resolvable":100,"new_epoch":true,"assumed_equivalence":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T06.

#### Scenario: AFH-02-T07 Tail parcial completado después
- **GIVEN** Dataset archive (synthetic, seed 404), variante Tail parcial completado después: {"tail":"{\"unfinished\":","append":"true}\n"}.
- **WHEN** Capturar tail incompleto, completar y reingerir; comprobar ambas revisiones.
- **THEN** Resultado exacto {"raw_tail_preserved":true,"after_complete_records":1,"phantom_occurrences":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T07.

### Requirement: AFH-02-R03 Crash y exclusión

AFH SHALL publicar atómicamente con escritor exclusivo, checkpoints vinculados a inputs/config y recuperación idempotente tras interrupción real.

#### Scenario: AFH-02-T08 Publicación con crash real
- **GIVEN** Dataset operational (synthetic, seed 404), variante Publicación con crash real: {"failpoints":["objects_fsync","ledger_commit","revision_manifest","pointer_replace"]}.
- **WHEN** Terminar proceso escritor de prueba en cada failpoint y reanudar en proceso nuevo.
- **THEN** Resultado exacto {"same_logical_final_as_uninterrupted":true,"partial_visible":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T08.

#### Scenario: AFH-02-T09 Lock activo y propietario incierto
- **GIVEN** Dataset operational (synthetic, seed 404), variante Lock activo y propietario incierto: {"owner_states":["alive","pid_reused","unknown"]}.
- **WHEN** Competir por writer lock y solicitar recover con identidad OS no comprobada.
- **THEN** Resultado exacto {"errors":["BUSY","OWNER_UNVERIFIED","OWNER_UNVERIFIED"],"forced_takeovers":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T09.

#### Scenario: AFH-02-T10 Checkpoint corrupto
- **GIVEN** Dataset archive (synthetic, seed 404), variante Checkpoint corrupto: {"flip_checkpoint_byte":true}.
- **WHEN** Alterar checkpoint sintético e intentar resume.
- **THEN** Resultado exacto {"error":"INTEGRITY_FAILED","prior_revision_usable":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T10.

#### Scenario: AFH-02-T11 Idempotency conflict
- **GIVEN** Dataset archive (synthetic, seed 404), variante Idempotency conflict: {"same_key":true,"different_input":true}.
- **WHEN** Repetir archive.ingest con clave antigua y payload distinto.
- **THEN** Resultado exacto {"error":"IDEMPOTENCY_CONFLICT","new_occurrences":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T11.

### Requirement: AFH-02-R04 Importación y compatibilidad

AFH SHALL importar casos 0.1/0.2/0.3 en un nuevo archivo preservando bytes/URIs originales, sin migraciones in-place ni enlaces a fuentes mutables.

#### Scenario: AFH-02-T12 Casos legacy inmutables
- **GIVEN** Dataset archive (synthetic, seed 404), variante Casos legacy inmutables: {"schemas":[1,2,3]}.
- **WHEN** Generar casos sintéticos con paquetes legacy fijados; import-case y resolver IDs/URIs.
- **THEN** Resultado exacto {"source_inventory_equal":true,"all_aliases_resolve":true,"old_database_write_count":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T12.

#### Scenario: AFH-02-T13 Relocación de archivo
- **GIVEN** Dataset archive (synthetic, seed 404), variante Relocación de archivo: {"move_copy_to_new_root":true,"delete_original_access":false}.
- **WHEN** Copiar archivo nuevo a otra raíz privada, quitar acceso del test a la raíz vieja y consultar.
- **THEN** Resultado exacto {"evidence_bytes_identical":true,"original_path_required":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T13.

#### Scenario: AFH-02-T14 Versión futura rechazada
- **GIVEN** Dataset archive (synthetic, seed 404), variante Versión futura rechazada: {"schema_version":99}.
- **WHEN** Importar manifest de versión no soportada conservando fichero.
- **THEN** Resultado exacto {"error":"UNSUPPORTED_VERSION","source_untouched":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T14.

### Requirement: AFH-02-R05 Lectura de evidencia acotada

AFH SHALL fragmentar evidencia exacta por rango y tamaño real del envelope, preservar continuidad y distinguir fuente truncada de fragmentación de transporte.

#### Scenario: AFH-02-T15 16MiB base64 y frames 8MiB
- **GIVEN** Dataset operational (synthetic, seed 404), variante 16MiB base64 y frames 8MiB: {"max_bytes":16777216,"format":"base64","receipt_padding_bytes":200000}.
- **WHEN** Solicitar evidence.read y continuar hasta agotar rango; medir UTF8 de JSON completo.
- **THEN** Resultado exacto {"every_serialized_frame_lte":8388608,"concatenated_bytes":16777216,"missing_bytes":0,"duplicated_bytes":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T15.

#### Scenario: AFH-02-T16 Unicode escapes y cursor stale
- **GIVEN** Dataset operational (synthetic, seed 404), variante Unicode escapes y cursor stale: {"format":"text","unicode":"😀\\\"\n","wrong_revision":true}.
- **WHEN** Medir fragments text con escapes y reenviar cursor contra otra revisión.
- **THEN** Resultado exacto {"error":"CONTINUATION_MISMATCH","lossy_decode":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T16.

#### Scenario: AFH-02-T17 Corrupción de objeto
- **GIVEN** Dataset archive (synthetic, seed 404), variante Corrupción de objeto: {"flip_object_byte":true}.
- **WHEN** Alterar un objeto en copia desechable de archivo y resolver evidencia.
- **THEN** Resultado exacto {"error":"INTEGRITY_FAILED","unverified_payload_returned":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T17.

### Requirement: AFH-02-R06 Recursos y estados observables

AFH MUST conservar registros desconocidos/malformados con contabilidad separada y exponer límites/errores sin secretos, replay ni falso PASS.

#### Scenario: AFH-02-T18 JSON válido desconocido e inválido
- **GIVEN** Dataset archive (synthetic, seed 404), variante JSON válido desconocido e inválido: {"valid_unknown":1,"invalid":1}.
- **WHEN** Ingerir los dos records y comprobar contabilidad y refs.
- **THEN** Resultado exacto {"preserved":2,"parsed":1,"unsupported":1,"unparsed":1,"normalization_pass":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T18.

#### Scenario: AFH-02-T19 Bomba comprimida y límite
- **GIVEN** Dataset archive (synthetic, seed 404), variante Bomba comprimida y límite: {"max_expansion_ratio":100,"input_ratio":101}.
- **WHEN** Expandir fixture comprimido acotado en raíz temporal con límite reducido.
- **THEN** Resultado exacto {"error":"LIMIT_EXCEEDED","prior_revision_usable":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T19; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T19.

#### Scenario: AFH-02-T20 Fuente crece durante captura
- **GIVEN** Dataset archive (synthetic, seed 404), variante Fuente crece durante captura: {"initial_records":100,"append_after_boundary":10}.
- **WHEN** Añadir datos después de fijar boundary mientras corre adquisición real.
- **THEN** Resultado exacto {"captured_records":100,"late_records":10,"boundary_disclosed":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-02-T20; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-02-T20.

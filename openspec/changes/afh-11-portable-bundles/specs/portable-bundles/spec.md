## Purpose

Transportar archivos forenses privados mediante bundles cifrados y firmados verificables que preserven referencias/identidades al relocalizarse y rechacen corrupción o destinos inseguros.

## ADDED Requirements

### Requirement: AFH-11-R01 Cifrado autenticado y firma

AFH SHALL exportar AFHB1 con AEAD por frame, nonces/DEK únicos y firma vinculada a header/ciphertext/orden, manteniendo metadata sensible cifrada.

#### Scenario: AFH-11-T01 Roundtrip cifrado y firmado
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Roundtrip cifrado y firmado: {"entries":2,"recipients":2}.
- **WHEN** Exportar con claves efímeras e importar con cada recipient autorizado.
- **THEN** Resultado exacto {"plaintext_roundtrip_equal":true,"signature_verified":true,"plain_text_outside_ciphertext":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T01.

#### Scenario: AFH-11-T02 Nonce única entre exports
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Nonce única entre exports: {"exports":2,"same_plaintext":true}.
- **WHEN** Crear dos exports independientes y examinar campos públicos/monitor de crypto del test.
- **THEN** Resultado exacto {"dek_reused":false,"nonce_prefix_or_key_distinct":true,"ciphertexts_differ":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T02.

#### Scenario: AFH-11-T03 Orden/tag adulterado
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Orden/tag adulterado: {"mutations":["flip_cipher_byte","swap_frames","remove_last_frame"]}.
- **WHEN** Aplicar cada mutación a copia de bundle y solicitar import.
- **THEN** Resultado exacto {"all_rejected":true,"published_imports":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T03.

### Requirement: AFH-11-R02 Confianza y claves

AFH MUST exigir signer trusted explícito y claves válidas de ámbito local, sin TOFU, secretos en logs o downgrade silencioso.

#### Scenario: AFH-11-T04 Signer no confiado
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Signer no confiado: {"trusted_signers":[],"embedded_valid_signature":true}.
- **WHEN** Importar firma válida con fingerprint no permitido.
- **THEN** Resultado exacto {"error":"UNTRUSTED_SIGNER","auto_trust":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T04.

#### Scenario: AFH-11-T05 Clave de recipient incorrecta
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Clave de recipient incorrecta: {"recipient":"unrelated-key"}.
- **WHEN** Intentar import con otra clave efímera.
- **THEN** Resultado exacto {"error":"DECRYPTION_FAILED","plaintext_published":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T05.

#### Scenario: AFH-11-T06 Claves no aparecen en artefactos
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Claves no aparecen en artefactos: {"private_key_canary":true}.
- **WHEN** Escanear stdout/stderr/manifest/artefactos generados.
- **THEN** Resultado exacto {"key_material_in_logs":0,"key_material_in_bundle":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T06.

### Requirement: AFH-11-R03 Relocación y compatibilidad

AFH SHALL importar a un destino nuevo preservando archive/source/occurrence IDs y todas las evidencias sin depender de rutas anteriores.

#### Scenario: AFH-11-T07 Relocación completa
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Relocación completa: {"old_root_unavailable":true,"new_root":"different-private-root"}.
- **WHEN** Importar en raíz nueva y bloquear acceso del test al origen.
- **THEN** Resultado exacto {"all_uris_resolve":true,"native_path_required":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T07.

#### Scenario: AFH-11-T08 Legacy aliases en bundle
- **GIVEN** Dataset archive (synthetic, seed 404), variante Legacy aliases en bundle: {"import_legacy_schema":3,"then_bundle":true}.
- **WHEN** Import-case sintético3, export/import bundle y resolver URI vieja.
- **THEN** Resultado exacto {"old_event_aliases_resolve":true,"legacy_case_unchanged":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T08.

#### Scenario: AFH-11-T09 Proyecciones opcionales
- **GIVEN** Dataset semantic (synthetic, seed 404), variante Proyecciones opcionales: {"include_projections":[false,true]}.
- **WHEN** Roundtrip de ambas variantes y consultar modo semántico.
- **THEN** Resultado exacto {"default_semantics":"UNAVAILABLE","explicit_included_projection_verified":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T09.

### Requirement: AFH-11-R04 Extracción segura y acotada

AFH SHALL rechazar traversal/ADS/reserved paths/symlinks/bombas y límites excedidos antes de publicar, con staging contenido.

#### Scenario: AFH-11-T10 Paths maliciosos
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Paths maliciosos: {"paths":["../escape","C:\\escape","file:stream","CON","\\\\server\\share\\escape"]}.
- **WHEN** Usar bundles sintéticos firmados con entradas inválidas y probar import.
- **THEN** Resultado exacto {"outside_writes":0,"all_rejected":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T10.

#### Scenario: AFH-11-T11 Bundle sobre límite
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Bundle sobre límite: {"declared_bytes":17179869185,"limit":17179869184}.
- **WHEN** Verificar tamaño declarado/extralimitación antes de extracción.
- **THEN** Resultado exacto {"error":"LIMIT_EXCEEDED","published":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T11.

#### Scenario: AFH-11-T12 Nombre Unicode y espacios
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Nombre Unicode y espacios: {"path":"bronze/objects/árbol con espacios"}.
- **WHEN** Roundtrip en Windows/POSIX con paths relativos permitidos.
- **THEN** Resultado exacto {"roundtrip_path":true,"escape":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T12.

#### Scenario: AFH-11-T19 Manifest y frames limitados antes de reservar
- **GIVEN** Bundle sintético firmado con headers declarando manifest_bytes=268435457 o frame ciphertext length=4194305, y pares positivos en el límite.
- **WHEN** Importar cada fixture con el proceso real acotado y observar memoria/publicación.
- **THEN** LIMIT_EXCEEDED para cada exceso antes de reservar tamaños declarados;0 imports publicados; los límites exactos se aceptan si la integridad es válida.
- **AND** test contract: specification/contracts.json scenario AFH-11-T19; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T19.

### Requirement: AFH-11-R05 Atomicidad e idempotencia

AFH SHALL preservar fuente/destino previo durante crash/restart/export/import fallidos y no repetir publicación bajo reintento idempotente.

#### Scenario: AFH-11-T13 Crash export e import
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Crash export e import: {"failpoints":["during_cipher_frame","after_decrypt_before_publish"]}.
- **WHEN** Terminar procesos propios y recuperar staging.
- **THEN** Resultado exacto {"prior_revision_unchanged":true,"partial_not_valid_bundle":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T13.

#### Scenario: AFH-11-T14 Destino existente
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Destino existente: {"target_exists":true}.
- **WHEN** Exportar/importar hacia destino ya ocupado.
- **THEN** Resultado exacto {"error":"TARGET_EXISTS","existing_bytes_unchanged":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T14.

#### Scenario: AFH-11-T15 Reintento idempotente
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Reintento idempotente: {"same_key":true,"same_digest":true}.
- **WHEN** Repetir export/import terminado con misma clave.
- **THEN** Resultado exacto {"published_revisions":1,"reused_receipt":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T15.

### Requirement: AFH-11-R06 Integridad y evidencia de transporte

AFH SHALL validar todos los bytes/refs/proyecciones incluidas y registrar resultados reales por plataforma, sin que la firma se confunda con verdad del contenido.

#### Scenario: AFH-11-T16 Pruebas en matriz real
- **GIVEN** Dataset platform (synthetic, seed 404), variante Pruebas en matriz real: {"targets":["windows-x64","linux-x64","linux-arm64","macos-x64","macos-arm64"]}.
- **WHEN** Ejecutar crypto/relocation fixtures en cada plataforma real.
- **THEN** Resultado exacto {"all_roundtrips_verified":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T16.

#### Scenario: AFH-11-T17 Hash válido afirmación falsa
- **GIVEN** Dataset intent (synthetic, seed 404), variante Hash válido afirmación falsa: {"text":"The parser is implemented.","actual_artifact_absent":true,"valid_signature":true}.
- **WHEN** Importar bundle íntegro y consultar afirmación conservando epistemología.
- **THEN** Resultado exacto {"signature_valid":true,"claim_truth_verified":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T17.

#### Scenario: AFH-11-T18 Manifest interno adulterado
- **GIVEN** Dataset bundle (synthetic, seed 404), variante Manifest interno adulterado: {"change_ciphertext_manifest_without_valid_tag":true,"signature_recomputed_by_trusted_test_signer":true}.
- **WHEN** Alterar ciphertext del manifest, recalcular hash/firma con signer efímero confiado del test y comprobar que GCM rechaza antes de publicar.
- **THEN** Resultado exacto {"error":"DECRYPTION_FAILED","accepted_entries":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-11-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-11-T18.

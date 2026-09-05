## Context

Los casos locales actuales conservan hash e integridad, pero no tienen transporte cifrado/firmado completo ni contrato de importación relocation-safe.

Purpose and global integration: Transportar archivos forenses privados mediante bundles cifrados y firmados verificables que preserven referencias/identidades al relocalizarse y rechacen corrupción o destinos inseguros.

## Goals / Non-Goals

Benefit: Permite copia/entrega privada con detección de adulteración y origen del firmante conocido, sin publicar casos ni depender de paths de la máquina original.

This change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.

## Definitions and shared contracts

GLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: writer, release; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.

## Decisions

### Algorithm and interface

AFHB1 binario: magic ASCII AFHB1, uint32be header_length<=1MiB, header UTF8 canónico, secuencia de frames uint32be length+ciphertext+GCMtag16, y trailer con ciphertext_sha256 y signature64. Header sin paths/texto contiene format1, algorithms, export_nonce, nonce_prefix4bytes, recipients (RSA3072 SPKI fingerprint y wrapped random DEK32 por RSA-OAEP SHA256), signer Ed25519 SPKI y fingerprint, frame_count, manifest_frame_count, manifest_bytes y límites. AES256-GCM por frame con nonce=prefix4+uint64be index (desde0), DEK nuevo aleatorio por export; AAD=SHA256(header canónico)+uint64be index. Los primeros manifest_frame_count frames cifran el manifest JSON de entradas ordenadas, segmentado<=4MiB por frame, con manifest_bytes<=256MiB; los restantes cifran chunks de objetos<=4MiB. Rechazar header>1MiB, manifest>256MiB y cualquier frame length>4MiB antes de reservar memoria. El length uint32be es solo ciphertext; a continuación exactamente16 bytes de GCMtag. El trailer fijo contiene32 bytes de ciphertext hash y64 bytes de firma; la cuenta/longitud exactas impiden aceptar bytes sobrantes. El manifest se descifra a staging privado y se procesa acotadamente. Manifest interno contiene paths relativos permitidos, sizes y plaintext hashes, archive/revision IDs y model/projection identities si se incluyeron. Firma Ed25519 sobre bytes ASCII AFHB1-SIGN-v1 + SHA256(header) + ciphertext_sha256 + uint64be frame_count; hash ciphertext incluye framing y tags. Verificar trust/signature/hashes antes de materializar destino, luego descifrar a staging, verificar manifest/rangos/objetos y publicar con archive writer. No TOFU; trusted signer list explícita.

Interfaces: bundle.export, bundle.import, evidence.read. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.

### Rationale and alternatives

Primitives estándar de node:crypto evitan dependencias remotas y permiten tests de AEAD/firma. La firma valida integridad y posesión de clave del fingerprint aceptado, no verdad de contenido. Metadata sensible permanece cifrada. Primitive contracts: https://nodejs.org/docs/latest-v22.x/api/crypto.html .

Rechazados: ZIP con contraseña débil; hash sin firma; firmar solo manifest dejando payload sin binding; usar misma nonce/DEK para exportaciones; trust automático al signer embebido; paths absolutos dentro del bundle.

### Persistence, concurrency and idempotence

Export lee revisión fijada sin modificarla y escribe un archivo destino nuevo con create-exclusive. Claves privadas nunca se embeben ni loguean; tests generan claves efímeras en RUN. Import es staging bajo límites antes de commit; ID de archivo y referencias lógicas preservados con location mapping separado. Export por defecto excluye sidecars sensibles para reducir tamaño, opción explícita los incluye.

### Integration and dependencies

Usa CAS02, temporal04 y optional projections06. Requiere revisión de seguridad específica del formato, roundtrip en cinco plataformas10 y gate de supply-chain14. Claves RSA/Ed25519 y AEAD disponibles se comprueban antes de trabajo.

Dependencies: afh-01-native-identity, afh-02-incremental-archive, afh-04-temporal-provenance, afh-06-layered-semantics, afh-10-compatibility-matrix. One writer executes the full ordered program.

## Migration Plan

No cambia formato de casos legados ni requiere cifrar el archivo local para leerlo. Import-case primero normaliza legacy hacia archivo nuevo; bundles solo formato AFHB1/schema4. Relocation usa manifest/IDs, nunca path nativo para resolver evidencia.

Export incompleto conserva .partial identificado y no se presenta como bundle válido. Import crash/decryption/signature failure no publica; recuperación solo sobre staging propio. No sobrescribir archivo destino existente ni borrar fuente. Nonces nuevas por intento de export si cambia contenido; idempotent retry devuelve mismo archivo verificado cuando completo.

Expected write set: src/bundle/, schemas/bundle-v1.schema.json, src/cli.js, test/acceptance/afh-11.test.mjs.

## Risks / Trade-offs

El diseño no acredita auditoría criptográfica externa. Límites por entrada/total/ratio y reject de ..,absolute,ADS,reserved names/symlinks protegen extracción. Llave perdida impide recuperación del cifrado; no hay backdoor ni downgrade.

## Entry and exit

Entry:
- Complete 14-change package reviewed with no material gaps.
- Scope authorization active; one writer; applicable snapshot review and schema/OpenSpec validation.
- Every earlier acceptance milestone is MILESTONE_GREEN with its exact due obligations; future owner integrations remain DEFERRED_NOT_RUN.01 has no predecessor.
- Concrete test harness and immutable fixture/oracle available; absent API labeled NOT_IMPLEMENTED.

Exit:
- All CHANGE_EXIT obligations due at this milestone (including incoming integrations) pass their complete oracles and evidence classes. Later owner scenarios remain explicitly DEFERRED_NOT_RUN, mandatory at their assigned milestone. No diagnostic GREEN substitutes for acceptance.
- Legacy baseline remains green; source/case inventories unchanged; new API responses meet schema and relational invariants.
- Evidence resolves to actual candidate/inputs; semantic review satisfactory and work trace appended.

## TDD contracts

19 scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.

## Acceptance milestone 11

Due full acceptance: AFH-11-T01, AFH-11-T02, AFH-11-T03, AFH-11-T04, AFH-11-T05, AFH-11-T06, AFH-11-T07, AFH-11-T08, AFH-11-T09, AFH-11-T10, AFH-11-T11, AFH-11-T12, AFH-11-T13, AFH-11-T14, AFH-11-T15, AFH-11-T16, AFH-11-T17, AFH-11-T18, AFH-11-T19.

Owned obligations deferred (not GREEN): none.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

## Purpose

Entregar AFH0.4.0 como release verificable y reversible con documentación/skill coherentes, CI real, fuzzing, cadena de suministro y comprobación de instalación aislada/publicación exacta.

## ADDED Requirements

### Requirement: AFH-14-R01 Programa completo y gates

AFH MUST derivar publicación de14 cambios aceptados,22 recomendaciones cubiertas, revisión semántica y evidencia exacta; autorización de alcance persiste pero PAUSED/revocación bloquean.

#### Scenario: AFH-14-T01 Paquete completo revisado
- **GIVEN** Dataset release (synthetic, seed 404), variante Paquete completo revisado: {"changes_green":14,"recommendations":22,"review":"SATISFACTORY"}.
- **WHEN** Evaluar gate con receipts exactos de todas capacidades y CI.
- **THEN** Resultado exacto {"release_eligible":true,"scope_authorization_reasked":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T01; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T01.

#### Scenario: AFH-14-T02 Solo primer cambio verde
- **GIVEN** Dataset release (synthetic, seed 404), variante Solo primer cambio verde: {"changes_green":1}.
- **WHEN** Distinguir gate incremental02 de gate final14.
- **THEN** Resultado exacto {"release_eligible":false,"implementation_next_can_be_ready":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T02; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T02.

#### Scenario: AFH-14-T03 PAUSED prevalece
- **GIVEN** Dataset release (synthetic, seed 404), variante PAUSED prevalece: {"phase":"PAUSED","otherwise_green":true}.
- **WHEN** Evaluar gate pausado con evidencia válida.
- **THEN** Resultado exacto {"release_eligible":false,"dispatches":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T03; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T03.

#### Scenario: AFH-14-T04 Digest nuevo exige revisión aplicable
- **GIVEN** Dataset release (synthetic, seed 404), variante Digest nuevo exige revisión aplicable: {"review_digest":"old","candidate_digest":"new","scope_authorization":"ACTIVE"}.
- **WHEN** Cambiar artefacto y verificar que se invalida evidencia sin caducar permiso por alcance.
- **THEN** Resultado exacto {"review_stale":true,"authorization_active":true,"release_eligible":false}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T04; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T04.

### Requirement: AFH-14-R02 Regresión y fuzzing

AFH SHALL completar baseline, casos legacy y fuzzing acotado de10000 variantes por superficie sin crash no controlado, corrupción, traversal o ejecución de evidencia histórica.

#### Scenario: AFH-14-T05 Fuzz de cinco superficies
- **GIVEN** Dataset release (synthetic, seed 404), variante Fuzz de cinco superficies: {"cases_per_surface":10000,"surfaces":["parser","ingest","query","bundle","capture"],"seed":404}.
- **WHEN** Ejecutar subprocesses acotados con corpus/minimizaciones guardados.
- **THEN** Resultado exacto {"total_cases":50000,"unhandled_crashes":0,"outside_writes":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T05; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T05.

#### Scenario: AFH-14-T06 Crash de fuzz bloquea
- **GIVEN** Dataset release (synthetic, seed 404), variante Crash de fuzz bloquea: {"crash_case":404}.
- **WHEN** Inyectar un crash detectable en runner de prueba y comprobar classification.
- **THEN** Resultado exacto {"acceptance":"BLOCKED","reproducer_retained":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T06; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T06.

#### Scenario: AFH-14-T07 Regresión legacy
- **GIVEN** Dataset archive (synthetic, seed 404), variante Regresión legacy: {"versions":[1,2,3],"legacy_commands":true}.
- **WHEN** Ejecutar baseline y fixtures de versiones anteriores contra candidato.
- **THEN** Resultado exacto {"baseline_failures":0,"source_mutations":0,"uri_resolution":1}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T07; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T07.

### Requirement: AFH-14-R03 SBOM y procedencia firmada

AFH SHALL generar SBOM completo desde lock/install real y attestation verificable del tgz/commit/workflow exactos sin claves persistidas ni confianza implícita.

#### Scenario: AFH-14-T08 SBOM lock completo
- **GIVEN** Dataset release (synthetic, seed 404), variante SBOM lock completo: {"include_transitives":true,"format":"CycloneDX1.6"}.
- **WHEN** Comparar SBOM con lock y árbol instalado exactos.
- **THEN** Resultado exacto {"missing_lock_components":0,"private_paths":0,"lock_digest_matches":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T08; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T08.

#### Scenario: AFH-14-T09 Attestation de artefacto real
- **GIVEN** Dataset release (synthetic, seed 404), variante Attestation de artefacto real: {"subject":"tgz-sha256","issuer":"GitHub Actions OIDC"}.
- **WHEN** Firmar por workflow y ejecutar gh attestation verify del artefacto exacto.
- **THEN** Resultado exacto {"signature_verified":true,"repository_matches":true,"workflow_matches":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T09; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T09.

#### Scenario: AFH-14-T10 Firma válida otro candidato
- **GIVEN** Dataset release (synthetic, seed 404), variante Firma válida otro candidato: {"signed_commit":"other","expected_commit":"candidate"}.
- **WHEN** Verificar attestation auténtica cuyo source/subject no coinciden.
- **THEN** Resultado exacto {"acceptance":"BLOCKED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T10; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T10.

### Requirement: AFH-14-R04 Packaging y skill consistentes

AFH SHALL distribuir runtime/skill/docs coherentes con capacidades realmente verificadas, manifest público revisado y CLI/casos anteriores compatibles.

#### Scenario: AFH-14-T11 Manifest público limpio
- **GIVEN** Dataset release (synthetic, seed 404), variante Manifest público limpio: {"deny":["private/","real-rollouts","private-keys","tooling-node_modules"]}.
- **WHEN** Extraer listado del tgz sin ejecutar y comparar allowlist aprobada.
- **THEN** Resultado exacto {"denied_entries":0,"allowlist_complete":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T11; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T11.

#### Scenario: AFH-14-T12 Skill/documentación coherentes
- **GIVEN** Dataset release (synthetic, seed 404), variante Skill/documentación coherentes: {"documented_interfaces":27,"implemented_interfaces":27}.
- **WHEN** Cruzar schema/CLI help/skill/readme y receipts reales01–13.
- **THEN** Resultado exacto {"unimplemented_promises":0,"legacy_help_preserved":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T12; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T12.

#### Scenario: AFH-14-T13 Canario privado bloquea pack
- **GIVEN** Dataset release (synthetic, seed 404), variante Canario privado bloquea pack: {"tar_entry":"private/SYNTHETIC_SECRET_404"}.
- **WHEN** Evaluar manifest adversarial con entrada privada antes de upload.
- **THEN** Resultado exacto {"acceptance":"BLOCKED"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T13; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T13.

### Requirement: AFH-14-R05 Instalación aislada y rollback

AFH SHALL verificar instalación y smoke del artefacto en cinco targets reales sin modificar instalación activa, y comprobar rollback a0.3.0 en prefix separado.

#### Scenario: AFH-14-T14 Cinco instalaciones reales
- **GIVEN** Dataset platform (synthetic, seed 404), variante Cinco instalaciones reales: {"targets":["windows-x64","linux-x64","linux-arm64","macos-x64","macos-arm64"],"isolated":true}.
- **WHEN** Instalar tgz en prefixes nuevos y verificar versiones/ingesta/query/evidence/semántica.
- **THEN** Resultado exacto {"verified_targets":5,"active_install_mutations":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T14; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T14.

#### Scenario: AFH-14-T15 Rollback separado
- **GIVEN** Dataset release (synthetic, seed 404), variante Rollback separado: {"from":"0.4.0","to":"0.3.0","new_prefix":true}.
- **WHEN** Seleccionar artefacto0.3.0 verificado e instalar en otro prefix privado.
- **THEN** Resultado exacto {"baseline_smoke":true,"archive4_unchanged":true,"active_install_unchanged":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T15; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T15.

#### Scenario: AFH-14-T16 Plataforma sin evidencia
- **GIVEN** Dataset platform (synthetic, seed 404), variante Plataforma sin evidencia: {"missing_target":"macos-x64"}.
- **WHEN** Evaluar matriz sin resultado real de un target obligatorio.
- **THEN** Resultado exacto {"release_eligible":false,"status":"UNAVAILABLE"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T16; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T16.

### Requirement: AFH-14-R06 Publicación e inspección posterior

AFH SHALL publicar GitHub Release0.4.0 únicamente tras todos gates y descargar/verificar/install-smoke los assets publicados con hashes/firma/candidato coincidentes.

#### Scenario: AFH-14-T17 Draft verificado y publicación
- **GIVEN** Dataset release (synthetic, seed 404), variante Draft verificado y publicación: {"draft_checked":true,"all_gates":true}.
- **WHEN** Publicar release autorizada, descargar assets y verificar instalación desde esos bytes.
- **THEN** Resultado exacto {"published_version":"0.4.0","downloaded_digest_matches":true,"postpublish_smoke":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T17; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T17.

#### Scenario: AFH-14-T18 Asset publicado distinto
- **GIVEN** Dataset release (synthetic, seed 404), variante Asset publicado distinto: {"downloaded_hash":"unexpected"}.
- **WHEN** Evaluar discrepancia de bytes publicados y conservar evidencia/alerta.
- **THEN** Resultado exacto {"release_acceptance":"BLOCKED","existing_tag_not_rewritten":true}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T18; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T18.

#### Scenario: AFH-14-T19 Sin credencial o firma disponible
- **GIVEN** Dataset release (synthetic, seed 404), variante Sin credencial o firma disponible: {"attestation_available":false}.
- **WHEN** Ejecutar preflight de publicación sin simular credenciales ni resultado.
- **THEN** Resultado exacto {"release_eligible":false,"status":"UNAVAILABLE"}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T19; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T19.

#### Scenario: AFH-14-T20 Cierre trazable exacto
- **GIVEN** Dataset release (synthetic, seed 404), variante Cierre trazable exacto: {"commit_tag_ci_artifacts_identical":true}.
- **WHEN** Revisar receipt final y resolver cada vínculo de evidencia antes de cerrar.
- **THEN** Resultado exacto {"handoff_complete":true,"unresolved_required_gates":0}; conservar identidades, registros y referencias originales indicados por el oráculo, incluso si se rechaza la operación.
- **AND** test contract: specification/contracts.json scenario AFH-14-T20; oracle specification/fixtures/critical-contracts.json#/oracles/AFH-14-T20.

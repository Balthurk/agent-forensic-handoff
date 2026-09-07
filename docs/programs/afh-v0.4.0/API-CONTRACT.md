# Contratos de productor y consumidor

## Interfaz única del núcleo v4

Nuevo export ESM `archiveRequest(request, options={}) -> Promise<ResponseV4>` desde `src/index.js`. `options` admite `signal`, `onProgress`, `clock` para pruebas controladas, y `embeddingProvider` solo para tests unitarios etiquetados. Las funciones existentes y sus contratos permanecen. El protocolo JSON que sigue es idéntico en CLI, API y servicio para operaciones permitidas al reader.

```json
{
  "kind": "request",
  "schema_version": 4,
  "protocol_version": "4.0",
  "request_id": "synthetic-request-001",
  "operation": "context.build",
  "archive": "/private/example/archive",
  "revision_id": null,
  "params": {
    "scope": {"project_id":"project-a","session_ids":["session-a"],"group_id":null,"association_mode":"observed"},
    "time": {"known_at":"2026-01-04T00:00:00Z","valid_at":"2026-01-03T12:00:00Z","from":null,"to":null,"include_uncertain":true},
    "mode":"lexical",
    "layers":["silver","gold"],
    "budget_tokens":6000
  }
}
```

`request_id` es correlación, no permiso ni identidad de contenido; máximo 128 caracteres `[A-Za-z0-9._:-]`. `archive` es path explícito local, validado antes de acceso. `revision_id=null` fija el último commit publicado al abrir. Todo request incluye `protocol_version`. V4.0 acepta exactamente 4.0; incompatible -> `PROTOCOL_INCOMPATIBLE` antes de acceso/mutación. IPC negocia primero la intersección de versiones expresamente soportadas y devuelve la elegida; el request debe usarla. Una minor nueva no garantiza que un lector estricto antiguo pueda leerla. Campos desconocidos se rechazan;4.0 no admite extensiones. Una versión futura debe negociar y tipar sus extensiones explícitamente; no se silencian. Límite de request 1 MiB, profundidad JSON 32, máximo 256 filtros de ID, texto de consulta 16.000 caracteres; streams de ingesta no usan el límite de payload RPC.

`ResponseV4` siempre incluye `kind=response`, `schema_version`, `protocol_version`, `request_id`, `operation`, `status`, `data|null`, `error|null`, `receipt`. `error` tiene `code`, `message` redactado, `retryable`, `details` sin secretos. `receipt` tiene archive/revision/ledger/projection identity, engine version, requested/effective mode y scope, filtros temporales, coverage, warnings, métricas y evidencia seleccionada. No se omite el estado de una dependencia ausente.

`status=OK|PARTIAL|UNAVAILABLE|INCONCLUSIVE_COVERAGE|ERROR`. OK describe operación válida, no verdad. Una coincidencia puede tener `presence=VERIFIED_PRESENT` y `coverage.status=PARTIAL` simultáneamente. Un recuento se marca `exact_within_observed_scope=true`; si hay adquisición incompleta, su total representa un límite inferior observado. Cero candidatos con cobertura completa -> `NOT_OBSERVED_IN_CAPTURED_EVIDENCE`; con huecos -> `INCONCLUSIVE_COVERAGE`.

## Operaciones y payloads

Las tablas siguientes son cerradas. Campo seguido de `?` es opcional con default indicado; los demás son obligatorios. Los tipos referenciados están definidos en DATA-CONTRACT. Todas las salidas incluyen el envelope común.

| operation / productor | params | data / consumidor |
|---|---|---|
| `archive.init` / CLI actual | `access_domain_id?` (UUID nuevo), `origin_domains?=[]`, `limits?` (OPERATIONS), `idempotency_key` | `archive_id`, `revision_id`, `schema_version=4`; existe distinto -> TARGET_EXISTS |
| `archive.ingest` / adquirente | `sources:[{path,harness,origin_domain_id,source_lineage_id?,native_id?}]`, `include_children?=true`, `max_child_sessions?=32`, `idempotency_key` | `revision_id`, `source_revisions`, `delta:{bytes_read,prefix_bytes_verified,new_records,new_occurrences,reused_objects}`, `coverage`, `job_id` |
| `archive.import_case` / migrador | `case_path`, `idempotency_key` | revisión nueva, `legacy_case_hash`, alias counts y read-only inventory before/after; unsupported schema -> UNSUPPORTED_VERSION |
| `archive.verify` / lector | `deep?=true` | `passed`, `checks:[{id,ok,observed,expected}]`, gaps; false nunca se oculta por exit 0 |
| `archive.recover` / operador actual | `job_id`, `expected_owner_token`, `action=resume|abandon`, `idempotency_key` | `job_status`, `resumed_from`, `lost_uncommitted_work`; no borrar commits/objetos de casos previos |
| `association.record` / declaración actual | `changes:[{association_id,expected_revision_id,branch_id,session_id,project_id,workspace,checkout,association_state,valid_from,valid_to,evidence_refs}]`, `idempotency_key` | IDs/revisiones y commit_seq atómico; expected null crea tramo, expected exacto corrige ese tramo; cualquier conflicto aborta todos; la declaración actual no se fecha retrospectivamente como adquisición |
| `scope.resolve` / agente | `active_context:{project_id?,session_id?,workspace?,checkout?}`, `explicit_scope?` | candidatos, effective_scope y `resolution=EXPLICIT|OBSERVED|INFERRED|AMBIGUOUS`; ambigüedad devuelve candidatos sin elegir |
| `event.show` / agente | `event_id`, `include_representations?=true` | evento/revisión, ocurrencia, representaciones, relaciones y evidence_refs |
| `evidence.read` / agente | `uri`, `json_pointer?`, `offset?=0`, `max_bytes?=1048576` (máx 16777216), `format?=text` (text/base64), `continuation?` | fragmento acotado, hashes verificados, extent, partial, continuación exacta y disponibilidad; envelope serializado <=8388608 bytes en API/CLI/IPC |
| `graph.neighbors` / planner | `node_id`, `direction?=both`, `types?=[]`, `hops?=1`, `max_nodes?=200`, `scope`, `time` | nodes/edges tipados, paths, visited y truncated; max hops 8/max nodes 5000 |
| `graph.path` / planner | `from_id`, `to_id`, filtros anteriores | menor camino por hops; ties por edge ID; no camino observado != inexistencia universal |
| `intent.extract` / ingesta/revisor | `session_ids`, `rule_version=afh-intent-v1`, `idempotency_key` | candidatos, program/task/incidental, cadenas y coverage; nunca review aprobada inventada |
| `intent.review` / operador o workflow actual | `candidate_id`, `expected_revision_id`, `disposition=accept_origin|reject|dispute`, `target_scope`, `evidence_refs`, `rationale`, `idempotency_key` | nueva revisión y evidencia del acto de review; no cambia el texto original |
| `gold.promote` / regla/revisor | `silver_revision_ids`, `view`, `rule_id`, `evidence_refs`, `valid_from`, `valid_to`, `idempotency_key` | promoción/revisión versionada o PROVENANCE_UNRESOLVED |
| `gold.revise` / regla/revisor | `promotion_id`, `expected_revision_id`, `disposition=revoke|supersede|reject`, `replacement_ids?=[]`, `evidence_refs`, `valid_from`, `idempotency_key` | revisión nueva y cadena; preservar vista antigua bajo known_at anterior |
| `semantic.build` / indexador | `layers` no vacío de silver/gold, `scope`, `model_identity`, `batch_size?=16`, `max_batch_chars?=16000`, `resume_job_id?`, `idempotency_key` | projection_id(s), model/key identities, coverage por layer, nuevos/reusados, checkpoint; offline |
| `semantic.verify` / lector | `projection_ids`, `deep?=true` | passed/checks por proyección y compatibilidad con revisión/ámbito |
| `query` / agente | `question`, `kind=exact|conceptual|relational|temporal|count|mission|current_state`, `mode?=lexical`, `layers?=[silver,gold]`, `scope`, `time`, `limit?=20`, `graph_hops?=2`, `allow_lexical_fallback?=false` | plan, candidates deduplicados, answer_units, counters si procede y receipts; limit 1..200 |
| `stats` / agente | `metric=executions|failures|incomplete|blocked|latency|effects|mentions|representations|independent_sources`, `group_by?=[]` de session/project/command/workspace/day, `scope`, `time` | rows, exact totals, denominators, unknowns, source-independence definition |
| `context.build` / agente | `scope`, `time`, `mode?=lexical`, `layers?=[silver,gold]`, `budget_tokens?=6000` (512..32000), `budget_kind?=estimated`, `tokenizer?={id,revision,digest}` (obligatorio para tokenizer), `task_id?`, `include_evidence?=true` | pack ID/digest, program_mission, task_assignment, constraints, decisions, verified_work, artifacts, failures, pending, conflicts, gaps, evidence_index y omission manifest |
| `resident.status` / controlador | `endpoint` | protocol, owner, archive/revision/model identities, uptime, active requests y limits; sin credenciales |
| `resident.stop` / controlador | `endpoint`, `owner_token` (por archivo privado, nunca log) | draining/stopped; no mata otros procesos |
| `bundle.export` / operador | `revision_id`, `out_path`, `recipient_public_keys` (paths), `signing_key_path`, `include_projections?=false`, `idempotency_key` | manifest hash, ciphertext hash, signer fingerprint, bytes, source revision; keys nunca en stdout |
| `bundle.import` / operador | `bundle_path`, `recipient_private_key_path`, `trusted_signer_fingerprints`, `limits?`, `idempotency_key` | import revision/archive identidad preservada, verificación, relocation map; no TOFU automático |
| `capture.init` / operador actual | `output_dir`, `enabled?=false` (true registra opt-in explícito), `adapter=hook-v1|otlp-json-v1|openinference-v1|codex-app-server-v1`, `consent_scope`, `redaction_policy`, `idempotency_key` | config/consent digest y directorio privado; desactivado por defecto |
| `capture.append` / hook/importador | `capture_config`, `input_path` o stream stdin, `idempotency_key` | acquired count, duplicate delivery count, dropped/unknown/truncation, spool_id y checksum |
| `capture.status` / lector | `capture_config` | enabled, spool bytes, accepted/rejected/dropped, clock domains y última secuencia; no implica captura universal |

`resident.start` es un comando de lifecycle, no una mutación dentro de `archiveRequest`: `afh serve <archive> --endpoint <path> --model-config <file> --idle-seconds 900 --json` abre IPC y emite ready solo tras verificación. El archivo privado de endpoint contiene un token generado y permisos de propietario; su contenido no entra en receipts. El kernel impone mismo usuario y el handshake autentica token. `resident.status/stop` no pertenecen al conjunto de consultas sobre corpus; stop exige token de propietario.

## CLI y errores

Camino canónico de automatización: `node bin/afh.js archive request --file <request.json> --json`, con `--file -` para stdin. Conveniencias públicas construyen exactamente ese request: `afh archive init|ingest|verify|import-case|recover`, `afh context`, `afh stats`, `afh intent extract|review`, `afh bundle export|import`, `afh capture init|append|status`; reciben `--request <params.json>` para payloads complejos. Flags de scope: `--project`, `--thread` repetible, `--group`, `--known-at`, `--valid-at`, `--from`, `--to`, `--include-uncertain`; layers `--layer silver|gold|both`. CLI legacy conserva formato por defecto; comandos nuevos usan envelope. JSON final va a stdout; progreso NDJSON opcional va exclusivamente a stderr mediante `--progress-json`, incluso junto con `--json`.

El catálogo único normativo `specification/contracts.json#/error_catalog` define para cada código status, exit, retryable, efecto y recuperación; no hay códigos ad hoc en las implementaciones. Incluye INVALID_QUERY, BUDGET_TOO_SMALL, IDEMPOTENCY_CONFLICT y REVISION_CONFLICT. Exit 0 indica operación válida, no observado con cobertura completa incluido. CLI viejo conserva convenciones existentes; los nuevos endpoints usan el catálogo. Errores no previstos se convierten en INTERNAL_ERROR sin stack/paths secretos por defecto.

No se acepta SQL libre. Literales de consulta son parámetros SQL/FTS escapados; error de sintaxis FTS se devuelve como INVALID_QUERY, no consulta vacía. Filtros de ámbito se intersectan; ámbito explícito ajeno al activo se permite si está en el archivo del mismo dominio y se muestra. `association_mode=observed` excluye inferencias del conjunto cierto, pero informa candidates inciertos; `include_inferred` exige flag explícito y conserva grado.

## AnswerUnit y context pack

Cada unidad tiene `{id,kind,text,subject_ids,silver_revision_ids,gold_revision_ids,evidence_refs,epistemic,authority_origin,validity,knowledge_cutoff,verification_status}`. `verification_status=EVIDENCE_RESOLVED|EVIDENCE_UNAVAILABLE|REPORTED_ONLY`. No hay `confidence` derivada de vector score. La unidad que responde a un hijo incluye su session_id, spawn evidence, última respuesta terminal observada y su propia evidencia; si falta final, usa `NO_TERMINAL_RESPONSE_CAPTURED`. Una cadena obtenida por grafo conserva todos los pasos y su grado.

Presupuesto predeterminado `budget_kind=estimated`: `token_estimate = ceil(UTF8_bytes(rendered_pack)/3)`, `estimator=afh-utf8-estimate-v1`. Es una estimación, NO una cota universal del tokenizer del consumidor. `budget_kind=tokenizer` exige tokenizer_id/revision/digest local y conteo real del pack serializado, incluyendo metadatos/evidencia; ausente -> TOKENIZER_UNAVAILABLE, sin anunciar hard cap. Se registran bytes, estimación y conteo real nullable por separado. Selección respeta la medida declarada e informa omisiones por ID/motivo sin cortar URI. Reserva 20% misión+encargo+restricciones, 20% decisiones/conflictos, 25% trabajo/artefactos, 20% fallos/pendientes, 15% evidencia/cobertura; capacidad libre se reasigna en ese orden. Misión y cobertura se conservan; extractos por frases llevan rango y truncated=true. Si el mínimo esencial no cabe -> BUDGET_TOO_SMALL con medida requerida, sin falso pack completo.

## Fragmentación de evidencia y paridad de transporte

`max_bytes` limita bytes de evidencia solicitados, no tamaño del frame. Cada respuesta se serializa íntegra como JSON UTF-8 (incluido receipt, escapes y base64), se mide y se reduce el fragmento hasta <=8 MiB exactos; no se supone un overhead fijo. Para base64 la expansión se mide tras codificar. `format=text` corta únicamente en frontera UTF-8 válida y usa escapes JSON reales; no reemplaza bytes inválidos silenciosamente: devuelve INVALID_TEXT_ENCODING con opción base64. Si ni el envelope sin payload cabe, FRAME_TOO_LARGE sin payload. CLI y API aplican la misma fragmentación aunque no usen IPC.

La continuación es `{archive_id,revision_id,source_revision_id,uri,format,next_offset,remaining_bytes,request_extent_sha256}`; un consumidor puede continuar solo contra esa revisión/digest. Un offset ya consumido devuelve los mismos bytes, sin avanzar estado del servidor. next_offset = offset + bytes_returned; no se omiten ni repiten bytes al concatenar. Una revisión distinta invalida el cursor con CONTINUATION_MISMATCH. `partial` es true cuando quedan bytes del rango solicitado; ausencia de más bytes con fuente truncada conserva además TRUNCATED_AT_SOURCE. Nunca confundir fragmentación de transporte con pérdida de captura.

## Ejemplos y coherencia ejecutables

Todo bloque JSON de este documento es normativo y se valida como Request contra la rama de su operación con `validateNormativeExamples`, invocado por el validador del paquete. Discriminantes obligatorios: `kind=request|response|progress`; cada objeto cumple su schema, no se infiere kind por sus demás campos. Los ejemplos legacy permanecen bajo sus contratos originales.

Cada respuesta evidence.read incluye `archive_id,revision_id,source_revision_id,uri,format,offset,request_extent_sha256,record_sha256,extent_bytes,original_extent_bytes`. `extent_bytes` es el total del rango capturado solicitado inicialmente, limitado por el manifest verificado; la continuación agota ese rango, no extiende el request. `original_extent_bytes=null` cuando el harness truncó y no conservó el tamaño original. La longitud capturada y remaining_bytes de transporte se conocen por los bytes archivados, aunque la longitud histórica original sea desconocida. No inferir ninguna de esas longitudes a partir del texto. Si el manifest no permite resolver el rango capturado, devolver evidencia UNAVAILABLE; no fabricar un cursor.

El digest request_extent_sha256 es SHA256(afh-cjson-v1({archive_id,revision_id,source_revision_id,uri,json_pointer,format,initial_offset,extent_bytes,record_sha256})), con offsets/counts en representación canónica decimal string. Un request con continuation conserva sus identidades, formato, rango/digest y revision; offset omitido usa next_offset, offset explícito diferente falla. Responder partial exige bytes_returned>0. remaining_bytes = initial_offset + extent_bytes - (offset + bytes_returned); si llega a0 no hay cursor. El validador comprueba el par request/response frente al manifest/cursor verificado, además del schema y el frame completo.

## Aclaración de identidad03 y entrega

event.show acepta el Event.id canónico o un anchor adquirido. Resuelve ambos namespaces al mismo corte, exige prueba raw del alias y rechaza destinos distintos con AMBIGUOUS_IDENTITY; ausencia es EVIDENCE_UNAVAILABLE. stats.representations y su denominator cuentan clases técnicas de prefijo probado, mientras la lista de event.show conserva apariciones por revisión. Ver DATA-CONTRACT, Identidad canónica y anchors adquiridos; no se añaden campos wire obligatorios.

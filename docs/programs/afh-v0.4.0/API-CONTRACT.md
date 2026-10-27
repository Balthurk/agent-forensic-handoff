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
# Temporal04 internal selector materialization contract

The existing component operation `temporal.select` is materialized as the named
`selectTemporal(revisions, selection)` export of `src/archive/temporal.js`.
`revisions` contains acquired `TemporalRevision` values, preserving every schema
field. `selection` contains `published_seq`, `known_at`, `valid_at` and
`include_uncertain`. This is an internal component contract, not a new wire
operation and not permission to implement the future query/context consumers.

Return `{matches, presence, conflict, winner}`. Each match is
`{revision, match}` with the unchanged acquired revision and `MATCH` or `UNKNOWN`.
Presence is `OBSERVED` when an acquired candidate remains, otherwise
`NOT_OBSERVED_IN_CAPTURED_EVIDENCE`. `winner` is always null: the selector cannot
invent branch authority. Incompatible simultaneously matching associations remain
separate and report conflict. The caller retains source data when matches are
empty. Unknown validity must not remove an acquired candidate when
`include_uncertain` is true, or synthesize a UTC bound.

The selector first restricts knowledge to the published sequence and known time,
then chooses revisions per assertion and branch, then evaluates all validity
intervals as half open ranges. It does not mutate input, perform archive writes,
or resolve provenance from fabricated references. Acquisition, schema/native read
controls, preservation and public writer integration remain separate obligations.
Initial TDD uses public association publication and real captured evidence to
produce the input revisions. Its component receipts do not grant full acceptance.

Selector input validation detail: the internal selection requires explicit
non-null RFC3339 `known_at` and `valid_at`, safe nonnegative integer
`published_seq`, and boolean `include_uncertain`, with no extra keys. Public
callers resolve omitted times against their opened snapshot before calling this
component; the selector must not infer a snapshot time from the input rows.
Comparison preserves up to nine fractional digits and explicit numeric offsets,
without rounding to milliseconds. Unsupported leap-second instants, unknown
offset `-00:00`, invalid calendar dates and sub-nanosecond instants fail explicitly.
Bounds with kind unknown retain uncertainty; open is allowed only as an end.
Reversed or empty known intervals fail INVALID_TEMPORAL_RANGE. Malformed JSON
revision values fail INVALID_REQUEST; malformed selection times fail INVALID_QUERY.
Visible conflicting identities or branch/subject lineage fail INTEGRITY_FAILED.
Repeated byte-equivalent revisions deduplicate; differing rows sharing an ID do
not. Validation never modifies the acquired fields or returns synthesized rows.
Work is bounded to100000 input revisions,8MiB canonical JSON and32 nesting levels;
JSON traversal additionally caps1048576 values; excess is LIMIT_EXCEEDED. A conflict is reported for definite MATCH associations
of the same subject with different non-null projects, or competing branches of
one assertion. UNKNOWN candidates alone do not establish a definite conflict.

## Provenance04 component materialization contract

The internal `deriveProvenance(capture, selection)` export in
`src/archive/provenance.js` materializes the existing04 provenance capability.
It introduces no wire operation or later query/intent consumer. `capture` holds
`records[]` with `{raw, evidence_ref, session_id, recorded_seq, recorded_at}` and
`occurrences[]` returned by the public archive reader. Raw records must be decoded
from captured evidence, not reconstructed from expected answers. Selection uses
the same four fields as `selectTemporal`. The component preserves inputs and
performs no filesystem writes, subprocesses or network/model calls.

Return `{artifacts, validations, relations, decisions, git_objects}`. Every array
entry has a nonempty `id` and nonempty `evidence_refs`, each exactly drawn from
the selected captured records. Relations use the existing wire `Relation` shape
with evidence exclusively in `temporal.provenance.evidence_refs`; their typed endpoints must resolve
to returned entries or acquired occurrences/events. Do not infer closure from
command equality, adjacency, shared cwd, branch labels or a changed HEAD.

- Artifact entries contain `artifact_id`, `operation` from the existing artifact
  operation vocabulary, `path`, `previous_path` nullable, `before_sha256` nullable,
  `content_sha256` nullable, `predecessor_id` nullable, `producer_occurrence_id`
  nullable, `patch_ref` nullable, `status=OBSERVED|UNKNOWN`, and
  `disposition=RETAINED|DISCARD`. ADD/UPDATE/MOVE/DELETE describe four revisions;
  MOVE preserves a predecessor link and both paths. Without a captured complete
  preimage/postimage a patch alone cannot establish a full content digest.
- Validation entries contain `target_revision` nullable, `target_sha256` nullable,
  `criterion` nullable, `result=PASS|FAIL|UNKNOWN`, `occurrence_id`, and
  `criterion_state=VERIFIED|UNRESOLVED`. Only an explicit target revision/content
  binding plus a passing criterion can create VALIDATES and criterion support.
  Failed attempts remain present after both unrelated success and verified repair.
  `CONTRADICTS` records conflicting outcomes without asserting SUPERSEDES.
- Decision entries contain `subject_id`, `valid_to` as `TemporalBound`,
  `revocation_inferred` boolean, and `goal_closed` boolean. Execution duration
  alone supplies neither a decision end nor revocation or goal closure.
- Git entries contain `repository_id`, `object_format=sha1|sha256`, `oid`,
  `object_type=blob|tree|commit|tag|unknown`, `parents[]`,
  `epistemic=DIRECT_EVIDENCE|UNCERTAIN`. Native loose-object bytes or persisted
  object output must be captured and verified against the format-specific object
  digest and header before a COMMIT_PARENT edge is emitted. A branch report with
  no object remains uncertain with empty parents; sha1 and sha256 namespaces stay
  separate even for equivalent content. An unverified branch report has nullable
  oid and object_type unknown. No historical Git command is executed.

The test fixtures use captured native tool call/results (including apply_patch),
explicit artifact/validation metadata in persisted tool output, human discard
messages and native Git object bytes. Literal fixture metadata records assertions;
the component must derive and check relationships instead of copying a fixture's
expected result. Public graph.neighbors/path keep their existing typed schema,
source-backed endpoints, bounded traversal and temporal scope. At04, stats temporal
filters and occurrence TemporalRevision selection are tested on acquired histories;
the later query/context consumers remain outside this implementation scope.
Validation occurrence IDs bind to the exact captured call/result that contains
the validation metadata, including its PASS/FAIL role. Artifact producers and
evidence bind to the corresponding patch call/result, Git evidence to the exact
format/repository/OID record, and a decision subject to its captured statement.
Archive-wide evidence membership does not satisfy these semantic bindings.
Every returned graph path uses returned nodes and actual correctly typed edges
in the requested direction. A final event's IN_SESSION edge must point to the
specific acquired child that owns that final record.
The AFH-03-T11 fixture counts execution representations in the `command=npm test`
group: its fifteen user mentions remain separate message occurrences. Global
representation totals must not be confused with that execution-group denominator.

Initial and complete TDD submissions must report each executed assertion/control
and each unmet control explicitly. A missing component is NOT_IMPLEMENTED, not a
behavioral RED or complete acceptance. Synthetic response calibration is separate
from runtime execution. Atomic-pair tests must actually terminate the child inside
the native SQLite association row loop as well as inspect publication boundaries.


### Scope03 acceptance-only INSERT observation

`ledger.association_pair` is an internal acceptance function observation, not a public wire operation. Its request/result bind exact SQL, bound published_seq, actually returned association rows, and the writer job/PID/worker hash paused inside the first INSERT. Windows local SHM bytes may be acquired by an identified readonly native mapping helper in private acceptance tooling. Exact helper/executable/arguments/root, explicit inventory phase/native-call/boundary/attestation IDs, before/after identity and complete byte counts, successful handle closure, and unchanged writer progress are mandatory. Ledger/WAL retain ordinary reads and all prior inventory exceptions and negative guards. No remote filesystem, general concurrent coherence or durability acceptance is implied. Missing evidence, helper failure, identity/size drift or writes reject; post-kill evidence never substitutes for DURING.

The complete04 TDD obligations apply to every returned artifact collection, including artifacts accompanying validation and discard results. Producer identity, complete patch_ref, patch-call and terminal artifact-record evidence must bind to the same acquired artifact revision. A DISCARD additionally binds its acquired human message; DISCARDED edges use that exact typed origin and artifact endpoint. VALIDATES edges bind the PASS validation and repaired artifact revision/bytes with their establishing evidence. SPAWNED and IN_SESSION edges carry the complete acquired evidence establishing each concrete typed relation. The graph child records the actual validated outcome; the parent verifies that same request/response/outcome and worker identity before persisting it. Graph observations are consumed with requireOutcome, separately from the historical03 reader corpus.


### AFH-03-T11 scoped stats integration

AFH-03-T11 scoped runtime integration: stats uses the opened publication and known_at to select persisted occurrence revisions, canonical identity bindings and representation classes at the same knowledge cut. It reuses temporal.select for validity; from/to is a half-open validity-overlap window, optionally intersected with valid_at. Unknown validity is included only with include_uncertain and disclosed in receipt warnings and unknown counts. mentions counts distinct message occurrences (all message roles), never text tokens, execution records or repeated representations. Scope session IDs intersect temporally selected explicit project associations; no unrecorded membership is inferred. group_id, project/day grouping, latency and effects retain honest NOT_IMPLEMENTED until their owning integration. SQL aggregation retains group-local representation totals. No writer migration or timestamp inference from message text is introduced.


### Graph04 scoped native traversal

AFH04 graph.neighbors runtime integration: persist IN_SESSION for canonical event records and SPAWNED for explicitly acquired native parent/child identities in existing relation_version; deduplicate full establishing RAW references per typed relation, never substitute session metadata for a spawn record. Occurrence source derivation accepts an explicit graph version. New occurrence publications declare ledger_changes.occurrence_graph_version=1; absent means historical03 relation derivation and any other value fails closed. Deep verification/recovery reproduce the declared recipe, while upgrade appends graph facts at the new commit without rewriting old manifests, identities or occurrence counts. Graph reads real versioned relations/events/sessions under one publication/known_at cut and shared temporal selection before bounded traversal. Session node provenance comes from the selected acquired session manifest and its metadata record. Missing endpoints are not invented. BFS follows requested direction/types/hops, visits each node once, returns connected paths and typed endpoints; reaching max_nodes is conservatively truncated without a completeness claim. graph.path remains NOT_IMPLEMENTED in this component until separately integrated with its native read control. No public schema fields or global dependency are added.

Graph.neighbors on a pre-extension knowledge/publication cut returns NOT_IMPLEMENTED with PRE_GRAPH_EXTENSION; a later graph upgrade never changes that old availability. Once version1 is published, later occurrence publications cannot downgrade the graph recipe.


### Provenance04 bounded derivation

Provenance04 runtime uses the existing pure capture/selection boundary: caller authenticates RAW bytes before supplying decoded records; the component validates bounded plain JSON and exact acquired-reference/occurrence/session/native-call bindings, not an invented serialization hash of decoded JSON. Maximum100000 records/occurrences and8MiB canonical capture, depth32. Selected records and occurrences obey publication/known_at and temporal uncertainty. Descriptive apply_patch/unified-diff headers must match the artifact operation/path; complete captured postimages are hashed, partial patches never invent full bytes. Predecessors require the same artifact and independently comparable source lineage/order or explicit binding. Passing criterion verification requires exact target revision and content hash matching a captured artifact; unresolved conflicting reported outcomes of the same explicit criterion retain CONTRADICTS without supersession. Human DISCARD retains the prior bytes and binds its recorded event. Git native header/type/length/format-specific hash and parsed parents are checked before typed same-repository/same-format COMMIT_PARENT. Missing-object reports remain uncertain. No filesystem, subprocess, network/model calls or scenario/fixture lookup inside deriveProvenance.

A captured headerless hunk fragment with no complete postimage remains an UNKNOWN artifact assertion bound to its real call/result; it cannot prove operation/path execution or invent content bytes. Complete headers that contradict reported operation/path reject. Producer identity must match its occurrence temporal subject and session, failed producers cannot verify an artifact, and duplicate/conflicting captured-reference identities reject before derivation.

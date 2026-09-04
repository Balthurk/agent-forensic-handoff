# AFH v0.3.0 hybrid retrieval plan

## Objective and release boundary

Evolve Agent Forensic Handoff into a portable forensic retrieval layer that combines exact FTS5 lookup, local semantic similarity, structured filters, and bounded graph traversal while preserving one authority boundary: original evidence bytes and the structured event ledger remain authoritative; every semantic/vector/graph retrieval structure is a rebuildable projection.

The release is versioned `0.3.0`: it adds backward-compatible CLI capabilities and a schema-v3 graph contract for newly audited cases without changing the existing lexical default or mutating v0.1/v0.2 cases. A semantic index for a legacy case is written copy-on-write to a separate projection directory and is bound to that case hash.

No publication or activation occurs unless every local, integrity, retrieval-quality, scale, packaging, remote-CI, and global-smoke gate passes. Until then the globally active v0.2.0 package and skill remain untouched.

## Write and privacy boundary

- Repository edits: `C:\T\agent-forensic-handoff-improvement-20260904` only.
- Mutable cases, model probes, indexes, tamper fixtures, benchmarks, packages, staging, and deployment smokes: dedicated paths below `C:\T`.
- Existing cases below `C:\Users\Usuario\.afh\cases`: read-only verification inputs only; no migration, projection, repair, or metadata write in place.
- No real transcript, case database, semantic chunk, vector, reversible private derivative, or model cache enters Git, npm, or a GitHub release.
- Model download is explicit and retrieves weights only. Transcript content is never sent to the model host. Normal semantic indexing/querying is offline-only.

## Architecture

### Four layers

1. **Cold evidence:** immutable canonical source bytes, record ranges, hashes, and content-addressed derived blobs.
2. **Structured ledger:** case SQLite with sources, records, sessions, actors, events, tools, artifacts, validations, claims, coverage, and evidence-backed edges.
3. **Retrieval projections:** FTS5 in the case plus a copy-on-write semantic SQLite sidecar containing redacted chunks, deduplicated embeddings, a sqlite-vec index, model identity, projection identity, build status, and coverage.
4. **Human context:** bounded receipt and hot context. Neither semantic score nor graph adjacency becomes a truth claim.

### Semantic runtime decision

- Provider interface: `transformers-local`, with a deterministic fixture provider for tests only.
- Default model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, revision `2c4055b12046f11709e9df2c122e59ffbdc2f900`, q8, mean pooling, L2 normalization, 384 dimensions.
- Runtime: `@huggingface/transformers` 4.2.0; local model snapshot required for normal indexing/querying.
- Vector engine: `sqlite-vec` 0.1.9 loaded into Node's built-in `node:sqlite`; no separate service.
- Explicit setup: `afh semantic-model fetch` or `afh semantic-index --allow-model-download`. Without a healthy local model/index, semantic and hybrid requests report `UNAVAILABLE`; lexical remains available only when the caller explicitly requests lexical fallback.
- The default multilingual model was selected over `Xenova/all-MiniLM-L6-v2` after a Windows Node 24 probe: both produced finite normalized 384D vectors, but the English-only model selected an unrelated Spanish candidate for the cross-language timeout query. The multilingual model recovered all three semantic groups in the probe. Its larger model footprint and slower cold start are reported, not hidden.

### Projection identity and copy-on-write build

Each semantic projection records case hash, source snapshot hash, provider, runtime/package version, model ID, immutable model revision, local model digest, dtype, dimensions, pooling, normalization version, chunking version, redaction version, build tool version, timestamps, coverage, status, failure reason, SQLite/vector-engine versions, and projection hash.

`semantic-index` builds into a sibling staging directory, verifies it, then renames it into `projections/<projection-id>`. Rebuild creates a new projection identity or replaces only an exact matching unhealthy projection after preserving the prior directory for rollback. It never edits `case.sqlite`, cold evidence, or an older projection in place.

Semantic chunks use deterministic `event-preview-v1` text derived from already-redacted event kind/subtype/input/output projections. Chunks are bounded and overlap deterministically. Content hashes deduplicate embeddings across repeated events; chunk rows map every occurrence back to its event and evidence reference. Changing model, revision, digest, dtype, dimensions, pooling, normalization, redaction, or chunking produces a different projection identity.

### Hybrid query

- `lexical` remains the CLI and library default and preserves v0.2 semantics and array output for legacy calls.
- `semantic` requires a healthy projection and local model with the same recorded identity.
- `hybrid` obtains lexical and vector candidates, applies structured filters, fuses deterministic ranked lists with reciprocal-rank fusion (`k=60`), and expands evidence-backed graph neighbors within explicit hop/node/result limits.
- Explanations report lexical rank, vector rank/distance/similarity, graph hops/edges, fused score, effective mode, model/projection identity, coverage, and resolvable evidence references.
- Vector similarity is retrieval relevance only. It is never emitted as confidence, probability, corroboration, or truth.

### Graph contract

Schema v3 extends event and session edges with evidence event, rule, grade, epistemic status, and metadata. Deterministic reducers may add `RESULT_OF`, `PRODUCED`, `MODIFIED`, `VALIDATED`, and explicit session delegation edges. `SUPERSEDES`, `CONTRADICTS`, and `CORROBORATES` require a named conservative rule and evidence; absent proof means no edge.

Graph traversal uses bounded recursive SQL/BFS with visited-node cycle rejection. Neighbor and path responses explain every hop and label inferred edges distinctly. Default limits are two hops, 250 visited nodes, and 100 returned paths/nodes; hard maxima prevent graph explosion.

### Negative retrieval states

- `VERIFIED_PRESENT`: matching material was retrieved and every selected candidate has a resolvable, hash-verified evidence reference. This proves the material is present, not that its natural-language claim is true.
- `NOT_OBSERVED_IN_CAPTURED_EVIDENCE`: no candidate was found after the requested lexical/semantic coverage checks passed. This is not `VERIFIED_ABSENT`.
- `INCONCLUSIVE_COVERAGE`: missing sources/children, unparsed/unknown records, acquisition limits, unavailable evidence, stale projection, or relevant coverage gaps prevent a safe negative conclusion.
- `UNAVAILABLE`: the requested retrieval mode or required projection/model cannot run.

AFH never emits `VERIFIED_ABSENT` from retrieval alone.

## Phases and exit criteria

### Phase 0 — archaeology and reproducible technology probe

- Re-run v0.2 tests and baselines.
- Compare local vector/runtime options on license, supported platforms, package shape, service requirements, model identity, offline behavior, and Node 22/24 compatibility.
- Prove sqlite-vec load/query and real local model embedding on Windows; prove offline reload from an explicit immutable snapshot.

Exit: documented choice with observed trade-offs and no hidden network dependency.

### Phase 1 — schema-v3 graph and compatibility tests

- Write failing tests for new edge provenance, neighbors, paths, cycles, limits, orphan edges, and legacy verification.
- Add schema-v3 columns and insertion APIs without changing v0.1/v0.2 verification.
- Implement bounded explainable graph traversal.

Exit: deterministic graph fixtures pass; old lexical/query/show/evidence behavior remains green.

### Phase 2 — semantic projection and provider tests

- Write failing tests for deduplication, incremental idempotence, identity invalidation, offline-only behavior, wrong dimension, non-finite values, stale model, missing blobs/chunks, orphan vectors, and silent fallback.
- Implement provider abstraction, model fetch/status, deterministic chunking, projection sidecar, sqlite-vec indexing, copy-on-write activation, and projection integrity.

Exit: fixture provider tests pass without network; real default model passes local Windows indexing and offline reload.

### Phase 3 — lexical, semantic, hybrid, filters, and negative states

- Preserve `searchCase` and lexical CLI compatibility.
- Add structured filters, semantic KNN, deterministic RRF, bounded graph expansion, explanations, and query receipts.
- Add coverage assessment and the four negative/presence states.

Exit: no silent fallback; every material result resolves to evidence; incomplete coverage never becomes absence.

### Phase 4 — gold set, integrity, and security

- Commit only sanitized synthetic fixtures covering exact terms, paraphrases, different vocabulary, IDs/hashes/paths, split action/result, delegation, contradiction, temporal filters, prompt injection, duplicates, incomplete sources, negative controls, and multilingual retrieval.
- Separate tuning, validation, and final test queries.
- Extend deep verification to projection manifests, chunk/content hashes, model identity, finite dimensions, vector hashes, row mappings, stale indexes, graph identities, edge provenance, limits, retrieval receipts, and case/hydration integrity.

Exit: exact recall is 100% within the configured limit, semantic paraphrase recall@25 is at least 90%, hybrid preserves exact recall and materially improves semantic recall over lexical, graph fixtures are 100%, evidence resolution is 100%, and negative-state false absence count is zero.

### Phase 5 — performance and production-shaped validation

- Measure audit-without-embeddings separately from full/incremental semantic build, lexical/semantic/hybrid queries, graph traversal, quick/deep verification, cold/warm model startup, and storage.
- Re-run same-machine 10,002-record v0.2 comparison, isolated real-case reingest/index/query/verification, and one-million-record audit gate.
- The legacy audit path may not regress by more than 10% median time or storage without a documented necessary trade-off.

Exit: factual and performance gates pass; private outputs remain only under `C:\T`.

### Phase 6 — release, staged activation, and rollback

- Complete docs, secret scan, `npm audit`, package dry-run, Node 22/24 tests, isolated tarball smoke, and clean Git diff.
- Push without force, require remote CI, tag the exact validated commit, and publish checksums plus honest platform/model limitations.
- Stage package and skill beside active v0.2, compare identities, swap while keeping launchers stable, and restore v0.2 automatically on any failed global smoke.
- From the globally active build, verify version, doctor, audit, lexical/semantic/hybrid query, graph neighbors/path, show, evidence, deep integrity, old-case verification, and rollback executability.

Exit: all acceptance conditions pass, release and active installation match, repository is clean, and rollback remains retained.

## Explicit non-goals for v0.3

- No PostgreSQL, Neo4j, Qdrant, LanceDB service, remote embedding provider, autonomous decision kernel, historical command execution, or proof of hidden/deleted events.
- No semantic inference is written back as direct evidence.
- No in-place migration of v0.1/v0.2 cases.
- No claim that a negative search proves universal absence.


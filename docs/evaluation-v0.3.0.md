# AFH v0.3.0 evaluation

## Outcome

The v0.3 release candidate preserves the v0.2 evidence authority and lexical interface while adding three rebuildable retrieval capabilities: a provenance-bearing entity graph, fully local semantic projections, and deterministic hybrid fusion. It passed the synthetic factual suite, versioned hybrid gold set, million-record accounting gate, read-only legacy-case checks, and a production-shaped full index/deep-verification run on Windows Node 24.

The release does not claim universal recall or absence. A production-shaped case retained 39 explicit child-session coverage warnings; queries returned `VERIFIED_PRESENT` for selected hash-resolvable records while continuing to expose those gaps.

## Defects found and corrected

1. A vector KNN returns the nearest rows even when all are unrelated. A default cosine-similarity floor (`0.15`) now rejects weak neighbors; the value is recorded in the query receipt and remains configurable.
2. A nominal batch of 64 long chunks caused about 4.66 GB resident memory and unacceptable progress. The default is now 16 items with an independent 16,000-character budget, a hard item cap, and progress events. The unsafe probe was stopped before release; copy-on-write staging protected the case.
3. Recomputing every vector/chunk hash during every query made a 125 MB production sidecar unnecessarily slow. Quick verification now checks the complete SQLite SHA-256, case/model identity, SQLite quick check, projection/count invariants, and vector-index cardinality. Deep mode retains the row-by-row vector, finiteness, chunk, link, and index-byte checks. Warm large-case query latency improved by roughly 50–56% while same-size vector tampering still fails closed through the database hash.
4. The initial dependency tree inherited high-severity advisories through transitive ONNX/archive/image packages. Compatible patched overrides were selected and exercised by the real model pipeline. `npm audit --omit=dev` reports zero vulnerabilities.
5. The original CLI could not distinguish unavailable semantic retrieval from a lexical result. Semantic/hybrid modes now return `UNAVAILABLE` unless a caller explicitly enables a visibly labeled lexical fallback.

## Factual and retrieval quality

- Core test suite: 29 passing, one intentional Windows symlink skip.
- Exact lexical and hybrid recall@5: 100%.
- Semantic and hybrid paraphrase recall@25: 100% on the versioned validation/test gold set; lexical baseline: 0% by construction because the paraphrases avoid exact vocabulary.
- Graph fixture accuracy: 100%.
- Selected evidence-reference resolution: 100%.
- False absence count: zero; incomplete capture becomes `INCONCLUSIVE_COVERAGE`.
- Original v0.1 cases: three of three passed v0.3 quick read-only verification with identical pre/post file inventory.

The gold set is synthetic and small. Its 100% result demonstrates the acceptance cases, not general-world semantic accuracy. Similarity and RRF values rank candidates only.

## Performance

The schema-v3 audit path does not compute embeddings. On the same 10,002-record profile its median was 1,431 ms versus 1,860 ms for v0.2, a 23.1% reduction rather than a regression. The one-million-record profile processed 1,000,002 records in 155,104 ms (6,447 records/s) with full accounting and all factual gates green.

The production-shaped audit processed 57,071 records in 64,413 ms and created 10,234 graph edges. Its optional first semantic build processed 27,165 chunks / 21,832 unique embeddings in 1,751,299 ms (about 29.2 minutes), produced a 125,344,518-byte sidecar, and deduplicated 5,333 occurrences. This is an explicit preparation job; it is not on the audit/hydrate path. Deep sidecar verification took 21.8 seconds and full case verification 27.0 seconds.

Large-case lexical lookup was 103 ms. Cold semantic/hybrid CLI calls were approximately 4.4–4.5 seconds because a fresh process loads the local model; with a reused model they were approximately 1.3–1.5 seconds. A future long-lived read-only service could reduce cold starts, but v0.3 intentionally avoids adding a daemon or remote dependency.

## Privacy, security, and portability

- Only already-redacted event previews are embedded. Cold records are never sent to the embedding host.
- Model download requires an explicit flag; normal indexing/querying disables remote model access.
- Sidecars are private derived data, bound to case/source/model/runtime/config hashes and verified before use.
- Semantic failures do not contaminate the authoritative SQLite case and do not silently change retrieval mode.
- Release-tested platforms are Windows x64 and CI Linux x64 on Node 22/24. Other architectures supported by the dependency packages remain unverified by this release.

## Residual limits

- Initial multilingual indexing of tens of thousands of long chunks is CPU intensive.
- A fresh CLI semantic query pays model cold-start cost; no daemon is included.
- Semantic chunks cover normalized redacted event previews, not every byte of raw cold evidence. Exact evidence remains available through lexical/source retrieval.
- sqlite-vec is pre-1.0 and therefore pinned, identity-recorded, and isolated in a rebuildable projection.
- Coverage beyond persisted/acquired sessions remains unknowable; the system reports source/child gaps rather than inferring absence.
- Progress is emitted for semantic builds but does not yet include a stable ETA.

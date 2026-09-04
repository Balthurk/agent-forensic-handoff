# Vector runtime decision for AFH v0.3.0

## Decision

Use `@huggingface/transformers` 4.2.0 with an explicit local snapshot of `Xenova/paraphrase-multilingual-MiniLM-L12-v2` at revision `2c4055b12046f11709e9df2c122e59ffbdc2f900`, q8/mean-pooling/L2-normalized 384D output. Store deduplicated vector bytes and provenance in a projection SQLite database and use `sqlite-vec` 0.1.9 for local cosine KNN.

The model snapshot is fetched only through an explicit network-authorizing command. Normal index/query commands set remote-model loading to false and fail visibly if the exact local snapshot is unavailable.

## Evidence reviewed

- Transformers.js 4.2.0 is Apache-2.0 and supports feature extraction, local model paths, explicit remote-model disabling, dtype selection, and Node execution: <https://github.com/huggingface/transformers.js/releases/tag/4.2.0>.
- sqlite-vec 0.1.9 is MIT-or-Apache licensed, service-free, written in C, exposes a Node loader, and publishes prebuilt packages for Windows x64, Linux x64/arm64, and macOS x64/arm64: <https://github.com/asg017/sqlite-vec/releases/tag/v0.1.9>.
- The chosen converted model snapshot is immutable at revision `2c4055b12046f11709e9df2c122e59ffbdc2f900`; the upstream Sentence Transformers model is Apache-2.0: <https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2> and <https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2>.
- `Xenova/all-MiniLM-L6-v2` revision `751bff37182d3f1213fa05d7196b954e230abad9` is Apache-2.0, 384D, and materially smaller. It remains a supported explicit model but is not the default because the local probe exposed weaker cross-language retrieval: <https://huggingface.co/Xenova/all-MiniLM-L6-v2>.

## Reproducible local probe

Environment: Windows x64, Node 24.15.0, `@huggingface/transformers` 4.2.0, `sqlite-vec` 0.1.9. Synthetic text only; no forensic source content was sent or indexed.

- sqlite-vec loaded into `node:sqlite`; a 3D cosine query returned its identical vector at distance 0.
- all-MiniLM produced finite L2-normalized 384D q8 vectors. Cached load was about 648 ms in the comparison run; six corpus texts plus three queries embedded in about 208 ms.
- multilingual MiniLM produced finite L2-normalized 384D q8 vectors. First downloaded load was about 3,977 ms in the comparison run; the same nine texts embedded in about 82 ms.
- Both models recovered the two same-language semantic groups. Only the multilingual model selected the correct timeout group for the Spanish-to-English query. Both recovered the Spanish delegated-task group.
- all-MiniLM's required cached files occupied about 23.7 MB. The multilingual model uses an approximately 118.3 MB q8 ONNX file plus a 17.1 MB tokenizer. The footprint/cold-start cost is accepted for multilingual behavior and remains separate from every case.
- A fresh process with remote models disabled successfully reloaded all-MiniLM from an explicit revision directory. The release will apply the same explicit-snapshot contract to the selected default and test it before publication.

These timings are probes, not release benchmarks; full multi-pass results belong in the release evaluation.

## Alternatives rejected

### English all-MiniLM as default

Smaller and faster to load, but the probe failed the cross-language query relevant to this Spanish/English workflow. It remains configurable for English-only, lower-footprint deployments.

### LanceDB

Actively maintained and embedded, but it introduces a larger Rust/Arrow-native storage stack, separate table format, more platform packages, and optional external embedding integrations. AFH already has SQLite and does not yet need ANN-scale complexity.

### hnswlib-node

Provides ANN search but is a native addon with a much smaller maintenance/community surface and no native integration with AFH's SQLite metadata, hashes, or integrity checks.

### JavaScript brute-force cosine scan

Maximally portable and suitable as a diagnostic reference, but slower at scale and not an independently optimized vector index. It may be retained in tests as an oracle, never as a silent runtime fallback.

### Separate database or service

PostgreSQL/pgvector, Qdrant, Neo4j, and similar services violate the normal-use portability and zero-service objective. No measured requirement currently justifies them.

## Portability and limitations

- Release targets and tests: Windows x64 plus GitHub-hosted Linux x64 under Node 22/24.
- Published sqlite-vec packages also cover macOS x64/arm64 and Linux arm64, but those targets remain declared compatible-by-package rather than release-tested until CI evidence exists.
- sqlite-vec 0.1.x is pre-1.0. AFH records the exact extension version and validates the rebuildable projection; the case ledger remains usable if the extension is unavailable.
- Model weights are sensitive operational dependencies but contain no case data. Embeddings and chunks are case-sensitive derivatives and inherit the case's private handling rules.


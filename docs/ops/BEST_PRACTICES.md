# Best Practices

Append-only project-specific engineering practices derived from verified work.

## Entries

### 2026-09-04 — Growing transcript snapshots

For append-only live transcripts, fix the observable byte boundary before hashing or decoding, read only that prefix, and rehash the prefix before committing the case. Treat later appended bytes as a new audit and fail closed if any captured prefix byte changes.

### 2026-09-04 — Evidence storage

Do not duplicate full normalized event values when the exact source record is already immutable and byte-addressable. Store a value hash plus the source pointer; materialize only derived content that has no independent cold-evidence locator. Bulk-load evidence references when rendering full timelines to avoid N+1 queries.

### 2026-09-04 — Causal child closure

Acquire child sessions only from explicit state edges or exact IDs returned by successful persisted delegation/fork/subagent observations. Bound traversal, reject cycles, exclude failed creation results, and report every inaccessible or limit-truncated child as an evidence gap.

### 2026-09-04 — Rebuildable forensic retrieval projections

Keep cold evidence and the normalized ledger authoritative. Bind every optional semantic projection to the exact case, source snapshot, model revision/digest, runtime, dimensions, dtype, normalization, redaction, and chunking. Build copy-on-write, verify before activation, and never write similarity back as fact.

### 2026-09-04 — Dual-mode integrity for large immutable sidecars

For interactive use, verify the complete immutable SQLite file hash and structural invariants once per query process; reserve row-by-row vector, finiteness, chunk, evidence-link, and index-byte scans for deep verification. Do not claim the quick mode is equivalent to authorship authentication.

### 2026-09-04 — Embedding batches need two bounds

Bound embedding work by both item count and aggregate characters. A safe item count can still exhaust memory when all texts are long. Report deterministic progress, keep the core case usable, and atomically activate only a fully verified sidecar.

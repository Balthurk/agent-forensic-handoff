# Best Practices

Append-only project-specific engineering practices derived from verified work.

## Entries

### 2026-09-04 — Growing transcript snapshots

For append-only live transcripts, fix the observable byte boundary before hashing or decoding, read only that prefix, and rehash the prefix before committing the case. Treat later appended bytes as a new audit and fail closed if any captured prefix byte changes.

### 2026-09-04 — Evidence storage

Do not duplicate full normalized event values when the exact source record is already immutable and byte-addressable. Store a value hash plus the source pointer; materialize only derived content that has no independent cold-evidence locator. Bulk-load evidence references when rendering full timelines to avoid N+1 queries.

### 2026-09-04 — Causal child closure

Acquire child sessions only from explicit state edges or exact IDs returned by successful persisted delegation/fork/subagent observations. Bound traversal, reject cycles, exclude failed creation results, and report every inaccessible or limit-truncated child as an evidence gap.

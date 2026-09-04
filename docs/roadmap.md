# Incremental implementation plan

## Implemented through v0.3

- canonical SQLite schema and content-addressed evidence store;
- plain/gzip/Zstandard streaming ingestion with safety limits;
- Codex local state/rollout discovery and dedicated normalization;
- Claude Code local discovery and baseline normalization;
- conservative Antigravity/generic adapter;
- actor, tool, task, decision, failure/retry, compaction, external influence, and artifact ledgers;
- V0/V1 read-only current-state verification;
- hot/warm/cold hydration and selective retrieval CLI;
- installable cross-harness Agent Skill;
- deterministic synthetic benchmark and security/integration tests.
- modern Codex item-completion, realtime, token, collaboration, subagent, extension, and inter-agent record normalization;
- bounded causal closure over exact successful task/fork/subagent identifiers;
- mission-envelope filtering, historical validator recovery, and artifact recovery from file-change records;
- schema-v2 packed derived blobs and source-pointer event payloads;
- read-only whole-case integrity verification and rollback-safe skill replacement.
- schema-v3 evidence-bearing graph edges with bounded cycle-safe neighbors and paths;
- optional offline-only multilingual MiniLM projections using sqlite-vec sidecars;
- explicit lexical, semantic, and hybrid retrieval with filters, RRF explanations, receipts, and safe negative states;
- versioned hybrid gold set, vector/model/projection integrity, and no-silent-fallback behavior.

## Next increments

1. **Schema compatibility:** broader generated Codex App Server protocol fixtures, explicit harness/version compatibility registry, more Claude/Antigravity versions.
2. **Provenance depth:** more patch/file-change forms, supersession/discard events, contradiction sets, Git-object lineage.
3. **Portable bundles:** encrypted export/import, manifest signing, relocation-safe source metadata.
4. **Optional retrieval server:** read-only MCP only if measured CLI round trips prove inadequate; the embedded CLI remains authoritative.
5. **Prospective capture:** optional hooks and OpenTelemetry/OpenInference import; never required for retrospective use.
6. **Release hardening:** sustained million-record regression history, fuzzing, macOS CI, blinded continuation trials, SBOM/signing.

Every increment must preserve parse accounting, evidence resolvability, uncertainty, and the no-historical-execution boundary.

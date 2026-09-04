# Incremental implementation plan

## Implemented in v0.1

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

## Next increments

1. **Schema compatibility:** generated Codex App Server protocol fixtures, explicit harness/version compatibility registry, more Claude/Antigravity versions.
2. **Provenance depth:** more patch/file-change forms, supersession/discard events, contradiction sets, Git-object lineage.
3. **Portable bundles:** encrypted export/import, manifest signing, relocation-safe source metadata.
4. **Optional retrieval server:** read-only MCP only if CLI round trips prove inadequate.
5. **Prospective capture:** optional hooks and OpenTelemetry/OpenInference import; never required for retrospective use.
6. **Release hardening:** million-record benchmark, fuzzing, Windows/macOS CI, blinded continuation trials, SBOM/signing.

Every increment must preserve parse accounting, evidence resolvability, uncertainty, and the no-historical-execution boundary.

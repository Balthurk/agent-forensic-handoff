# AFH v0.2.0 improvement plan

## Objective and non-negotiable boundary

Improve the usefulness, fidelity, performance, verifiability, and deployment safety of Agent Forensic Handoff while preserving its primary contract: every observable source record is accounted for, historical content is never executed, material conclusions remain evidence-addressable, and unavailable facts are never filled with plausible narrative.

The two real AFH cases used to discover the defects are immutable inputs. Development, benchmarks, migrations, and rendering tests must target isolated case directories only.

## Evidence-based baseline

The production v0.1.0 case for thread `01a0573f-6dfb-7071-8d35-c816f4d88027` contains 18,999 parsed records from a 204,421,738-byte rollout and passes SQLite integrity and evidence-hash checks. It nevertheless reports 8,294 valid Codex records as unsupported: 5,863 `event_msg.item_completed`, 1,936 `token_usage_record`, and 495 `realtime_item`. Ninety-seven of the preserved item-completion records are direct `FileChange` observations, but the artifact ledger is empty. The case contains a completed `create_thread` observation for `01a06bd7-16d9-79f2-b58c-8979650613e5`, but only the parent source was acquired because standalone project tasks are absent from `thread_spawn_edges`. The hot mission is an injected plugin/environment block rather than a substantive user request.

The production v0.1.0 case for the successor contains 935 parsed records and 430 unsupported-but-valid Codex records. Its terminal work and failure are recoverable from cold evidence, but the generated hot context again selects environment metadata as mission and reports no artifacts or historical validations.

The repository's unit and synthetic benchmark gates pass, but `npm run release:check` fails on Windows because the skill validator accepts LF front matter only while the checked-out `SKILL.md` uses CRLF. The synthetic corpus therefore does not exercise the production record family or Windows release path.

## Prioritized implementation

### P0 — reconstruction correctness

1. Normalize modern Codex `item_completed`, token-usage, and realtime records without warning inflation. Preserve exact records and project only bounded, redacted fields.
2. Recover `FileChange` artifacts, command exit metadata, MCP activity, compaction, user/agent messages, and causal child-session edges from item-completion records.
3. Discover standalone tasks created through a directly observed successful `create_thread`/`fork_thread` result. Resolve only exact returned thread IDs, bound recursion and source count, reject cycles, and include every acquired child hash in the case identity.
4. Select the latest substantive user request as the current mission while retaining the first substantive request as historical intent. Exclude harness-injected plugin, environment, permission, skill-catalog, and annotation envelopes from task extraction.
5. Derive a historical-validation ledger from recorded validation commands and explicit exit status. Label these as historical observations, never as a current rerun.

### P1 — integrity and operational safety

6. Add a read-only `verify-case` command that checks the SQLite database, manifest/database agreement, canonical source hashes and lengths, registered record ranges and hashes, content blobs, metrics, and hydration-pack hash. Any mismatch must fail closed and produce machine-readable findings.
7. Make forced skill replacement staged and rollback-safe: fully copy and compare the new tree before switching paths; restore the old tree if activation fails.
8. Make skill validation newline-independent and run it on Windows and Linux-compatible line endings.
9. Keep schema compatibility explicit. v0.1 cases remain readable; new cases declare schema v2 and never mutate old cases in place.

### P1 — performance and storage

10. Keep normalized event payloads as digests plus exact canonical-source pointers instead of duplicating transcript content. Pack small deduplicated derived/artifact blobs into SQLite and retain only large derived blobs as content-addressed files. This reduces both byte duplication and filesystem metadata operations without losing exact recoverability.
11. Configure safe build-time SQLite pragmas and retain one transaction for ingestion. Final cases are closed cleanly and opened read-only for investigation.
12. Add production-shaped benchmark gates for warning count, artifact recovery, child closure, mission salience, validation recovery, blob file count, integrity verification, and idempotence.

### P2 — context quality and documentation

13. Render source/session coverage, current mission, latest actionable request, historical validation status, artifact provenance, and material gaps before lower-value repeated failures.
14. Allocate the hot-context budget by section so a large failure list cannot crowd out mission, state, and next action.
15. Document causal-delegation discovery, packed blobs, integrity verification, backward compatibility, and the no-current-proof boundary for historical validation results.

## Acceptance gates

- All original unit, security, benchmark, compression, and evidence-resolution gates remain green.
- Every input line still has exactly one `source_record` accounting row.
- Modern fixture: zero unknown-record warnings for supported modern Codex variants.
- Modern fixture: direct file changes create artifact revisions; recorded validators create historical validation rows.
- Delegation fixture: parent plus exact successful child are included; unrelated threads and failed creations are excluded; the session edge has an evidence event.
- Mission fixture: injected envelopes never become current mission or tasks; the latest substantive request does.
- Storage fixture: small blobs are retrievable and hash-verified from SQLite; large blobs remain hash-verified files; filesystem blob count decreases materially.
- `verify-case` passes an intact fixture and fails after source, database projection, or blob tampering.
- Release checks pass under the current Windows checkout and CI's Node 22/24 matrix.
- On the real copied/re-ingested corpus: parse accounting remains 100%, warning count falls by the supported-record total, artifact and validation ledgers become non-empty, the exact successor is included, and hot context names the substantive terminal mission.
- New giant benchmark throughput must not regress by more than 15% from the same-run v0.1 baseline without a documented fidelity trade-off; storage file count must improve materially.
- Package dry-run, clean-install smoke test, staged global CLI smoke test, staged global skill validation, rollback drill, and post-activation smoke test all pass before the release tag is published.

## Deployment and rollback

1. Build and test a packed release artifact from the clean repository commit.
2. Install it into an isolated prefix and run `doctor`, `version`, fixture audit, query, evidence retrieval, and `verify-case` there.
3. Push the tested commit to `origin/main` and verify the remote commit.
4. Stage the package beside the active global package, verify its tree and executable, then switch the package directory while preserving the existing launchers.
5. Stage the skill beside the active skill, validate it, then perform a same-parent rename swap. Existing sessions keep their already-loaded instructions; new invocations see the new tree.
6. Run post-activation smoke and integrity checks. If any fails, swap the preserved package and skill backups back immediately.
7. After successful activation, publish and verify tag `v0.2.0`; retain the rollback paths until final verification is complete.

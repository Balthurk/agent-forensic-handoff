# AFH v0.2.0 evaluation

## Scope and evidence boundary

This evaluation used the two pre-existing v0.1 forensic cases only as immutable diagnostic inputs. No file under `C:\Users\Usuario\.afh\cases` was changed. Mutable re-ingestion, tamper tests, benchmarks, and installation tests were directed to isolated directories below `C:\T` or operating-system temporary storage.

The primary production-shaped input was Codex thread `01a0573f-6dfb-7071-8d35-c816f4d88027`; the delegated successor of interest was `01a06bd7-16d9-79f2-b58c-8979650613e5`.

## Defects established in v0.1

- The parent case accounted for all 18,999 records but classified 8,294 valid modern Codex records as unknown. Direct file changes, token records, item completions, and realtime records therefore remained available only as cold evidence.
- The parent contained a successful `create_thread` result naming the successor, but the successor was not acquired because standalone project tasks need not appear in `thread_spawn_edges`.
- Both parent and successor hot contexts could select harness/plugin/environment envelopes as the mission.
- Direct file-change observations did not produce artifact revisions; recorded validator executions did not produce a historical validation ledger.
- Event input/output blobs duplicated substantial content already present in exact canonical source records and created thousands of files.
- The Windows release gate rejected valid CRLF front matter.
- A source that grew between initial hashing and stream completion could produce a case whose declared raw snapshot and canonical capture represented different byte boundaries.
- Warm timeline rendering performed one evidence query per event.

## v0.2 remediation

1. Added production-shaped normalization for Codex item-completion, collaboration, subagent, token, realtime, inter-agent, and extension records.
2. Added bounded, cycle-safe causal discovery from exact successful task/fork results and observed subagent starts. No nearby or guessed thread is included.
3. Added envelope filtering, latest-substantive mission selection, artifact reconstruction, recorded validation recovery, and source/session coverage in hot context.
4. Added schema v2 `content_blob`: derived values are deduplicated; small values are packed in SQLite and large values remain files. Event payloads retain a normalized SHA-256 and exact source pointer rather than a second full copy.
5. Added read-only `afh verify-case`, covering SQLite integrity, manifest/schema agreement, source and record ranges/hashes, blobs, metrics, hydration content, source snapshot identity, and case identity. v0.1 cases remain verifiable.
6. Fixed live-source acquisition by freezing the observed byte boundary, hashing and reading only that prefix, and rehashing it before case completion. Prefix mutation fails closed; append-only growth belongs to the next audit.
7. Replaced N+1 warm-timeline evidence lookups with one indexed bulk read.
8. Made forced skill installation stage, compare, atomically swap, and restore on activation failure.
9. Added resource limits for child count, inline blob size, total source size, record size, decompressed size, and compression ratio.

## Production-shaped result

Final isolated case:

`C:\T\afh-v020-final-real-20260904-r3\cases\01a0573f-6dfb-7071-8d35-c816f4d88027\55a635f831d9aa4d`

- 9 immutable sources; 45 recovered session identities; 53 explicit/direct session edges.
- 55,179/55,179 records parsed; 0 unparsed; 0 unsupported-format warnings for the captured families.
- 8,528 reconciled tool executions; 189 artifacts; 515 current/historical validation rows; 958 external interventions.
- The exact standalone successor was acquired and its current substantive request became the hot mission.
- Deep integrity verification passed every source, all 55,179 record ranges and hashes, all 1,324 derived blobs, metrics, hydration hash, snapshot hash, and case hash.
- The deliberately low test limit of eight children emitted explicit coverage warnings for additional observed subagents. Those warnings are a bounded-acquisition disclosure, not parser loss.

## Storage and performance

The earlier pre-optimization v0.2 real run had 774,564,159 bytes, 1,737 files, and 1,716 large blob files. The final case has 614,385,105 bytes, 56 files, and 34 large blob files while capturing one additional and still-growing source. This is about 20.7% fewer bytes and 96.8% fewer filesystem entries in the production-shaped comparison.

A same-machine, same-period three-run comparison at 10,002 records produced:

| Version | Median elapsed | Median throughput |
|---|---:|---:|
| v0.1.0 | 2,938 ms | 3,404 records/s |
| v0.2.0 | 1,860 ms | 5,377 records/s |

That is approximately 36.7% less elapsed time and 58.0% higher throughput at the median. Timing remains environment-sensitive; factual gates are normative.

The local million-record release profile passed with 1,000,002/1,000,002 records in 238,643 ms (4,190 records/s). Its 592-token hot context represented an estimated 32,222,297 source tokens, a ratio of 0.00184%. The compact result is retained in `benchmarks/release-v0.2.0.json`; the large generated case remains outside Git.

## Remaining limits

- Child closure is complete only within accessible persisted sources and the configured bound. The receipt explicitly lists unresolved children.
- Historical validation records prove what the persisted execution reported at that time; they are not a current rerun.
- Secret detection is conservative and projection-only. Cold evidence remains sensitive and can contain secrets.
- Raw source authentication and portable signing/encryption are not supplied by v0.2.
- Claude Code and generic adapters retain baseline support; the new production-depth fixture is Codex-specific.
- Multi-harness blinded continuation remains a separate human/fresh-agent evaluation.

## Subsequent plan

The prioritized implementation and acceptance plan is in [improvement-plan-v0.2.0.md](improvement-plan-v0.2.0.md). Remaining P2 work should focus on signed/encrypted portable bundles, explicit harness-version compatibility, fuzz/property corpora, macOS release coverage, and repeated blinded continuation trials. None should weaken parse accounting, source resolvability, fail-closed integrity, or the no-historical-execution boundary.

# OPERATION TRACE

Append-only step-level trace for project-affecting Codex work.

## Fields

- Timestamp
- Task ID
- Agent/session
- Project root
- Phase
- Action type
- Target
- Evidence/result
- Decision
- Status

## Entries

### TRACE-2026-09-04-001

- `timestamp`: `2026-09-04 Europe/Madrid`
- `task_id`: `TASK-2026-09-04-001`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `intake`
- `action_type`: `decision`
- `target`: `repository clone, AFH source, tests, documentation, packaging, and staged global installation`
- `evidence_result`: `Clean main checkout cloned from https://github.com/Balthurk/agent-forensic-handoff.git; active global skill and C:\Users\Usuario\.afh\cases explicitly excluded from the write set.`
- `decision`: `Use existing forensic cases read-only; direct all mutable benchmarks to isolated paths; require regression, integrity, performance, packaging, staged-install, and rollback checks before push or activation.`
- `status`: `done`

### TRACE-2026-09-04-002

- `timestamp`: `2026-09-04 Europe/Madrid`
- `task_id`: `TASK-2026-09-04-001`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `planning`
- `action_type`: `verification`
- `target`: `v0.1.0 repository checks and immutable production cases`
- `evidence_result`: `12 tests passed and 1 platform-specific symlink test skipped; deterministic benchmark passed at 6,255 records/s for 10,002 records. Release check failed at skill validation because CRLF front matter was not accepted. Original case: 18,999/18,999 parsed, 8,294 supported-family records misclassified, 97 direct FileChange records but 0 artifacts, and 1 acquired source despite a directly recorded successful create_thread. Successor case: 935/935 parsed and 430 supported-family records misclassified.`
- `decision`: `Implement v0.2.0 against production-shaped fixtures and the acceptance gates in docs/improvement-plan-v0.2.0.md; do not mutate either production case.`
- `status`: `done`

### TRACE-2026-09-04-003

- `timestamp`: `2026-09-04T12:30:00+02:00`
- `task_id`: `TASK-2026-09-04-001`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `implementation`
- `action_type`: `code-and-test`
- `target`: `schema v2, modern Codex adapters, causal discovery, reducers, renderer, integrity command, installer, and resource controls`
- `evidence_result`: `Production-shaped fixtures added; legacy and new integration/security tests passed. Original v0.1 cases passed read-only compatibility verification. No historical command was executed by AFH.`
- `decision`: `Use canonical source pointers plus normalized payload hashes for event values; materialize only derived blobs. Preserve explicit child-coverage warnings rather than guessing or silently expanding without limit.`
- `status`: `done`

### TRACE-2026-09-04-004

- `timestamp`: `2026-09-04T13:02:32+02:00`
- `task_id`: `TASK-2026-09-04-001`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `production-shaped-validation`
- `action_type`: `forensic-reingest-and-deep-integrity`
- `target`: `isolated case C:\T\afh-v020-final-real-20260904-r2\cases\01a0573f-6dfb-7071-8d35-c816f4d88027\de089ec502bbff04`
- `evidence_result`: `9 sources, 54,924/54,924 parsed, 0 warnings, 189 artifacts, 514 validations, exact successor acquired, and deep verification PASS for all source/record/blob/manifest/hydration hashes. Final case: 609,566,934 bytes and 56 files.`
- `decision`: `Reject the first isolated run after detecting concurrent source growth; implement fixed byte-boundary acquisition and rerun. Accept only the second stable-prefix case.`
- `status`: `done`

### TRACE-2026-09-04-005

- `timestamp`: `2026-09-04T13:14:55+02:00`
- `task_id`: `TASK-2026-09-04-001`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `release-candidate-validation`
- `action_type`: `verification`
- `target`: `v0.2.0 release gates`
- `evidence_result`: `release:check PASS; 17 tests passed and one Windows symlink test skipped; Node 22.23.2 and Node 24.15.0 suites PASS; skill validators PASS; npm audit reports 0 vulnerabilities; package dry-run contains 58 files. Million profile: 1,000,002/1,000,002 records in 238,643 ms at 4,190 records/s, all gates PASS.`
- `decision`: `Docker validation omitted because Docker Desktop was not running; redundant Node 22 and Node 24 native runs provide the required runtime coverage. Proceed to commit, remote CI, staged activation, and rollback smoke.`
- `status`: `done`

### TRACE-2026-09-04-006

- `timestamp`: `2026-09-04T13:21:25+02:00`
- `task_id`: `TASK-2026-09-04-001`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `tool-ledger-reconciliation`
- `action_type`: `code-and-production-shaped-rerun`
- `target`: `modern CommandExecution projections and final isolated case C:\T\afh-v020-final-real-20260904-r3\cases\01a0573f-6dfb-7071-8d35-c816f4d88027\55a635f831d9aa4d`
- `evidence_result`: `3,058/4,393 command observations matched existing wrapper executions and were enriched rather than duplicated; unmatched observations became ledger rows. Final case: 55,179/55,179 parsed, 8,528 tools, 189 artifacts, 515 validations, 0 warnings; deep integrity PASS; 614,385,105 bytes, 56 files.`
- `decision`: `Do not accept a receipt that reports zero tools when direct CommandExecution evidence exists. Reconcile by exact session/command match and retain direct observed result metadata.`
- `status`: `done`

### TRACE-2026-09-04-007

- `timestamp`: `2026-09-04T13:25:05+02:00`
- `task_id`: `TASK-2026-09-04-001`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `production-activation`
- `action_type`: `remote-publish-and-staged-global-swap`
- `target`: `origin/main, global npm package, and global Codex skill`
- `evidence_result`: `Commit f2912c2828593342484dd36c1b09b87092378c56 is on origin/main and GitHub CI passed Node 22/24. Package tree comparison was 58/58 files equal. Global CLI reports 0.2.0; doctor PASS on blocking checks; skill replacement reports REPLACED_ATOMICALLY and quick_validate PASS. A fresh global fixture case contains one reconciled completed command and passes deep integrity.`
- `decision`: `Retain the v0.1 package directory as rollback evidence. Treat the absent Claude home as a non-blocking doctor warning because Codex is the requested production target.`
- `status`: `done`

### TRACE-2026-09-04-008

- `timestamp`: `2026-09-04T15:28:04+02:00`
- `task_id`: `TASK-2026-09-04-001`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `release-maintenance`
- `action_type`: `dependency-modernization`
- `target`: `.github/workflows/ci.yml`
- `evidence_result`: `GitHub's release API reports actions/checkout v7.0.1 and actions/setup-node v7.0.0 as the latest stable releases. CI now follows the v7 major channels instead of the Node 20-based v4 channels.`
- `decision`: `Require a clean remote Node 22/24 matrix after this change before creating the immutable v0.2.0 release tag.`
- `status`: `done`

### TRACE-2026-09-04-009

- `timestamp`: `2026-09-04T16:20:50+02:00`
- `task_id`: `TASK-2026-09-04-002`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `intake`
- `action_type`: `decision`
- `target`: `hybrid lexical, semantic, and graph retrieval release after v0.2.0`
- `evidence_result`: `Repository is clean at tagged commit ac049c1093a632da9c3cc47e6bcf0faf8249ed74 on main. Existing v0.1/v0.2 cases under C:\Users\Usuario\.afh\cases remain outside the write set. Mutable semantic indexes, copies, benchmarks, tamper cases, package staging, and deployment smokes are limited to C:\T.`
- `decision`: `Keep lexical query compatibility and v0.2.0 globally active until local embeddings, hybrid quality, graph traversal, integrity, scale, packaging, remote CI, and post-deploy gates all pass. SQLite remains authoritative; semantic and graph materializations are rebuildable projections.`
- `status`: `done`

### TRACE-2026-09-04-010

- `timestamp`: `2026-09-04T16:31:00+02:00`
- `task_id`: `TASK-2026-09-04-002`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `planning`
- `action_type`: `read-and-decision`
- `target`: `local embedding model, provider runtime, vector index, schema and release plan`
- `evidence_result`: `Official package/repository metadata and isolated Windows probes established Transformers.js 4.2.0, sqlite-vec 0.1.9, node:sqlite extension loading, finite normalized 384D vectors, and explicit offline snapshot loading. A synthetic cross-language probe favored multilingual MiniLM over all-MiniLM; observed size and cold-start costs are documented in docs/vector-runtime-decision-v0.3.0.md.`
- `decision`: `Implement v0.3.0 with lexical default preserved, explicit offline-only local semantic projections, multilingual MiniLM as default, sqlite-vec sidecars, schema-v3 evidence-bearing graph edges, deterministic RRF, bounded cycle-safe traversal, and no silent fallback. Follow the gated phases in docs/improvement-plan-v0.3.0.md.`
- `status`: `done`

### TRACE-2026-09-04-011

- `timestamp`: `2026-09-04T17:55:00+02:00`
- `task_id`: `TASK-2026-09-04-002`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `execution`
- `action_type`: `edit-and-test`
- `target`: `schema v3 graph, semantic projection, hybrid retrieval, filters, receipts, CLI, doctor, documentation, and synthetic gold set`
- `evidence_result`: `Implemented evidence-bearing RESULT_OF/PRODUCED/MODIFIED/VALIDATED/SUPERSEDES/CONTRADICTS edges; local Transformers.js/sqlite-vec sidecars; exact/semantic/hybrid retrieval; explicit fallback; safe negative states; projection integrity; model status/fetch; versioned hybrid benchmark. Unit and integration tests reached 29 PASS plus one intentional Windows symlink SKIP.`
- `decision`: `Keep cold evidence and the structured ledger authoritative. Treat vectors and graph traversal as rebuildable explainable retrieval projections; never convert scores or adjacency into truth confidence.`
- `status`: `done`

### TRACE-2026-09-04-012

- `timestamp`: `2026-09-04T17:55:00+02:00`
- `task_id`: `TASK-2026-09-04-002`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `verification`
- `action_type`: `blocker-and-correction`
- `target`: `KNN relevance, semantic dependency audit, large-batch memory, and query-time integrity overhead`
- `evidence_result`: `KNN returned unrelated nearest rows until a 0.15 default similarity floor was added. npm audit initially exposed four high advisories; patched compatible overrides reduced this to zero and the real model remained functional. A 64-item long-text batch used about 4.66 GB and made unacceptable progress; its C:\T-only process was stopped before release. A full-DB plus per-row query verifier caused redundant work.`
- `decision`: `Use batch 16 plus a 16,000-character budget and progress output. Quick semantic verification relies on the complete SQLite SHA-256 plus structural/count invariants; deep mode retains every row/vector/link/index-byte check. Never silently fall back from a failed semantic projection.`
- `status`: `done`

### TRACE-2026-09-04-013

- `timestamp`: `2026-09-04T17:55:00+02:00`
- `task_id`: `TASK-2026-09-04-002`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `verification`
- `action_type`: `production-shaped-validation`
- `target`: `isolated schema-v3 reingest and full local semantic index of the original thread family`
- `evidence_result`: `57,071/57,071 records parsed from 9 sources; 8,903 tools, 189 artifacts, 526 validations and 10,234 graph edges. The 634,114,115-byte core case exposed 39 bounded child-coverage warnings. The full semantic build created 27,165 chunks and 21,832 unique embeddings in 1,751,299 ms, deduplicated 5,333 occurrences, and produced a 125,344,518-byte sidecar. Deep projection and whole-case verification passed in 21,756 ms and 27,004 ms. Warm large-case queries improved to 1.32-1.52 s after quick-verifier optimization; every selected result resolved to evidence and retained the 39 gaps.`
- `decision`: `Document the roughly 29.2-minute first-build cost as an optional preparation job, keep it off the audit/hydrate path, and retain explicit coverage gaps in every assessment.`
- `status`: `done`

### TRACE-2026-09-04-014

- `timestamp`: `2026-09-04T17:55:00+02:00`
- `task_id`: `TASK-2026-09-04-002`
- `agent_session`: `Codex`
- `project_root`: `C:\T\agent-forensic-handoff-improvement-20260904`
- `phase`: `verification`
- `action_type`: `release-candidate-verification`
- `target`: `compatibility, scale, retrieval quality, supply chain, tarball, and staged skill`
- `evidence_result`: `Three original schema-v1 cases passed v0.3 quick verification and retained identical file count, byte count, and latest timestamp. The 10,002-record median was 1,431 ms versus v0.2 1,860 ms; the million profile passed 1,000,002/1,000,002 at 6,447 records/s. Real-model gold gates were 100% exact/semantic/hybrid recall, graph and evidence resolution, with zero false absences. Node 22.23.2 and 24.15.0 passed; real Node 22 embeddings were finite 384D. release:check, both skill validators, npm audit, license inventory, package dry-run, isolated tarball smoke and staged skill smoke passed. Secret scan matched only the explicit fake token fixture.`
- `decision`: `Proceed to commit and remote CI. Do not alter global v0.2 until the exact pushed commit passes the Node 22/24 matrix.`
- `status`: `done`

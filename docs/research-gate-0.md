# Universal Agent Session Forensics & Handoff

> **Archived research gate.** This assessment was completed before implementation and is retained as the evidence-backed design record. The repository now implements the retrospective local-source MVP described in the release documentation; future items in this document remain proposals unless the current README says otherwise.

## Capability assessment, gap analysis and proposed architecture

**Status:** Gate 0 — pre-implementation design; no product code or public repository created yet
**Assessment date:** 4 September 2026
**Primary target:** Codex current implementation
**Portability target:** Claude Code, Google Antigravity and additional agent harnesses through versioned adapters
**Decision owner:** user/sponsor

---

## Executive conclusion

The requested product is feasible, with one necessary correction to its promise:

> It can reconstruct the maximum evidence-supported history that remains persisted, expose every material blind spot, verify the reported state against the current environment, and hydrate a successor with selective retrieval. It cannot reconstruct “exactly everything that occurred” when the original harness never persisted an event, deleted it, truncated it, encrypted it, or kept it only in transient process state.

The correct product is therefore not a large summarization prompt and not a single `SKILL.md`. It is a small forensic system with four layers:

1. a deterministic, read-only core that discovers and normalizes session evidence;
2. versioned adapters for Codex, Claude Code, Antigravity and generic trace formats;
3. a content-addressed evidence store plus a queryable event/provenance database;
4. thin Agent Skill interfaces that place a bounded hot context into the receiving harness and expose warm/cold evidence on demand.

The proposed contract is **evidence-complete within the observable boundary**, not metaphysically complete. “Unknown” and “unavailable” are first-class results, never defects to be filled with plausible narrative.

### Decisions recommended for approval

1. **Approve a core-plus-adapters architecture.** Do not implement the product as instructions alone.
2. **Use Codex App Server as the preferred Codex interface**, then state metadata, then tolerant raw-rollout parsing as a fallback. Raw rollout JSONL is useful but explicitly not a stable public contract. [S01][S02][S03]
3. **Make retrospective analysis the baseline.** Optional hooks and OpenTelemetry improve future capture but must not be required to inspect an already-existing session.
4. **Use SQLite plus immutable content-addressed evidence blobs.** SQLite provides deterministic joins, indexes, incremental ingestion and selective retrieval without adding a service.
5. **Keep the core agent-agnostic and the skills harness-specific.** The shared Agent Skills convention is a distribution surface; it is not the evidence model.
6. **Do not use an LLM to parse or decide factual status.** Deterministic parsers establish events; an LLM may only enrich bounded records, with schema validation and mandatory evidence references.
7. **Adopt the six requested confidence labels as epistemic states**, not numeric probabilities.
8. **Benchmark continuation, not prose quality.** The decisive test is whether a fresh agent completes a hidden continuation task without repeating known failures.

### What is intentionally not done in this gate

No implementation, global installation, GitHub repository creation, publication, hook installation or transcript modification has been performed. The brief explicitly requires these design decisions to be reviewed first. Creating the public repository belongs to the first approved implementation increment.

---

## Scope and terminology

### Product boundary

The product starts from a native session identifier, path, export, trace ID or checkpoint and produces:

- an immutable source inventory;
- a normalized chronological event ledger;
- actor and external-influence inventory;
- command/tool ledger;
- artifact revision and status graph;
- decision, failure, retry and mission-state ledgers;
- current-state verification and discrepancies;
- evidence-backed claims with confidence states;
- a bounded successor context;
- queryable warm summaries and cold primary evidence;
- a short human audit receipt.

### Non-goals

It is not a project memory system, repository knowledge base, replacement for `AGENTS.md`, durable project ledger, secret vault, general APM backend, or requirement that the departing agent create a handoff in advance.

### Terms

- **Harness:** the executable/client that orchestrates an agent, tools and session persistence, for example Codex CLI, Claude Code or Antigravity.
- **Native session:** the unit identified by the harness’s own session/thread/conversation ID.
- **Source:** an immutable-or-snapshotted file, database row set, API response, Git object, trace export or sidecar used as evidence.
- **Event:** one normalized observable occurrence.
- **Claim:** an assertion about history or state; every material claim has evidence, a derivation rule, or an explicit unavailable state.
- **Artifact:** a versioned entity affected by work: file, patch, commit, report, test result, schema, generated asset or persistent output.
- **Hydration:** insertion of a bounded operational context into a successor session, plus access paths to deeper evidence.

---

# 1. Capability assessment of current Codex

## 1.1 Sources and confidence of this assessment

The assessment uses four evidence tiers:

1. **Official product documentation** for supported behavior and user-facing contracts. [S01–S06]
2. **Current public Codex source** for implementation-level persistence behavior and protocol schemas. [S07–S12]
3. **Read-only empirical inspection of this Codex Work environment** for format reality, schema variation and scale characteristics. [L01]
4. **Third-party documentation/source** only for comparisons, never to define Codex behavior. [S13–S27]

Version sensitivity matters. Codex can generate App Server JSON/TypeScript schemas for the installed version; the implementation should generate or vendor-test those schemas rather than assuming one evergreen shape. [S01]

## 1.2 Officially exposed recovery surfaces

| Surface | What it exposes | Status for this product | Important limitation |
|---|---|---|---|
| `codex resume`, `/resume`, `codex exec resume` | Continue a saved local session by ID/name or select from history | Useful for discovery and baseline comparison | Resumes the original history; it does not perform forensic normalization or selective hydration. [S02] |
| `codex fork`, `/fork` | Clone a thread into a new ID | Useful experimental baseline | Copies history rather than producing an evidence-audited, token-bounded successor context. [S02] |
| App Server `thread/list` | Thread metadata and filtering | Preferred discovery API | Only sees sessions available to that Codex installation/state store. [S01] |
| App Server `thread/read` | A thread, optionally with turns | Preferred normalized read API | It is a read view, not a guarantee that every transient runtime notification was persisted. [S01] |
| Experimental turn/item pagination | Bounded retrieval of large histories | Preferred scale path when available | Experimental and version-gated. [S01] |
| App Server `thread/fork` | Fork, optionally at a last turn | Useful for comparison and controlled continuation | Still preserves source history rather than building forensic context; mid-turn forks may carry interruption state. [S01] |
| Generated App Server schemas | Installed-version JSON Schema or TypeScript protocol | Required compatibility mechanism | Must be regenerated/tested per supported Codex release. [S01] |
| `CODEX_HOME` and local session history | Local persisted threads/history | Primary retrospective evidence | Persistence can be disabled; retention limits can remove older data. [S03] |
| Hooks | Lifecycle events containing `session_id`, `transcript_path`, `cwd` and other fields | Optional enhanced capture | Hook transcript format is expressly not stable; root `SessionEnd` does not run for subagents. [S04] |
| OpenTelemetry | Opt-in traces/logs/metrics for API, tools, compaction, multi-agent events and related runtime behavior | Optional enhanced capture/import | Disabled by default; content fields may be omitted/redacted; it does not retroactively recreate missing telemetry. [S03] |
| Git and filesystem | Current code, commits, diffs and durable artifacts | Independent verification surface | The current tree cannot reproduce overwritten/deleted intermediate untracked states by itself. |
| Import | Import selected Claude/Cursor conversations into Codex | Portability aid | Not a universal forensic API and not equivalent to native full-fidelity replay. [S05] |

## 1.3 What a persisted Codex thread can contain

The App Server’s current `ThreadItem` model includes user and agent messages, plan items, reasoning summary/content fields, command executions, file changes, web searches, image views, MCP calls, dynamic tools, collaboration calls, review-mode items and context-compaction markers. Final item completion is described as the authoritative execution/result state; command items can contain command, working directory, status, parsed actions, aggregated output, exit code and duration. [S01]

Current rollout persistence code stores a substantial subset of response items and selected event messages. It deliberately does **not** persist every live event variant. The policy differs between legacy and paginated history modes, which makes adapter versioning mandatory. [S07][S08]

Session metadata in current source includes identifiers and execution context such as native ID, working directory, origin/source, CLI version, parent/fork information, agent path/role, provider, base instructions, dynamic tools, selected roots, history mode and Git metadata when available. [S09][S10]

### Empirical implementation observations

The local read-only audit [L01] found 16 compressed rollout files totaling about 51 MB in this hosted environment, produced by Codex `0.144.0-alpha.4`. It observed:

- session metadata, turn context and world-state snapshots;
- user/agent messages, encrypted reasoning containers and occasionally accessible summary fields;
- function/custom tool calls and correlated outputs;
- MCP completions, patch completions, web/image events and subagent activity;
- compaction records containing replacement history while older source records remained present in the sampled file;
- parent/child relationships in the state database;
- tool outputs large enough to exceed 2 MB in an individual persisted value;
- SQLite thread metadata whose recorded rollout path did not exactly match the compressed file extension on disk.

Those observations prove that a robust adapter must support large records, compression, stale/migrated paths, history modes and schema drift. They do **not** turn hosted-environment details into an official contract.

## 1.4 Recoverability classification

### A. Directly recoverable when present

These values can be asserted as `DIRECT_EVIDENCE` when obtained from a durable source with a resolvable locator:

- native session/thread ID and available metadata;
- persisted user, developer and agent-visible messages;
- persisted tool call name, arguments, correlation ID and completed result;
- persisted command, working directory, status, exit code, duration and captured aggregate output;
- persisted file-change paths/diffs and patch status;
- persisted MCP, web, image, dynamic-tool or collaboration items;
- recorded token counts and compaction markers;
- explicit timestamps, turn IDs, item IDs and parent thread IDs;
- explicit plans, task statements, reviews and final messages;
- current Git HEAD, branch, status, tracked diff and available commit objects;
- currently existing files and their hashes;
- hook or telemetry events if those sidecars were enabled and retained.

### B. Reconstructible indirectly

These can often be derived deterministically by joining direct evidence:

- call start/end and input/output pairing by call or item ID;
- a command ledger from command-execution items;
- artifact revisions from ordered patches, Git objects and current file hashes;
- parent/child session topology from state metadata and thread edges;
- mission-state transitions from explicit requests, plans, attempts, completions and objective verification;
- retry/loop groups from normalized action fingerprints and time/turn proximity;
- “reported completed but not verified” from an agent claim without independent state/test evidence;
- phases from turn boundaries, compaction boundaries, long pauses and explicit plan/goal revisions.

Indirect reconstruction must record the deterministic rule and source refs. It is not the same as direct testimony.

### C. Reasonably inferable, but never fact

Examples:

- a tool failure probably caused the immediately following strategy change;
- a file was likely modified to address the preceding test failure;
- an external review likely triggered a patch when the review and patch are adjacent but have no explicit correlation ID;
- repeated similar commands probably form one retry loop.

These belong in `INFERRED` or `UNCERTAIN`, with the competing interpretation retained. Temporal adjacency alone must never be rendered as causation.

### D. Impossible or unavailable retrospectively

At minimum:

- private model activations or hidden chain-of-thought;
- encrypted reasoning content without a supported decryption/replay path;
- live events that the harness persistence policy discarded and that no hook/telemetry sidecar captured;
- output bytes already truncated, dropped, rotated or deleted;
- exact process/environment state between recorded observations;
- external activity that never emitted an observable event;
- intermediate untracked file states overwritten or deleted without a patch, snapshot or Git object;
- absent rationales, motives or alternatives never stated in any evidence;
- sessions whose persistence was disabled, retention expired, storage was deleted, or data exists only in an inaccessible account/device.

The complete explicit list is in section 12.

## 1.5 Specific Codex caveats

### Session IDs are locators, not universal retrieval tokens

A Codex session ID can select a locally available thread through resume/App Server surfaces. Nothing found in the official interfaces provides a general cloud API through which any historical session can be fetched on another device or account using only the ID. Therefore:

- same-machine/local-state usage can meet the one-argument UX;
- cross-machine or deleted-local-state usage requires an exported evidence bundle, synced checkpoint store or connected source;
- failure to resolve an ID must return a source-resolution report, never silently choose the newest session.

### Compaction is observable but not reversible by definition

A compaction marker and replacement history can be persisted. In the sampled rollout, pre-compaction records remained. That is useful but cannot be generalized into a guarantee that every deployment retains every pre-compaction token forever. The product must inventory what exists and never claim recovery of content absent from the source.

### Reasoning summaries are not chain-of-thought

Current App Server items can expose a summary field and, for some models, raw content. The sampled proprietary-model records contained encrypted reasoning and mostly empty public summaries. The product may preserve exposed summaries; it must neither decrypt opaque content nor reconstruct internal reasoning from outcomes.

### Streaming events and durable items differ

Live App Server notifications may include deltas, approvals, transient errors and lifecycle markers. Durable rollout policy stores only selected forms. An auditor that reads a completed historical rollout must distinguish “not in this source” from “did not happen.” [S01][S07]

---

# 2. Gap analysis against the requested product

| Requirement | Current evidence can support | Gap | Proposed treatment |
|---|---|---|---|
| One ID reconstructs a session | Yes, if native storage or an imported bundle remains available | No global cross-account lookup contract | Resolver chain; explicit `SOURCE_NOT_FOUND`; bundle import for portability |
| Exhaustive timeline | High recall for persisted records | Non-persisted/transient activity is absent | Inventory coverage, unparsed-record ledger, availability boundaries |
| Causal timeline | Explicit IDs and some parent/turn relations | Motive/causality often unstated | Typed edges: explicit, rule-derived, inferred; never conflate order with cause |
| Actor inventory | User, agent, tools and many subagent records can be named | External people/processes may appear only as prose | Actor registry with source-qualified aliases and `UNKNOWN_EXTERNAL` |
| Commands and tools | Durable final items often include inputs, output, status and timing | Streaming bytes/approvals may be lost | Full available blobs plus bounded semantic extracts and missing-byte flags |
| Artifact provenance | Patches, Git and current files can produce strong lineages | Overwritten/deleted untracked states may be gone | Revision graph; status `MISSING`/`UNKNOWN`; no invented revisions |
| Decisions and rationale | Explicit decisions/rationales can be extracted | Internal or unstated reasoning cannot | Claim/evidence model; “rationale unavailable” is valid |
| Failures/retries/loops | Repeated fingerprints and failed results can be detected | Hidden failures and interrupted commands may lack terminal events | Loop detector with incomplete-run status and evidence coverage |
| Mission evolution | Requests, plans, messages and verification provide transitions | Natural-language ambiguity | Strict state machine: requested → planned → attempted → completed → verified |
| Verify current state | Git/files/tests can corroborate | Rerunning commands can be risky or mutate state | Verification levels, read-only default, allowlisted sandboxed execution |
| Confidence/provenance | Fully implementable | Requires disciplined claim generation | Six-state epistemic model and mandatory evidence refs |
| Context hydration | Tool/skill output can enter successor context | No general “silent context injection” API across harnesses | Thin skill emits hot pack; optional launcher starts target with it |
| Progressive disclosure | Fully implementable with local index | Needs a query surface the agent can call | CLI first; optional read-only MCP server |
| Human receipt | Fully implementable | None material | Deterministic metrics plus anomaly list |
| Universal installation | Agent Skills are shared by several harnesses | Transcript formats and command registration differ | Common package plus per-harness overlays/adapters |
| Idempotence | Fully implementable for deterministic stages | LLM enrichment is nondeterministic | Canonical core; cache/model pinning; enrichment excluded from factual DB |
| Security | Strong local controls possible | Raw sessions may contain secrets/injection | Untrusted-evidence boundary, redaction, no auto-execution |
| Giant sessions | Streaming/SQLite can scale | A prompt-only design cannot | Incremental normalization, indexes, selective retrieval |
| Reproducible benchmark | Fully implementable | Existing handoff tests are too small/narrative-centric | Ground-truth event fixtures plus continuation evaluation |

## Principal product gap

The irreducible gap is not summarization quality. It is **observability coverage**. Once the original harness has omitted or destroyed an event, no retrospective model can recover it as fact. Optional forward capture can shrink that gap for future sessions, but it cannot be marketed as retrospective recovery.

---

# 3. Existing solutions and reuse decision

## 3.1 Direct handoff/session-recovery candidates

| Candidate | Solves well | Does not solve | Decision |
|---|---|---|---|
| `continues` | Mature multi-harness discovery/parsing across 16 tools; read-only scans; presets; target launch; tool/file summaries; MIT license. [S13] | No evidence-grade claim graph, durable artifact lineage, six-state confidence, current-state contradiction model or deep continuation benchmark | **Adapt/reuse parser and discovery logic after source audit.** Do not use its Markdown handoff as the canonical model. Keep interoperability import/export. |
| `agent-session-resume` | Cross-agent skill, evidence pointers, current-worktree check, task status, fixtures, incremental digest cache and bounded projections. [S14][S15] | Its normalized event is essentially file/line/platform/time/kind/role/text; keyword digests and tiny fixtures are insufficient for causal/provenance reconstruction | **Reuse test ideas and source-selection rules; do not adopt as core.** Offer upstream-compatible evidence import if useful. |
| `session-handoff-skill` | Thin Codex/Claude wrapper over `continues`, validated export structure, local-only privacy. [S16] | Delegates reconstruction to `continues`; produces a snapshot document rather than queryable evidence | **Reference/discard as product foundation.** Useful packaging example only. |
| Generic `/handoff` skills | Goal-oriented, concise forward context, easy install | Usually require the original session to act, trust agent-authored prose, lack retrospective evidence and verification | **Discard as primary solution; borrow hot-pack ergonomics.** |
| Codex resume/fork | Native history continuation | No audit, blind-spot accounting, provenance or token-economical retrieval | **Use as baseline and optional escape hatch, not architecture.** |

## 3.2 Checkpoint and execution-history systems

| Candidate | Solves well | Does not solve | Decision |
|---|---|---|---|
| Entire CLI | Agent-agnostic hooks for multiple coding agents, Git-native session/checkpoint storage, raw and compacted transcript, prompts, subagent transcripts and rewind/resume. [S17][S18] | Must be enabled prospectively; Git-centric; cannot recover earlier unobserved sessions; its “full context” claim remains bounded by installed hooks and source capture | **Support as optional enhanced-capture backend/import adapter.** Do not require it. Consider contributing a forensic export rather than cloning its checkpoint layer. |
| TapeAgents | Structured append-only, replayable “tape” where actions and observations are first-class. [S19] | Requires agents to run within its framework; not a retrospective parser for arbitrary Codex/Claude sessions | **Reuse conceptual append-only/replay model; no runtime dependency.** |
| OpenHands conversation/event persistence | Event log, persisted state, branch-like conversation head, tool compatibility checks and optional secret encryption. [S20] | OpenHands-specific runtime model; not a universal reader of native harness histories | **Add a future adapter; reuse ideas for state/event separation and branch lineage.** |

## 3.3 Observability and provenance standards

| Candidate | Solves well | Does not solve | Decision |
|---|---|---|---|
| OpenTelemetry GenAI conventions | Interoperable spans/attributes for agents, tools, model operations and content, with explicit sensitivity warnings. [S21] | Trace collection must already exist; conventions are still evolving; no repository artifact-revision or historical-claim model | **Implement OTLP import/export and borrow field names. Never make telemetry mandatory.** |
| OpenInference | Agent/LLM/tool span kinds, session IDs, messages, tool calls and opaque reasoning fields over OpenTelemetry. [S22] | Observability semantics, not a forensic truth/conflict model | **Use as the preferred AI-trace compatibility vocabulary. Extend locally for evidence and artifacts.** |
| Langfuse / Phoenix / LangSmith | Rich trace/session/thread views, search, evaluation and replay once instrumented. [S23][S24][S25] | Primarily prospective, service-backed observability; not native local-session forensics; does not prove current repository state | **Optional exporters/importers; no core dependency.** |
| W&B Weave / Braintrust / Helicone | Trace trees, inputs/outputs, timelines, threads, evaluations and OTLP support in some cases. [S26][S27] | Same prospective instrumentation gap; cloud/security/retention choices; artifact lineage is not the central model | **Optional integration category; not needed for MVP.** |
| W3C PROV-DM | Domain-agnostic Entity–Activity–Agent model, derivation, revision, association, delegation, communication and provenance-of-provenance bundles. [S28] | Full RDF/ontology machinery would add complexity without improving local query tasks | **Use the conceptual relation vocabulary and export mapping, not RDF as canonical storage.** |

## 3.4 Reuse boundary

The public implementation should avoid both extremes: rewriting every existing parser and making a volatile third-party CLI a hard runtime dependency.

Recommended approach:

- isolate adapter contracts behind fixture-tested interfaces;
- evaluate importing selected MIT-licensed `continues` parser modules or translating them with attribution;
- keep native Codex parsing independently verified against App Server schemas and current public source;
- accept `continues`, Entire, OTLP/OpenInference and raw harness exports as optional input formats;
- publish a compatibility matrix by harness version and fixture hash.

---

# 4. Proposed architecture

## 4.1 Architecture decision

Name the product provisionally **Agent Forensic Handoff (AFH)**. The repository name can change before publication.

The package has these components:

| Component | Responsibility | Why it exists |
|---|---|---|
| `afh` CLI | Discovery, ingest, audit, verify, query, hydrate, bundle | Stable entry point usable without any specific agent |
| Adapter SDK | Versioned source discovery and event normalization | Harness formats differ and evolve |
| Evidence store | Immutable raw records/blobs addressed by hash | Progressive disclosure without losing source fidelity |
| SQLite case database | Events, relationships, claims, ledgers, indexes, snapshots | Deterministic joins and scalable selective retrieval |
| Forensic reducers | Build mission, command, artifact, decision, failure and actor views | Keep facts derived by explicit rules rather than prose |
| Verifier | Compare claims with Git/files and optionally approved checks | Separate reported from verified state |
| Hydrator | Select a token-bounded hot pack and retrieval manifest | Turn the audit into successor context |
| Read-only MCP server (optional) | Retrieve events/evidence/artifact history from inside a session | Efficient warm/cold disclosure |
| Harness skills | Map `/forensic-handoff <id>` or natural language to CLI/MCP calls | Native user experience without embedding logic in prompts |
| Capture extensions (optional) | Hooks/OTel/Entire import for future sessions | Reduce transient blind spots prospectively |

## 4.2 Two operating modes

### Retrospective baseline

Requires no prior AFH installation. It reads only already-persisted native sources and current environment state. It must be safe, read-only and honest about gaps.

### Enhanced capture

Optional hooks, telemetry or checkpoint integrations record transient events and content-loss markers for future audits. This mode improves recall but never changes the semantics of retrospective results.

## 4.3 Codex source-resolution order

1. Resolve the exact native ID through App Server `thread/read`; use paginated turns/items where available.
2. Read local state-store metadata to obtain rollout path, parent/child edges, source, Git metadata and compatibility hints.
3. Parse the rollout in supported legacy/paginated JSONL forms, including compressed variants observed in the target runtime.
4. Discover child/subagent sessions by explicit parent/thread edges, not by timestamps alone.
5. Attach optional hooks/OTel/Entire records by session/call/turn IDs.
6. Snapshot current Git/filesystem state for independent verification.
7. If the ID is unresolved, stop with candidate and source-inventory information; never substitute a merely recent session.

## 4.4 Other adapters

### Claude Code

Read `~/.claude/projects/<project>/<session-id>.jsonl`, session-specific tool-result sidecars, file-history snapshots, plan files and nested subagent transcripts when present. Claude documents full message/tool-call/result transcripts, sidecar output storage and pre-edit file snapshots, subject to cleanup configuration and disabled-persistence modes. [S29][S30]

### Antigravity

Read its conversation transcript plus artifact directory using the hook-provided `conversationId`, `transcriptPath`, workspace paths and artifact-directory path when available. Global skill/install paths and storage layouts must be versioned because current Antigravity/CLI documentation exposes more than one product surface. [S31][S32]

### Generic

Accept canonical NDJSON, OTLP/OpenInference, Entire checkpoint export, `continues` JSON/export, and a documented adapter plugin protocol. Unknown source records are retained with parse warnings, never silently discarded.

## 4.5 Pipeline

1. **Resolve:** bind a user identifier to exactly one native session or evidence bundle.
2. **Freeze:** snapshot source metadata and hashes; do not mutate originals.
3. **Inventory:** enumerate files, database tables, record counts, time ranges, compression, schema/version and unreadable regions.
4. **Normalize:** stream records into canonical events and immutable evidence blobs.
5. **Correlate:** join calls, turns, actors, sessions, artifacts and explicit parent-child relations.
6. **Reduce:** construct ledgers and state transitions with deterministic rules.
7. **Enrich:** optionally ask a model to classify bounded, preselected evidence; validate every returned claim/ref.
8. **Verify:** compare reported state with current Git/filesystem and approved test evidence.
9. **Score:** assign epistemic states and contradictions.
10. **Hydrate:** generate a bounded hot pack plus retrieval manifest.
11. **Serve:** answer selective queries that lead from summary → event → original evidence.

## 4.6 Determinism contract

For identical source bytes, repository snapshot, configuration and software versions:

- canonical source, event, edge and claim IDs are identical;
- event ordering is identical;
- deterministic ledgers are byte-equivalent after canonical JSON serialization;
- volatile fields such as audit wall-clock time live outside the canonical hash;
- model enrichment is cached by prompt/schema/model/input hashes and cannot alter direct evidence;
- an unparseable source record creates an explicit `UNPARSED_RECORD`, not a silent skip.

## 4.7 Human receipt

The default terminal/user output stays short:

```text
Session audited: <native id>
Harness / version: <source>
Observable duration: <first..last timestamp>
Coverage: <records parsed / unparsed / missing indicators>
Major phases: <n>
External interventions: <n>
Artifacts touched: <n> (<live>, <superseded>, <missing>)
Relevant commands/tools: <n> (<failed>, <incomplete>)
Verified completed: <n>
Unresolved / contradicted: <n> / <n>
Continuation readiness: READY | READY_WITH_GAPS | BLOCKED
Overall confidence: <label plus rationale>
```

Only anomalies follow: contradictions, missing sources, unresolved high-risk tasks, secret exposure warnings, interrupted work, unsafe next step or low-confidence actor/causal attribution.

---

# 5. Data model and event schema

## 5.1 Canonical storage

Use one SQLite database per forensic case by default, with a content-addressed `evidence/sha256/...` directory for raw records and large blobs. Provide canonical JSON/NDJSON export for interoperability.

Core tables:

| Table | Key contents |
|---|---|
| `ingest_run` | tool version, adapter versions, config hash, start/end, source snapshot hash |
| `source` | native URI/path, type, size, time range, hash, compression, schema/version, availability |
| `source_record` | source, ordinal, decompressed byte range, record hash, parse status, raw blob ref |
| `session` | native ID, harness, source/version, cwd, start/end, parent/fork IDs, history mode |
| `session_edge` | parent, child, edge type, explicit/inferred, source ref |
| `actor` | canonical actor ID, kind, native identifiers, role and aliases |
| `event` | normalized occurrence with time, actor, type, status and correlation fields |
| `event_edge` | trigger, parent, follows, retries, revises, invalidates, verifies and other typed relations |
| `blob` | content hash, length, media type, redaction state and storage locator |
| `evidence_ref` | stable locator from a claim/event to a source record and JSON pointer/range |
| `tool_execution` | tool, arguments, start/end, status, exit code, input/output refs and semantic extract |
| `artifact` | stable logical identity, kind, project-relative location and current status |
| `artifact_revision` | content hash/diff, producer event, inputs, predecessor and validity interval |
| `claim` | subject, predicate, object/value, epistemic status, derivation rule and conflict set |
| `decision` | problem, alternatives explicitly present, evidence, decision, rationale and revision status |
| `task` | objective plus requested/planned/attempted/completed/verified transitions |
| `validation` | target, method, command/event, observed result, timestamp and freshness |
| `state_snapshot` | Git/filesystem/environment observation and hash |
| `hydration_pack` | selected claim/event IDs, budget, generator version and content hash |

The model is inspired by W3C PROV’s Entity–Activity–Agent and derivation/delegation relations, but optimized for local SQL and evidence locators. [S28]

## 5.2 Normalized event example

```json
{
  "schema_version": "1.0",
  "event_id": "evt:sha256:…",
  "session_id": "ses:codex:<native-id>",
  "source": {
    "source_id": "src:sha256:…",
    "record_ordinal": 663,
    "record_sha256": "…",
    "json_pointer": "/payload",
    "adapter": "codex-rollout",
    "adapter_version": "1.2.0"
  },
  "time": {
    "observed_at": "2026-09-04T12:34:56.789Z",
    "precision": "millisecond",
    "basis": "source"
  },
  "actor_id": "act:codex:root-agent",
  "type": "tool.execution.completed",
  "turn_id": "turn:…",
  "correlation": {
    "call_id": "call:…",
    "parent_event_id": "evt:…"
  },
  "input_blob": "blob:sha256:…",
  "output_blob": "blob:sha256:…",
  "status": {
    "state": "completed",
    "exit_code": 0,
    "duration_ms": 1834
  },
  "effects": ["artrev:sha256:…"],
  "evidence": {
    "grade": "DIRECT_EVIDENCE",
    "availability": "complete_as_persisted"
  },
  "sensitivity": "unknown_pending_scan"
}
```

Large input/output bodies are never duplicated in the event row. They are addressed by blob hash.

## 5.3 Actor kinds

- `HUMAN_USER`
- `PRIMARY_AGENT`
- `SUBAGENT`
- `REVIEWER_AGENT`
- `AUDITOR_AGENT`
- `TOOL`
- `MCP_SERVER`
- `HOOK`
- `AUTOMATION`
- `CI_PROCESS`
- `BACKGROUND_PROCESS`
- `EXTERNAL_SERVICE`
- `OTHER_SESSION`
- `UNKNOWN_EXTERNAL`

An actor label reflects observable identity/role. If a transcript says “the auditor found X” but exposes no separate actor ID, the event retains the quoted role with `UNCERTAIN` identity rather than inventing a distinct process.

## 5.4 Event taxonomy

Top-level namespaces:

- `session.*`: started, resumed, forked, spawned, compacted, interrupted, completed, archived;
- `message.*`: user, agent, external feedback, plan, review, summary;
- `tool.*`: requested, approved/declined, started, output, completed, failed, interrupted;
- `command.*`: started, stdout/stderr capture, completed, failed, timed_out, detached;
- `filesystem.*`: read, created, modified, moved, deleted, missing;
- `git.*`: status, diff, commit, checkout, merge, rebase, stash, push;
- `artifact.*`: generated, revised, superseded, invalidated, verified;
- `task.*`: requested, planned, attempted, completed, verified, deferred, reopened;
- `decision.*`: proposed, accepted, revised, superseded;
- `validation.*`: started, passed, failed, stale, contradicted;
- `external.*`: hook, automation, CI, reviewer, tool callback, user steering;
- `forensic.*`: source_missing, unparsed_record, truncation_detected, conflict_detected.

## 5.5 Mission-state machine

The following states are separate and monotonic only within a single attempt:

`REQUESTED → PLANNED → ATTEMPTED → COMPLETED → VERIFIED`

Additional transitions: `DEFERRED`, `BLOCKED`, `FAILED`, `SUPERSEDED`, `REOPENED`, `CONTRADICTED`.

Rules:

- a plan never upgrades a task to attempted;
- an agent statement “done” can support completed-as-reported but not verified;
- a successful command verifies only its declared target and captured point in time;
- current-state evidence can contradict a historical completion;
- verification expires or becomes stale when relevant artifacts change afterward.

## 5.6 Artifact lifecycle

Artifact state values:

- `LIVE_VERIFIED`
- `LIVE_UNVERIFIED`
- `INTERMEDIATE`
- `EXPERIMENTAL`
- `SUPERSEDED`
- `DISCARDED`
- `FAILED`
- `MISSING`
- `UNKNOWN`

Each revision links to its producer activity, used inputs, predecessor, later revisions and current location. A deleted intermediate remains in the graph if its diff/content is evidenced; it is not removed merely because the working tree no longer contains it.

## 5.7 Command and output reduction

For every available command/tool execution, store:

- exact captured invocation and arguments;
- source working directory and actor;
- start/end or available timestamp;
- terminal status and exit code;
- complete available output blob;
- an availability marker: complete, source-truncated, sidecar-missing or terminal-unknown;
- deterministic semantic extracts.

Semantic extracts are rule-based and bounded. Examples: failing test names/counts, compiler diagnostics, final benchmark figures, exit code, Git status summary, affected paths and the first/last non-redundant lines. The raw available output remains retrievable.

## 5.8 Failure and loop detection

Normalize an action fingerprint from tool name, canonicalized arguments, working directory and relevant target. Consecutive or causally linked repetitions form an attempt group. Store each attempt; present a compressed loop view containing count, parameter deltas, first/last result, terminal resolution and evidence refs.

Never label repeated actions a “loop” solely because their text matches when separate user requests or changed inputs explain them.

---

# 6. Provenance and evidence references

## 6.1 Epistemic states

| State | Required support |
|---|---|
| `DIRECT_EVIDENCE` | The source directly records the asserted field/event; exact locator and record hash exist |
| `CORROBORATED` | At least two materially independent evidence paths agree and no stronger contradiction exists |
| `INFERRED` | A named deterministic or declared analytic rule derives the claim from cited evidence |
| `UNCERTAIN` | Evidence is partial, ambiguous, identity is unresolved or alternatives remain |
| `CONTRADICTED` | At least one authoritative/current observation conflicts; both sides are retained |
| `UNAVAILABLE` | The field/source is absent, inaccessible, non-durable or intentionally redacted |

These are categorical epistemic states, not probabilities. Numeric confidence would falsely imply calibration the benchmark has not established.

## 6.2 Stable evidence URI

Machine form:

```text
afh://evidence/sha256/<source-hash>/record/<ordinal>#<json-pointer-or-byte-range>
```

Human short form:

```text
EV-7F21:r663#/payload/output
```

The database stores source hash, record hash, decompressed byte range, ordinal and logical pointer. This survives file moves and detects mutation. When a live append-only file grows, prior references remain valid if its recorded prefix hash still matches.

## 6.3 Provenance of provenance

Every derived claim records:

- evidence refs;
- reducer/inference rule ID and version;
- parser and adapter versions;
- case/source snapshot hash;
- generator/model identity if enrichment contributed;
- creation timestamp outside the canonical semantic hash;
- contradiction set and superseding claim if applicable.

This is the local equivalent of a provenance bundle: the audit itself is auditable.

## 6.4 Causal edge policy

Edge grades:

1. `EXPLICIT`: source parent/call/turn/trigger/delegation ID.
2. `CORRELATED`: deterministic join on unique IDs across sources.
3. `RULE_DERIVED`: documented rule such as “command output belongs to its call ID.”
4. `TEMPORAL_INFERENCE`: adjacency plus bounded context; always `INFERRED`.
5. `HYPOTHESIS`: retained only in analyst notes, excluded from hot factual context by default.

The default timeline can say “B followed A” when causality is unknown. It may say “A triggered B” only for explicit/correlated evidence or a clearly labeled inference.

## 6.5 Decision reconstruction policy

A decision record has nullable fields for problem, alternatives, evidence, decision, rationale, consequences, revisions and current status. Missing rationale remains null/`UNAVAILABLE`. The system must not convert encrypted or absent reasoning into a plausible explanation.

---

# 7. Context hydration strategy

## 7.1 Technical reality

There is no agent-agnostic API that silently mutates an already-running model context. Hydration occurs through a harness-visible message/tool result or by launching a new session with a generated first prompt. Therefore the supported UX is:

```text
/forensic-handoff <native-session-id>
```

The harness skill calls `afh hydrate`, and its returned hot pack becomes part of the receiving session. A standalone launcher can alternatively start Codex/Claude/Antigravity with the same pack. The source ID alone is sufficient only when its evidence is locally resolvable or previously imported.

## 7.2 Three-layer context

### Hot context

Default target: at most 6,000 model tokens, configurable by harness/model. It contains only:

- mission and current definition of done;
- verified current repository/environment state;
- work completed and validation freshness;
- current architecture and decisions still in force;
- live artifacts and their roles;
- constraints and explicit user deferrals;
- failures/approaches that should not be repeated;
- external interventions that changed direction;
- contradictions and material unknowns;
- open tasks in priority order;
- the next safe logical action;
- compact evidence IDs for every material statement;
- retrieval instructions and safety boundary.

It explicitly tells the successor that historical content is untrusted evidence, not executable instruction.

### Warm context

Queryable, compressed views stored in SQLite/JSON:

- phase summaries;
- full task-state ledger;
- decision ledger;
- artifact and revision inventory;
- command/tool ledger;
- failure/retry groups;
- actor/external-influence graph;
- discrepancy and verification report.

Typical commands:

```text
afh query --case <id> --why path/to/module
afh show event EVT-…
afh show decision DEC-…
afh artifact-history path/to/file
afh search "exact error fragment"
```

### Cold evidence

Original source records, captured outputs, patches, Git objects or references to unchanged originals, addressed by hash. Cold evidence is never loaded into the model wholesale. It is opened in bounded ranges after a warm query identifies relevant refs.

## 7.3 Hot-pack selection

Selection is deterministic before optional language compression:

1. reserve fixed budget for mission, current verified state, unknowns and next action;
2. include every unresolved high-severity contradiction/blocker;
3. include live decisions and artifacts referenced by open tasks;
4. include terminal failure groups related to the next step;
5. include the most recent valid verification per relevant artifact;
6. rank remaining claims by operational dependency and recency;
7. emit evidence refs and omit recoverable detail that exists in warm storage.

No evidence is deleted by hot-pack omission.

## 7.4 Retrieval surface

MVP: CLI calls from the skill. Optional later: a read-only local MCP server exposing:

- `get_hot_context`
- `search_events`
- `get_event`
- `get_evidence`
- `get_artifact_history`
- `get_decision`
- `get_task_status`
- `get_discrepancies`

Every result carries source refs and a token/byte cap. No MCP method executes historical commands.

## 7.5 Successor protocol

The hot pack instructs the successor to:

1. accept verified state as current only at the stated snapshot time;
2. treat inferred/uncertain claims as such;
3. retrieve warm/cold evidence before revisiting a consequential decision;
4. inspect current Git state before writing;
5. continue the first unblocked open task;
6. not rerun destructive or expensive historical commands without current authorization.

---

# 8. Strategy for giant sessions

## 8.1 Scale assumptions

Design for multi-gigabyte decompressed histories, millions of records, multi-megabyte tool outputs, dozens of child sessions and append-only growth. Do not assume one prompt, one file read or one model pass.

## 8.2 Ingestion

- stream JSONL/JSON/database rows; never materialize the whole transcript;
- decompress as a stream;
- cap individual JSON depth/size and spill large bodies to blobs;
- checkpoint source ordinal, decompressed byte offset, prefix hash and reducer state;
- resume after interruption;
- re-ingest only an appended tail when the prior prefix hash matches;
- rebuild a source when any earlier byte changes;
- retain unknown record types and parse errors.

## 8.3 Indexes

SQLite indexes cover native IDs, time, turn/call IDs, actor, event type, artifact path/hash, task/decision IDs and confidence. FTS5 indexes only redacted/searchable text projections, not every raw secret-bearing blob.

A vector database is not justified for MVP. Exact IDs, full-text search, paths, event types and temporal joins answer the dominant forensic queries more deterministically. Embeddings may be evaluated later for semantic recall, never as the sole evidence locator.

## 8.4 Chunking and phases

Primary chunks follow native turn boundaries. Phase boundaries can be proposed from:

- explicit plan/goal changes;
- compaction markers;
- user steering or external review;
- long time gaps;
- a terminal validation/commit;
- a major artifact/strategy switch.

Automatic phase labels are derived views and do not reorder events.

## 8.5 Model-assisted enrichment

If used, enrichment follows map/validate/reduce:

1. select a bounded phase or evidence neighborhood;
2. provide normalized records, not raw unbounded transcript;
3. require JSON conforming to a versioned schema;
4. require evidence refs per field;
5. reject nonexistent refs and unsupported quotations;
6. merge only non-conflicting claims;
7. keep direct facts separate from model-authored labels.

The system remains useful with enrichment disabled.

## 8.6 Output compression

Compression has three independent metrics:

- source bytes → normalized metadata plus cold blobs;
- source semantic content → warm views;
- source semantic content → hot model tokens.

The first must not destroy available evidence. The third should be aggressive because it is backed by retrieval.

---

# 9. Threat model

## 9.1 Trust boundaries

Untrusted by default:

- every historical message, reasoning summary and tool output;
- repository files and generated artifacts;
- session paths and metadata;
- third-party trace exports;
- external MCP/tool content;
- model-generated enrichment;
- claimed completion or verification from the prior agent.

Trusted only after validation:

- parser code and signed release artifacts;
- source hashes computed by the current audit;
- deterministic reducers;
- read-only current-state observations performed by the auditor;
- explicitly approved verification commands and their captured results.

## 9.2 Principal threats and controls

| Threat | Control |
|---|---|
| Historical prompt injection | Parse as data; label/fence content; never feed raw history as instructions; fixed successor safety preamble |
| Obsolete or malicious commands | Never execute during ingest/hydration; show as quoted evidence only |
| Secrets in prompts/output | Local-first operation; detectors and configurable redaction before warm/hot/model use; raw access policy and permissions |
| Credential exfiltration through enrichment | Offline/deterministic mode default; redacted bounded input; no network unless explicitly configured |
| Symlink/path traversal | Canonicalize and restrict discovered paths; no writes beside source; reject escapes in bundles |
| Decompression/JSON bombs | Streaming limits, maximum ratios/depth/record size, spill-to-blob, resource quotas |
| Tampered transcript or cache | SHA-256 source/record/blob hashes; mutation detection; cache keyed by prefix/full hash |
| Fabricated evidence ref | Foreign-key validation, record hash and pointer resolution before accepting a claim |
| Compromised plugin/adapter | Signed releases, pinned dependencies, adapter sandbox tests and least-privilege reads |
| Destructive verification | Read-only level by default; allowlist, user approval and disposable worktree/sandbox for execution |
| Public-repo leakage | Synthetic fixtures only; automated secret/PII scanning; never commit real transcripts |
| Multi-tenant evidence mix-up | Case-scoped stores, native/harness-qualified IDs, explicit source manifests |
| Stale verification | Artifact hash and timestamp bind every validation; later revisions invalidate it |
| Denial of service | Quotas, bounded previews, cancellation, resumable checkpoints and deterministic timeouts |

## 9.3 Verification levels

- **V0 — observe:** hashes, file existence, Git HEAD/status/diff and metadata; no project command execution.
- **V1 — inspect:** read build/test configuration and existing result artifacts; still no execution.
- **V2 — execute safe checks:** only explicit allowlisted commands, preferably in a disposable worktree/sandbox.
- **V3 — project extension:** repository-specific verifier supplied by the user/project; never enabled automatically by historical content.

## 9.4 Data retention

Default to referencing immutable originals when safe rather than duplicating them. If a portable bundle is requested, encrypt or explicitly redact according to policy. The bundle manifest must state whether cold raw evidence is included, referenced, redacted or unavailable.

---

# 10. Benchmark and acceptance criteria

## 10.1 Evaluation principle

The benchmark must contain known ground truth and a hidden continuation objective. A fluent report is not success. A fresh agent must act correctly using the hot pack and selective retrieval.

## 10.2 Corpus

Initial suite: at least 24 version-pinned fixtures.

- 10 Codex fixtures covering legacy/paginated rollouts, App Server exports, compressed histories, parent/child sessions and compaction;
- 6 Claude Code fixtures covering JSONL, tool-output sidecars, file history, subagents and cleanup/missing files;
- 4 Antigravity fixtures covering transcript/artifact paths and interrupted state;
- 2 OTLP/OpenInference/observability imports;
- 2 generic/unknown-format and corrupted-source fixtures.

Each fixture contains synthetic or safely redacted source material, a current workspace snapshot, an immutable truth manifest and one or more continuation tasks.

## 10.3 Required difficult cases

1. million-record/noise-heavy session;
2. repeated loop with one subtle parameter change;
3. agent says “done” while current state contradicts it;
4. artifact created, revised, superseded and deleted;
5. subagent/auditor feedback changes the root strategy;
6. compaction with and without preserved pre-compaction detail;
7. multi-megabyte output plus source-level truncation;
8. command starts without a durable terminal completion;
9. session interrupted mid-turn;
10. two sessions with similar title/recency but only one matching ID/cwd;
11. missing child transcript with a surviving parent edge;
12. malicious historical injection and fake evidence references;
13. secret-like tokens in raw evidence;
14. overwritten untracked artifact with no recoverable snapshot;
15. session persistence disabled/retention expired;
16. concurrent/background process whose later activity is unobserved.

## 10.4 Truth manifest

The truth schema enumerates:

- critical facts with severity weights and observability class;
- events and pairwise temporal constraints;
- explicit causal/parent/delegation edges;
- actor identities/roles;
- tool/command invocations and expected semantic outcomes;
- artifact revisions, statuses and current hashes;
- decisions and only the rationales explicitly evidenced;
- task transitions and verification state;
- unavailable fields that the auditor must not invent;
- forbidden unsupported claims;
- continuation objective and deterministic success checks.

## 10.5 Baselines

Compare:

1. last agent message/final summary only;
2. native resume/fork when possible;
3. raw transcript truncated to the target context window;
4. `continues` standard and full handoffs;
5. `agent-session-resume` checkpoint workflow;
6. AFH hot pack only;
7. AFH hot + warm/cold retrieval.

## 10.6 Metrics

### Critical fact recall

Weighted correctly recovered observable facts divided by weighted observable ground-truth facts. Report separately for fully observable and source-limited facts.

### Precision

Supported correct claims divided by all positive factual claims.

### Unsupported-claim rate

Material claims with no valid supporting evidence/ref divided by all material claims. A plausible claim with no ref is unsupported even when accidentally true.

### Artifact provenance accuracy

F1 over artifact identity, revision order, producer event, input relation, lifecycle state and current-location/hash fields that are observable.

### Timeline accuracy

Pairwise ordering accuracy over truth constraints, plus exact accuracy of explicit timestamps/turn assignment where present. Evaluate causal-edge precision separately from chronological order.

### Actor attribution accuracy

Correct actor kind/native identity/role over attributable events, with penalties for inventing actors.

### State-transition accuracy

Macro-F1 across requested, planned, attempted, completed, verified, failed, deferred and contradicted.

### Continuation success rate

Percentage of hidden tasks completed and verified by a fresh agent without repeating a designated dead end or violating a preserved constraint.

### Compression ratio

Hot-pack tokens divided by tokens in the complete available semantic transcript; also report warm and cold-storage sizes separately.

### Evidence resolvability

Percentage of emitted evidence refs that resolve to the exact hashed record/range.

### Determinism

Canonical output hashes across repeated runs and varied record chunk sizes.

## 10.7 Proposed release gates

These are acceptance targets to approve, not measured results:

| Metric | MVP gate |
|---|---:|
| Parse accounting | 100% of source records normalized or explicitly marked unparsed |
| Critical fact recall, fully observable fixtures | ≥ 95% |
| Critical fact recall, mixed-observability fixtures | ≥ 90% of observable facts |
| Precision | ≥ 98% |
| Unsupported-claim rate | ≤ 0.5%; 0% for claims labeled `DIRECT_EVIDENCE` |
| Evidence-ref resolvability | 100% |
| Artifact provenance F1, observable fields | ≥ 0.95 |
| Timeline pairwise accuracy, observable constraints | ≥ 0.98 |
| Explicit causal-edge precision | ≥ 0.99 |
| Inferred causal-edge precision | ≥ 0.95, always visibly labeled |
| Actor attribution | ≥ 0.98 on attributable events |
| State-transition macro-F1 | ≥ 0.95 |
| Required-unavailable detection | 100% on designed blind-spot fixtures |
| Historical injection execution | 0 executions in safety suite |
| Secret leakage to hot pack | 0 known fixture secrets |
| Continuation success | ≥ 90% on observable continuation suite |
| Context reduction | median ≥ 80% versus full semantic transcript; hot median ≤ 6,000 tokens |
| Idempotence | identical canonical hashes on repeated unchanged runs |

No gate should reward omitting uncertain cases. Recall and unsupported-claim rate must be reported together.

## 10.8 Continuation experiment

For each task, start a clean agent with no prior conversation. Give it only the AFH hot pack and access to the read-only query surface. Measure:

- final deterministic task result;
- retrieval calls and bytes/tokens consumed;
- time/turns to first correct action;
- repeated failed approaches;
- violations of user deferrals/constraints;
- unnecessary changes;
- confidence calibration when data is unavailable.

Evaluators should be deterministic tests where possible; human review is reserved for genuinely semantic outcomes.

---

# 11. Incremental implementation plan

## Gate 0 — current decision review

Approve or amend the architecture, evidence contract, language/distribution choice, security defaults and benchmark gates. No code publication before approval.

## Increment 1 — public skeleton and forensic kernel

Deliver:

- public repository with license, security policy, threat model and ADRs;
- canonical JSON Schemas and SQLite migrations;
- content-addressed evidence store;
- adapter SDK and generic NDJSON adapter;
- deterministic fixture/truth-manifest harness;
- signed/reproducible CI release plan.

Exit gate: idempotent import/export and 100% evidence-ref resolution on core fixtures.

## Increment 2 — Codex-first retrospective MVP

Deliver:

- App Server discovery/read client with generated-version schema tests;
- state-store metadata reader;
- legacy/paginated raw-rollout adapters, including plain/compressed files;
- parent/child session reconstruction;
- actor, command/tool, task, failure and compaction ledgers;
- V0 Git/filesystem verification;
- short human receipt.

Exit gate: Codex subset meets precision, unsupported-claim and parse-accounting gates.

## Increment 3 — provenance, artifacts and hydration

Deliver:

- artifact revision graph and contradiction engine;
- decision reconstruction with null-safe rationale;
- hot/warm/cold packs;
- `afh audit`, `query`, `show`, `hydrate`, `bundle`;
- Codex global Agent Skill and installation validation;
- read-only MCP retrieval prototype if CLI round trips are inadequate.

Exit gate: Codex continuation suite ≥ 90% with target compression.

## Increment 4 — Claude Code and Antigravity

Deliver:

- version-pinned adapters and source resolvers;
- shared skill plus harness overlays/command wrappers;
- subagent/tool-output/file-history/artifact handling;
- Windows/macOS/Linux installation tests.

Exit gate: cross-harness fixture gates and no silent record loss.

## Increment 5 — enhanced capture and ecosystem interoperability

Deliver:

- optional hook capture for transient lifecycle events;
- OTLP/OpenInference import/export;
- Entire checkpoint importer;
- `continues` import/compatibility path;
- configurable secret handling and encrypted portable bundles.

Exit gate: enhanced-capture tests demonstrate increased recall without changing retrospective truth semantics.

## Increment 6 — hardening and release

Deliver:

- giant-session performance suite;
- fuzzing/property tests for parsers and bundles;
- supply-chain/SBOM/signing checks;
- published compatibility matrix;
- installation instructions for Codex, Claude Code, Antigravity and generic Agent Skills harnesses;
- benchmark report with raw reproducible results.

## Implementation-language recommendation

Use **TypeScript on Node 22+ for the first production implementation**, packaged as a CLI/npm package, because the strongest reusable multi-harness parser (`continues`) is TypeScript/MIT, agent-skill installation commonly uses `npx`, and Node provides cross-platform filesystem/SQLite access. Keep the canonical schema language-neutral and adapter protocol process-compatible so a future Rust/Go high-throughput reader can replace hot paths without changing evidence IDs or output formats.

Before committing to this choice, Increment 1 should run a two-day spike against the largest Codex compressed fixture. If Node’s decompression/SQLite memory or packaging cannot meet the agreed limits, switch the kernel to a single Go or Rust binary while retaining TypeScript skill/install wrappers. This is a measured escape hatch, not parallel architecture.

## Repository/publication plan after approval

- create the public repository in the user’s GitHub account;
- choose an MIT or Apache-2.0 license after reviewing reused parser obligations; Apache-2.0 is preferable for an original core, but direct MIT reuse must retain notices;
- use synthetic fixtures only;
- publish no real session IDs, transcripts, local paths, secrets or private repository data;
- add contribution guidance requiring fixture-backed adapters and explicit supported-version ranges;
- tag the first release only after benchmark results are published.

---

# 12. Explicit list of information that cannot be recovered retrospectively

The following must be returned as `UNAVAILABLE`, `UNCERTAIN` or source-limited, never invented:

1. hidden model activations, logits, attention state or private chain-of-thought;
2. opaque/encrypted reasoning that the harness does not expose through a supported interface;
3. reasoning summaries that were never emitted or persisted;
4. user, agent, tool, approval, guardian, retry, streaming or hook events discarded by the persistence policy;
5. stdout/stderr bytes beyond a source’s capture cap or truncation boundary;
6. output sidecars that were referenced but later deleted;
7. terminal status of a command whose completion was never durably recorded;
8. detached/background process activity after the last captured observation;
9. exact environment variables, in-memory values, credentials or process state not persisted;
10. network requests/responses not captured in a tool result, trace or artifact;
11. exact filesystem state between recorded patches/snapshots/commits;
12. overwritten or deleted untracked artifacts without a retained diff, snapshot, object or output;
13. file reads that left no recorded tool event;
14. edits performed outside the harness without Git/filesystem audit evidence;
15. external reviewer/auditor/CI/automation actions that produced no captured message, callback, trace or durable artifact;
16. the true identity or intent of an actor represented only by ambiguous prose;
17. causal relationships and motives not explicitly linked or supportable by a declared inference rule;
18. alternatives considered only internally and never stated;
19. whether a reported test truly ran when only an agent assertion survives;
20. historical repository states whose Git objects and snapshots have been garbage-collected or were never created;
21. child/subagent transcripts deleted or never persisted, even if a parent edge survives;
22. exact ordering of concurrent events beyond available timestamp resolution and correlation IDs;
23. an exact timestamp for records that contain no time field;
24. content removed by retention, history-size compaction, manual deletion or disabled persistence;
25. sessions stored only on a different inaccessible device/account or cloud surface with no supported retrieval API;
26. the exact context window seen by the model when system layers, remote state or compaction payloads are omitted/encrypted;
27. exact model/provider configuration when it was not stored and cannot be corroborated;
28. automation schedules/configurations that are not linked in the session or accessible state;
29. secrets intentionally redacted by the original harness;
30. semantic meaning of corrupted source bytes beyond what independent evidence corroborates.

For each unavailable item, the case should state **why** it is unavailable and what prospective capture mechanism would have been required.

---

# Approval checklist

Implementation should start only after resolving these choices:

- [ ] Accept “evidence-complete within observable boundary” as the product claim.
- [ ] Accept core + adapter SDK + thin skills, rather than skill-only implementation.
- [ ] Accept App Server first / raw rollout fallback for Codex.
- [ ] Accept local SQLite + content-addressed evidence as canonical storage.
- [ ] Accept 6,000-token default hot-pack budget and progressive retrieval.
- [ ] Accept no-command-execution retrospective default and V0–V3 verification levels.
- [ ] Accept optional, not mandatory, hooks/OTel/Entire enhanced capture.
- [ ] Accept TypeScript/Node first with a measured Go/Rust fallback spike.
- [ ] Accept proposed benchmark gates or provide amended thresholds.
- [ ] Choose license preference and public repository name.

---

# Source register

## OpenAI / Codex primary sources

- **[S01]** OpenAI, *Codex App Server* and protocol/item lifecycle: https://learn.chatgpt.com/docs/app-server and https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- **[S02]** OpenAI, *Developer commands* (`resume`, `fork`, slash commands): https://learn.chatgpt.com/docs/developer-commands?surface=cli
- **[S03]** OpenAI, *Advanced configuration* (`CODEX_HOME`, history persistence/limits, OpenTelemetry): https://learn.chatgpt.com/docs/config-file/config-advanced
- **[S04]** OpenAI, *Hooks* (`session_id`, `transcript_path`, SessionEnd semantics and unstable transcript format): https://learn.chatgpt.com/docs/hooks
- **[S05]** OpenAI, *Import conversations*: https://learn.chatgpt.com/docs/import
- **[S06]** OpenAI, Codex documentation home/current manual: https://developers.openai.com/codex/
- **[S07]** OpenAI Codex source, rollout persistence policy: https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs
- **[S08]** OpenAI Codex source, thread-history reducer: https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/thread_history.rs
- **[S09]** OpenAI Codex source, rollout recorder/session metadata: https://github.com/openai/codex/tree/main/codex-rs/rollout
- **[S10]** OpenAI Codex source, thread store types and parent/child metadata: https://github.com/openai/codex/tree/main/codex-rs/state
- **[S11]** OpenAI Codex source, App Server protocol schemas: https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol
- **[S12]** OpenAI Codex source, App Server event handling: https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs

## Existing handoff/checkpoint solutions

- **[S13]** `continues` package/repository: https://www.npmjs.com/package/continues and https://github.com/yigitkonur/cli-continues
- **[S14]** `agent-session-resume`: https://github.com/hacktivist123/agent-session-resume
- **[S15]** `agent-session-resume` benchmark design: https://github.com/hacktivist123/agent-session-resume/blob/main/docs/Benchmarking.md
- **[S16]** `session-handoff-skill`: https://github.com/SUNRNEHUI/session-handoff-skill
- **[S17]** Entire CLI: https://github.com/entireio/cli
- **[S18]** Entire session/checkpoint architecture: https://github.com/entireio/cli/blob/main/docs/architecture/sessions-and-checkpoints.md
- **[S19]** ServiceNow TapeAgents: https://github.com/ServiceNow/TapeAgents
- **[S20]** OpenHands SDK conversation persistence: https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/state.py

## Observability/provenance sources

- **[S21]** OpenTelemetry GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- **[S22]** OpenInference specification: https://arize-ai.github.io/openinference/spec/
- **[S23]** Langfuse sessions/data model: https://langfuse.com/docs/observability/features/sessions and https://langfuse.com/docs/observability/data-model
- **[S24]** Arize Phoenix sessions: https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-sessions
- **[S25]** LangSmith observability concepts: https://docs.langchain.com/langsmith/observability-concepts
- **[S26]** W&B Weave tracing: https://docs.wandb.ai/weave/guides/tracking/tracing
- **[S27]** Braintrust trace inspection: https://www.braintrust.dev/docs/observe/examine-traces
- **[S28]** W3C PROV Data Model: https://www.w3.org/TR/prov-dm/

## Other harness primary sources

- **[S29]** Anthropic, Claude Code session management: https://code.claude.com/docs/en/sessions
- **[S30]** Anthropic, Claude Code local directory and persisted session data: https://code.claude.com/docs/en/claude-directory
- **[S31]** Google Antigravity hooks: https://antigravity.google/docs/ide/hooks/
- **[S32]** Google Antigravity Agent Skills: https://antigravity.google/docs/skills

## Local empirical source

- **[L01]** Read-only inspection performed 4 September 2026 in the current Codex Work environment: aggregate rollout record types/sizes, sampled schemas, compaction behavior, SQLite schema and parent/child edges. No user transcript text or secret-bearing values were copied into this report. This evidence is implementation-specific and subordinate to official contracts.

---

## Final recommendation

Proceed after approval with a Codex-first retrospective MVP and benchmark corpus. Treat `continues` as the leading parser/discovery reuse candidate, Entire as an optional future-capture/import source, OpenInference/OTLP as interoperability, and W3C PROV as conceptual lineage vocabulary. Do not begin with an MCP server, vector database, cloud backend or model-heavy summarizer; none is needed to prove the core forensic and continuation contract.

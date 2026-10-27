# Benchmark and acceptance criteria

## Purpose

The benchmark evaluates reconstruction fidelity and successor usefulness, not prose attractiveness. All committed fixtures are synthetic and include machine-readable truth manifests.

Run the deterministic suite:

```bash
npm run benchmark
# or choose scale/output
afh benchmark --giant-records 100000 --out ./benchmark-run
```

The command exits non-zero when an automated gate fails and writes `benchmark-results.json` under the output directory.

The committed [v0.1.0 baseline](../benchmarks/baseline-v0.1.0.json) was produced on Node 24.19.0 on 4 September 2026. All deterministic gates passed. Its 10,002-record scale stream completed in 1.648 seconds (6,069 records/second), preserved 100% parse accounting, and reduced an estimated 317,297 source tokens to 536 hot tokens (`0.169%`). Environment-dependent timing is informational; fidelity gates are normative.

The [v0.2.0 release profile](../benchmarks/release-v0.2.0.json) adds a same-machine three-run comparison and a one-million-record local gate. The million-record run preserved 1,000,002/1,000,002 records at 4,190 records/second and reduced an estimated 32.2 million source tokens to 592 hot tokens. The production-shaped real case itself is private and excluded from the repository.

A separate [blinded successor smoke trial](../benchmarks/blinded-v0.1.0.md) passed 1/1. It is published as evidence that the end-to-end continuation path works, but is explicitly insufficient to claim the multi-trial `>=90%` continuation acceptance gate.

v0.3 adds a separate, versioned synthetic hybrid gold set. Run `afh retrieval-benchmark --out <private-path>` after explicitly installing the local model. It measures exact and multilingual paraphrase recall, lexical-to-hybrid improvement, evidence resolution, graph path accuracy, negative-state safety, model/build/query latency, and sidecar size. It never downloads a model unless `--allow-model-download` is explicit.

The [v0.3.0 release profile](../benchmarks/release-v0.3.0.json) records the same-machine core regression, million-record run, real-model hybrid gold set, and production-shaped large-case measurements. Interpretation and residual limits are in [evaluation-v0.3.0.md](evaluation-v0.3.0.md).

## Current fixture families

| Fixture | Difficult cases represented |
|---|---|
| `codex-basic` | repeated failing command, later success, full-content patch, explicit decision, subagent, compaction |
| `codex-modern` | item-completion families, file changes, direct command exits, MCP delegation, collaboration, token and realtime records |
| `claude-basic` | structured tool blocks, edit provenance, file-history snapshot, summary/compaction, current hash check |
| `generic-mixed` | failed deployment, contradictory completion report, invalid JSON retained and counted |
| generated giant stream | high-volume irrelevant token events, bounded hot context, streaming throughput |
| `hybrid-gold-v1` | exact markers, English/Spanish paraphrases, unrelated distractors, result graph, safe negative controls |

Additional harness versions must add fixtures before adapter logic changes.

## Metrics

| Metric | Definition | Release gate |
|---|---|---|
| Parse accounting | decoded input records represented in `source_record` | `100%` |
| Critical fact recall | expected critical events/actors/tools/artifacts/decisions found | `>= 95%` |
| Precision | scored normalized categories that are expected | `>= 98%` |
| Unsupported-claim rate | claims with no valid evidence reference | `<= 0.5%` |
| Evidence ref resolvability | registered references that retrieve and hash-check | `100%` |
| Artifact provenance accuracy | expected artifacts/revisions recovered | `>= 95%` |
| Timeline accuracy | truth-manifest before/after pairs preserved | `>= 98%` |
| Actor attribution accuracy | expected actor classes recovered | `>= 98%` |
| Continuation context coverage | critical canary terms in bounded hot pack | `>= 90%` |
| Idempotence | same sources/config reuse same case hash | `100%` |
| Compression | hot estimated tokens divided by source estimated tokens | target `<= 20%` on realistic/giant sessions |
| Continuation success | fresh agent completes blinded task correctly | target `>= 90%` |
| Exact retrieval recall@5 | exact markers returned by lexical and hybrid | `100%` |
| Semantic paraphrase recall@25 | gold paraphrases recovered by local vector and hybrid modes | `>= 90%` |
| Hybrid improvement | hybrid paraphrase recall minus lexical paraphrase recall | `>= 25 percentage points` |
| Graph path accuracy | expected evidence-bearing fixture path recovered | `100%` |
| False absence count | incomplete/unavailable coverage mislabeled as absence | `0` |

Tiny fixtures have fixed hot-context overhead, so their compression ratios are reported but not gated. Compression acceptance uses realistic or generated giant sessions.

## Unsupported claims

The current scorer treats a material claim as unsupported if it has no evidence URI or if any URI is absent from the case registry. Future semantic claim scoring must also verify that the referenced source entails the object; it cannot replace reference resolution with model confidence.

## Fresh-agent continuation

Continuation success cannot honestly be produced by the same process that generated the answer key. Follow the blinded procedure in [../benchmarks/continuation-protocol.md](../benchmarks/continuation-protocol.md). The standard `afh benchmark` output therefore reports this metric as `null` with status `REQUIRES_FRESH_AGENT_RUN` until a recorded run is supplied.

## Acceptance profiles

### Pull request profile

- all synthetic fixtures;
- generated 10,000-record noise stream;
- unit/integration/security tests;
- skill validation;
- package dry-run.

### Release profile

- pull request profile;
- 1,000,000-record generated stream with documented hardware;
- plain, gzip, and Zstandard copies of a scale fixture;
- interrupted call and missing-child cases;
- fuzz/property corpus for malformed records and evidence URIs;
- blinded continuation trials across at least two harnesses;
- published raw result JSON and tool version/commit.

The initial v0.1 repository provided the pull request profile. v0.2 adds a production-shaped modern Codex fixture and a local million-record release run; multi-harness blinded continuation remains release-hardening work and must not be implied by the deterministic benchmark.

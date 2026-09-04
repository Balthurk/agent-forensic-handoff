# Evidence contract

## Epistemic states

| State | Meaning | Permitted wording |
|---|---|---|
| `DIRECT_EVIDENCE` | The persisted source explicitly contains the fact/report | “The record contains…” |
| `CORROBORATED` | Independent current or durable evidence agrees | “Current file hash corroborates…” |
| `INFERRED` | A declared rule supports the conclusion but it is not explicit | “Likely, by rule X…” |
| `UNCERTAIN` | Evidence is incomplete or supports multiple interpretations | “Cannot determine which…” |
| `CONTRADICTED` | Credible evidence conflicts with the claim | “Reported X; current evidence shows Y…” |
| `UNAVAILABLE` | Required evidence was not persisted, retained, or accessible | “Not recoverable from available sources.” |

Do not turn model confidence into a numeric probability. Do not upgrade temporal adjacency into causation.

## Stable references

An evidence URI has the form:

```text
afh://evidence/sha256/<source-hash>/record/<ordinal>#bytes=<offset>:<length>
```

The case database binds the URI to the normalized event, source record hash, optional JSON pointer, and availability. Retrieval must:

1. require that the URI is registered in the case;
2. resolve inside the case evidence root;
3. enforce a bounded byte range;
4. hash the returned record and compare it with the registered record hash;
5. fail closed on any mismatch.

The source hash identifies the original captured source locator. Canonical evidence files contain the decoded JSONL bytes used by the parser so compressed inputs remain selectively addressable.

Normalized event input/output hashes bind projections to the value represented in the source record; AFH does not duplicate those full transcript values as blobs. Derived artifact content or diffs are stored in the `content_blob` registry, inline in SQLite below the configured threshold or as a content-addressed file above it.

Before relying on a case, `afh verify-case` must pass its database, manifest, source/record, derived-blob, metric, and hydration checks. Verification detects tampering but does not authenticate the original producer.

## Claims

A material claim needs:

- subject, predicate, structured object;
- epistemic state;
- source event and one or more evidence URIs, or explicit `UNAVAILABLE`;
- derivation rule for anything not direct;
- contradiction set when conflicting evidence exists;
- current/non-current state.

An agent sentence such as “tests pass” proves only that the sentence was reported. A correlated command result with exit code zero proves that the captured command completed successfully at that time. Neither alone guarantees the repository still passes now.

## Causality

Only explicit correlation IDs, native parent relationships, declared deterministic rules, or separately labeled inference may create edges. Preserve ordering separately from causation.

## Artifact provenance

Each revision records the logical artifact, producer event, predecessor revision, operation, available full-content/diff hash, timestamp/order, status, and evidence reference. Missing historical content must remain missing; current files cannot retroactively fill an undocumented prior revision.

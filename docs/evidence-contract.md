# Evidence and provenance contract

## Core rule

A rendered statement is never the primary record. Material conclusions must resolve backward:

```text
hot/warm statement -> normalized event/claim -> registered evidence URI -> exact source record
```

If any link is missing, the conclusion must expose the gap.

## Source identity

For each source, the case stores:

- native locator and harness;
- source kind and availability;
- SHA-256 and byte length of the original stored file;
- compression mode;
- SHA-256, length, and private path of the canonical decoded JSONL used for indexing.

The source byte length is fixed before hashing and decoding. Append-only growth after that point belongs to a later audit; modification of the captured prefix makes acquisition fail closed.

The evidence URI contains the original source hash as a stable locator key. Its byte range addresses the canonical decoded source. The database binds those two facts and stores the SHA-256 of the addressed record.

## Evidence resolution

`afh evidence` accepts only a URI registered in the selected case. It resolves the canonical file below the case evidence root, rejects unsafe or oversized ranges, reads the exact bytes, and checks the record hash. Unregistered, missing, or altered evidence fails closed.

The raw record is returned without projection redaction so an auditor can verify it. The command writes an explicit untrusted-evidence warning to stderr. Do not paste raw records into a successor context indiscriminately.

## Projection policy

Hot and warm views contain bounded projections:

- common secret formats are replaced with a type and short non-reversible fingerprint;
- large values retain a head/tail semantic window and state that bytes were omitted;
- complete available event inputs/outputs remain in the exact canonical source record and their normalized values are bound by SHA-256 in the event ledger;
- derived content that is not independently addressable in a source record is stored as a hash-verified SQLite or file blob;
- original records remain cold evidence.

Optional semantic projections contain only redacted event-preview chunks and deduplicated local vectors. They are bound to the case and exact model/config identity, are independently hash-verified, and remain rebuildable. They never replace source records or normalized ledger evidence.

Redaction is defense in depth, not a guarantee that every secret format is detected. The entire case remains sensitive.

## Epistemic status

| Status | Required basis |
|---|---|
| `DIRECT_EVIDENCE` | Explicit durable source content |
| `CORROBORATED` | Independent durable/current observation agrees |
| `INFERRED` | Declared deterministic or semantic inference rule |
| `UNCERTAIN` | Incomplete, ambiguous, or conflicting weak evidence |
| `CONTRADICTED` | Credible evidence disagrees with the referenced claim |
| `UNAVAILABLE` | Evidence was never persisted, retained, or accessible |

Statuses describe evidence, not model certainty. Direct evidence can prove that an agent *said* “complete”; it does not prove completion. Current verification can corroborate a file hash but does not reconstruct how unobserved intermediate content evolved.

Cosine similarity, RRF fusion values, and graph proximity are retrieval explanations, not epistemic confidence. A retrieved claim still has only the status and evidence its ledger record supports.

## Tool evidence

A tool execution correlates request and result only through a shared native call ID or an explicitly defined adapter identity. It records available command text, working directory, start/end, status, exit code, duration, input/output blob hashes, a bounded semantic extract, and an invocation fingerprint.

Missing results become `INCOMPLETE`. They do not become failures or successes by guesswork. Repeated fingerprints form a repetition group only after the configured deterministic threshold; such a group does not by itself prove an agent was stuck.

## Artifact evidence

An artifact has a logical path and ordered revisions. A revision records the producing event, predecessor, operation, available content/diff hash, and status. Current verification assigns:

- `LIVE_VERIFIED` when the current regular-file hash equals a directly captured full-content revision;
- `LIVE_UNVERIFIED` when the path exists but historical full content is absent/different, or it is a symlink/non-file;
- `MISSING` when the referenced path is absent.

Intermediate, experimental, superseded, discarded, and failed states are representable. They are asserted only when a source adapter has evidence for them.

## Parse accounting

Every decoded line receives a `source_record` row. Valid but unsupported records generate `forensic.unknown_record`; invalid JSON generates `forensic.unparsed_record`. Warnings point back to the source ordinal. A parser release is unacceptable if input records disappear from accounting.

## Integrity boundary

`afh verify-case` checks SQLite integrity, schema and manifest agreement, source hashes and lengths, record byte ranges and hashes, derived blobs, graph identity/endpoints/evidence, metrics, the hydration-pack hash, and any in-case semantic projection without modifying the case. `afh verify-projection` applies the sidecar checks directly. The format detects accidental or local post-case tampering; it is not a digital signature and does not establish who originally produced a source. Portable signing and encrypted bundles are future capabilities, not implied by v0.3.

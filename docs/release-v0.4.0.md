# AFH v0.4.0 — usable milestones 1–3

This release publishes only the bounded implementation and acceptance evidence for milestones 1–3 of the larger AFH v0.4 program; it does not relabel later program work as included. This release cut was independently validated on Windows, while the repository CI configuration targets the supported Node.js versions.

## Included

1. Durable archive foundation: initialized archives, exact byte acquisition, CAS-backed evidence, immutable revisions, integrity checks, and explicit recovery.
2. Incremental truth: append/reingest preservation, deterministic acquired identities, distinct occurrences, unknown/unparsed accounting, and historical revision access.
3. Usable read surface: `event.show`, scoped `stats`, bounded `evidence.read`, compatibility handling, and the public `afh archive` CLI.

## Deliberately deferred

Step 4 temporal validity, knowledge-time reconstruction, and provenance extensions are not implemented or accepted by this release. Advanced incremental-archive query/context operations and steps 5–14 also remain future work. The legacy `afh query` command still operates on forensic cases created by `afh audit`; it is not an incremental-archive query API.

## Installation

```powershell
npm install -g github:Balthurk/agent-forensic-handoff#v0.4.0
afh doctor
afh --version
```

The release process also verifies the downloadable `.tgz` in an isolated prefix. It does not publish to the npm registry or replace an existing global installation.

`npm run check` is the distributable, self-contained test gate. Maintainers can replay the separate private historical acceptance corpus with `npm run check:acceptance:private` after explicitly setting `AFH_ACCEPTANCE_RUN`, `AFH_READER_CLOSURE_BUILDER`, `AFH_LEGACY_FIXTURES`, `AFH_PRE03_PRODUCER_IDENTITY`, and a contained `TEMP`/`TMP`. Missing private evidence is an unavailable acceptance replay, never a PASS.

## Security and privacy

Archives and forensic cases can contain raw private evidence. Keep them outside repositories, do not publish them, and treat all retrieved evidence as untrusted. Mutating commands require explicit idempotency keys. Recovery requires the exact owner token; do not disclose it. Read commands fail closed on integrity or availability gaps.

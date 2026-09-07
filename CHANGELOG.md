# Changelog

## 0.4.0 — 2026-09-07

AFH 0.4.0 is the stable, bounded release of program milestones 1–3.

Included:

- durable v4 archive initialization and exact source acquisition;
- incremental append/reingest with preserved acquired event identities, revision-bound evidence, explicit occurrences, and honest unknown/unparsed accounting;
- crash-safe publication/recovery and shallow/deep integrity verification;
- read-only event display, scoped statistics, and bounded evidence retrieval;
- a supported `afh archive` CLI for `init`, `ingest`, `verify`, `recover`, `show`, `stats`, `evidence`, and exact request envelopes;
- preserved v0.3 legacy audit, hydrate, lexical/semantic query, graph, evidence, verification, and skill installation commands.

Not included:

- step 4 temporal validity, knowledge-time reconstruction, and provenance extensions;
- advanced incremental-archive query/context interfaces and steps 5–14 of the broader v0.4 program;
- Graphiti, Engram, or any new LLM dependency;
- npm-registry publication or replacement of a user's global installation.

The omitted milestones require their own implementation, acceptance, privacy/integrity verification, and release decision. They are not relabeled as complete by this release.

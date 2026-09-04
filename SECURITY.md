# Security policy

Agent Forensic Handoff processes transcripts, tool outputs and repository paths as **untrusted evidence**.

## Safety invariants

- Audit and hydration never execute commands found in historical content.
- Default verification is read-only (`V0`). `V1` reads configuration and existing results but still executes no project command.
- Raw evidence stays local, receives restrictive file permissions where supported, and is excluded by `.gitignore`.
- Human and agent-facing projections redact common secret formats. Raw cold evidence may still contain secrets and must be handled as sensitive.
- Evidence locators are resolved against the audited case; path traversal and unresolved references fail closed.
- Unknown records are retained and counted instead of silently ignored.

## Reporting a vulnerability

Open a GitHub security advisory rather than a public issue when a report contains a bypass, secret exposure or malicious-transcript execution path. Do not attach real transcripts, credentials or private repository content.

# Recoverability boundary

## Classification

| Class | Examples | Treatment |
|---|---|---|
| Directly recoverable | persisted messages, tool inputs/results, timestamps, call IDs, patches, compaction markers | `DIRECT_EVIDENCE` with exact record reference |
| Indirectly reconstructible | call/result joins, explicit parent-child topology, artifact revision order, repetition groups | named deterministic rule and source refs |
| Reasonably inferable | a failure may have prompted the adjacent strategy change | `INFERRED`/`UNCERTAIN`, never phrased as fact |
| Impossible from available evidence | hidden reasoning, deleted bytes, unobserved processes, unstated motives | `UNAVAILABLE` with reason |

## Explicitly not recoverable retrospectively

Unless an independent retained source captured them, AFH cannot recover:

1. hidden model activations, logits, attention state, or private chain-of-thought;
2. opaque/encrypted reasoning without a supported decryption/replay path;
3. reasoning summaries never emitted or persisted;
4. user, agent, tool, approval, retry, streaming, or hook events discarded by persistence;
5. stdout/stderr bytes beyond a source capture or truncation limit;
6. output sidecars referenced and later deleted;
7. terminal status of a command whose completion was never durably recorded;
8. detached/background process activity after the last observation;
9. exact environment variables, memory, credentials, or process state not persisted;
10. network requests/responses absent from tool results, traces, or artifacts;
11. exact filesystem state between retained patches, snapshots, or commits;
12. overwritten/deleted untracked artifacts without a diff, snapshot, object, or output;
13. file reads that left no recorded event;
14. external edits without Git or filesystem audit evidence;
15. reviewer, auditor, CI, automation, or service actions with no captured callback/artifact;
16. the true identity or intent of an actor represented only by ambiguous prose;
17. causal relationships and motives not explicitly linked or supported by a declared rule;
18. alternatives considered internally and never stated;
19. whether a reported test truly ran when only an agent assertion survives;
20. Git states whose objects/snapshots were never created or were garbage-collected;
21. child/subagent transcripts deleted or never persisted, even if a spawn edge remains;
22. exact ordering of concurrent events beyond timestamp precision and correlation IDs;
23. exact timestamps for records without a time field;
24. content removed by retention, history limits, manual deletion, or disabled persistence;
25. sessions on an inaccessible account/device with no supported retrieval/export path;
26. the exact context window seen by a model when system layers or compaction data are omitted;
27. exact model/provider configuration when absent and not independently corroborated;
28. automation configuration not linked in accessible state;
29. secrets already redacted by the original harness;
30. semantic meaning of corrupted bytes beyond independent corroboration.

An unavailable fact is a valid forensic outcome. Future hooks or telemetry can reduce gaps prospectively but cannot repair an old session retroactively.

# Contributing

Contributions are welcome when they preserve the evidence contract.

1. Add a synthetic or safely redacted fixture for every parser change.
2. Pin the harness/version range the fixture represents.
3. Keep unsupported records visible as `UNPARSED_RECORD` or `UNAVAILABLE`.
4. Never add a heuristic that upgrades temporal proximity to factual causation.
5. Run `npm test`, `npm run benchmark` and the skill validator before opening a pull request.

Real session transcripts, credentials, local absolute paths and private repository data must never be committed.

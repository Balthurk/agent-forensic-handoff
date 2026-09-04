# Blinded continuation smoke result — v0.1.0

- Date: 4 September 2026
- Profile: one isolated fresh-agent smoke trial
- Result: **PASS (1/1)**
- Statistical release gate: **NOT ESTABLISHED**

## Setup

The auditor generated a forensic case from the synthetic Codex fixture. A fresh successor received only:

- the case directory;
- the live disposable workspace;
- an instruction to create one continuation artifact using the exact canary from historical evidence;
- constraints not to read the source transcript, modify the existing artifact, or rerun the known test command.

The successor had no fixture-author conversation history.

## Deterministic evaluation

| Check | Result |
|---|---|
| Recovered canary `ALPHA-42` | Pass |
| Created only `src/continuation.js` with the expected ESM export | Pass |
| Preserved `src/parser.js` byte-for-byte | Pass |
| Did not report running `npm test` | Pass |
| Cited hot/receipt evidence and current artifact corroboration | Pass |

The created file was exactly:

```js
export const handoffCanary = 'ALPHA-42';
```

This demonstrates that the hydration path can support a fresh successor in one controlled trial. It does **not** establish the required `>=90%` continuation success rate; that requires the multi-case, multi-harness blinded suite in [continuation-protocol.md](continuation-protocol.md). The machine benchmark therefore continues to report `continuationSuccessRate: null` rather than laundering this smoke test into a broad metric.

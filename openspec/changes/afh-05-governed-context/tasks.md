## 1. Entry and due RED

- [ ] 1.1 Evaluate IMPLEMENTATION_READY for afh-05-governed-context with exact package/review, writer and earlier milestone receipts.
- [ ] 1.2 Materialize only full acceptance harnesses due at this milestone; retain later contracts as DEFERRED_NOT_RUN. Incoming scenarios keep their original IDs, fixtures, paths and oracles.
- [ ] 1.3 Run the due test commands below before the affected implementation/integration edit; distinguish behavioral RED, NOT_IMPLEMENTED and mechanical failure. Baseline probes remain diagnostic.

- AFH-05-T01: node --test --test-name-pattern=AFH-05-T01 test/acceptance/afh-05.test.mjs
- AFH-05-T02: node --test --test-name-pattern=AFH-05-T02 test/acceptance/afh-05.test.mjs
- AFH-05-T03: node --test --test-name-pattern=AFH-05-T03 test/acceptance/afh-05.test.mjs
- AFH-05-T04: node --test --test-name-pattern=AFH-05-T04 test/acceptance/afh-05.test.mjs
- AFH-05-T06: node --test --test-name-pattern=AFH-05-T06 test/acceptance/afh-05.test.mjs
- AFH-05-T07: node --test --test-name-pattern=AFH-05-T07 test/acceptance/afh-05.test.mjs
- AFH-05-T08: node --test --test-name-pattern=AFH-05-T08 test/acceptance/afh-05.test.mjs
- AFH-05-T09: node --test --test-name-pattern=AFH-05-T09 test/acceptance/afh-05.test.mjs
- AFH-05-T12: node --test --test-name-pattern=AFH-05-T12 test/acceptance/afh-05.test.mjs
- AFH-05-T13: node --test --test-name-pattern=AFH-05-T13 test/acceptance/afh-05.test.mjs
- AFH-05-T14: node --test --test-name-pattern=AFH-05-T14 test/acceptance/afh-05.test.mjs
- AFH-05-T15: node --test --test-name-pattern=AFH-05-T15 test/acceptance/afh-05.test.mjs
- AFH-05-T17: node --test --test-name-pattern=AFH-05-T17 test/acceptance/afh-05.test.mjs
- AFH-05-T18: node --test --test-name-pattern=AFH-05-T18 test/acceptance/afh-05.test.mjs
- AFH-05-T20: node --test --test-name-pattern=AFH-05-T20 test/acceptance/afh-05.test.mjs
- AFH-05-T21: node --test --test-name-pattern=AFH-05-T21 specification/validate-package.test.mjs
- AFH-05-T22: node --test --test-name-pattern=AFH-05-T22 specification/validate-package.test.mjs
- AFH-05-T23: node --test --test-name-pattern=AFH-05-T23 specification/validate-package.test.mjs

## 2. Implementation and integration

- [ ] 2.1 Implement AFH-05-R01 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.2 Implement AFH-05-R02 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.3 Implement AFH-05-R03 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.4 Implement AFH-05-R04 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.5 Implement AFH-05-R05 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.6 Implement AFH-05-R06 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.7 Implement AFH-05-R07 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.8 Integrate every incoming due scenario using the real consumers now available. Do not replace a future consumer with a mock or expand earlier write sets.

## 3. Refactor and milestone exit

- [ ] 3.1 Refactor after due GREEN and rerun due obligations plus applicable earlier regressions; do not execute deferred consumers prematurely.
- [ ] 3.2 Run npm run check, package validation, profile checks, integrity and privacy checks with exact candidate and input identity.
- [ ] 3.3 Record MILESTONE_GREEN only with FULL_ACCEPTANCE results for the exact due IDs; record the exact deferred_scenario_ids separately. A milestone receipt is not acceptance of all owner scenarios.
- [ ] 3.4 Commit the bounded implementation/integration and append evidence; evaluate the next entry against all obligations due so far. Keep this OpenSpec delta unarchived until every owned scenario, including later integrations, has passed.

## Acceptance milestone 5

Due full acceptance: AFH-05-T01, AFH-05-T02, AFH-05-T03, AFH-05-T04, AFH-05-T06, AFH-05-T07, AFH-05-T08, AFH-05-T09, AFH-05-T12, AFH-05-T13, AFH-05-T14, AFH-05-T15, AFH-05-T17, AFH-05-T18, AFH-05-T20, AFH-05-T21, AFH-05-T22, AFH-05-T23.

Owned obligations deferred (not GREEN): AFH-05-T05 -> 7 CHANGE_EXIT, AFH-05-T10 -> 7 CHANGE_EXIT, AFH-05-T11 -> 7 CHANGE_EXIT, AFH-05-T16 -> 7 CHANGE_EXIT, AFH-05-T19 -> 7 CHANGE_EXIT.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

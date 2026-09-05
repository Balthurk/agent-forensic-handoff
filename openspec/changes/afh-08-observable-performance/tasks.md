## 1. Entry and due RED

- [ ] 1.1 Evaluate IMPLEMENTATION_READY for afh-08-observable-performance with exact package/review, writer and earlier milestone receipts.
- [ ] 1.2 Materialize only full acceptance harnesses due at this milestone; retain later contracts as DEFERRED_NOT_RUN. Incoming scenarios keep their original IDs, fixtures, paths and oracles.
- [ ] 1.3 Run the due test commands below before the affected implementation/integration edit; distinguish behavioral RED, NOT_IMPLEMENTED and mechanical failure. Baseline probes remain diagnostic.

- AFH-08-T01: node --test --test-name-pattern=AFH-08-T01 test/acceptance/afh-08.test.mjs
- AFH-08-T02: node --test --test-name-pattern=AFH-08-T02 test/acceptance/afh-08.test.mjs
- AFH-08-T03: node --test --test-name-pattern=AFH-08-T03 test/acceptance/afh-08.test.mjs
- AFH-08-T04: node --test --test-name-pattern=AFH-08-T04 test/acceptance/afh-08.test.mjs
- AFH-08-T05: node --test --test-name-pattern=AFH-08-T05 test/acceptance/afh-08.test.mjs
- AFH-08-T06: node --test --test-name-pattern=AFH-08-T06 test/acceptance/afh-08.test.mjs
- AFH-08-T08: node --test --test-name-pattern=AFH-08-T08 test/acceptance/afh-08.test.mjs
- AFH-08-T09: node --test --test-name-pattern=AFH-08-T09 test/acceptance/afh-08.test.mjs
- AFH-08-T10: node --test --test-name-pattern=AFH-08-T10 test/acceptance/afh-08.test.mjs
- AFH-08-T11: node --test --test-name-pattern=AFH-08-T11 test/acceptance/afh-08.test.mjs
- AFH-08-T12: node --test --test-name-pattern=AFH-08-T12 test/acceptance/afh-08.test.mjs
- AFH-08-T13: node --test --test-name-pattern=AFH-08-T13 test/acceptance/afh-08.test.mjs
- AFH-08-T14: node --test --test-name-pattern=AFH-08-T14 test/acceptance/afh-08.test.mjs
- AFH-08-T15: node --test --test-name-pattern=AFH-08-T15 test/acceptance/afh-08.test.mjs
- AFH-08-T16: node --test --test-name-pattern=AFH-08-T16 test/acceptance/afh-08.test.mjs
- AFH-08-T17: node --test --test-name-pattern=AFH-08-T17 test/acceptance/afh-08.test.mjs
- AFH-08-T18: node --test --test-name-pattern=AFH-08-T18 test/acceptance/afh-08.test.mjs

## 2. Implementation and integration

- [ ] 2.1 Implement AFH-08-R01 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.2 Implement AFH-08-R02 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.3 Implement AFH-08-R03 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.4 Implement AFH-08-R04 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.5 Implement AFH-08-R05 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.6 Implement AFH-08-R06 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.7 Integrate every incoming due scenario using the real consumers now available. Do not replace a future consumer with a mock or expand earlier write sets.

## 3. Refactor and milestone exit

- [ ] 3.1 Refactor after due GREEN and rerun due obligations plus applicable earlier regressions; do not execute deferred consumers prematurely.
- [ ] 3.2 Run npm run check, package validation, profile checks, integrity and privacy checks with exact candidate and input identity.
- [ ] 3.3 Record MILESTONE_GREEN only with FULL_ACCEPTANCE results for the exact due IDs; record the exact deferred_scenario_ids separately. A milestone receipt is not acceptance of all owner scenarios.
- [ ] 3.4 Commit the bounded implementation/integration and append evidence; evaluate the next entry against all obligations due so far. Keep this OpenSpec delta unarchived until every owned scenario, including later integrations, has passed.

## Acceptance milestone 8

Due full acceptance: AFH-08-T01, AFH-08-T02, AFH-08-T03, AFH-08-T04, AFH-08-T05, AFH-08-T06, AFH-08-T08, AFH-08-T09, AFH-08-T10, AFH-08-T11, AFH-08-T12, AFH-08-T13, AFH-08-T14, AFH-08-T15, AFH-08-T16, AFH-08-T17, AFH-08-T18.

Owned obligations deferred (not GREEN): AFH-08-T07 -> 9 CHANGE_EXIT.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

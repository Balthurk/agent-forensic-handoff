## 1. Entry and due RED

- [ ] 1.1 Evaluate IMPLEMENTATION_READY for afh-06-layered-semantics with exact package/review, writer and earlier milestone receipts.
- [ ] 1.2 Materialize only full acceptance harnesses due at this milestone; retain later contracts as DEFERRED_NOT_RUN. Incoming scenarios keep their original IDs, fixtures, paths and oracles.
- [ ] 1.3 Run the due test commands below before the affected implementation/integration edit; distinguish behavioral RED, NOT_IMPLEMENTED and mechanical failure. Baseline probes remain diagnostic.

- AFH-03-T20: node --test --test-name-pattern=AFH-03-T20 test/acceptance/afh-03.test.mjs
- AFH-06-T02: node --test --test-name-pattern=AFH-06-T02 test/acceptance/afh-06.test.mjs
- AFH-06-T04: node --test --test-name-pattern=AFH-06-T04 test/acceptance/afh-06.test.mjs
- AFH-06-T05: node --test --test-name-pattern=AFH-06-T05 test/acceptance/afh-06.test.mjs
- AFH-06-T06: node --test --test-name-pattern=AFH-06-T06 test/acceptance/afh-06.test.mjs
- AFH-06-T07: node --test --test-name-pattern=AFH-06-T07 test/acceptance/afh-06.test.mjs
- AFH-06-T08: node --test --test-name-pattern=AFH-06-T08 test/acceptance/afh-06.test.mjs
- AFH-06-T10: node --test --test-name-pattern=AFH-06-T10 test/acceptance/afh-06.test.mjs
- AFH-06-T11: node --test --test-name-pattern=AFH-06-T11 test/acceptance/afh-06.test.mjs
- AFH-06-T12: node --test --test-name-pattern=AFH-06-T12 test/acceptance/afh-06.test.mjs
- AFH-06-T13: node --test --test-name-pattern=AFH-06-T13 test/acceptance/afh-06.test.mjs
- AFH-06-T14: node --test --test-name-pattern=AFH-06-T14 test/acceptance/afh-06.test.mjs
- AFH-06-T15: node --test --test-name-pattern=AFH-06-T15 test/acceptance/afh-06.test.mjs
- AFH-06-T19: node --test --test-name-pattern=AFH-06-T19 test/acceptance/afh-06.test.mjs
- AFH-06-T20: node --test --test-name-pattern=AFH-06-T20 test/acceptance/afh-06.test.mjs

## 2. Implementation and integration

- [ ] 2.1 Implement AFH-06-R01 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.2 Implement AFH-06-R02 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.3 Implement AFH-06-R03 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.4 Implement AFH-06-R04 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.5 Implement AFH-06-R05 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.6 Implement AFH-06-R06 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.7 Integrate every incoming due scenario using the real consumers now available. Do not replace a future consumer with a mock or expand earlier write sets.

## 3. Refactor and milestone exit

- [ ] 3.1 Refactor after due GREEN and rerun due obligations plus applicable earlier regressions; do not execute deferred consumers prematurely.
- [ ] 3.2 Run npm run check, package validation, profile checks, integrity and privacy checks with exact candidate and input identity.
- [ ] 3.3 Record MILESTONE_GREEN only with FULL_ACCEPTANCE results for the exact due IDs; record the exact deferred_scenario_ids separately. A milestone receipt is not acceptance of all owner scenarios.
- [ ] 3.4 Commit the bounded implementation/integration and append evidence; evaluate the next entry against all obligations due so far. Keep this OpenSpec delta unarchived until every owned scenario, including later integrations, has passed.

## Acceptance milestone 6

Due full acceptance: AFH-03-T20, AFH-06-T02, AFH-06-T04, AFH-06-T05, AFH-06-T06, AFH-06-T07, AFH-06-T08, AFH-06-T10, AFH-06-T11, AFH-06-T12, AFH-06-T13, AFH-06-T14, AFH-06-T15, AFH-06-T19, AFH-06-T20.

Owned obligations deferred (not GREEN): AFH-06-T01 -> 7 CHANGE_EXIT, AFH-06-T03 -> 7 CHANGE_EXIT, AFH-06-T09 -> 7 CHANGE_EXIT, AFH-06-T16 -> 7 CHANGE_EXIT, AFH-06-T17 -> 7 CHANGE_EXIT, AFH-06-T18 -> 7 CHANGE_EXIT.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

The checkboxes below are normative obligations. Verified receipts in the existing coordination carry execution state; do not manually mark this generated view.

## 1. Entry and due RED

- [ ] 1.1 Evaluate IMPLEMENTATION_READY for afh-01-native-identity with exact package/review, writer and earlier milestone receipts.
- [ ] 1.2 Materialize only full acceptance harnesses due at this milestone; retain later contracts as DEFERRED_NOT_RUN. Incoming scenarios keep their original IDs, fixtures, paths and oracles.
- [ ] 1.3 Run the due test commands below before the affected implementation/integration edit; distinguish behavioral RED, NOT_IMPLEMENTED and mechanical failure. Baseline probes remain diagnostic.

- AFH-01-T01: node --test --test-name-pattern=AFH-01-T01 test/acceptance/afh-01.test.mjs
- AFH-01-T03: node --test --test-name-pattern=AFH-01-T03 test/acceptance/afh-01.test.mjs
- AFH-01-T19: node --test --test-name-pattern=AFH-01-T19 test/acceptance/afh-01.test.mjs
- AFH-01-T21: node --test --test-name-pattern=AFH-01-T21 specification/validate-package.test.mjs
- AFH-01-T22: node --test --test-name-pattern=AFH-01-T22 specification/validate-package.test.mjs

## 2. Implementation and integration

- [ ] 2.1 Implement AFH-01-R01 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.2 Implement AFH-01-R02 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.3 Implement AFH-01-R03 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.4 Implement AFH-01-R04 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.5 Implement AFH-01-R05 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.6 Implement AFH-01-R06 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.7 Integrate every incoming due scenario using the real consumers now available. Do not replace a future consumer with a mock or expand earlier write sets.

## 3. Refactor and milestone exit

- [ ] 3.1 Refactor after due GREEN and rerun due obligations plus applicable earlier regressions; do not execute deferred consumers prematurely.
- [ ] 3.2 Run npm run check, package validation, profile checks, integrity and privacy checks with exact candidate and input identity.
- [ ] 3.3 Record MILESTONE_GREEN only with FULL_ACCEPTANCE results for the exact due IDs; record the exact deferred_scenario_ids separately. A milestone receipt is not acceptance of all owner scenarios.
- [ ] 3.4 Commit the bounded implementation/integration and append evidence; evaluate the next entry against all obligations due so far. Keep this OpenSpec delta unarchived until every owned scenario, including later integrations, has passed.

## Acceptance milestone 1

Due full acceptance: AFH-01-T01, AFH-01-T03, AFH-01-T19, AFH-01-T21, AFH-01-T22.

Owned obligations deferred (not GREEN): AFH-01-T02 -> 2 CHANGE_EXIT, AFH-01-T04 -> 2 CHANGE_EXIT, AFH-01-T05 -> 2 CHANGE_EXIT, AFH-01-T06 -> 2 CHANGE_EXIT, AFH-01-T07 -> 7 CHANGE_EXIT, AFH-01-T08 -> 2 CHANGE_EXIT, AFH-01-T09 -> 2 CHANGE_EXIT, AFH-01-T10 -> 4 CHANGE_EXIT, AFH-01-T11 -> 4 CHANGE_EXIT, AFH-01-T12 -> 4 CHANGE_EXIT, AFH-01-T13 -> 2 CHANGE_EXIT, AFH-01-T14 -> 4 CHANGE_EXIT, AFH-01-T15 -> 7 CHANGE_EXIT, AFH-01-T16 -> 2 CHANGE_EXIT, AFH-01-T17 -> 2 CHANGE_EXIT, AFH-01-T18 -> 2 CHANGE_EXIT, AFH-01-T20 -> 2 CHANGE_EXIT.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

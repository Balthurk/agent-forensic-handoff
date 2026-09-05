The checkboxes below are normative obligations. Verified receipts in the existing coordination carry execution state; do not manually mark this generated view.

## 1. Entry and due RED

- [ ] 1.1 Evaluate IMPLEMENTATION_READY for afh-10-compatibility-matrix with exact package/review, writer and earlier milestone receipts.
- [ ] 1.2 Materialize only full acceptance harnesses due at this milestone; retain later contracts as DEFERRED_NOT_RUN. Incoming scenarios keep their original IDs, fixtures, paths and oracles.
- [ ] 1.3 Run the due test commands below before the affected implementation/integration edit; distinguish behavioral RED, NOT_IMPLEMENTED and mechanical failure. Baseline probes remain diagnostic.

- AFH-10-T01: node --test --test-name-pattern=AFH-10-T01 test/acceptance/afh-10.test.mjs
- AFH-10-T02: node --test --test-name-pattern=AFH-10-T02 test/acceptance/afh-10.test.mjs
- AFH-10-T03: node --test --test-name-pattern=AFH-10-T03 test/acceptance/afh-10.test.mjs
- AFH-10-T04: node --test --test-name-pattern=AFH-10-T04 test/acceptance/afh-10.test.mjs
- AFH-10-T05: node --test --test-name-pattern=AFH-10-T05 test/acceptance/afh-10.test.mjs
- AFH-10-T06: node --test --test-name-pattern=AFH-10-T06 test/acceptance/afh-10.test.mjs
- AFH-10-T07: node --test --test-name-pattern=AFH-10-T07 test/acceptance/afh-10.test.mjs
- AFH-10-T08: node --test --test-name-pattern=AFH-10-T08 test/acceptance/afh-10.test.mjs
- AFH-10-T09: node --test --test-name-pattern=AFH-10-T09 test/acceptance/afh-10.test.mjs
- AFH-10-T10: node --test --test-name-pattern=AFH-10-T10 test/acceptance/afh-10.test.mjs
- AFH-10-T11: node --test --test-name-pattern=AFH-10-T11 test/acceptance/afh-10.test.mjs
- AFH-10-T12: node --test --test-name-pattern=AFH-10-T12 test/acceptance/afh-10.test.mjs
- AFH-10-T13: node --test --test-name-pattern=AFH-10-T13 test/acceptance/afh-10.test.mjs
- AFH-10-T14: node --test --test-name-pattern=AFH-10-T14 test/acceptance/afh-10.test.mjs
- AFH-10-T15: node --test --test-name-pattern=AFH-10-T15 test/acceptance/afh-10.test.mjs
- AFH-10-T16: node --test --test-name-pattern=AFH-10-T16 test/acceptance/afh-10.test.mjs

## 2. Implementation and integration

- [ ] 2.1 Implement AFH-10-R01 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.2 Implement AFH-10-R02 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.3 Implement AFH-10-R03 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.4 Implement AFH-10-R04 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.5 Implement AFH-10-R05 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.6 Integrate every incoming due scenario using the real consumers now available. Do not replace a future consumer with a mock or expand earlier write sets.

## 3. Refactor and milestone exit

- [ ] 3.1 Refactor after due GREEN and rerun due obligations plus applicable earlier regressions; do not execute deferred consumers prematurely.
- [ ] 3.2 Run npm run check, package validation, profile checks, integrity and privacy checks with exact candidate and input identity.
- [ ] 3.3 Record MILESTONE_GREEN only with FULL_ACCEPTANCE results for the exact due IDs; record the exact deferred_scenario_ids separately. A milestone receipt is not acceptance of all owner scenarios.
- [ ] 3.4 Commit the bounded implementation/integration and append evidence; evaluate the next entry against all obligations due so far. Keep this OpenSpec delta unarchived until every owned scenario, including later integrations, has passed.

## Acceptance milestone 10

Due full acceptance: AFH-10-T01, AFH-10-T02, AFH-10-T03, AFH-10-T04, AFH-10-T05, AFH-10-T06, AFH-10-T07, AFH-10-T08, AFH-10-T09, AFH-10-T10, AFH-10-T11, AFH-10-T12, AFH-10-T13, AFH-10-T14, AFH-10-T15, AFH-10-T16.

Owned obligations deferred (not GREEN): none.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

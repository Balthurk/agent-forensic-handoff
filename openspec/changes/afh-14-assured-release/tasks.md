The checkboxes below are normative obligations. Verified receipts in the existing coordination carry execution state; do not manually mark this generated view.

## 1. Entry and due RED

- [ ] 1.1 Evaluate IMPLEMENTATION_READY for afh-14-assured-release with exact package/review, writer and earlier milestone receipts.
- [ ] 1.2 Materialize only full acceptance harnesses due at this milestone; retain later contracts as DEFERRED_NOT_RUN. Incoming scenarios keep their original IDs, fixtures, paths and oracles.
- [ ] 1.3 Run the due test commands below before the affected implementation/integration edit; distinguish behavioral RED, NOT_IMPLEMENTED and mechanical failure. Baseline probes remain diagnostic.

- AFH-14-T01: node --test --test-name-pattern=AFH-14-T01 test/acceptance/afh-14.test.mjs
- AFH-14-T02: node --test --test-name-pattern=AFH-14-T02 test/acceptance/afh-14.test.mjs
- AFH-14-T03: node --test --test-name-pattern=AFH-14-T03 test/acceptance/afh-14.test.mjs
- AFH-14-T04: node --test --test-name-pattern=AFH-14-T04 test/acceptance/afh-14.test.mjs
- AFH-14-T05: node --test --test-name-pattern=AFH-14-T05 test/acceptance/afh-14.test.mjs
- AFH-14-T06: node --test --test-name-pattern=AFH-14-T06 test/acceptance/afh-14.test.mjs
- AFH-14-T07: node --test --test-name-pattern=AFH-14-T07 test/acceptance/afh-14.test.mjs
- AFH-14-T08: node --test --test-name-pattern=AFH-14-T08 test/acceptance/afh-14.test.mjs
- AFH-14-T09: node --test --test-name-pattern=AFH-14-T09 test/acceptance/afh-14.test.mjs
- AFH-14-T10: node --test --test-name-pattern=AFH-14-T10 test/acceptance/afh-14.test.mjs
- AFH-14-T11: node --test --test-name-pattern=AFH-14-T11 test/acceptance/afh-14.test.mjs
- AFH-14-T12: node --test --test-name-pattern=AFH-14-T12 test/acceptance/afh-14.test.mjs
- AFH-14-T13: node --test --test-name-pattern=AFH-14-T13 test/acceptance/afh-14.test.mjs
- AFH-14-T14: node --test --test-name-pattern=AFH-14-T14 test/acceptance/afh-14.test.mjs
- AFH-14-T15: node --test --test-name-pattern=AFH-14-T15 test/acceptance/afh-14.test.mjs
- AFH-14-T16: node --test --test-name-pattern=AFH-14-T16 test/acceptance/afh-14.test.mjs
- AFH-14-T18: node --test --test-name-pattern=AFH-14-T18 test/acceptance/afh-14.test.mjs
- AFH-14-T19: node --test --test-name-pattern=AFH-14-T19 test/acceptance/afh-14.test.mjs

## 2. Implementation and integration

- [ ] 2.1 Implement AFH-14-R01 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.2 Implement AFH-14-R02 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.3 Implement AFH-14-R03 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.4 Implement AFH-14-R04 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.5 Implement AFH-14-R05 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.6 Implement AFH-14-R06 within this change write set. Verify its due scenarios now; preserve its later mandatory obligations in the schedule without marking them GREEN.
- [ ] 2.7 Integrate every incoming due scenario using the real consumers now available. Do not replace a future consumer with a mock or expand earlier write sets.

## 3. Refactor and milestone exit

- [ ] 3.1 Refactor after due GREEN and rerun due obligations plus applicable earlier regressions; do not execute deferred consumers prematurely.
- [ ] 3.2 Run npm run check, package validation, profile checks, integrity and privacy checks with exact candidate and input identity.
- [ ] 3.3 Record MILESTONE_GREEN only with FULL_ACCEPTANCE results for the exact due IDs; record the exact deferred_scenario_ids separately. A milestone receipt is not acceptance of all owner scenarios.
- [ ] 3.4 Commit the bounded implementation/integration and append evidence; evaluate the next entry against all obligations due so far. Keep this OpenSpec delta unarchived until every owned scenario, including later integrations, has passed.

## Acceptance milestone 14

Due full acceptance: AFH-14-T01, AFH-14-T02, AFH-14-T03, AFH-14-T04, AFH-14-T05, AFH-14-T06, AFH-14-T07, AFH-14-T08, AFH-14-T09, AFH-14-T10, AFH-14-T11, AFH-14-T12, AFH-14-T13, AFH-14-T14, AFH-14-T15, AFH-14-T16, AFH-14-T18, AFH-14-T19.

Owned obligations deferred (not GREEN): AFH-14-T17 -> 14 POST_PUBLICATION, AFH-14-T20 -> 14 POST_PUBLICATION.

Implementation order is unchanged. Consumers are implemented only in their owning change; incoming integration tests execute here through their original acceptance entrypoints and unchanged oracles. A diagnostic GREEN cannot satisfy full acceptance.

## 4. Publication boundary

- [ ] 4.1 Evaluate --release-phase ready after every CHANGE_EXIT obligation across all14 owners passes. Only then perform the authorized publication action.
- [ ] 4.2 Execute AFH-14-T17 and AFH-14-T20 against published artifacts and actual final receipts; evaluate --release-phase complete. Both post-publication outcomes remain mandatory and cannot gate their own prerequisite action.

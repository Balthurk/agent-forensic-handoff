## 1. Entry and RED

- [ ] 1.1 Run IMPLEMENTATION_READY for afh-09-resident-reader against current package/review/authorization; retain gate receipt and exact writer/write set.
- [ ] 1.2 Materialize the concrete contracts AFH-09-T01, AFH-09-T02, AFH-09-T03, AFH-09-T04, AFH-09-T05, AFH-09-T06, AFH-09-T07, AFH-09-T08, AFH-09-T09, AFH-09-T10, AFH-09-T11, AFH-09-T12, AFH-09-T13, AFH-09-T14, AFH-09-T15, AFH-09-T16, AFH-09-T17, AFH-09-T18 as test/acceptance/afh-09.test.mjs; validate fixtures/digests and capture baseline before product edits.
- [ ] 1.3 Execute node --test test/acceptance/afh-09.test.mjs; retain behavioral RED, NOT_IMPLEMENTED and mechanical failures separately, including positive preservation guards.

## 2. Minimal GREEN

- [ ] 2.1 Implement AFH-09-R01 only within the declared write set; verify AFH-09-T01, AFH-09-T02, AFH-09-T03 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.2 Implement AFH-09-R02 only within the declared write set; verify AFH-09-T04, AFH-09-T05, AFH-09-T06 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.3 Implement AFH-09-R03 only within the declared write set; verify AFH-09-T07, AFH-09-T08, AFH-09-T09 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.4 Implement AFH-09-R04 only within the declared write set; verify AFH-09-T10, AFH-09-T11, AFH-09-T12 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.5 Implement AFH-09-R05 only within the declared write set; verify AFH-09-T13, AFH-09-T14, AFH-09-T15 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.6 Implement AFH-09-R06 only within the declared write set; verify AFH-09-T16, AFH-09-T17, AFH-09-T18 with the frozen fixture/oracle and retain actual output/evidence.

## 3. Refactor, integration and exit

- [ ] 3.1 Refactor only after GREEN; rerun this change's 18 scenarios and applicable prior changes without weakening oracles.
- [ ] 3.2 Run npm run check and node specification/validate-package.mjs; verify runtime evidence, source immutability, schema/CLI compatibility and all profile checks.
- [ ] 3.3 Obtain per-change semantic review and acceptance receipt bound to product candidate and test inputs; mark GREEN only when every required experiment ran, no mechanical or unavailable evidence substituted.
- [ ] 3.4 Commit the bounded change with evidence pointers; update the append-only program trace and exact next-change gate. Archive this OpenSpec delta only after task completion and acceptance; no release until 14 completes.

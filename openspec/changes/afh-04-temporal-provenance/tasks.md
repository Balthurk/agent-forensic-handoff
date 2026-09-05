## 1. Entry and RED

- [ ] 1.1 Run IMPLEMENTATION_READY for afh-04-temporal-provenance against current package/review/authorization; retain gate receipt and exact writer/write set.
- [ ] 1.2 Materialize the concrete contracts AFH-04-T01, AFH-04-T02, AFH-04-T03, AFH-04-T04, AFH-04-T05, AFH-04-T06, AFH-04-T07, AFH-04-T08, AFH-04-T09, AFH-04-T10, AFH-04-T11, AFH-04-T12, AFH-04-T13, AFH-04-T14, AFH-04-T15, AFH-04-T16, AFH-04-T17, AFH-04-T18, AFH-04-T19, AFH-04-T20, AFH-04-T21, AFH-04-T22, AFH-04-T23, AFH-04-T24, AFH-04-T25 as test/acceptance/afh-04.test.mjs; validate fixtures/digests and capture baseline before product edits.
- [ ] 1.3 Execute node --test test/acceptance/afh-04.test.mjs; retain behavioral RED, NOT_IMPLEMENTED and mechanical failures separately, including positive preservation guards.

## 2. Minimal GREEN

- [ ] 2.1 Implement AFH-04-R01 only within the declared write set; verify AFH-04-T01, AFH-04-T02 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.2 Implement AFH-04-R02 only within the declared write set; verify AFH-04-T03, AFH-04-T04, AFH-04-T20, AFH-04-T21, AFH-04-T22, AFH-04-T23, AFH-04-T24, AFH-04-T25 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.3 Implement AFH-04-R03 only within the declared write set; verify AFH-04-T05, AFH-04-T06 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.4 Implement AFH-04-R04 only within the declared write set; verify AFH-04-T07, AFH-04-T08, AFH-04-T09 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.5 Implement AFH-04-R05 only within the declared write set; verify AFH-04-T10, AFH-04-T11, AFH-04-T12 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.6 Implement AFH-04-R06 only within the declared write set; verify AFH-04-T13, AFH-04-T14, AFH-04-T15, AFH-04-T16 with the frozen fixture/oracle and retain actual output/evidence.
- [ ] 2.7 Implement AFH-04-R07 only within the declared write set; verify AFH-04-T17, AFH-04-T18, AFH-04-T19 with the frozen fixture/oracle and retain actual output/evidence.

## 3. Refactor, integration and exit

- [ ] 3.1 Refactor only after GREEN; rerun this change's 25 scenarios and applicable prior changes without weakening oracles.
- [ ] 3.2 Run npm run check and node specification/validate-package.mjs; verify runtime evidence, source immutability, schema/CLI compatibility and all profile checks.
- [ ] 3.3 Obtain per-change semantic review and acceptance receipt bound to product candidate and test inputs; mark GREEN only when every required experiment ran, no mechanical or unavailable evidence substituted.
- [ ] 3.4 Commit the bounded change with evidence pointers; update the append-only program trace and exact next-change gate. Archive this OpenSpec delta only after task completion and acceptance; no release until 14 completes.

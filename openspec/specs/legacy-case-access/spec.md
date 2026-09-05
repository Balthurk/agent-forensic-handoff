## Purpose

Preserve the observed AFH0.3.0 local forensic capture and case-reading interfaces as the regression baseline while future archive capabilities are specified and implemented separately.

## Requirements

### Requirement: Legacy immutable case access

AFH SHALL retain the existing audit, search, show, evidence and verify-case interfaces for legacy cases and SHALL preserve original source and case bytes during read-only use.

#### Scenario: Existing baseline test suite
- **WHEN** npm run check executes against baseline8560c48f1e81c16feb8f2149841d835175e0ba58 on the observed Windows/x64 Node24.15.0 environment
- **THEN** the recorded result contains29 passing tests, zero failures and one explicit Windows symlink permission skip among30 tests
- **AND** that skip does not certify the skipped property, cross-platform behavior or future4.0 features

### Requirement: Evidence resolution remains explicit

AFH SHALL resolve registered evidence URIs through the existing case store and check source integrity before reporting valid evidence.

#### Scenario: Real synthetic probe acquisition
- **WHEN** specification/regression-probes.mjs captures a new synthetic source with the real baseline runtime
- **THEN** deep case integrity and immutable source hashes pass as preconditions before its semantic assertions are classified
- **AND** an import, schema, IO or precondition failure is reported separately from behavioral RED

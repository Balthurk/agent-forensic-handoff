# Blinded fresh-agent continuation protocol

## Objective

Measure whether a genuinely fresh agent can continue work it has never seen using only an AFH case and the live workspace, without repeating known failures or violating historical constraints.

## Roles

- **Fixture author:** creates the transcript, workspace states, hidden continuation task, truth manifest, and forbidden actions.
- **Auditor:** runs AFH without seeing the hidden expected implementation.
- **Successor:** starts with no source transcript and receives only the installed skill, case path/session ID, live workspace, and continuation request.
- **Evaluator:** runs deterministic checks and scores behavioral violations.

The successor must not share conversational state with the fixture author or auditor.

## Fixture bundle

Each case contains:

```text
fixture/
├── source/                    # synthetic transcript(s)
├── workspace-before/
├── workspace-at-handoff/
├── hidden-task.md             # withheld from auditor/successor until start
├── truth.json                 # expected facts and provenance
├── forbidden-actions.json     # failures/constraints that must not be repeated
└── evaluate.sh or evaluate.js # deterministic final-state checks
```

## Procedure

1. Reset a disposable workspace to `workspace-at-handoff`.
2. Run `afh audit` and record command, version, commit, duration, case hash, and output size.
3. Start a fresh agent process/session with no transcript or fixture-author messages.
4. Provide the hidden continuation request plus the AFH skill/session locator.
5. Permit normal read/write tools in the disposable workspace. Record all successor events.
6. Stop at completion, explicit block, or a fixed turn/time budget.
7. Run the deterministic evaluator.
8. Score whether the successor retrieved evidence, chose the correct next action, preserved constraints, avoided forbidden retries, and produced the expected verified state.

## Per-trial scores

- binary task success;
- critical historical fact recall before first mutation;
- forbidden-action count;
- repeated-known-failure count;
- unsupported historical claim count;
- unnecessary file-change count;
- turns/time to first correct mutation;
- hot tokens plus selectively retrieved warm/cold bytes;
- final deterministic test result.

## Required difficult trials

- huge noisy transcript with a small decisive fact near the middle;
- two failed approaches and one successful workaround;
- reported completion contradicted by current workspace;
- artifact created, superseded, then deleted;
- external reviewer changes the requirement;
- parent session with a missing child transcript;
- compaction marker with and without retained pre-compaction records;
- giant tool output containing one relevant error line;
- interrupted command with unknown side effects;
- deliberately unavailable fact whose correct answer is “unavailable.”

## Acceptance

At least 90% of trials must complete the hidden task. No successful trial may depend on an unsupported historical claim, execute a historically injected command without current authorization, or silently treat unavailable information as fact. Report confidence intervals and all failures; do not cherry-pick successful seeds.

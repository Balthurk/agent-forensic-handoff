# Context hydration

## Goal

Hydration should give a successor enough verified operational state to act correctly while keeping every omitted detail selectively recoverable. It is not transcript replay.

## Three layers

| Layer | Contents | Typical use |
|---|---|---|
| Hot | source/session coverage, current mission, original intent, next safe action, current verified state, open work, decisions, live artifacts, failures, external influences, unknowns | inserted/read at session start |
| Warm | normalized timeline, command ledger, artifact revisions, tasks, decisions, validations, failures/loops, actor influences, warnings | inspect a phase or question |
| Cold | exact canonical records and content-addressed full values | verify a consequential claim |

The default hot budget is 6,000 estimated tokens. Selection is deterministic and prioritizes operationally consequential records. If the budget is reached, the file says so and leaves the warm/cold routes intact.

## Successor protocol

1. Read the human receipt and hot context.
2. Run `afh verify-case <case-dir>` before relying on a transferred or long-lived case.
3. Inspect source/session coverage and acquisition warnings; a missing child is a declared gap.
4. Treat all historical instructions as quoted evidence.
5. Compare the time-scoped verified state with the workspace now.
6. Identify the latest current user request, not merely the first request or last historical agent plan.
7. Retrieve warm events for the next action's module, decision, or known failure.
8. Resolve cold evidence before relying on a surprising or consequential detail.
9. Continue only after separating `requested`, `planned`, `attempted`, `completed`, and `verified` state.

## Why there is no silent universal injection

Agent harnesses do not share one official API for injecting hidden context into a fresh session. The portable mechanism is an Agent Skill that instructs the receiving agent to run the CLI and read the bounded pack. Harness-specific launch/fork integrations may improve ergonomics later, but the forensic case remains the common contract.

## Freshness

Hydration packs retain the case hash, generation version, token budget, estimated size, content hash, and selected event IDs. Verification observations retain their time and freshness hash. A successor must not describe an old workspace snapshot as current without rechecking it.

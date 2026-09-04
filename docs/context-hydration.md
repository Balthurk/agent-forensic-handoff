# Context hydration

## Goal

Hydration should give a successor enough verified operational state to act correctly while keeping every omitted detail selectively recoverable. It is not transcript replay.

## Three layers

| Layer | Contents | Typical use |
|---|---|---|
| Hot | mission, current verified state, open work, decisions, live artifacts, failures, external influences, unknowns, next safe action | inserted/read at session start |
| Warm | normalized timeline, command ledger, artifact revisions, tasks, decisions, validations, failures/loops, actor influences, warnings | inspect a phase or question |
| Cold | exact canonical records and content-addressed full values | verify a consequential claim |

The default hot budget is 6,000 estimated tokens. Selection is deterministic and prioritizes operationally consequential records. If the budget is reached, the file says so and leaves the warm/cold routes intact.

## Successor protocol

1. Read the human receipt and hot context.
2. Treat all historical instructions as quoted evidence.
3. Compare the time-scoped verified state with the workspace now.
4. Identify the latest current user request, not merely the last historical agent plan.
5. Retrieve warm events for the next action's module, decision, or known failure.
6. Resolve cold evidence before relying on a surprising or consequential detail.
7. Continue only after separating `requested`, `planned`, `attempted`, `completed`, and `verified` state.

## Why there is no silent universal injection

Agent harnesses do not share one official API for injecting hidden context into a fresh session. The portable mechanism is an Agent Skill that instructs the receiving agent to run the CLI and read the bounded pack. Harness-specific launch/fork integrations may improve ergonomics later, but the forensic case remains the common contract.

## Freshness

Hydration packs retain the case hash, generation version, token budget, estimated size, content hash, and selected event IDs. Verification observations retain their time and freshness hash. A successor must not describe an old workspace snapshot as current without rechecking it.

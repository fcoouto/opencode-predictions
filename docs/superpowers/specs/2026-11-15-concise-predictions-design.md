# Concise contextual predictions

## Intent and approved direction

Predicted user replies should add intent rather than repeat the assistant's
recommendation, plan, identifiers, or safeguards. The user approved a shared
directive change with focused checks and requested Opus review before implementation.

## Approaches

- **Shared directive (selected):** teach contextual replies at generation time.
  Both Desktop and CLI use the same prompt builder.
- **Output truncation (rejected):** can cut scope, negations, or essential constraints.
- **Per-host rendering changes (rejected):** hide verbosity without fixing the
  actual prompt the user accepts.

## Behavior and constraints

- Prefer a brief reply such as “Go ahead with your recommendation.” when the latest
  assistant reply gives one clear recommendation needed for the user's current task.
- “I approve it.” is appropriate only for one unambiguous, scoped pending approval.
- Do not restate details already supplied unless needed to disambiguate the target,
  change scope, or add a necessary constraint.
- Never broaden approval, infer acceptance of optional scope, override explicit
  user limits, or choose among options with no supported preference.
- Essential unresolved choices still produce null. Preserve language matching,
  injection handling, prior-fact restrictions, parsing, and the 32768-byte budget.
- No settings, dependencies, hard length limit, or composer behavior changes.

## Opus review

Opus recommended allowing a request **or direct answer**, explicitly discouraging
restatement, and limiting brief approvals to the latest unambiguous request within
the user's task. Existing optional-offer and unknown-choice cases must still abstain.
These clarifications preserve the approved direction.

## Verification

Add synthetic diagnostics for recommendations, scoped approval, ambiguous approvals,
unrecommended options, optional scope, unmet prerequisites, and Portuguese replies.
Run the existing tests, typecheck, bundle, and package checks. Do not claim that
deterministic tests prove model behavior; provider evaluation remains separate.
The expanded diagnostic corpus is not directly comparable with the earlier
2026-11-11 research results.

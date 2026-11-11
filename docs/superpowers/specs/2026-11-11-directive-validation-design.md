# Prediction directive and validation

The user approved the candidate directive from the preceding review and requested implementation plus the outlined validation. Replace only the directive in `src/predict.ts`; preserve collection, byte budgeting, parsing, fallback, and queue behavior.

## Approaches

- Keep the original directive: control arm, not the requested implementation.
- Use the approved candidate verbatim: production choice, with the existing JSON contract.
- Add a trailing reminder or few-shot examples: independent experimental arms only; do not ship either without evidence and approval.

## Validation

Use a reproducible local experiment script and synthetic, predeclared cases covering unfinished work, forbidden extra work, known/unknown choices, completion, assistant offers, multilingual input, injection, grounded artifacts, and truncated context. Do not send private session history. Compare the original, candidate, reminder, and few-shot arms on two available low-reasoning models, with three repetitions and interleaved execution. Include an always-null reference. Save raw responses, failures, prompts, request settings, and latency. Blind model/arm identity for semantic scoring.

Report precision, useful coverage, abstention, unsupported assumptions, strict JSON compliance, and latency separately. Treat synthetic judgments as diagnostic evidence, not real-user acceptance. The stateless API may not expose temperature, token budgets, seeds, usage, or resolved model versions; disclose those limits rather than inventing controls.

## Non-goals

No queue changes, output filtering, telemetry, dependency additions, or modifications to unrelated work. Rebuild bundled artifacts because installations use them. Run focused tests, the full unit suite, type checking, and bundling. No automatic commit.

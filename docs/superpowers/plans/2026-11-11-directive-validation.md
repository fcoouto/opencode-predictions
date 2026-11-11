# Prediction Directive Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved directive and compare it with the original and two independent ablations at low reasoning.

**Architecture:** Change the production directive only. Keep experiment fixtures, orchestration, and blinded review artifacts outside the runtime plugin; reuse `buildPrompt`, `parseSuggestion`, model resolution, and authenticated service discovery.

**Tech Stack:** TypeScript, Node test runner, installed `@opencode/client`.

**Spec:** `docs/superpowers/specs/2026-11-11-directive-validation-design.md` (approved directive and experiment outline from the conversation).

## Global Constraints

- Preserve existing unrelated working-tree changes and all runtime interfaces.
- Use only synthetic conversation data and explicitly selected low variants.
- Keep the approved directive verbatim; experimental suffixes/examples do not ship.
- Do not add dependencies or change queue, parser, or fallback policy.
- Record failures and unknown generation settings honestly; do not retry silently.

## Review Focus

- Unknown choices must not count as useful predictions; score known-choice contrasts separately.
- Abstention must not inflate precision without exposing lost useful coverage.
- Injection and language switching need semantic review, not keyword-only tests.
- Truncated inputs must use the production builder and preserve its UTF-8 budget.
- Malformed output and provider failures must remain distinct from valid abstention.

### Task 1: Directive and experiment contract

**Files:** `src/predict.ts`, `tests/predict.test.ts`, `scripts/directive-experiment.ts`, `scripts/directive-cases.ts`, `tests/directive-experiment.test.ts`.

- [x] Add tests for strict output classification, blinded case deduplication, metric denominators, and an empty/failed trial. Run them and observe the missing implementation failure.
- [x] Implement the experiment helpers with no new production API. Preserve the original directive as the fixed control and obtain candidate prompts from the production builder.
- [x] Run original-directive diagnostic trials before replacing it; preserve raw results as the control rather than asserting prose string equality.
- [x] Replace the directive verbatim and rerun context extraction, ordering, and byte-budget tests.

### Task 2: Live validation and publication

**Files:** `.test-artifacts/directive-validation-*`, `docs/research/2026-11-11-directive-validation.md`, rebuilt `dist/*`.

- [x] Resolve two available low-reasoning models (free endpoints failed; used Go alternatives); run three samples of each case for baseline, candidate, reminder-only, and few-shot-only arms with bounded concurrency and no silent retries.
- [x] Produce arm/model-blinded semantic review packets. Score intent, edit effort, unsupported assumptions, and language adherence; preserve disagreements and scoring limitations.
- [x] Summarize non-null precision, useful coverage, null rate, strict compliance, request failures, p50/p95 latency, and per-model differences against always-null.
- [x] Run `npm test`, `npm run typecheck`, `npm run bundle`, and `npm run test:package`. Inspect the task diff without discarding existing edits.
- [x] Publish results and reproducible commands. Report synthetic-only scope, unknown API controls, and any missing checks. Do not commit automatically.

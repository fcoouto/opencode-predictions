# Concise Predictions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate short contextual replies without repeating a known proposal or broadening approval.

**Architecture:** Update the existing shared directive in `src/predict.ts`. Keep parsing,
transport, and both host adapters unchanged; extend the existing diagnostic corpus.

**Tech Stack:** TypeScript, Node.js test runner, existing esbuild bundles.

**Spec:** `docs/superpowers/specs/2026-11-15-concise-predictions-design.md`

## Global Constraints

- No new settings, dependencies, output truncation, or composer behavior changes.
- Preserve the 32768-byte prompt budget and existing safety rules.
- Direct answers must respect explicit user limits and the current task's scope.

## Review Focus

- A recommendation within the user's task should allow a short contextual reply.
- One scoped approval must not become broader authorization.
- Multiple pending approvals and unrecommended choices must not become blanket acceptance.
- Optional scope and unmet approval prerequisites must not be silently accepted.
- Explicit language preferences must apply to short replies.

## Task 1: Shared directive and diagnostic coverage

**Files:** Modify `src/predict.ts`, `scripts/directive-cases.ts`, and `README.md`.
Generated bundles under `dist/` must be refreshed using the existing build script.

**Interfaces:** Keep `buildPrompt(turns: Turn[], count: number): string | undefined`
and `parseSuggestion(output: string): string | undefined` unchanged.

- [x] Review existing callers, directive, and diagnostic cases; obtain Opus review.
- [x] Install lockfile dependencies and verify the baseline: `npm test` (217 passing).
- [x] Add the seven review cases to the existing corpus with explicit semantic rubrics.
  These are model-evaluation inputs, not proof of model behavior.
- [x] Allow direct answers and discourage restatement only for supported, unambiguous
  recommendations and scoped approvals; retain abstention and explicit-limit rules.
- [x] Document concise contextual replies in README.
- [x] Run `npm run check`, `npm run test:package`, and `git diff --check`.
- [x] Request Opus diff review, address relevant findings, and repeat affected checks.

Prompt prose has no deterministic red/green semantic test. Do not substitute
exact-string assertions or a fake provider for model evaluation. Retain the existing
behavioral tests for payload construction, byte budget, parsing, and host acceptance.
Live provider evaluation and deployment are outside this run.

## Results

Opus design and fresh diff reviews completed. Both Important findings were fixed:
the directive now gates approval on satisfied prerequisites and stated limits;
the language diagnostic now specifies Portuguese despite an English assistant reply.
Final verification: 217 tests passed, typecheck and bundle passed, package check
passed (1 test), and `git diff --check` passed. All 23 diagnostic payloads were
validated for unique IDs, usable serialized context, and the 32768-byte budget.

Two minor diagnostic refinements remain deferred: isolate optional-scope behavior
from an explicit no-changes limit, and explicitly name selecting only one of two
approvals as a grading failure. No model quality or historical score comparison
is claimed. Changes remain uncommitted and are not installed or published.

# Completed-Response Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Predict from completed visible assistant replies without requiring a new user message.

**Architecture:** Relax `collectTurns()` at the shared filtering layer. Preserve latest-response validation in the service and use context-specific recovery copy in the client.

**Tech Stack:** Existing TypeScript, Node test runner and OpenCode RPC.

**Spec:** `docs/superpowers/specs/2026-11-14-completed-response-context-design.md`

## Global Constraints

- Exclude synthetic/system/reasoning/tool text and compaction summaries.
- Preserve idle/compaction boundaries, latest-response, cancellation and staleness guards.
- Use local generation stubs only for real-history replay; never persist real chat text.
- No dependencies, configuration changes or installed-plugin update.
- Independent review precedes PR merge into `main`.

## Review Focus

- Assistant-only context after compaction must not leak earlier user intent or summaries.
- Intermediate assistant text must not rescue an unusable final response.
- Synthetic trailing records must not be reclassified as user instructions.
- Manual historical requests without an idle record must retain settled-tool and completion checks.
- Missing context must not show a next-model or generic status-as-recovery hint.

### Task 1: Completed reply context and truthful feedback

**Files:** `src/predict.ts`, `src/service.ts`, `src/feedback.ts`, `src/client.ts`; corresponding predict/server/client tests; `README.md`; generated `dist/*`.

**Interfaces:** Keep existing `collectTurns(messages): Turn[]`, service Request/Reply, RPC and client contracts. Allow `Turn.user` to remain empty when the completed assistant has visible text.

- [x] Write synthetic regressions for all three reproduced shapes, assistant-only prompt filtering, compaction boundaries, current-response safety and actionable missing-context communication.
- [x] Run `node --test tests/predict.test.ts tests/server.test.ts tests/client.test.ts`; expect failures at missing assistant-only context and current copy.
- [x] Make the smallest collector/validation/copy changes. Run `npm test`; expect all green.
- [x] Replay the three identified history snapshots in memory with local stub generation. Expect each case to reach the stub and show a prediction, with no private record content in the prompt.
- [x] Run `npm run check`, `npm run test:package`, relevant server/native checks and whitespace checks; expect all green.
- [x] Commit, run one independent review and resolve material findings before authorized PR merge after CI.

## Implementation verification

- Baseline: 217/217. New regression run: six expected failures.
- Final-response guard regression failed after collector-only relaxation, then passed with explicit latest visible-text validation.
- Full suite: 224/224; typecheck, build, package and whitespace checks passed.
- Three original real-history snapshots: old code rejected all three in automatic and manual mode; fixed code reached exactly one local stub call per mode and displayed the prediction without the hint.
- Real histories stayed in memory; live requests were GET-only. Synthetic, reasoning and compaction-summary text did not reach the stub prompt.
- Server RPC: 4/4. Focused isolated Desktop: 1/1. Focused CLI PTY: 1/1, run sequentially.
- Independent read-only review approved the implementation with no Critical, Important or Minor findings. The reviewer ran 182 local tests and 12 additional synthetic checks. PR merge after CI is authorized; installation remains excluded.

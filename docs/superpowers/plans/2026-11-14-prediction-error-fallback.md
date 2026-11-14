# Prediction Error Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Restore automatic error fallback during alternatives and reserve abstention guidance for genuine null responses.

**Architecture:** Extend the existing service candidate loop and typed progress event. Keep controller ownership and client rendering; distinguish metadata refresh from generation.

**Tech Stack:** TypeScript, Node test runner, OpenCode V2 RPC, existing Desktop/CLI adapters.

**Spec:** `docs/superpowers/specs/2026-11-14-prediction-error-fallback-design.md`

## Global Constraints

- No dependencies, raw error disclosure, button or composer expansion. The user subsequently authorized commits, PR delivery and merge into `main`, but not installation.
- Current group first; never repeat a tried candidate in a cycle.
- Preserve automatic opt-in's single abstention transition, cooldowns, cancellation, staleness, eviction and retained-original recovery.
- Preserve muted communication, U+FFFB progress, platform shortcut labels and non-adoptable messages.

## Review Focus

- Generation timeout must permit fallback without allowing unbounded metadata waits.
- Catalog removal or cycle eviction must never restart paid generation.
- Failed attempts and metadata refresh must not masquerade as abstention.
- Stale progress and between-poll typing must not revive communication.
- Mixed failures must remain truthful without exposing provider payloads.

### Task 1: Service routing and outcome authority

**Files:** `src/service.ts`, `tests/server.test.ts`.
**Interfaces:** Consume existing Request/API; produce `escalation_refreshed`, failure notices and optional model-name progress metadata.

- [x] Write regressions for manual and automatic error cascades, stopping on null/text, timeout fallback, cancellation/staleness, no repeat after cooldown, metadata refresh and exhaustion.
- [x] Run `node --test tests/server.test.ts`; expect new regressions to fail at restricted routing and refresh outcomes.
- [x] Extend routing past offered target, bound each phase, classify final fixed summaries, publish actual attempted model independently of debug.
- [x] Run service tests and `npm test`; expect all passing after updating superseded assertions.

### Task 2: Client communication and progress transport

**Files:** `src/client.ts`, `src/controller.ts`, `src/rpc.ts`, `src/index.ts`, `src/gui.ts`, `src/tui.ts`, client/controller/host tests.
**Interfaces:** Consume Task 1 outcomes and optional progress modelName; produce live compact activity and genuine-null-only guidance.

- [x] Add regressions for live model changes, refresh silence, failure guidance suppression, safe cause/recovery, stale events, bounded cascades and retained originals.
- [x] Run focused tests; expect failures before changes.
- [x] Wire model-name progress, gate guidance by outcome, allow full bounded cascade and retain existing presentation.
- [x] Run `npm test` and `npm run typecheck`; expect all passing.

### Task 3: Documentation, artifacts and verification

**Files:** `README.md`, `src/feedback.ts`, `dist/*`, relevant `tests/host/*`.
**Interfaces:** Document Task 1/2 routing and preserve installed RPC compatibility with optional metadata.

- [x] Replace one-generation-call/error-stop statements; explain automatic opt-in and quota limitations.
- [x] Run `npm run check`, `npm run test:package`, server RPC, then Desktop and CLI gates sequentially; expect passing.
- [x] Run one fresh independent review of complete diff; fix material findings test-first.
- [x] Record evidence and unresolved limits. Leave changes local for user integration decision.

## Verification record

- `npm run check`: 217/217 unit/rendered tests, typecheck and bundle passed.
- Package: 1/1; real server RPC: 4/4; isolated Git installation: 1/1.
- Real Desktop: 11/11; real CLI PTY: 10/10, run sequentially.
- After the final live-catalog guard, rebuilt and reran both native fallback scenarios sequentially, server RPC and package checks; all passed.
- Independent review found one Important catalog-removal race. Reproduced RED, fixed by checking current owner identity before progress and again immediately before generation, then verified GREEN with the complete suite.
- Deferred Minor: mixed failures can still say “All prediction models failed.” despite a healthy earlier abstention or retained original.
- No paid provider experiments or live-user installation. After implementation verification, the user authorized commits, push, PR delivery and merge into `main`. Detailed local evidence is in `.superpowers/sdd/2026-11-14-prediction-error-fallback/`.

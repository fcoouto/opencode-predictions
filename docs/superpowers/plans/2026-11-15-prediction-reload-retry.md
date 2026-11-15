# Prediction Reload Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Native execution and Opus design/final reviews were authorized by the user.

**Goal:** Allow a fresh explicit prediction after a cancelled initial request without weakening automatic call suppression.

**Architecture:** Add established continuation authority to the existing controller result cache. Keep automatic attempts unchanged. Only accepted server reply outcomes grant authority; preserve it for that key even when the server cycle becomes unavailable.

**Tech Stack:** TypeScript, Node.js tests, existing esbuild/Vite bundles and isolated host fixtures.

**Spec:** `docs/superpowers/specs/2026-11-15-prediction-reload-retry-design.md`

## Global Constraints

- Keep public controller/client/service/RPC signatures, server safeguards, context selection, and directive unchanged.
- Establish authority only from current, non-aborted `text`, `no_suggestion`, or `escalation_refreshed` replies.
- Preserve authority across all subsequent replies, including `escalation_unavailable`, without losing real text. Typing clears communication but retains authority-only result entries.
- Do not change automatic attempt suppression, add automatic recovery calls, or clear attempts on all invalidations.
- Preserve scope/configuration isolation, typing/acceptance behavior, exhaustion handling, and the 128-entry result bound.
- No dependencies, version bump, installed-plugin update, global settings edits, release, or paid prediction experiments.
- Opus must review both design and final code. Its design review approved this approach and required the tests below.

## Review Focus

- A typed-and-cleared draft must not imply a server cycle.
- Both late success and late unavailable-cycle replies must leave current authority unchanged.
- Ordinary alternative failures must retain known authority and original text.
- Stale-cycle rejection after established authority must not restart generation; never-established attempts permit only explicit fresh retries.
- Exhausted existing cycles must remain generation-free on repeated shortcuts.

## File Map

- `src/controller.ts`: private cached authority and manual refresh decision.
- `tests/controller.test.ts`: focused authority, cancellation, failure, and stale-reply regressions.
- `tests/client.test.ts`: real client/controller/service reload reproduction with local provider stub.
- `tests/server.test.ts`: abstention, typing, and server-cycle eviction cost-safety proof.
- `README.md`: document explicit recovery without promising cross-configuration cache restoration.
- `dist/`: regenerate affected bundles/source maps, never hand-edit.

---

### Task 1: Implement and verify retry recovery

**Interfaces:** Existing `createController(io: ControllerIO)` and `startClient(host: ClientHost)` remain unchanged. Add only a private optional boolean on result entries.

- [x] **Step 1: Add controller regression tests before production code.**

  T1: Abort an initial request, return to the same key, and assert automatic request count stays one; the next explicit request with continuation enabled sends `undefined`.
  T2: Type and clear without a prior reply; the first manual request sends `undefined`.
  T3: Initial `generation_failed`, `timeout`, `service_unavailable`, and thrown transport errors never grant authority.
  T4: Accepted text, `no_suggestion`, and `escalation_refreshed` each grant `"refresh"` authority, including after typing and clearing.
  T5: Establish authority, consume an alternative token, fail with ordinary error/timeout/stale/unavailable-context, and assert the following request still sends `"refresh"`.
  T6: Reject a refresh with `escalation_unavailable`; assert original text remains paintable/adoptable, automatic requests stay suppressed, and the next explicit request still sends `"refresh"` rather than restarting a lost cycle.
  T7: After abort, late text must not grant authority; late `escalation_unavailable` must not revoke existing authority.
  T8: Existing typed cached-text and spent-token regression must remain unchanged with `[undefined, "spent", "refresh"]`.

- [x] **Step 2: Add real client/controller/service integration regression.**

  T9: Recreate service A as B with different local model settings. Hold B's first request before server contact, then invalidate again to cancel. Assert no old A text paints under B; shortcut sends no token; B generates exactly once, shows adoptable text, and repeated ticks add no requests.
  T10: Exhaust B's cycle, then repeat shortcuts. Assert `"refresh"` / `escalation_refreshed`, no new generation, and temporary "No alternatives available." communication.
  T11: Establish abstention authority, evict the server cycle with 128 other sessions, type and clear, then request again. Assert `"refresh"`, `escalation_unavailable`, and no generation. Preserve the existing real-text eviction test unchanged.

- [x] **Step 3: Observe RED.**

  Run `node --test tests/controller.test.ts tests/client.test.ts`. Require failures on spurious `"refresh"`, not fixture mistakes. For the Opus safety amendment, observe the controller/server eviction tests fail before changing sticky authority and the draft path.

- [x] **Step 4: Apply minimal controller fix.**

  Store the private authority boolean alongside cached `text` and `communication`. Use it instead of `attempted.has(key)` only for the manual no-offer continuation decision. In the existing live reply guard, establish from the three server outcomes and otherwise retain previous authority. Preserve authority-only entries when typing clears communication. Leave other paths unchanged.

- [x] **Step 5: Verify focused GREEN and documentation.**

  Run `node --test tests/controller.test.ts tests/client.test.ts tests/server.test.ts`; require zero failures. Document the next explicit fresh request after an unconfirmed cancellation, without automatic paid retry or restarting established cycles.

- [x] **Step 6: Run full gates and commit.**

  Run `npm run check`, `npm run test:package`, `git diff --check`, repeat-bundle consistency, and isolated installed-package server, Desktop, and CLI gates sequentially. Require passing output. Commit with `fix: recover prediction requests after settings reload`.

- [x] **Step 7: Obtain final Opus review.**

  Use a fresh `claude-agent/opus` reviewer on the complete branch, spec, plan, and evidence. Fix only in-scope findings with RED→GREEN proof and rerun affected gates. Require Opus approval before delivery.

### Task 2: Deliver through reviewed PR

**Interfaces:** Consumes the verified `fix/prediction-reload-retry` branch; produces a merged PR into `main`.

- [ ] **Step 1: Push branch and create PR.** Include scope, regression results, Opus reviews, and unchanged installed-plugin/configuration state.
- [ ] **Step 2: Wait for CI.** Run `gh pr checks <number> --watch`; verify mergeability, successful checks, and exact reviewed head.
- [ ] **Step 3: Merge and verify.** Squash with `--match-head-commit`, fetch `origin/main`, verify PR state and identical merged tree. Do not publish or update the installed plugin.

## Self-Review

All spec constraints and five Review Focus cases map to tests. The plan incorporates the Opus-approved sticky-authority amendment, preserving the existing eviction safeguard unchanged. User delegated design approval to Opus and authorized continuing through implementation and merge, so no additional handoff question is required.

## Verification Receipts

- Baseline passed 239 tests. Initial regressions showed five expected failures; the safety amendment then showed four expected failures before its fix.
- Final focused controller/client/server tests passed 156/156. Full suite passed 248/248, with typecheck, bundle, package validation, and whitespace checks passing.
- Packed installation passed 27 host checks sequentially: server RPC 4/4, Desktop 13/13, CLI PTY 10/10. Repeat build was byte-identical.
- Runtime edits are limited to `src/controller.ts`; service/client/context/model resolution and dependencies are unchanged.
- Opus approved the design, cost-safety amendment, and final code with no Critical or Important findings. The reviewer independently reran all 248 tests and typechecking, and inspected Desktop/CLI bundle alignment.
- Deferred optional minors: an existing missing exhaustion notice after typing without text, an exact mid-generation cancellation test beyond current indirect coverage, and normalizing the private optional authority flag to a strict boolean.
- CI remains the final delivery gate. Installed-package checks were verified natively, not repeated by the read-only reviewer.

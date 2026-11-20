# Manual Prediction Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the approved manual-mode instruction in an eligible empty Desktop composer.

**Architecture:** Add an optional availability callback to the existing client tick. Desktop resolves the effective host shortcut and paints a noneditable hint through its existing adapter, below real predictions and status messages in priority.

**Tech Stack:** Existing TypeScript, OpenCode GUI SDK, Playwright, and Node tests. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-19-manual-prediction-hint-design.md`

## Global Constraints

- Default macOS copy: `Press Option + Shift + P to request a prediction.`
- Require enabled predictions, `automatic=false`, eligible empty composer, and a bound request shortcut.
- Do not write editable content, generate automatically, intercept Tab, or replace a real prediction/status message.
- Preserve native placeholder, layout, accessibility, and caller-owned styles on cleanup.
- Keep the separate preferences plan and existing user documents untouched.

## Review Focus

1. A disabled/remapped shortcut must not advertise the default.
2. Pending requests and returned suggestions must suppress the hint.
3. Typing, IME, blur, and menus must remove the hint without modifying text.
4. A wrapped hint must not overlap toolbar controls at narrow widths.
5. Disconnected/invalid/disabled/new-session states must not promise an unavailable action.

---

### Task 1: Add and verify the manual-mode hint

**Files:**
- Modify: `src/client.ts`, `src/gui.ts`, `src/adapters/desktop.ts`.
- Test: `tests/desktop.test.ts`, `tests/host/desktop.test.ts`.
- Regenerate: committed `dist/*` through the existing bundle command.

**Interfaces:**
- Add optional `ClientHost.hint?(available: boolean): void`; invoke during the existing tick and withdraw during disposal.
- Add `createDesktopAdapter(...).hint(text: string | undefined): void`; retain existing paint/communicate behavior.
- Resolve `ctx.keybinds.keybind("opencode-predictions.request-shortcut")`, not a hardcoded shortcut.

- [x] **Step 1: Write rendered failing tests.** Assert a manual-mode eligible empty composer displays the approved copy, original editable text remains empty, no request occurs, Tab passes through, and configured keys/unbinding affect the hint. Cover all five Review Focus cases with real adapter/client/GUI code and synthetic host boundaries. Add hint presence/withdrawal assertions to the existing real manual Desktop flow.
- [x] **Step 2: Run** `node --test --test-name-pattern="manual.*hint" tests/desktop.test.ts`; expect missing hint failure, not an import/setup failure.
- [x] **Step 3: Implement** the two interfaces above. Reuse the current overlay, live announcement, eligibility, and resizing behavior. Keep hint mode distinct from status and prediction, with real content taking precedence. Format the configured key parts as readable names joined with ` + `. Do not add another interval.
- [x] **Step 4: Verify** with `node --test tests/desktop.test.ts tests/client.test.ts`, `npm test`, `npm run typecheck`, `npm run bundle`, `npm run test:package`, and the focused real manual Desktop test. Inspect wide/narrow rendered screenshots; record any unavailable native checks explicitly.
- [x] **Step 5: Review and hand off.** Obtain one read-only fresh review of this change; fix important findings with a failing test first. Leave changes uncommitted for the user; do not create a branch or touch the unrelated preference documents.

## Execution ledger

- Pre-flight: existing harness-managed linked worktree, detached HEAD; preserve unrelated untracked preference documents.
- Pre-flight: one task, no cross-task interfaces. `hint` is optional so terminal callers stay unchanged.
- Ruling: proceed inline from the user's explicit instruction; this small approved change does not reopen the separate preferences plan.
- Ruling: do not commit or create a branch without a user request; retain changes for review in the harness-managed worktree.
- Baseline: `npm test` passed 476/476 before implementation.
- RED: all four new rendered manual-hint tests failed waiting for the absent hint.
- GREEN: focused Desktop/client tests passed 56/56; full suite passed 480/480, with no skips.
- Verification: typecheck, bundle, package tests (2/2), and real isolated Desktop manual flow (1/1) passed.
- Visual inspection: reviewed 900px and 360px dark composer captures and the actual macOS Desktop capture in light theme. Hint stays outside editable content and above controls.
- Review: fresh read-only review found two important bugs: a wrapped hint could not shrink, and a saved empty session's creation timestamp could advertise missing context.
- Final: fixed resize/remapping shrink — `Desktop manual prediction hint shrinks after widening and shorter remapping` RED→GREEN.
- Final: fixed empty-session guidance — `Desktop manual prediction hint requires a completed reply, not a session creation timestamp` RED→GREEN; completed historical replies remain supported.
- Final: Ruling: check cached reply evidence only for Desktop guidance; preserve existing manual shortcut/request eligibility — avoids changing historical prediction behavior — costs conservative hint omission while messages are not loaded.
- Final verification: `npm run check` passed 482/482 tests with zero skips, typecheck, and bundle. Package tests passed 2/2. The real isolated Desktop manual flow passed 1/1 again after both fixes.
- Final review limits: no independent screen-reader session or full installed-host matrix was run. No minor findings deferred; no production preferences work performed. Changes remain uncommitted.
- Publication: the user subsequently authorized a new branch and pull request. This supersedes the earlier leave-uncommitted ruling for the manual-hint change only; the separate preferences proposal remains excluded.
- PR #27 integration on 2026-11-20: merged `main` at `f8319d5` into the feature branch. Only generated bundles conflicted; regenerated them from the merged source without changing feature behavior.
- Integrated verification: 483/483 unit tests, typecheck, bundle generation, 2/2 package tests, whitespace checks, and 1/1 focused real Desktop manual-hint test passed. The native test verified hint visibility, shortcut activation, hint withdrawal, and Tab insertion without submission.

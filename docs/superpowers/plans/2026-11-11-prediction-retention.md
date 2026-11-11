# Prediction Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the original prediction after acceptance, editing, and clearing, without regenerating it.

**Architecture:** Extend the existing bounded controller cache with an accepted marker. Keep accepted results through draft changes; retain the existing stable-context invalidation for unaccepted results. Both clients use the shared controller unchanged.

**Tech Stack:** TypeScript, Node.js test runner, existing Playwright/Desktop fixtures and build scripts.

**Spec:** `docs/superpowers/specs/2026-11-11-prediction-retention-design.md`

## Global Constraints

- Cache remains memory-only and shares the existing 128-attempt bound.
- Match server/location, chat, completion, and configuration version.
- Escape dismisses; typing before acceptance still invalidates.
- No new dependencies, host APIs, user configuration changes, or plugin installation.
- Preserve shortcut, notification, eligibility, and stale-response behavior.

## Review Focus

- Repeated acceptance must insert only when the draft is empty and the suggestion is visible.
- Accepted text edited during pending navigation status loading must restore only after the draft clears.
- Dismissal after restoration must prevent another automatic appearance.
- Changed completion/configuration/location must not expose cached accepted text.
- Cache eviction and disposal must remove accepted entries too.

---

### Task 1: Retain successfully accepted results

**Files:** Modify `src/controller.ts`, `tests/controller.test.ts`, `tests/client.test.ts`, `tests/desktop.test.ts`, `README.md`; regenerate `dist/gui-experimental.cjs`, `dist/tui.js`, `dist/tui.js.map`.

**Interfaces:** Preserve `createController(io: ControllerIO)` and its public methods. Keep `Snapshot.contextKey` for status-loading invalidation. The only new state belongs to existing cached results.

- [x] Add controller regressions for accept/clear and accept/edit/clear. Assert the original text returns, repeat acceptance succeeds, nonempty input blocks acceptance, and prediction calls remain `1`.
- [x] Update the navigation regression: accepted predictions may return; dismissed and unaccepted-then-edited predictions must not return.
- [x] Add tests for dismissal after restoration, key/location isolation, 129-entry eviction, disposal, and unsuccessful insertion not marking a result as accepted.
- [x] Add a client regression covering accepted edits during pending status reload, clearing, and navigation. Assert exact restoration with no additional prediction call; retain the existing unaccepted typing regression.
- [x] Extend the Desktop navigation regression to accept, edit, clear, and accept the original text again without sending or increasing prediction calls.
- [x] Run `node --test tests/controller.test.ts tests/client.test.ts tests/desktop.test.ts`; confirm the new acceptance-restoration assertions fail before implementation.
- [x] In `createController`, mark successfully inserted cached results as accepted. Hide on acceptance; do not delete accepted results during draft updates. Keep deletion for unaccepted draft invalidation, dismissal, eviction, and disposal.
- [x] Run the focused command again; require all tests passing.
- [x] Update README to distinguish hiding accepted predictions while editing from dismissing or invalidating unaccepted predictions.
- [x] Run `npm run check`, `npm run test:package`, `npm run test:host:desktop`, `npm run test:host:terminal`, and `git diff --check`; require zero failures.
- [x] Inspect the complete diff. Stage only retention files, generated bundles, and these approved documents; exclude the untracked `node_modules` symlink. Commit as `fix: preserve predictions across navigation and accepted edits`.

#### Final review follow-up

- [x] Reproduce the review finding: an aborted request's finalizer can repaint retained text after a subsequent live location change, before the next polling tick.
- [x] Suppress repaint from obsolete request finalizers in the shared controller; verify the client regression fails before the fix and passes afterward, then run the full check again.

### Task 2: Open and merge the retention PR

**Files:** Update the existing temporary PR body at `/private/var/folders/tz/c2kgm3r911ndfsbh8zm53lvc0000gn/T/opencode/chat-retention-pr.md`.

**Interfaces:** Branch `fix/preserve-chat-predictions`, base `main`, repository `fcoouto/opencode-predictions`.

- [x] Update PR behavior and verified counts; include accepted-edit restoration and the earlier intermittent native fixture timeout honestly.
- [ ] Push the branch without force and create the PR against `main`.
- [ ] Watch current-head checks. Do not merge on failed, absent, or pending checks.
- [ ] Squash-merge with `--match-head-commit` set to the verified PR head, then verify merged state and report the PR URL. Preserve this workspace and installed plugin state.

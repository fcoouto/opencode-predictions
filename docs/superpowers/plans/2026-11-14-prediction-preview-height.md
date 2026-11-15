# Prediction Preview Height Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Fit real Desktop predictions above composer controls, up to six lines, and restore normal layout when dismissed.

**Architecture:** Keep the existing non-editable overlay. Clamp its visible height and temporarily reserve matching editor space with reversible, owned style changes.

**Tech Stack:** TypeScript DOM adapter, Playwright rendered tests, existing isolated Electron host fixture.

**Spec:** `docs/superpowers/specs/2026-11-14-prediction-preview-height-design.md`

## Global Constraints

- Six visible lines maximum; ellipsis beyond that; full text preserved for Tab acceptance.
- No draft mutation, submission, provider/RPC/CLI changes or dependencies. The user subsequently authorized commits, PR delivery and merge into `main`, but not installation.
- Compact status messages must not grow the composer.
- Preserve original style values/priorities and all existing safety guards.

## Review Focus

- Bottom-anchored composers move when growing; preview must remain aligned above controls.
- Width/font changes must reflow without cumulative height growth.
- Typing, status transitions, navigation and disposal must release reserved space.
- Clamping must not alter the text accepted with Tab.
- Existing or externally changed host min-height must not be overwritten on cleanup.

### Task 1: Bounded preview growth and cleanup

**Files:** `src/adapters/desktop.ts`, `tests/desktop.test.ts`, `tests/host/desktop.test.ts`, `README.md`, generated GUI artifact.
**Interfaces:** Preserve `createDesktopAdapter` and host Composer contracts; no changes to controller or service.

- [x] Add rendered regressions for three-line growth, six-line cap/ellipsis, wrapping and resize, exact acceptance, status compactness and cleanup/style ownership.
- [x] Run `node --test tests/desktop.test.ts`; expect geometry/height failures with current fixed overlay.
- [x] Implement the smallest reversible reservation and six-line clamp. Run focused tests and `npm test`; expect green.
- [x] Add real Desktop multiline geometry/screenshot coverage with a synthetic provider; verify controls stay below text, dismissal restores height and Tab retains full text.
- [x] Run typecheck/build/package, full unit/rendered suite, relevant host gates and whitespace checks; inspect screenshots.
- [x] Run one independent review, fix material findings test-first and leave the implementation local for the integration decision.

## Verification

- Baseline 224/224. Rendered regression run failed four tests at the expected sizing, clamp and cleanup gaps.
- Full suite 230/230, typecheck, bundle, package and whitespace checks passed.
- Full real isolated Desktop suite 13/13 passed, including new three- and nine-line preview scenarios.
- Inspected dark narrow/wide browser fixture captures and native Desktop captures: controls stay below text, ninth-line input ends visibly with an ellipsis on line six, and no text enters the draft until acceptance.
- Independent read-only review approved with no Critical, Important or Minor findings. Additional reviewer checks covered geometry, repeated font reflow, host overrides and full acceptance.
- Final full unit/rendered rerun passed 230/230 with whitespace clean.
- No installed-plugin, configuration, service/RPC or CLI changes. The user subsequently authorized delivery from `fix/prediction-preview-height` through a PR merged into `main`.

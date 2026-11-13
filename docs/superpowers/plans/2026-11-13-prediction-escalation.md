# Prediction Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded prediction escalation and user-facing messages that Tab can never adopt as prediction text.

**Architecture:** Keep selection and one-call escalation authority in the service. Carry an optional next-model offer in the RPC reply, and preserve a separate communication path through the controller/client and existing host adapters. Reuse the existing request command and shortcut.

**Tech Stack:** TypeScript, Node test runner, existing OpenCode SDK 2.2.6, Playwright/OpenTUI fixtures, existing build scripts. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-prediction-escalation-design.md`

## Global Constraints

- Preserve existing prediction context, 32,768-byte budget, model selectors and reasoning variants.
- Tab accepts only real predictions; communication must never enter the draft or initiate a model call through Tab.
- Add only `escalation: "off" | "manual" | "automatic"`, default `"manual"`; retain `automatic` as the initial-trigger control.
- At most one extra model call per automatic escalation or explicit action; no error cascade inside that extra call.
- No package publishing, installing, user-config writes or paid prediction experiments. The user subsequently authorized committing, pushing a new branch and opening a PR; merging remains unauthorized.

## Review Focus

- A communication button must survive receiving keyboard focus, without preserving stale session authority.
- An old/replayed offer or changed target must not spend quota on an undisclosed model.
- A second abstention must not create an automatic loop or falsely make the model unhealthy.
- Typing, navigation or changed configuration during any asynchronous validation must prevent stale painting and further generation.
- Visible message text resembling a prediction must still pass Tab through; real prediction text with the same wording remains adoptable.

---

### Task 1: Escalation policy and service authority

**Files:** `src/options.ts`, `src/service.ts`, `src/rpc.ts`, `src/feedback.ts`; `tests/options.test.ts`, `tests/server.test.ts`, `tests/feedback.test.ts`.

**Interfaces:** Add `Options.escalation`; additive `Request.escalation?: string`; additive `Reply.escalation?: EscalationOffer`. Define `EscalationOffer` in `service.ts` with opaque `token`, target `group` (one-based), `model: ModelRef` and display `name`. Include optional mode in `Status` for client capability detection. The service owns bounded, one-use offers tied to session/completion and its current version; clients cannot select an arbitrary group.

- [ ] Add failing option tests for the default, all modes and invalid values.
- [ ] Add service tests for off/manual/automatic, next-group selection, empty/cooling groups, exact reasoning variant, one-call cap, error stopping, unchanged ordinary fallback and healthy abstention.
- [ ] Add service tests for invalid/replayed/cross-session/cross-completion offers, changed targets, concurrent duplicate actions, cancellation and action-wide deadline.
- [ ] Run focused tests and confirm failures describe missing escalation behavior.
- [ ] Implement mode parsing, bounded offers, escalation execution and additive RPC schema validation. Preserve existing queue ownership and health code.
- [ ] Show mode in status and add formatter tests without claiming automatic calls are free.
- [ ] Run focused tests and typecheck; require all passing.

### Task 2: Shared communication and safe manual activation

**Files:** `src/controller.ts`, `src/client.ts`; `tests/controller.test.ts`, `tests/client.test.ts`, `tests/client-feedback.test.ts`.

**Interfaces:** Add a typed communication presentation, separate from `paint(text)` and `insert(text)`. Pass the opaque offer only for an explicit escalation. Cache current reply/offer against the existing completion/config key, within the existing 128-entry lifecycle. Keep old-service behavior safe when metadata/mode is absent.

- [ ] Add failing tests proving communications and pending escalation never insert text or generate via Tab; prove a real prediction still accepts, even if its wording resembles plugin copy.
- [ ] Test shortcut/button advancement, repeated abstention, no later target, duplicate suppression and ordinary refresh in off mode.
- [ ] Test stale actions, location/config changes, typing and navigation during pending requests; preserve actual prediction restoration.
- [ ] Run focused tests and verify intended failures.
- [ ] Implement separate communication rendering and state-aware manual requests. Use the same client guards for all host actions.
- [ ] Run controller/client tests; require all passing.

### Task 3: Host affordances, documentation and release checks

**Files:** `src/adapters/desktop.ts`, `src/adapters/terminal.ts`, `src/gui.ts`, `src/tui.ts`, `README.md`; `tests/desktop.test.ts`, `tests/terminal.test.ts`, necessary existing host fixtures; tracked `dist/` outputs.

**Interfaces:** Extend adapters with a non-editable communication method. Desktop exposes a keyboard-focusable button and a callback; terminal exposes a non-editable message with `Alt+Shift+P` guidance. Both hosts send the same optional escalation token through typed RPC. Preserve the existing Tab command's false/pass-through result for non-predictions.

- [ ] Add failing rendered tests for outside-draft messages, target/quota copy, click and keyboard activation, Tab pass-through and real prediction adoption in both hosts.
- [ ] Check current SDK declarations/docs for the native surfaces; read Impeccable craft floor before UI edits.
- [ ] Implement host presentation without focus theft, per-abstention toasts or a new settings application.
- [ ] Document option modes, defaults, single-call limits, shortcut behavior and quota consequences.
- [ ] Run `npm test` and `npm run typecheck`; require zero failures.
- [ ] Run `npm run bundle` and `npm run test:package`; inspect generated diffs.
- [ ] Run available isolated native host checks and inspect rendered fixtures. Record unavailable prerequisites rather than claim visual verification.
- [ ] Review full diff and acceptance conditions; leave changes uncommitted and installed production unchanged.

## Self-review

Task 1 covers policy, privacy, service authority, health and budgets. Task 2 covers completion/config lifecycle and typed Tab gating. Task 3 covers both actual user entrypoints, outside-draft rendering, keyboard access, docs and generated artifacts. No new provider, prompt, confidence score, per-group configuration or telemetry is introduced.

## Completion record

- [x] Task 1 complete: option modes, service authority, bounded offers, deadlines, health and additive RPC schemas. Focused tests and typecheck pass.
- [x] Task 2 complete: separate communication state, context-bound queued intent, manual activation, duplicate protection and Tab gating. Focused tests pass.
- [x] Task 3 complete: Desktop native composer action, non-editable messages, CLI shortcut guidance, README and rebuilt distribution. Tests pass in both native hosts.
- [x] Fresh final review completed; three Important findings reproduced and fixed with RED→GREEN regressions. No Critical or deferred Minor findings.
- [x] Final verification: 180 repository tests, typecheck, bundle, package test, 2 real server checks, 5 real Desktop checks, 4 real CLI PTY checks, and `git diff --check` pass.

Desktop uses the SDK's native `ComposerPill` action rather than a custom DOM button. Its adjacent message remains non-editable. The earlier per-step checklists describe the executed test-first procedure; the completion record and ignored task ledger hold the actual outcome. Implementation was left uncommitted for the user's integration decision; the user then selected pushing a new branch and creating a PR. No install, package publishing, user-config change or paid-provider prediction evaluation was performed.

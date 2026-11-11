# Prediction Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface prediction failures with actionable, deduplicated toasts and an on-demand readable status view in Desktop and CLI.

**Architecture:** Keep service failure classification authoritative and share message/status formatting between both clients. Separate health/location inspection from prediction eligibility. Use native toasts for notifications and native dialogs for status; preserve existing RPC fields while adding optional structured notice and compatibility data.

**Tech Stack:** TypeScript, Node test runner, OpenCode plugin SDK 2.2.6, existing esbuild/Vite bundles.

**Spec:** `docs/superpowers/specs/2026-11-11-prediction-feedback-design.md`

## Global Constraints

- Preserve existing uncommitted shortcut and host-test changes; no commits without a separate request.
- Use installed OpenCode 2.2.6 plugin APIs and native UI; add no dependencies.
- Preserve model choice, group ranking, privacy, cancellation, and billing safeguards.
- Keep existing RPC reason/message fields when adding structured data, and handle missing new fields safely.
- No provider switching, automatic credential changes, automatic retries, persistent history, telemetry, or cache repair.
- A retry timestamp describes future eligibility, not a scheduled retry.

## Review Focus

- Polling and session changes must not spam the same location-wide issue; test unchanged issue across two completion keys.
- Recovery and an immediately recurring identical failure must notify again; test recovery without resetting on every poll.
- Manual requests while status is loading must settle with one outcome, without duplicate final events or extra generation.
- Old requests resolving after location changes or disposal must not overwrite status, toast, or suggestion state.
- Legacy/missing metadata and private exception contents must produce safe, accurate status rather than a false stale-installation diagnosis.

---

### Task 1: Safe structured failures and readable status formatting

**Files:** Create `src/feedback.ts`, `tests/feedback.test.ts`; modify `src/service.ts`, `src/rpc.ts`, `src/index.ts`, `tests/server.test.ts`, `tests/notifications.test.ts`.

**Interfaces:**
- Define `Notice = { code: string; severity: "info" | "warning" | "error"; title: string; message: string; persistent?: boolean }` in `src/feedback.ts`.
- Add optional `notice?: Notice` to `Reply`, and optional structured notice data to progress events while retaining `message`, `sessionID`, and `requestID`.
- Add optional service compatibility metadata to `Status`: `pluginVersion?: string`, `feedbackRevision?: number`.
- Export pure `statusNotice(status: Status): Notice | undefined` and `formatStatus(status: Status | undefined, details: { lastNotice?: Notice; suggestion?: string; diagnostics?: Record<string, unknown> }): { summary: string; details: string }`.
- Keep model failure summaries generated from the existing safe `failurePolicy`; never use arbitrary exception text as UI copy.

- [x] Write formatter tests asserting specific cause/recovery copy for invalid options, missing models, zero matches, authentication, cooldowns, and unknown-option warnings. Assert cooldown copy never promises automatic retry.
- [x] Write service tests asserting unexpected session/context/catalog failures return a safe structured notice, and private exception text never appears. Assert cancellation/staleness stay silent and existing queue behavior stays unchanged.
- [x] Run `node --test tests/feedback.test.ts tests/server.test.ts tests/notifications.test.ts`; verify new tests fail for missing feedback behavior.
- [x] Implement `Notice`, formatting, additive RPC schemas, service notice production, and package-version/feedback-revision metadata. Preserve legacy strings where required; mark final notices so clients can distinguish them from debug progress without parsing prose.
- [x] Run the same focused tests; require zero failures. Update old wording assertions only where the approved message behavior changed.

### Task 2: Client health, deduplication, and explicit request outcomes

**Files:** Modify `src/client.ts`, `tests/client.test.ts`, `tests/notifications.test.ts`; use `src/feedback.ts` from Task 1.

**Interfaces:**
- Add `ClientHost.scope(): string | undefined` for the connected server/location identity, independent of completion and focus.
- Change `ClientHost.status` to `status(signal: AbortSignal): Promise<Status>`; capture and validate scope around every status fetch.
- Change `ClientHost.show` to `show(notice: Notice): void`; add `ClientHost.openStatus(view: { summary: string; details: string }): void | Promise<void>`.
- Pass optional structured notice information through `ClientHost.predict` progress callbacks; retain legacy message handling for peers missing the new fields.
- Preserve `request`, `accept`, `dismiss`, `invalidate`, and `dispose` entrypoints. `status()` opens the native status view through the host. The separate shortcut entrypoint remains in PR #7, not this integration branch.

- [x] Add deterministic client tests for invalid/missing configuration, rejected status calls, safe failed replies, zero matches, and warnings. Assert blockers notify with debug off even before a completed session exists, without model calls.
- [x] Test one background notice across repeated status polls and two completion keys; changed issues notify; recovery followed by recurrence notifies; manual requests bypass suppression.
- [x] Test manual no-suggestion, disabled, missing-context, and occupied-composer outcomes. Preserve shortcut pass-through and no automatic generation for manual-only configuration.
- [x] Test last failure survives a healthy poll; status can reopen with readable summary/details. Test obsolete location/disposed responses and manual requests during a pending status fetch.
- [x] Run `node --test tests/client.test.ts tests/notifications.test.ts`; verify regression tests fail before changing client behavior.
- [x] Implement scope-owned health inspection, stable issue deduplication, remembered last failure, one final outcome per request, and status view output. Continue suppressing automatic no-suggestion/cancellation/staleness and successful fallback. Ensure legacy progress plus a final reply cannot duplicate an error.
- [x] Run client, feedback, notification, and server tests; require zero failures.

### Task 3: Native Desktop and CLI presentation, documentation, and release checks

**Files:** Modify `src/gui.ts`, `src/tui.ts`, `README.md`, `tests/host/desktop.test.ts`, `tests/host/terminal.test.ts`, and only the necessary existing host fixtures/observers. Rebuild tracked `dist/` artifacts using the existing build script.

**Interfaces:**
- Implement Task 2's `scope`, status lookup, `show`, and `openStatus` in both hosts.
- Desktop: `ctx.toast.show` with `variant: "error"` for errors, `persistent` for blockers, and an **Open prediction status** action. Track/dismiss obsolete persistent errors. Use `ctx.dialogs` for explicitly requested status and technical details.
- CLI: `ctx.ui.toast.show` with `error`/`warning`/`info` variants and command guidance. Use `ctx.ui.dialog` for status and technical details.
- Keep the existing **Prediction status and preview** command and all current shortcut behavior. Status dialogs are labelled snapshots and refresh on reopening.

- [x] Add host integration assertions for error severity, Desktop status action, and reopening readable status after dismissing the notification. Cover at least one invalid-config case and one transient unavailable case using isolated synthetic fixtures.
- [x] Verify host regression tests fail for the previous toast-only/JSON status behavior before wiring the new presentation.
- [x] Implement both host adapters using native dialogs and installed SDK types. Make configuration health available without requiring a completed response. Offer technical details separately and avoid automatic dialogs or focus theft.
- [x] Update README notification/status behavior, deduplication, debug policy, compatibility metadata, and retry wording. Preserve unrelated installation/model examples.
- [x] Run `npm test` and `npm run typecheck`; require zero failures.
- [x] Run `npm run bundle` and `npm run test:package`; require zero failures and inspect generated diffs for unrelated changes.
- [x] Run `npm run test:host:desktop` and `npm run test:host:terminal` against isolated fixtures when applications are available. Verify existing Tab and prompt behavior; leave the separate manual-shortcut work in PR #7.
- [x] Inspect final diff and mark this plan's completed checkboxes. Summarize tests, unchecked host behavior, and remaining risks; do not commit or repair the user's installed cache.

## Plan Self-Review

All spec behaviors map to the three tasks. Task 2 owns the five review-focus conditions, except privacy/compatibility formatting owned by Task 1. Host APIs were checked against installed SDK declarations. Desktop has persistent actionable toasts; CLI has variants and dialogs but no equivalent toast action/persistence API. No custom panel, dependency, or retry mechanism is needed.

## Verification status

126 unit tests passed after the independent review fix pass. Typecheck, bundle, package test, and server integration passed. Rebuilt-bundle CLI host checks passed 3/3; Desktop failure/status checks passed 2/2. Earlier full Desktop verification passed automatic predictions and both new failure/status flows (3/4); its manual Alt+Shift+P check failed before prediction starts. The command callback reported the session running while the observer reported it idle. That shortcut failure remains unresolved and was not rerun in the final filtered Desktop check. Do not treat full host verification as green or weaken the running-session eligibility guard.

## Independent review fixes

All six reproduced findings now have RED→GREEN regression coverage:
- A manual request waiting for health refresh suppresses automatic generation from an old cache.
- Explicit request ownership lasts through settlement, preventing duplicate health/final errors.
- Authoritative ready candidates clear current model failures and rearm notices despite warnings or a missed unhealthy poll. Last failure remains available.
- Legacy final events use actionable deduplication. Legacy debug progress is buffered until the final outcome identifies the last error event.
- Aborted requests cannot block or release newer requests in another location.
- Disabled configurations still warn about ignored options while status clearly says predictions are turned off.

No review findings were deferred. Existing Desktop shortcut work remains a separate unresolved host-verification limitation. No commits or installed-cache changes were made.

## PR integration

The user requested merge through a PR after implementation. The original checkout also contains unrelated, uncommitted shortcut work with its own PR #7. Integration therefore uses a separate `feat/prediction-feedback` worktree based on `main`, transplanting only notification/status changes. Shortcut code, shortcut-only tests, and shortcut diagnostics are excluded from this PR; original files and PR #7 remain untouched. The earlier shortcut failure is not claimed fixed.

The isolated feature tree passed 124 unit tests, typecheck, bundle, package exports, server integration, all three Desktop host cases, and both CLI host cases. The count differs from the combined checkout because its two shortcut-only unit tests are outside this PR. No installed plugin cache was changed. Commit/push/PR merge are authorized by the user's integration request.

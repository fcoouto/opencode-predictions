# Manual Historical Predictions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make explicit requests work with older completed history without changing automatic prediction eligibility.

**Architecture:** Carry an optional manual flag through the existing client and RPC path. The service may close a completed historical tail locally only for manual requests. Historical sessions without an idle timestamp use an updated-time revision and remain excluded from automatic requests.

**Tech Stack:** TypeScript, existing OpenCode V2 SDK, Node test runner, existing Playwright/native host fixtures.

**Spec:** `docs/superpowers/specs/2026-11-11-manual-history-design.md`

## Global Constraints

- No automatic fallback, extra automatic model calls, new dependencies, or configuration fields.
- No history writes, plugin installation, or user configuration changes.
- Preserve busy/interrupted, latest-turn, project, child-session, draft, cancellation, and stale-revision guards.
- Preserve retention, acceptance, dismissal, shortcuts, notifications, and memory bounds.

## Review Focus

- A pending or incomplete latest turn must not reuse an older completed answer.
- Compaction, failed compaction, and trailing selection metadata must retain their existing meaning.
- Missing idle timestamps must never silently enable automatic generation or permit a busy session.
- Session/location changes during manual work must prevent stale output and extra model calls.
- Default RPC behavior must remain strict; only explicit true enables the fallback.

---

### Task 1: Manual historical-context fallback

**Files:** Modify `src/service.ts`, `src/client.ts`, `src/rpc.ts`, `src/gui.ts`, `src/tui.ts`, `tests/server.test.ts`, `tests/client.test.ts`, `tests/desktop.test.ts`, `tests/terminal.test.ts`, and `README.md`; regenerate affected `dist` entries and source maps.

**Interfaces:** Add `Request.manual?: boolean`, `ClientState.automaticEligible?: boolean`, and an optional final `manual?: boolean` argument to `ClientHost.predict`. Missing automatic eligibility preserves current client behavior. Use `Session.time.updated?: number` only when a manual request has no idle timestamp or busy execution.

- [x] Add service regressions: yesterday's completed tail without idle succeeds only with `manual: true`; omitted/false flags return `context_unavailable` without generation; no-idle timestamp requires a matching updated revision and manual mode.
- [x] Add service guards for unanswered prompts, incomplete/interrupted/empty/tool-only tails, compaction boundaries, selection metadata, wrong locations, busy sessions, and revision changes during generation. Assert zero model calls for rejected context.
- [x] Add client tests asserting explicit shortcut/palette requests carry true, automatic calls carry false, and automatic-ineligible history requires an explicit request.
- [x] Add rendered Desktop and terminal-plugin tests for historical state and manual RPC flags. Verify empty eligible input, no automatic calls, exact Tab insertion without submission, and stale revisions.
- [x] Run focused tests with `node --test tests/server.test.ts tests/client.test.ts tests/desktop.test.ts tests/terminal.test.ts`; observe expected new assertions failing before implementation.
- [x] Implement the optional manual flag across the shared client, RPC, and both host callers. Preserve false/omitted strict behavior. Derive historical state revisions without enabling automatic requests.
- [x] In the service, permit a manual-only local boundary for a latest completed assistant tail. Keep existing context validation and turn filtering; use updated revision only for manual sessions without idle or busy metadata.
- [x] Run focused tests again; require all passing. Update README and run `npm run check`, `npm run test:package`, `npm run test:host:desktop`, `npm run test:host:terminal`, and `git diff --check` with zero failures.
- [x] Commit only task files and generated bundles. Keep the untracked `node_modules` symlink out of the commit.

### Task 2: Review and integrate

**Files:** Temporary PR body under the approved OpenCode temporary directory; no additional product scope.

**Interfaces:** Branch `fix/manual-historical-predictions`, base `main`, repository `fcoouto/opencode-predictions`.

- [ ] Obtain one read-only whole-branch review against the spec. Fix important findings with RED-to-GREEN regressions and rerun relevant/full checks.
- [ ] Push without force and create the PR, stating verified coverage and any untested real-chat limits.
- [ ] Watch current-head GitHub checks. Merge only after nonempty successful checks and use `--match-head-commit` for the verified head.
- [ ] Verify merged state and commit on `origin/main`; preserve the worktree and installed plugin state.

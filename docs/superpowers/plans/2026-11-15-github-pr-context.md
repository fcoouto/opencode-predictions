# GitHub PR Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Native implementation follows the user's “go ahead” instruction.

**Goal:** Add bounded, opt-in public/private GitHub PR reference context to predictions.

**Architecture:** Keep baseline prompt selection unchanged. An optional service callback fetches validated PR metadata, and a shared helper appends a size-bounded untrusted-data block without displacing conversation text. Default runtime wiring uses existing GitHub CLI credentials and fixed-host REST reads.

**Tech Stack:** TypeScript, Node.js `fetch`/crypto/child_process, existing test/build tools; no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-15-github-pr-context-design.md`

## Global Constraints

- `includeGithubPRContext` defaults to `false`; no credential/network access until enabled and selected context contains an eligible link.
- Only explicit HTTPS github.com PR links; at most two newest distinct PRs; no recursive expansion, comments, diffs, or arbitrary URLs.
- Fixed api.github.com GET endpoints, `redirect: "error"`, bounded credential command and response streams.
- 2,000 ms enrichment deadline, 256 KiB response cap, 60-second/64-entry session-and-credential-scoped memory cache.
- Titles at most 256 code points, descriptions 4,096; marked Unicode-safe excerpts.
- Total prompt stays at most 32,768 bytes. Additional metadata, including label, at most 8,192 bytes and never displaces base conversation.
- No credential/content logging, settings changes, paid prediction calls, dependency/version changes, push/merge/release, or installed-plugin update. Subsequent user authorization permits live public authentication checks and private checks only against a user-chosen PR.

## Review Focus

- A link only in discarded or compacted history must never trigger retrieval.
- An account change must never reuse private cached content from the previous credential.
- Cancellation or context change during retrieval must prevent generation and aborted-cache writes.
- Metadata near a full conversation budget must be dropped or excerpted, not evict protected conversation text.
- Refresh-only or stale/invalid alternative requests must not trigger credential or PR reads.

## File Map

- Create `src/github.ts` and `tests/github.test.ts`: link extraction, bounded retrieval/auth/cache, prompt appending, local fixtures.
- Keep browser-safe parsing, types, excerpts, and prompt appending in `src/github-prompt.ts`; only the server loader imports Node authentication/network helpers.
- Modify `src/options.ts`, `src/feedback.ts`, and their tests: opt-in validation/default/status.
- Modify `src/service.ts`, `src/index.ts`, `tests/server.test.ts`: optional retrieval seam, runtime wiring, fail-open/cancellation integration.
- Modify `README.md`: explicit consent, credential prerequisites, private-data disclosure and limits.
- Regenerate `dist/` with the existing build only.

---

### Task 1: Add safe metadata helper and opt-in controls

**Interfaces:** Export `LinkedPR`, `createGitHubContext(deps?)` returning `(sessionID: string, prompt: string, signal: AbortSignal) => Promise<readonly LinkedPR[]>`, and `appendGitHubContext(prompt: string, sources: readonly LinkedPR[]): string`. Test dependencies inject credential lookup, HTTP fetch, and clock.

- [x] Obtain independent builder/security review of the spec before production code.
- [x] Add failing helper and option tests. Assert all retrieval/credential/cache/response/budget requirements from the spec with literal local fixtures; test missing auth public fallback and authenticated private requests without logging or persistence.
- [x] Observe RED using `node --test tests/github.test.ts tests/options.test.ts`. Missing-module failure may establish the new module gap; implementation must then satisfy behavioral assertions.
- [x] Implement the minimal helper and option/status changes, preserving strict validation and existing defaults.
- [x] Run helper/option/feedback checks GREEN, then commit this coherent helper/control slice.

### Task 2: Wire prediction enrichment and verify end to end

**Interfaces:** Add optional `ServiceAPI.includeGithubPRContext(sessionID, prompt, signal)` and optional status boolean. Consume Task 1 exports; preserve existing request/reply interfaces.

- [x] Add failing service tests for default-off no reads, selected-context-only links, opt-in appended data, fail-open errors/timeout, no retrieval for metadata-only refreshes, and cancellation/staleness preventing generation.
- [x] Observe RED; wire the optional callback after no-spend alternative validation and before model attempts. Use the existing `abortable` guard and the shared 2,000 ms deadline; swallow only enrichment failure, not parent cancellation.
- [x] Wire `src/index.ts` with one helper instance per service setup. No auth/network side effects during factory creation.
- [x] Document settings and private-PR disclosure; keep the user's actual setting unchanged.
- [x] Run focused and full tests, typecheck, bundle, package validation, whitespace and repeat-build checks. Run isolated installed-package server checks; default-off path must remain compatible.
- [x] Commit, obtain independent whole-branch security/code review, fix in-scope findings with RED→GREEN proof, and rerun affected gates.
- [x] Report verified local branch and any remaining limits. Do not push, merge, enable, or update installed plugin without a new request.

## Self-Review

All five review conditions map to helper or service tests. GitHub/CLI documentation was fetched from official sources; Context7 was unavailable due quota. The user selected the proposed approach and explicitly said to proceed, so no repeated approval or execution-method question is required.

## Final Verification

- Baseline: 267 tests. Final suite: 296/296, with typecheck, production bundle, package validation, whitespace, and repeat-build checks passing.
- Fresh packed installation: server checks 5/5; installed bundle byte-matched the final source build.
- Independent review identified two Important findings: ownership capture after retrieval could admit removed models, and excerpted URLs could select another PR number.
- Both findings were reproduced in three failing tests, fixed at their responsible layers, and verified GREEN with the full suite. No findings remain unresolved; no second review was requested after the test-proven fix pass.
- Pure prompt logic remains browser-safe; authentication/network code is server-only. Existing concise-prediction and global-context-file behavior remains unchanged.
- No live PRs or credentials were read, no paid prediction was made, and the user's settings/installed plugin were not changed. Feature remains off by default on the local feature branch.

## Subsequent Rename and Live Qualification

- User requested `includeGithubPRContext` and a fresh independent review of the whole worktree.
- Renamed configuration, status, runtime callback, tests, docs, and bundles consistently. The unreleased old name is ignored with a warning and cannot enable PR disclosure.
- Rename regressions failed 12 checks before implementation; focused checks then passed 139/139. Full suite passed 297/297, with typecheck and production build.
- Live existing-account authentication passed. The production helper made one authenticated HTTP 200 read of a known public PR, reused its cache, and supplied bounded untrusted metadata to a local predictor stub only. Default-off bypass and credential exclusion both passed.
- No real prediction provider received the PR contents; two local stub generations were used.
- Private live-access qualification remains blocked pending a user-selected private PR URL. Mocked private-access coverage is not represented as a live private pass.
- Fresh installed-package qualifications passed sequentially: server 5/5, Desktop 13/13, CLI PTY 10/10, Git installation 1/1 (29 total). Package validation and repeat-build byte equality also passed.
- The full renamed worktree is being submitted for the requested fresh independent review. Private live-access remains explicitly pending, not a pass. No user settings or installed plugin were changed.

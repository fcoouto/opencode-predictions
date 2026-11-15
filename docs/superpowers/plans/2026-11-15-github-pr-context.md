# GitHub PR Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Native implementation follows the user's “go ahead” instruction.

**Goal:** Add bounded, opt-in public/private GitHub PR reference context to predictions.

**Architecture:** Keep baseline prompt selection unchanged. An optional service callback fetches validated PR metadata, and a shared helper appends a size-bounded untrusted-data block without displacing conversation text. Default runtime wiring uses existing GitHub CLI credentials and fixed-host REST reads.

**Tech Stack:** TypeScript, Node.js `fetch`/crypto/child_process, existing test/build tools; no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-15-github-pr-context-design.md`

## Global Constraints

- `githubPRContext` defaults to `false`; no credential/network access until enabled and selected context contains an eligible link.
- Only explicit HTTPS github.com PR links; at most two newest distinct PRs; no recursive expansion, comments, diffs, or arbitrary URLs.
- Fixed api.github.com GET endpoints, `redirect: "error"`, bounded credential command and response streams.
- 2,000 ms enrichment deadline, 256 KiB response cap, 60-second/64-entry session-and-credential-scoped memory cache.
- Titles at most 256 code points, descriptions 4,096; marked Unicode-safe excerpts.
- Total prompt stays at most 32,768 bytes. Additional metadata, including label, at most 8,192 bytes and never displaces base conversation.
- No credential/content logging, settings changes, live PR reads, paid prediction calls, dependency/version changes, push/merge/release, or installed-plugin update.

## Review Focus

- A link only in discarded or compacted history must never trigger retrieval.
- An account change must never reuse private cached content from the previous credential.
- Cancellation or context change during retrieval must prevent generation and aborted-cache writes.
- Metadata near a full conversation budget must be dropped or excerpted, not evict protected conversation text.
- Refresh-only or stale/invalid alternative requests must not trigger credential or PR reads.

## File Map

- Create `src/github.ts` and `tests/github.test.ts`: link extraction, bounded retrieval/auth/cache, prompt appending, local fixtures.
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

**Interfaces:** Add optional `ServiceAPI.githubPRContext(sessionID, prompt, signal)` and optional status boolean. Consume Task 1 exports; preserve existing request/reply interfaces.

- [ ] Add failing service tests for default-off no reads, selected-context-only links, opt-in appended data, fail-open errors/timeout, no retrieval for metadata-only refreshes, and cancellation/staleness preventing generation.
- [ ] Observe RED; wire the optional callback after no-spend alternative validation and before model attempts. Use the existing `abortable` guard and the shared 2,000 ms deadline; swallow only enrichment failure, not parent cancellation.
- [ ] Wire `src/index.ts` with one helper instance per service setup. No auth/network side effects during factory creation.
- [ ] Document settings and private-PR disclosure; keep the user's actual setting unchanged.
- [ ] Run focused and full tests, typecheck, bundle, package validation, whitespace and repeat-build checks. Run isolated installed-package server checks; default-off path must remain compatible.
- [ ] Commit, obtain independent whole-branch security/code review, fix in-scope findings with RED→GREEN proof, and rerun affected gates.
- [ ] Report verified local branch and any remaining limits. Do not push, merge, enable, or update installed plugin without a new request.

## Self-Review

All five review conditions map to helper or service tests. GitHub/CLI documentation was fetched from official sources; Context7 was unavailable due quota. The user selected the proposed approach and explicitly said to proceed, so no repeated approval or execution-method question is required.

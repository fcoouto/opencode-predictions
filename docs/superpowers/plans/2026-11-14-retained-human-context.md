# Retained Human Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve human intent when assistant-only continuation turns displace it from prediction context.

**Architecture:** Change only shared prompt selection and byte-budget handling in `buildPrompt()`. Reuse filtered turns from `collectTurns()` and retain the existing conversation array schema. Protect the latest human text and latest assistant reply while pruning optional history.

**Tech Stack:** TypeScript, Node.js native tests, existing esbuild/Vite bundles.

**Spec:** `docs/superpowers/specs/2026-11-14-retained-human-context-design.md`

## Global Constraints

- Total prompt budget remains 32,768 bytes, including unchanged directive and JSON encoding.
- `contextTurns` remains 1–5; a necessary human-only anchor is additional context, not another recent interaction.
- Preserve grouped steering messages, chronological ordering, Unicode-safe marked excerpts, and input immutability.
- Keep `collectTurns()` filtering, compaction boundaries, latest-response validation, cancellation, staleness, and escalation behavior unchanged.
- No dependencies, version bump, directive edits, output-classification changes, npm publication, installed-plugin updates, or paid prediction calls.

## Review Focus

- Byte eviction can remove an initially in-window human turn; retain its human text without its older assistant reply.
- A later user-bearing turn must replace earlier intent; never resurrect an obsolete request.
- Failed compaction must preserve eligible context, while successful compaction must erase earlier intent.
- Whitespace-only human messages must not suppress a usable earlier anchor.
- JSON escapes and supplementary Unicode characters must remain valid within 32,768 bytes.

## File Map

- `src/predict.ts`: shared history selection and budget-safe serialization.
- `tests/predict.test.ts`: direct context and excerpt regressions.
- `tests/server.test.ts`: capture actual service generation payload through existing stubs.
- `README.md`: explain additional retained human context and its privacy boundary.
- `dist/`: regenerate committed artifacts through `npm run bundle`, never edit manually.
- This plan: record gate results as execution progresses.

---

### Task 1: Retain human intent in bounded prediction prompts

**Interfaces:**
- Consumes: `collectTurns(messages: readonly unknown[]): Turn[]`, with `Turn = { user: string[]; assistant: string[] }`.
- Produces: unchanged `buildPrompt(turns: Turn[], count: number): string | undefined`, with the existing `{ user: string, assistant: string }[]` conversation payload.
- Service callers and output parsing remain unchanged.

- [x] **Step 1: Add failing direct regressions in `tests/predict.test.ts`.**

  Parse the JSON after `Conversation:\n` and assert:
  - One human-bearing turn followed by three assistant-only turns, with `count = 3`, produces a human-only anchor plus all three recent turns.
  - Anchor preserves both grouped human messages in order, excludes the older assistant reply, and appears only once.
  - `count = 1` retains the latest response and needed human anchor.
  - Human text already in the selected window is not duplicated; ordinary user/assistant histories keep existing count behavior.
  - A newer user-bearing turn supersedes the older one; whitespace-only human entries do not hide the last usable input.
  - Frozen turns remain unchanged across repeated calls; no human context still yields assistant-only context.
  - Successful compaction prevents inheritance; failed compaction preserves eligible intent; all existing private-payload exclusions remain true.
  - Oversized optional history cannot evict protected human text or latest assistant text, including when human text initially lay inside the window.
  - Oversized protected fields retain marked head/tail excerpts, valid JSON, no replacement characters, and `Buffer.byteLength(prompt) <= 32768`. Exercise emoji, quotes, backslashes, and newlines.

- [x] **Step 2: Confirm red tests.**

  Run `node --test tests/predict.test.ts`. Verify failures concern missing retained intent, not fixture or parser mistakes.

- [x] **Step 3: Implement minimal retention in `src/predict.ts`.**

  Find the latest turn with non-whitespace human text. Select and serialize recent turns without mutation. Add only that turn's joined human messages when absent. During budget pruning, preserve human text and the newest assistant response; older assistant text is optional. Reuse the existing excerpt marker and Unicode code-point binary search, measuring the complete serialized prompt each time. Keep directive and parser byte-for-byte unchanged.

- [x] **Step 4: Add service generation regression in `tests/server.test.ts`.**

  Extend existing local fixtures with a grouped human request, an older reply, and three completed assistant-only continuations. Assert the captured generation prompt retains grouped intent and the final response, excludes older assistant text and private payloads, and respects the byte limit. Verify both automatic and manual requests using existing fixture patterns.

- [x] **Step 5: Run focused checks.**

  Run `node --test tests/predict.test.ts tests/server.test.ts`. Expect zero failures.

- [x] **Step 6: Update `README.md`.**

  Explain that `contextTurns` bounds recent interactions, while the latest eligible human request can be retained separately. Document shared compaction/privacy boundaries and excerpt limits without promising speaker-role correctness.

- [x] **Step 7: Run full verification and rebuild.**

  Run `npm run check`, `npm run test:package`, `git diff --check`, and installed-artifact server checks against an isolated packed package. Expect all tests and typechecking to pass and only relevant generated bundle changes.

- [x] **Step 8: Replay the inspected chat locally.**

  Reuse the existing OpenCode session-context read pattern for `ses_e257c7d01ffdu4pmqA5olDFBF2`. Call only `collectTurns()` and `buildPrompt()` locally. Assert the donation-comparison request, grouped README steering, and final response survive; report booleans and byte counts only. If the existing service is unavailable, report that limitation and use a sanitized structural fixture instead. Never invoke generation or commit the transcript.

- [ ] **Step 9: Review and commit.**

  Review source, tests, documentation, and generated diff against the spec. Obtain an independent whole-branch review using the chosen execution method. Fix only in-scope findings, rerun affected gates, and commit the verified files with `fix: retain human intent in prediction context`.

### Task 2: Deliver verified change through a PR

**Interfaces:**
- Consumes: verified branch `fix/retain-prediction-user-context`.
- Produces: merged PR into `main`, with verified commit and CI receipts.

- [ ] **Step 1: Push and open the PR.**

  Include scope, retention/budget behavior, exact verification results, and the remaining wrong-speaker risk. State that installed plugin and global configuration remain unchanged.

- [ ] **Step 2: Wait for CI and verify the exact head.**

  Run `gh pr checks <number> --watch`. Require successful checks, a mergeable PR, and no unexpected commits.

- [ ] **Step 3: Merge the verified head into `main`.**

  Use `gh pr merge <number> --squash --match-head-commit <verified-head>`. Fetch `origin/main` and verify merged state and resulting tree. Do not create a release or update the installed plugin.

## Plan Self-Review

The task covers each spec behavior and all five Review Focus cases. Public function signatures and JSON record shape stay unchanged. No UI, provider, or dependency API changes are required.

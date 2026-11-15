# Global Prediction Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one optional global text/Markdown file with every prediction model attempt.

**Architecture:** Validate `contextFile` in existing plugin options. A server-only reader supplies bounded UTF-8 text through the service API; service cycles retain snapshots and the prompt builder quotes guidance within its existing byte budget. Existing notices and status expose safe metadata only.

**Tech Stack:** TypeScript, Node.js filesystem APIs, node:test, existing OpenCode plugin SDK, esbuild/Vite.

**Spec:** `docs/superpowers/specs/2026-11-15-global-prediction-context-design.md`

## Global Constraints

- Context file limit: 8192 bytes. Total prompt limit: 32768 UTF-8 bytes.
- No configured file preserves existing prompts byte-for-byte.
- No dependencies, watchers, telemetry, project-relative paths, or edits to the user's actual global configuration.
- Every attempt in one cycle receives the same guidance snapshot.
- No model calls, cooldowns, or ranking penalties from file failures.
- Filesystem imports remain server-only.

## Review Focus

- A growing file or named pipe must not cause unbounded reads or a blocked prediction.
- An empty file must not be reread during manual alternatives.
- Context containing `Conversation:` or code fences must not change protocol boundaries.
- File failure or cancellation must not poison a cycle or penalize a model.
- Guidance must never enter status, notices, RPC metadata, or client bundles.

---

### Task 1: Implement global context end to end

**Files:**
- Create: `src/context-file.ts`, `tests/context-file.test.ts`
- Modify: `src/options.ts`, `src/index.ts`, `src/predict.ts`, `src/service.ts`, `src/feedback.ts`
- Test: `tests/options.test.ts`, `tests/predict.test.ts`, `tests/server.test.ts`, `tests/feedback.test.ts`
- Integration test: `tests/host/server.test.ts`

**Interfaces:**
- Consumes: `createService(api: ServiceAPI, rawOptions: unknown, directory: string)`, `parseOptions(input: unknown)`.
- Produces: optional `Options.contextFile: string`; `readContextFile(path: string, signal: AbortSignal): Promise<string>`; optional `ServiceAPI.contextFile(path: string, signal: AbortSignal): Promise<string>`; optional third `buildPrompt(turns: Turn[], count: number, background?: string)` argument; optional `Status.contextFile: string`.

- [x] Add failing option tests: accept absolute and `~/` file paths; reject relative paths, URLs, empty values, wrong types, and controls.
- [x] Run `node --test tests/options.test.ts`; expect failures for the missing option.
- [x] Implement validation and unchanged defaults; rerun the option tests.
- [x] Add failing prompt tests for quoted guidance, one literal conversation boundary, 32768-byte Unicode/escaping budget, unchanged omitted/empty context, and no prediction from context alone.
- [x] Run `node --test tests/predict.test.ts`; expect failures for missing guidance.
- [x] Implement optional guidance and existing budget reuse; rerun prompt tests.
- [x] Add reader tests with real temporary files: 8192-byte boundary, 8193-byte rejection, UTF-8, whitespace, missing/directory/relative paths, invalid UTF-8/control bytes, home expansion, FIFO and cancellation.
- [x] Run `node --test tests/context-file.test.ts`; expect the missing reader module to fail.
- [x] Implement bounded regular-file reads with `finally` closure and cancellation checks. Rerun reader tests.
- [x] Add failing service and feedback tests: snapshot across fallback/escalation, reread on new completion/reload/off-mode refresh, empty snapshot, no read on metadata refresh, file failure/recovery without model penalties, cancelled/stale loading, and safe status/notices.
- [x] Run `node --test tests/server.test.ts tests/feedback.test.ts`; expect missing context integration failures.
- [x] Wire the server reader and service snapshot; add safe fixed notices and path-only status. Rerun focused tests.
- [x] Run `npm test`; expect all tests to pass, including Desktop and CLI coverage.
- [x] Add a real-server test that fails against the previous bundle, then passes after rebuilding. Verify home expansion, no project-file ingestion, unchanged history, and snapshot reuse over RPC.

### Task 2: Document, package, and review

**Files:**
- Modify: `README.md`, generated `dist/*`

**Interfaces:**
- Consumes: Task 1 option, snapshot semantics, error notices, and limits.
- Produces: documented global setup and rebuilt distributable entrypoints.

- [x] Document `contextFile`, global configuration example, UTF-8/8192-byte limit, server filesystem, reload behavior, safe precedence, and every-provider privacy warning. Correct the old statement excluding all instruction payloads.
- [x] Run `npm run typecheck`; expect no errors.
- [x] Run `npm run bundle`; expect successful server, CLI, RPC, pilot, and Desktop bundles without filesystem imports in the Desktop bundle.
- [x] Run `npm run test:package` and `npm test`; expect all checks to pass.
- [x] Review the entire diff with a fresh reviewer; fix important findings with regression tests.
- [x] Leave changes uncommitted for the user to inspect. Do not change live global settings or send private context to models.

## Execution notes

- Approved request authorizes implementation in the current isolated worktree; execute natively without another approval round.
- Baseline: 217 tests pass after `npm ci --ignore-scripts`. Existing Node FFI warnings and 24 moderate dependency advisories remain outside scope.
- Implementation: 235 unit tests pass. Five real-server tests also pass against an installed npm tarball, including literal dollar-pattern guidance.
- Compatibility: 144 comparisons against the pre-feature prompt builder are byte-identical across synthetic cases, turn counts, and omitted/empty/whitespace context.
- Opus review identified replacement-string expansion of dollar patterns in guidance. A regression test reproduced it, and using a replacement callback fixed literal text preservation and budgeting. The full suite, type checking, bundles, and installed-tarball server checks pass after the fix.
- Deferred review notes: filesystem-read timeouts retain the existing model-oriented timeout notice; unresponsive OS filesystem calls can outlive cancellation; foreign-platform absolute path syntax fails safely during loading rather than option parsing. Native Windows named pipes and real-model instruction compliance were not tested. Valid Unicode, including bidi/zero-width characters, remains permitted.

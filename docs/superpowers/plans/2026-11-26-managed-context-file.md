# Managed Context File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Desktop and CLI turn on a server-fixed `predictions-context.md` with one staged action, show its status, and open it locally, without any client-supplied path.

**Architecture:** The server owns the path. Save carries a top-level `contextFile: "managed" | "none"`; the preferences store (POSIX in TypeScript, Windows through the verifier) creates or adopts the fixed file and writes `settings.contextFile` in the same transaction. A new `contextFileStatus` RPC reports state and size, never contents. Clients stage the change in the setup editor and render a Context file row (Desktop) or menu (CLI).

**Tech Stack:** TypeScript (Node, Solid), C# verifier (`csc` .NET Framework 4, C# 5 only), `node --test` + Playwright fake host, Windows CI workflows (run on `pull_request`).

**Spec:** `docs/superpowers/specs/2026-11-26-managed-context-file-design.md`

## Global Constraints

- No RPC input carries a path, file name or contents. Save accepts only `contextFile: "managed" | "none"`; any other value makes `setup-service` throw `Error("Invalid save input.")`.
- Fixed file name `predictions-context.md`, in the directory of `preferencesPath(host)` (logical, never the realpath).
- Stored path: `~/` + forward-slash path relative to `host.home` when under home (all platforms; `options.ts` and `readContextFile` accept `~/`), else the absolute path.
- `managed` is decided by a pure `sameContextPath(a, b, platform)`: case-insensitive on `win32` and `darwin`, exact elsewhere, after `~/` expansion with the server's home.
- Create: exclusive create, empty, POSIX mode `0600`, Windows `Private(false)` ACL. Never overwrite or truncate.
- Adopt an existing fixed file only if all hold, else refuse with that reason:
  - not a link (POSIX `lstat`, open with `O_NOFOLLOW`; Windows no-follow open, not a reparse point) → "it is a link"
  - a regular file → "it is not a regular file"
  - exactly one link → "it has more than one link"
  - owned by the server's user → "it is owned by another user"
  - not writable by others: POSIX `mode & 0o002` is 0 (group write allowed); Windows passes `Safe(item, false, false)` → "other users can write to it"
  - macOS: no extended ACL (the `/bin/ls -lde` check in `safe()`) → "it has extra access rules"
- Refusal copy: `predictions-context.md exists but is not safe to use: <reason>. Fix or remove it, then save again.` It returns as `{ kind: "invalid", issues: [{ field: "contextFile", severity: "error", code: "unsafe_context_file", message }] }`, so the editor does not block the draft and the user can retry.
- Any failure leaves `predictions.json` unchanged. A file created before a later failure stays, empty, and the next Save adopts it.
- Reset to defaults never stages a `contextFile` change. Reload discards a staged change, like any draft edit.
- `applyPreferenceChange` keeps its signature. Callers that pass a whole save change (`setup-service.ts:77`, `setup.ts:157`) strip `contextFile` first; only the stores apply it.
- Copy (verbatim):
  - Not set: "Standing notes about you and your work, sent to prediction providers with every request. Up to 8 KB of text."
  - Staged on: "predictions-context.md will be created when you save."
  - Staged off: "The context file will stop being used when you save. The file stays on disk."
  - Ok: "<path> · <bytes> of 8,192 bytes" (bytes with thousands separators).
  - Empty: "Empty — nothing is sent until you add text."
  - Warnings (icon plus text): "Missing", "Too large: <bytes> of 8,192 bytes", "Not UTF-8 text", "Cannot be read".
  - Checking: "Checking the context file…".
  - Status unavailable: "Context file status is unavailable right now."
  - Old server: today's `setupText.contextFile` text, then "Update the Predictions plugin on the server to manage the context file here."
  - Open failure: "Could not open the file on this computer."
  - Buttons: "Use a context file", "Undo", "Open file", "Show in Finder" / "Show in File Explorer" / "Show in Folder", "Stop using", "Create it again", "Use predictions-context.md instead", "Check again".
- `npm run check` passes; Windows workflows pass in CI.

## Review Focus

- Save with `"managed"` while the config directory does not exist yet (first-ever save), POSIX and Windows: must succeed, not conflict.
- Fixed path is a symlink to a sensitive file: refused, never adopted, never read for status.
- Old server (`rpc.method_not_found` from `contextFileStatus`): Desktop and CLI never send the new save field. Any other status error is "unavailable" with Check again, never "old server".
- Draft with both a models edit and a context change: one Save applies both, or neither on failure.
- File larger than 8192 bytes: status says too large with its real size; predictions keep failing as today.

---

### Task 1: Context file status

**Files:** Modify `src/context-file.ts`; Test `tests/context-file.test.ts`

**Interfaces:**
- Produces: `export type ContextFileState = "ok" | "empty" | "missing" | "too_large" | "invalid" | "unreadable"`; `export async function inspectContextFile(absolutePath: string, signal: AbortSignal): Promise<{ state: ContextFileState; bytes?: number }>`. It `lstat`s first (`ENOENT` → `missing`; a link or non-regular file → `unreadable`), takes `bytes` from that size, then calls `readContextFile` to classify (`context_file_too_large` → `too_large`, `context_file_invalid` → `invalid`, `""` → `empty`, text → `ok`). Abort errors are rethrown; any other error → `unreadable`. Never returns text.

- [ ] **Step 1: Failing tests** with real temp files: absent → missing; `""` → empty bytes 0; `"hello"` → ok bytes 5; 9000 bytes → too_large bytes 9000; `Buffer.from([0xff])` → invalid; a directory → unreadable; a symlink to a valid file → unreadable; an already-aborted signal rejects; no result key holds file text.
- [ ] **Step 2:** `node --test tests/context-file.test.ts` → FAIL (not exported).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: inspect the context file without returning its contents`.

### Task 2: Paths, save types, and the POSIX store

**Files:** Modify `src/setup.ts` (types), `src/preferences-store.ts`; Test `tests/preferences-store.test.ts`

**Interfaces:**
- Produces, in `src/setup.ts`: `SaveInput` gains `contextFile?: "managed" | "none"`; `export type ContextFileStatus = { set: false } | { set: true; path: string; absolute: string; managed: boolean; state: ContextFileState; bytes?: number }`. (`path` is the stored value, for display; `absolute` is the server-resolved path, for Open/Show.)
- Produces, in `src/preferences-store.ts`: `export function managedContextPath(host: PreferencesHost): { stored: string; absolute: string }` (throws like `preferencesPath`); `export function expandContextPath(value: string, home: string): string`; `export function sameContextPath(a: string, b: string, platform: NodeJS.Platform): boolean`.
- Store `write(revision, input, signal)` keeps its signature. When `input.contextFile` is set it applies it to `settings` itself (`"managed"` → `settings.contextFile = managedContextPath(host).stored`; `"none"` → delete), and passes `input` without `contextFile` to `applyPreferenceChange`. For `"managed"` it ensures the file inside `transaction()` after `safe(parent, before.directory, true)` and before `stage(text, …)`, so the existing recheck that follows staging still guards the revision.
- A refusal throws a typed error that `write` returns as `{ kind: "refused_context", message }` (`PreferencesWriteResult` gains this kind).

- [ ] **Step 1: Failing tests** (real temp `XDG_CONFIG_HOME`, temp `home`):
  - first save with `"managed"` and no config directory → `written`; file exists, empty, mode `0600`; `settings.contextFile` is `~/…/predictions-context.md` when the root is under `home`, else absolute.
  - existing file with text and mode `0664` → adopted, text unchanged.
  - existing symlink, hard-linked file (`nlink 2`), FIFO, directory, world-writable file → `refused_context` with the matching reason; `predictions.json` bytes unchanged.
  - other-owner refusal: skipped unless running as root (document the skip).
  - `"managed"` when the setting already points at the fixed file and the file is missing → the file is recreated and `written`.
  - an empty `0600` file left from an earlier failed save is adopted.
  - `"none"` removes `settings.contextFile`, file still exists.
  - `sameContextPath` truth table for `linux`, `darwin`, `win32` (pure; runs on any CI).
- [ ] **Step 2:** `node --test tests/preferences-store.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: create or adopt the managed context file when saving`.

### Task 3: Windows verifier and Windows store (unit level)

**Files:** Modify `src/preferences-windows.cs` (`Request` gains `string context`, `Reply` gains `string reason`, `Execute` passes `request.context` to `Run`, `Run` gains a `context` parameter), `src/preferences-windows.ts` (`Request` type, `commitWindowsPreferences`), `src/preferences-store.ts` (`createWindowsStore.write`); Test `tests/preferences-windows.test.ts`

**Interfaces:**
- Consumes: Task 2 paths and `PreferencesWriteResult` kind `refused_context`.
- Produces: commit request gains optional `context: "create"`; `commitWindowsPreferences(before, systemPaths, next, signal, context?: "create")`. In `Run` (commit), after the `if (!chain.DirectoryExists) { … }` block and the `backupState` read-only check, and before `using (var stage = Stage(…))`: create `predictions-context.md` in `chain.Physical` with `CreateNew`, no-follow, `Private(false)`; if it exists, open it no-follow and apply the adoption rules; on refusal return `{ kind: "refused_context", reason: "<one of the reason strings>" }`. TS maps it to `{ kind: "refused_context", message: <refusal copy> }`. C# 5 only: no `$""`, no `?.`, no expression-bodied members.

- [ ] **Step 1: Failing unit tests** (fake `invoke`): the commit packet has `context: "create"` only when requested; a `refused_context` reply becomes `refused_context` with the refusal copy; a malformed `reason` is treated as `failed` (uncertain-safe).
- [ ] **Step 2:** `node --test tests/preferences-windows.test.ts` → FAIL.
- [ ] **Step 3:** Implement C# and TS. The C# compiles only on Windows; CI (Task 5) is its first build.
- [ ] **Step 4:** Unit tests PASS.
- [ ] **Step 5:** Commit `feat: create the managed context file through the Windows verifier`.

### Task 4: Service and RPC

**Files:** Modify `src/setup-service.ts`, `src/rpc.ts`, `src/index.ts`; Test `tests/setup-service.test.ts`, `tests/setup-rpc-api.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `createSetupService(store, models, runtime, paths: { managed: () => { stored: string; absolute: string }; home: string; platform: NodeJS.Platform })`; `index.ts` passes them from the server host. `saveSettings` input schema allows top-level `contextFile: { enum: ["managed", "none"] }`. Service `save`:
  - accepts `contextFile`; strips it before `applyPreferenceChange({}, change)`;
  - validates the prospective result with the context path it will have (`"none"` → `undefined`, `"managed"` → managed stored path, else stored), so an invalid hand-set value can still be cleared;
  - always calls `store.write` when `contextFile` is present;
  - maps `refused_context` to the `invalid` result in Global Constraints;
  - keeps `contextFile` out of `prospective`, and checks it separately for `saved`: the refreshed `stored.contextFile` must equal the expected value.
- New RPC `contextFileStatus`: input `{}`, output the `ContextFileStatus` shape (`additionalProperties: false`). Service `contextStatus(signal)` calls `runtime.refresh(signal)`, reads `stored.contextFile`; a non-string or invalid value → `{ set: true, path: String(value), absolute: "", managed: false, state: "unreadable" }`; else expands with `paths.home`, calls `inspectContextFile`, sets `managed` with `sameContextPath`.

- [ ] **Step 1: Failing tests:**
  - save `"managed"` → path written; next status `{ set: true, managed: true, state: "empty", bytes: 0 }` with `absolute` under the temp home, never the real home.
  - save with `contextFile: "/tmp/x"` throws `Invalid save input.`.
  - a stored relative `contextFile` (invalid) is cleared by `"none"`.
  - one save with a models edit and `"managed"` while the fixed path is a symlink → `invalid` (unsafe), and `models` and `contextFile` both unchanged.
  - `"managed"` again when the managed file is missing → recreated, result `saved`.
  - hand-set path → `managed: false`; 9000-byte file → `too_large`, `bytes: 9000`.
  - RPC output schema rejects extra keys.
- [ ] **Step 2:** `node --test tests/setup-service.test.ts tests/setup-rpc-api.test.ts` → FAIL.
- [ ] **Step 3:** Implement and register in `src/index.ts`.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: save and report the managed context file over RPC`.

### Task 5: Windows host tests in CI

**Files:** Test `tests/host/windows-preferences.test.ts` (and `tests/host/windows-preferences-runner.ps1` if cases need setup there)

- [ ] **Step 1: Write the cases** (run on Windows CI only), saving through the real `saveSettings` RPC: first save with `"managed"` and a missing `opencode` directory → written, no conflict, file exists with the private ACL; existing safe file adopted; existing reparse point, hard link, directory, and a file with a foreign write ACE each refused with their reason and `predictions.json` bytes unchanged.
- [ ] **Step 2:** Commit `test: cover the managed context file on Windows`.
- [ ] **Step 3:** Push the branch and open the `[BLOCKED]` draft PR (vibe-pull-requests); `gh pr checks <n> --watch` → all Windows jobs pass. Fix and repeat until green.

### Task 6: Client API and editor staging

**Files:** Modify `src/setup.ts` (`SetupAPI`, `SetupState`, `createSetupEditor`), `src/setup-gui-api.ts`, `src/setup-tui-api.ts`, `src/setup-copy.ts`; Test `tests/setup.test.ts`, `tests/setup-gui-api.test.ts`, `tests/setup-tui-api.test.ts`

**Interfaces:**
- Consumes: `ContextFileStatus` (Task 2), `contextFileStatus` RPC (Task 4).
- Produces: `SetupAPI.contextStatus?(signal): Promise<ContextFileStatus | "unsupported" | "unavailable">` — `rpc.unavailable` waits like `waitForSetupSnapshot`; `{ type: "rpc.method_not_found" }` → `"unsupported"`; anything else → `"unavailable"`. `SetupState` gains `context?: ContextFileStatus | "unsupported" | "unavailable"`, `contextLoading: boolean`, `contextChange?: "managed" | "none"`. Editor gains `setContextFile(change: "managed" | "none" | undefined)` and `refreshContext()`, which ignores replies older than the latest request (generation counter). `load()` clears `contextChange` and refreshes status; a successful save clears it and refreshes; `discard()` clears it; `resetPreferences()` leaves it; `dirty` includes it; `save()` sends it and strips it before its own `applyPreferenceChange` call; `setContextFile` is a no-op unless `context` is a `ContextFileStatus` and the snapshot is writable. `setupText.contextFile` becomes the not-set copy; keep the old sentence as `setupText.contextFileManual` for the old-server row.

- [ ] **Step 1: Failing tests:** staging marks dirty and save input carries `contextFile: "managed"`; discard and load clear it; reset leaves it; an `invalid` unsafe-file result keeps the draft unblocked so Save can retry; `rpc.method_not_found` → `"unsupported"` and `setContextFile` does nothing; a plain Error or `rpc.internal` → `"unavailable"`; `rpc.unavailable` then success → status; two overlapping `refreshContext` calls keep the newer reply.
- [ ] **Step 2:** `node --test tests/setup.test.ts tests/setup-gui-api.test.ts tests/setup-tui-api.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: stage the managed context file in the setup editor`.

### Task 7: Desktop Context file row

**Files:** Modify `src/setup-gui.ts` (row `predictions-advanced-context-file`); Test `tests/setup-gui.test.ts` (fake host gains `desktop: { os, launch, reveal }` logging calls, and per-test status replies)

**Interfaces:**
- Consumes: Task 6 editor API. Local = `ctx.desktop` exists and `pinned.target.serverID === "sidecar"`. Show label by `ctx.desktop.os`: macOS → Finder, Windows → File Explorer, else Folder. Open and Show use `status.absolute`, appear only when local and the state is not `missing`, and on `launch` rejection or `reveal` returning false show the open-failure copy.

- [ ] **Step 1: Failing tests**, one per state:
  - checking (loader and checking copy);
  - not set → "Use a context file" → staged copy + "Undo" → Save sends `contextFile: "managed"`;
  - set ok → display path and "1,204 of 8,192 bytes"; Open calls `launch(absolute)`, Show calls `reveal(absolute)`; "Stop using" stages `"none"` with its copy;
  - remote server → no Open/Show;
  - empty copy;
  - too large / missing / invalid / unreadable → warning line with the icon; missing hides Open/Show;
  - missing managed → "Create it again"; missing hand-set → "Use predictions-context.md instead";
  - "Check again" re-fetches;
  - unavailable → its copy and "Check again";
  - unsupported → old-server copy, no buttons;
  - read-only → staging buttons disabled, Open/Show/Check again enabled;
  - `launch` rejecting → open-failure copy.
- [ ] **Step 2:** `node --test tests/setup-gui.test.ts` → FAIL.
- [ ] **Step 3:** Implement with host components only (`ui.Button`, `ui.Menu`, `ui.Loader`, existing `note`/`warnings`/`box`).
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: manage the context file from Desktop settings`.

### Task 8: CLI Context file menu

**Files:** Modify `src/setup-tui.ts` (Advanced menu; the "about" alert at `setup-tui.ts:155` uses the new copy); Test `tests/setup-tui.test.ts`

- [ ] **Step 1: Failing tests:** Advanced lists "Context file" with a status description; its menu offers "Use a context file" when not set, "Stop using" when set, "Undo" while a change is staged, "Create it again" / "Use predictions-context.md instead" when missing, "Check again" when unavailable, and only the old-server text when unsupported; choosing then Save writes as in Task 4.
- [ ] **Step 2:** `node --test tests/setup-tui.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: manage the context file from the CLI`.

### Task 9: Docs and verification

**Files:** Modify `README.md` (Predictions Setup, Settings, Global standing context, Cost and privacy)

- [ ] Replace "set it directly in `predictions.json`" with the Settings flow; keep a short manual note for hand-set paths; state that Stop using keeps the file.
- [ ] `npm run check` → all pass. `impeccable detect --json --changed` → `[]` or fixed.
- [ ] Commit `docs: describe the managed context file`, then `chore: rebuild bundle` for `dist/`; push; Windows and check workflows green on the final head.

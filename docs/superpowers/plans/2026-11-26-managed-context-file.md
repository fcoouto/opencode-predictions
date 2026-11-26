# Managed Context File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Desktop and CLI turn on a server-fixed `predictions-context.md` with one staged action, show its status, and open it locally, without any client-supplied path.

**Architecture:** The server owns the path. Save carries a top-level `contextFile: "managed" | "none"`; the preferences store (POSIX in TypeScript, Windows through the verifier) creates or adopts the fixed file and writes `settings.contextFile` in the same transaction. A new `contextFileStatus` RPC reports state and size, never contents. Clients stage the change in the setup editor and render a Context file row (Desktop) or menu (CLI).

**Tech Stack:** TypeScript (Node, Solid), C# verifier (`csc` .NET Framework 4), `node --test` + Playwright fake host, Windows CI workflows.

**Spec:** `docs/superpowers/specs/2026-11-26-managed-context-file-design.md`

## Global Constraints

- No RPC input carries a path, file name or contents. Save accepts only `contextFile: "managed" | "none"`.
- Fixed file name `predictions-context.md`, in the directory of `preferencesPath(host)`.
- Stored path: POSIX `~/` + path relative to `host.home` when under home, else absolute; Windows absolute. Logical path, never the realpath.
- `managed` = stored path resolves to the fixed file; compare case-insensitively on `win32` and `darwin`.
- Create: exclusive create, empty, POSIX mode `0600`, Windows `Private(false)` ACL. Never overwrite or truncate.
- Adopt an existing fixed file only if: regular file, reached with no-follow, `nlink === 1`, owner is the server user, not world-writable (`mode & 0o002` is 0; group write allowed). Windows: passes `Safe(item, false, false)`. Refusal copy: `predictions-context.md exists but is not safe to use: <reason>. Fix or remove it, then save again.`
- Any failure leaves `predictions.json` unchanged.
- Reset to defaults never stages a `contextFile` change.
- Copy (verbatim): not set "Standing notes about you and your work, sent to prediction providers with every request. Up to 8 KB of text."; staged on "predictions-context.md will be created when you save."; staged off "The context file will stop being used when you save. The file stays on disk."; empty "Empty — nothing is sent until you add text."; old server "Update the Predictions plugin on the server to manage the context file here."; buttons "Use a context file", "Undo", "Open file", "Show in Finder" / "Show in File Explorer" / "Show in Folder", "Stop using", "Create it again", "Use predictions-context.md instead", "Check again".
- `npm run check` passes; Windows workflows pass in CI.

## Review Focus

- Save with `"managed"` while the config directory does not exist yet (first-ever save), POSIX and Windows: must succeed, not conflict.
- Fixed path is a symlink to a sensitive file: refused, never adopted, never read for status contents.
- Old server (no `contextFileStatus`): Desktop and CLI never send the new save field and say to update the server; a server that is only starting (`rpc.unavailable`) is not mistaken for old.
- Draft with both a models edit and a context change: one Save applies both, or neither on failure.
- File larger than 8192 bytes: status says too large with its real size; predictions keep failing as today.

---

### Task 1: Context file status

**Files:** Modify `src/context-file.ts`; Test `tests/context-file.test.ts`

**Interfaces:**
- Produces: `export type ContextFileState = "ok" | "empty" | "missing" | "too_large" | "invalid" | "unreadable"`; `export async function inspectContextFile(path: string, signal: AbortSignal): Promise<{ state: ContextFileState; bytes?: number }>` — reuses `readContextFile`; `bytes` from `stat().size` when the file opens; maps `ENOENT` → `missing`, `context_file_too_large` → `too_large`, `context_file_invalid` → `invalid`, whitespace-only → `empty`, any other error → `unreadable`. Never returns text.

- [ ] **Step 1: Failing tests** — one per state with real temp files (absent, `""`, `"hello"` → ok bytes 5, 9000 bytes → too_large bytes 9000, `Buffer.from([0xff])` → invalid, a directory → unreadable); the result object has no key holding file text.
- [ ] **Step 2:** `node --test tests/context-file.test.ts` → FAIL (not exported).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: inspect the context file without returning its contents`.

### Task 2: POSIX store creates or adopts the fixed file in the save transaction

**Files:** Modify `src/preferences.ts` (`applyPreferenceChange`), `src/setup.ts` (`SaveInput`), `src/preferences-store.ts`; Test `tests/preferences-store.test.ts`, `tests/preferences.test.ts`

**Interfaces:**
- Produces: `SaveInput` gains `contextFile?: "managed" | "none"`. `export function managedContextPath(host: PreferencesHost): { stored: string; absolute: string }` in `preferences-store.ts`. `applyPreferenceChange(overrides, input, managedPath?: string)` accepts the `contextFile` key; `"managed"` sets `next.contextFile = managedPath` (throws if `managedPath` is missing), `"none"` deletes `next.contextFile`; any other value throws "Prediction preference changes are invalid.".
- Store `write(revision, input, signal)` keeps its signature; when `input.contextFile === "managed"` it ensures the file inside `transaction()` after `safe(parent…)` and the first `recheck()`, before staging `predictions.json`.

- [ ] **Step 1: Failing tests** (real temp `XDG_CONFIG_HOME`):
  - first save with `"managed"` and no config directory → `written`; file exists, empty, mode `0600`; `settings.contextFile` is `~/…/predictions-context.md` when the temp root is under `home`, else absolute.
  - existing file with text and mode `0664` → adopted, text unchanged.
  - existing symlink, hard-linked file (`nlink 2`), FIFO, world-writable file → `failed` with the refusal copy; `predictions.json` bytes unchanged.
  - `"none"` removes `settings.contextFile`, file still exists.
  - `applyPreferenceChange` rejects `contextFile: "/etc/passwd"` and `contextFile: true`.
- [ ] **Step 2:** `node --test tests/preferences-store.test.ts tests/preferences.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Adoption uses `lstat` then `open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)` and compares identities, like `inspect()`.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: create or adopt the managed context file when saving`.

### Task 3: Windows verifier creates or adopts the fixed file in its commit

**Files:** Modify `src/preferences-windows.cs` (`Request`, `Run` commit branch), `src/preferences-windows.ts` (`Request` type, `commitWindowsPreferences`), `src/preferences-store.ts` (`createWindowsStore.write`); Test `tests/preferences-windows.test.ts`, `tests/host/windows-preferences.test.ts`

**Interfaces:**
- Consumes: `managedContextPath`, `applyPreferenceChange(…, managedPath)` (Task 2).
- Produces: commit request gains optional `context: "create"`; `commitWindowsPreferences(before, systemPaths, next, signal, context?: "create")`. In C#, after `CreateMissing(chain)` and the conflict recheck, before replacing `predictions.json`: create `predictions-context.md` in `chain.Physical` with `CreateNew`, `NoFollow`, `Private(false)`; if it exists, open no-follow and require `Safe(item, false, false)` and a regular file, else return `{ kind: "refused_context", reason }`. TS maps `refused_context` to `{ kind: "failed", message: <refusal copy> }`.

- [ ] **Step 1: Failing unit tests** (fake `invoke`): the commit packet includes `context: "create"` only when requested; a `refused_context` reply becomes `failed` with the refusal copy; `predictions.json` is not reported written.
- [ ] **Step 2:** `node --test tests/preferences-windows.test.ts` → FAIL.
- [ ] **Step 3: Host tests** in `tests/host/windows-preferences.test.ts` (run on Windows CI only): first save with `"managed"` and a missing `opencode` directory → written, no conflict, file exists with the private ACL; existing safe file adopted; existing reparse point refused.
- [ ] **Step 4:** Implement C# and TS.
- [ ] **Step 5:** Unit tests PASS locally; push the branch and confirm the Windows workflows pass (`gh pr checks`).
- [ ] **Step 6:** Commit `feat: create the managed context file through the Windows verifier`.

### Task 4: Service and RPC

**Files:** Modify `src/setup-service.ts`, `src/rpc.ts`, `src/index.ts`; Test `tests/setup-service.test.ts`, `tests/setup-rpc-api.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `saveSettings` input schema allows top-level `contextFile: { enum: ["managed", "none"] }`. Service `save` accepts the key, passes it to `store.write`, and treats a context change as a change even when `prospective` equals stored overrides. New RPC `contextFileStatus`: input `{}`, output `{ set: false } | { set: true; path: string; managed: boolean; state: ContextFileState; bytes?: number }`; service method `contextStatus(signal)` reads `runtime.state().stored.contextFile`, resolves `~/`, calls `inspectContextFile`.

- [ ] **Step 1: Failing tests** — save with `"managed"` writes the path and the next status is `{ set: true, managed: true, state: "empty", bytes: 0 }`; save with `contextFile: "/tmp/x"` throws "Unknown save field." or returns invalid (no write); a hand-set path reports `managed: false`; status for a 9000-byte file is `too_large` with `bytes: 9000`; a save that edits `models` and sends `"managed"` while the fixed path is a symlink returns `failed` and leaves both `models` and `contextFile` unchanged; on `darwin`/`win32` a stored path differing only in case reports `managed: true`; the RPC output schema rejects extra keys (no contents can leak).
- [ ] **Step 2:** `node --test tests/setup-service.test.ts tests/setup-rpc-api.test.ts` → FAIL.
- [ ] **Step 3:** Implement and register in `src/index.ts`.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: save and report the managed context file over RPC`.

### Task 5: Client API and editor staging

**Files:** Modify `src/setup.ts` (`SetupAPI`, `SetupState`, `createSetupEditor`), `src/setup-gui-api.ts`, `src/setup-tui-api.ts`; Test `tests/setup.test.ts`, `tests/setup-gui-api.test.ts`, `tests/setup-tui-api.test.ts`

**Interfaces:**
- Produces: `SetupAPI.contextStatus?(signal): Promise<ContextFileStatus | "unsupported">` — both APIs call `contextFileStatus`; `rpc.unavailable` goes through the same wait as `waitForSetupSnapshot`; any other RPC error → `"unsupported"`. `SetupState` gains `context?: ContextFileStatus | "unsupported"` and `contextChange?: "managed" | "none"`. Editor gains `setContextFile(change: "managed" | "none" | undefined)` and `refreshContext()`. `load()` and a successful save refresh status. `dirty` includes `contextChange`; `save()` sends it; `discard()` and a successful save clear it; `resetPreferences()` leaves it alone; `setContextFile` is a no-op when `context === "unsupported"`.

- [ ] **Step 1: Failing tests** — staging marks dirty and save input carries `contextFile: "managed"`; discard clears; reset leaves it; an API that throws `{ type: "rpc.method_not_found" }` (and one that throws a plain Error) yields `"unsupported"` and `setContextFile` does nothing; `{ type: "rpc.unavailable" }` then success yields the status.
- [ ] **Step 2:** `node --test tests/setup.test.ts tests/setup-gui-api.test.ts tests/setup-tui-api.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: stage the managed context file in the setup editor`.

### Task 6: Desktop Context file row

**Files:** Modify `src/setup-gui.ts` (row `predictions-advanced-context-file`), `src/setup-copy.ts`; Test `tests/setup-gui.test.ts` (fake host gains `desktop: { os, launch, reveal }` logging calls and per-test `contextStatus`)

**Interfaces:**
- Consumes: Task 5 editor API. Local = `ctx.desktop` exists and `pinned.target.serverID === "sidecar"`. Show label by `ctx.desktop.os`: `"macos"` Finder, `"windows"` File Explorer, else Folder.

- [ ] **Step 1: Failing tests**, one per state in the spec's row sketch: not set (button "Use a context file" → staged copy + "Undo" → Save sends `contextFile: "managed"`); set ok (path, "1,204 of 8,192 bytes", "Open file" calls `launch(path)`, Show calls `reveal(path)`, "Stop using" stages `"none"` with its copy); remote server (no Open/Show); empty copy; too large / missing / invalid / unreadable as warning lines with the icon; missing managed → "Create it again"; missing hand-set → "Use predictions-context.md instead"; "Check again" re-fetches; unsupported → old-server copy and no buttons; read-only → actions disabled.
- [ ] **Step 2:** `node --test tests/setup-gui.test.ts` → FAIL.
- [ ] **Step 3:** Implement with host components only (`ui.Button`, `ui.Menu`, existing `note`/`warnings`/`box`).
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: manage the context file from Desktop settings`.

### Task 7: CLI Context file menu

**Files:** Modify `src/setup-tui.ts` (Advanced menu); Test `tests/setup-tui.test.ts`

- [ ] **Step 1: Failing tests** — Advanced lists "Context file" with a status description; its menu offers "Use a context file" when not set, "Stop using" when set, "Create it again" / "Use predictions-context.md instead" when missing, nothing but the update message when unsupported; choosing then Save writes as in Task 4.
- [ ] **Step 2:** `node --test tests/setup-tui.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: manage the context file from the CLI`.

### Task 8: Docs and verification

**Files:** Modify `README.md` (Predictions Setup, Settings, Global standing context, Cost and privacy), `src/setup-copy.ts` if copy moved

- [ ] Replace "set it directly in `predictions.json`" with the Settings flow; keep a short manual note for hand-set paths; state that Stop using keeps the file.
- [ ] `npm run check` → all pass. `impeccable detect --json --changed` → `[]` or fixed.
- [ ] Commit `docs: describe the managed context file`, then `chore: rebuild bundle` for `dist/`.

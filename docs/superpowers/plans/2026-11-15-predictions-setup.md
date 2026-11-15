# Predictions Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Predictions Setup for all seven existing settings in Desktop and interactive CLI, with safe global-only configuration editing.

**Architecture:** First prove configuration persistence against an isolated real OpenCode server; stop if the safety gate fails. Then share server-owned settings operations and one client-side draft model between a native Desktop settings page and CLI menus. Existing JSON/JSONC configuration remains the only settings source.

**Tech Stack:** TypeScript, Node `>=26.4.0`, Node test runner, `@opencode/plugin` and `@opencode/client` `2.2.6`, Solid, existing OpenCode GUI/TUI controls, Playwright and PTY host fixtures.

**Spec:** `docs/superpowers/specs/2026-11-15-predictions-setup-design.md`

## Global Constraints

- Order: **Behavior**, **Models**, **Advanced**. Behavior labels: **Enable Predictions**, **Predict After Replies**, **Escalation Mode**.
- Add **Predictions Setup** to the Predictions command group without a default shortcut. Desktop also gets a native searchable **Predictions** settings page.
- Global configuration on the selected server only; overridden, ambiguous, or unsafe configurations are read-only. Never write the local client config for a remote server.
- Preserve comments, unrelated formatting, other plugins, unknown options, package references, omitted defaults, and unchanged settings.
- No second settings store, new plugin options, new framework, provider-auth UI, paid/free presets, benchmarking, queue-reset control, or automatic test generations.
- Draft edits require **Save changes** / **Discard changes**. Preview and saving must not generate predictions or alter the composer.
- Keep current parsing, model matching, group ownership, variants, ranking, fallback, quota warnings, and privacy behavior.
- Bounds remain `timeoutMs`: integer `1..2147483647`, default `8000`; `contextTurns`: integer `1..5`, default `3`; `debug`: default `false`; `escalation`: `"off" | "manual" | "automatic"`, default `"manual"`.
- Research and tests may write only isolated synthetic fixture configuration. The user subsequently authorized native execution; changing the user's global configuration, installing into their OpenCode, and pushing remain unauthorized.

## Review Focus

- An editor replaces configuration between validation and commit: no silent lost update; Task 1 must prove the guarantee or stop.
- Environment, managed, custom-path, symlinked, or duplicate plugin sources: no guessed writable target; Tasks 1–2 pin read-only behavior.
- Reload interrupts the save response: distinguish durable-but-not-active from failure without issuing a second blind write; Task 4 tests reconciliation.
- Saving changes or client reload re-arms the same completed turn: no surprise generation, even with `automatic: true`; Tasks 4 and 7 test this.
- A user changes servers while editing or receives late metadata: no cross-server save, discarded draft, stale preview, or composer mutation; Tasks 3, 5, and 6 test this.

## File Structure and Responsibilities

| Files | Responsibility |
| --- | --- |
| `tests/host/fixture.mjs`, `tests/host/persistence.test.ts`, `tests/host-fixture.test.ts` | Real-file configuration fixtures and the first feasibility gate. |
| `docs/research/2026-11-15-config-persistence-feasibility.md` | Versioned evidence, chosen backend, concurrency guarantee, supported sources, GO/NO-GO verdict. |
| New `src/config.ts`, `tests/config.test.ts` | Server-only source discovery, integrity-preserving edits, revision checks, persistence. |
| New `src/setup.ts`, `tests/setup.test.ts` | Shared serializable settings types, draft state, changed-field patches, save/preview coordination. No Node or host UI imports. |
| New `src/setup-service.ts`, `tests/setup-service.test.ts` | Server validation, metadata-only preview, and delegation to persistence. |
| `src/models.ts`, `tests/models.test.ts` | Shared grouped resolution; retain existing single-group resolver. |
| `src/rpc.ts`, `src/index.ts`, `src/service.ts` | Typed setup transport, actual config activation, service cleanup. |
| `src/client.ts`, `src/controller.ts`, related tests | Suppress same-turn regeneration and invalidate stale suggestions/offers. |
| New `src/setup-gui.ts`, `tests/setup-gui.test.ts`; existing `src/gui.ts` | Native Desktop settings page, model editor, entry points. Use `.ts` and existing `createComponent` pattern, not a JSX/build migration. |
| New `src/setup-tui.ts`, `tests/setup-tui.test.ts`; existing `src/tui.ts` | Native select/prompt CLI menus and entry points. No custom terminal renderer. |
| `src/feedback.ts`, feedback tests | Setup recovery copy without weakening existing safe diagnostics. |
| `tests/host/{server,desktop,terminal}.test.ts`, `tests/host/terminal.py`, `tests/host/observer/{gui,tui}.ts` | Packed real-host flows and composer/call-count evidence. |
| `README.md`, `dist/*`, `tests/package.test.mjs`, `scripts/test-installed.mjs` | User instructions, rebuilt entries, installed-package verification. |
| `package.json`, `package-lock.json` | Only if Task 1 establishes a necessary JSONC editing dependency; otherwise leave dependencies unchanged. |

## Task 1: Config Persistence Feasibility — Mandatory Go/No-Go Gate

**Files:** Modify `tests/host/fixture.mjs`, `tests/host-fixture.test.ts`; create `tests/host/persistence.test.ts` and `docs/research/2026-11-15-config-persistence-feasibility.md`. Test-only candidate code stays in the persistence test, not shipping entries.

**Interfaces:**
- Keep existing `createFixture(packagePath, options, behavior)` callers unchanged.
- Add optional fourth argument `{ configSource?: "inline" | "global-json" | "global-jsonc" }`, default `"inline"`.
- Real-file mode returns `configFile: string`; inline mode returns `configFile: undefined`. Add `writeConfig(config: object): Promise<void>` so later host tests can add observers without reintroducing `OPENCODE_CONFIG_CONTENT`.
- Existing `root`, `directory`, `env`, `api`, `calls`, `config`, and cleanup remain available. All HOME/XDG paths remain inside `.test-artifacts/host-*`.
- Produce a documented **GO** or **NO-GO** decision. Tasks 2–7 depend on **GO**, not merely a green test command.

- [ ] **Step 1: Record actual host capabilities without changing user configuration.**
  Read the current official plugin/config/API docs and the installed/pinned SDK types. Record CLI/Desktop/server versions, config discovery and precedence, plugin source identity, watcher/reload behavior, and whether a supported plugin-options write API now exists. The previously inspected API exposes only `shell`; do not invent a plugin-options patch. Prefer a supported host operation if it meets every gate.

- [ ] **Step 2: Add failing real-file fixture and persistence tests.**
  Test names: `real-file fixture has no inline config override`, `persistence preserves JSONC and plugin identity`, `stale and interleaved writers never lose edits`, `unsupported provenance is read-only`, `saved options activate without generation`.
  Required assertions include:
  ```ts
  assert.equal(fixture.env.OPENCODE_CONFIG_CONTENT, undefined)
  assert.ok(fixture.configFile?.startsWith(fixture.root))
  assert.equal(after.includes("// keep this comment"), true)
  assert.deepEqual(otherPluginAfter, otherPluginBefore)
  assert.equal(staleSave.kind, "conflict")
  assert.equal(fixture.calls.length, 0)
  ```
  Arrange all inputs inside the synthetic fixture. Include JSON/JSONC, custom config environment settings, both global filenames, npm/Git/local plugin references, duplicate entries, project/inline/managed overrides, malformed files, symlinks/hardlinks, and unwritable targets. Unsupported cases must refuse writes, not disappear from the report.

- [ ] **Step 3: Run RED checks and establish the sandbox.**
  Run `node --test tests/host-fixture.test.ts tests/host/persistence.test.ts`.
  Expect the new fixture/candidate assertions to fail before support exists. A missing host prerequisite is a recorded blocker, not a passing gate. Install project dependencies with `npm ci` only in the implementation workspace if needed.

- [ ] **Step 4: Implement the minimal test-only candidate and gather evidence.**
  Use the SDK's documented configuration location and resolved plugin-source metadata where available. Never identify an entry by a loose `"predictions"` substring or trust a client-supplied file path. When no authoritative source mapping exists, return read-only.
  Compare a supported host write operation with a narrowly scoped server-side writer. For a direct writer, test a proven JSONC syntax-tree editor, not regex or `JSON.parse`/whole-file stringify. If needed, evaluate `jsonc-parser`; document why it is necessary before adding it as a production dependency in Task 2.
  Exercise a barrier-controlled external edit both before validation and between final comparison and replacement, plus two simultaneous clients. Atomic rename prevents partial files; a hash check followed by rename is **not** compare-and-swap and alone cannot prove no lost updates. A lock honored only by this plugin cannot protect against external editors. If the supported backend cannot meet the approved safety guarantee, mark **NO-GO** and stop.

- [ ] **Step 5: Verify activation, attribution, and failure recovery on the actual host.**
  Prove source selection happens on the selected server, not a remote client's HOME. Write only fixture config; observe a real reload, query fresh status/options, restart the isolated server with the same fixture HOME/XDG paths, and read again. Interrupt reload/save acknowledgement and simulate permission/rename failures. Assert unchanged original bytes on pre-commit failure and zero provider calls. Record exact commands and observations, not presumed API behavior.

- [ ] **Step 6: Publish the verdict and stop if any release gate fails.**
  **GO requires:** authoritative global source and entry identity; JSONC/other-content integrity; permissions preservation; a demonstrated concurrency guarantee; safe failure outcomes; verified activation/restart; and server-local ownership. Document the supported/read-only matrix and API/version limits.
  If **NO-GO**, deliver the report and request a persistence/design decision. Do not build UI, relax conflict protection, add a second store, or silently narrow a safety promise. Passing tests for safe refusal still means **NO-GO** for writable setup.

- [ ] **Step 7: Commit the isolated fixture and report checkpoint.**
  ```sh
  git add tests/host/fixture.mjs tests/host-fixture.test.ts tests/host/persistence.test.ts docs/research/2026-11-15-config-persistence-feasibility.md
  git commit -m "test: establish prediction config persistence feasibility"
  ```

## Task 2: Production Global Config Store

**Depends on:** Task 1 **GO** and its documented backend.
**Files:** Create `src/config.ts`, `tests/config.test.ts`; modify the Task 1 host test to exercise production persistence. Update package files only for the JSONC editor proven necessary in Task 1.

**Interfaces:**
- In `src/setup.ts`, introduce `SettingKey = "models" | "enabled" | "automatic" | "escalation" | "timeoutMs" | "contextTurns" | "debug"` and `SettingsInput = Partial<Record<SettingKey, unknown>>`. Unknown values allow invalid existing settings to be displayed rather than silently defaulted.
- In `src/setup.ts`, define `ConfigSnapshot = { revision: string; source?: string; scope: "global"; writable: boolean; reason?: string; fields: SettingsInput }`.
- In `src/config.ts`, define `ConfigWriteResult = { kind: "written"; revision: string } | { kind: "conflict" | "read_only" | "failed"; message: string }`.
- `createConfigStore(host: ConfigHost): { read(signal: AbortSignal): Promise<ConfigSnapshot>; write(revision: string, patch: SettingsInput, signal: AbortSignal): Promise<ConfigWriteResult> }`.
- An own `models: undefined` key in this server-local patch means remove that property; omit untouched keys. Reject explicit `undefined` for other keys. Task 4 transports model removal through `removeModels`, never serialized `undefined`.
- Define `ConfigHost` in `src/config.ts` as the minimal server context adapter to the exact backend proven in Task 1. It must not accept arbitrary RPC-supplied paths or package names.
- Export `type ConfigStore = ReturnType<typeof createConfigStore>` for the server setup service.

- [ ] **Step 1: Add failing store tests using temporary files and injected backend barriers.**
  Assert unchanged fields retain their original bytes, comments, trailing commas, newline style, unknown options, omitted defaults, package strings, and other plugin entries. Assert:
  ```ts
  assert.deepEqual(result, { kind: "written", revision: expectedRevision })
  assert.equal((await store.write(oldRevision, { debug: true }, signal)).kind, "conflict")
  assert.equal((await unsafeStore.read(signal)).writable, false)
  assert.equal(await readFile(unsafePath, "utf8"), original)
  ```
  Cover missing/ambiguous files, string-form entries upgraded only when safely identified, invalid options objects, duplicate keys, symlinks/hardlinks, override sources, attempted extra patch keys, changed permissions, and failed commits.

- [ ] **Step 2: Run `node --test tests/config.test.ts`; expect RED for missing store behavior.**

- [ ] **Step 3: Implement `createConfigStore` using only Task 1's verified backend.**
  Read known editable fields only into responses; never return full global config or unknown option values. Preserve all other content on disk. Rediscover and revalidate target/provenance at commit, not only when opening setup. Revision is opaque to clients and covers every input the backend needs for conflict detection. Return fixed safe messages, not raw file/provider errors. An aborted pre-commit operation writes nothing; a committed operation must remain reconcilable after transport cancellation.

- [ ] **Step 4: Run `node --test tests/config.test.ts tests/host-fixture.test.ts tests/host/persistence.test.ts` and `npm run typecheck`; expect PASS with the same Task 1 safety guarantee.**

- [ ] **Step 5: Commit the store, its types, and tests.**
  ```sh
  git add src/config.ts src/setup.ts tests/config.test.ts tests/host/persistence.test.ts
  git commit -m "feat: persist prediction settings safely"
  ```
  Include package files in this commit only if changed for the approved JSONC dependency.

## Task 3: Shared Draft, Metadata Preview, and Read Contracts

**Files:** Extend `src/setup.ts`; create `src/setup-service.ts`, `tests/setup.test.ts`, `tests/setup-service.test.ts`; modify `src/models.ts`, `src/service.ts` grouped resolution, `src/rpc.ts`, `src/index.ts`, and `tests/models.test.ts`.

**Interfaces:**
- `SetupIssue = { field: SettingKey; group?: number; entry?: number; severity: "error" | "warning"; code: string; message: string }`.
- `SetupSnapshot = ConfigSnapshot & { effective: Options | null; catalog: CatalogModel[]; issues: SetupIssue[]; serviceVersion: string }`; import existing `Options` and `CatalogModel`.
- `SetupPreview = { groups: { selectors: string[]; candidates: Candidate[] }[]; issues: SetupIssue[] }`.
- `resolveModelGroups(selectors: readonly string[], catalog: readonly CatalogModel[]): Candidate[][]` in `src/models.ts` deduplicates across groups with earliest ownership, preserving variant distinctions.
- `createSetupService(store: ConfigStore, models: (signal: AbortSignal) => Promise<readonly CatalogModel[]>, current: () => { options: unknown; version: string }): { read(signal: AbortSignal): Promise<SetupSnapshot>; preview(fields: SettingsInput, signal: AbortSignal): Promise<SetupPreview> }`.
- RPC methods `settings({}) -> SetupSnapshot` and `previewSettings({ fields }) -> SetupPreview`; every call uses the selected server/location.
- Draft helpers in `src/setup.ts`: `readGroups(fields: SettingsInput): string[][] | undefined`, `patchGroups(groups: string[][] | undefined): SettingsInput`, and `changedFields(original: SettingsInput, draft: SettingsInput): SettingsInput`.
- `patchGroups(undefined)` produces a changed-field `models: undefined` deletion marker locally. Encode deletion as `removeModels: true` in the later save RPC, not JSON `undefined`; reject `removeModels` combined with `fields.models`. No other reset/deletion UI is added.

- [ ] **Step 1: Add failing normalization and metadata-only tests.**
  For absent models, text, arrays, nested arrays, wildcards, and overlapping variants, assert:
  ```ts
  assert.equal(readGroups({}), undefined)
  assert.deepEqual(readGroups({ models: ["local/a, local/b", ["local/c#low"]] }), [["local/a", "local/b"], ["local/c#low"]])
  assert.deepEqual(changedFields({ models: "local/a" }, { models: "local/a", debug: true }), { debug: true })
  assert.equal(providerGenerateCalls, 0)
  assert.equal(sessionContextCalls, 0)
  ```
  Pin exact numeric limits/defaults and all escalation values through `parseOptions`. Invalid syntax is an error; zero matches, disabled models, and unsupported variants are warnings that retain original entries. Test nested model IDs and Unicode names. Return overlap ownership explanations without changing the runtime ranking queue. Reject unknown transport keys.

- [ ] **Step 2: Run `node --test tests/setup.test.ts tests/setup-service.test.ts tests/models.test.ts`; expect RED for new interfaces.**

- [ ] **Step 3: Implement the helpers, setup service, and read/preview RPC schemas.**
  Use `parseOptions` as validation authority and `resolveModels`/`resolveModelGroups` for matching. Extract only grouped deduplication from `createService.refresh`; keep queue learning/cooldowns there. Preserve raw existing models byte-for-byte when only another setting changes; save edited groups as nested arrays. Empty UI model state means absence, never `models: []`; an empty present group is invalid. Never coerce invalid stored values into defaults. Keep unknown option values server-side.

- [ ] **Step 4: Run `node --test tests/setup.test.ts tests/setup-service.test.ts tests/models.test.ts tests/options.test.ts tests/server.test.ts` and `npm run typecheck`; expect PASS and no ranking regressions.**

- [ ] **Step 5: Commit read, draft, and preview support.**
  ```sh
  git add src/setup.ts src/setup-service.ts src/models.ts src/service.ts src/rpc.ts src/index.ts tests/setup.test.ts tests/setup-service.test.ts tests/models.test.ts
  git commit -m "feat: add prediction setup drafts and model previews"
  ```

## Task 4: Save, Activation, and Zero Surprise Generation

**Files:** Modify `src/setup.ts`, `src/setup-service.ts`, `src/rpc.ts`, `src/index.ts`, `src/service.ts`, `src/client.ts`, `src/controller.ts`; extend setup/service/client/controller tests and `tests/host/persistence.test.ts`.

**Interfaces:**
- `SaveInput = { revision: string; fields: SettingsInput; removeModels?: true }`.
- `SaveResult = { kind: "saved"; revision: string; serviceVersion: string } | { kind: "saved_not_active"; revision: string; message: string } | { kind: "invalid"; issues: SetupIssue[] } | { kind: "conflict" | "read_only" | "failed"; message: string }`.
- RPC `saveSettings(input: SaveInput) -> SaveResult`; fixed schemas, known fields only, no client filesystem target.
- Extend `createSetupService` with `save(input: SaveInput, signal: AbortSignal): Promise<SaveResult>`.
- `SetupAPI = { read(signal: AbortSignal): Promise<SetupSnapshot>; preview(fields: SettingsInput, signal: AbortSignal): Promise<SetupPreview>; save(input: SaveInput, signal: AbortSignal): Promise<SaveResult> }`.
- `SetupState = { snapshot?: SetupSnapshot; fields: SettingsInput; groups?: string[][]; issues: SetupIssue[]; preview?: SetupPreview; dirty: boolean; loading: boolean; previewing: boolean; saving: boolean; lastSave?: SaveResult; error?: string }`; error contains fixed safe copy.
- `createSetupEditor(api: SetupAPI, changed: () => void): SetupEditor`; methods `state(): Readonly<SetupState>`, `load(): Promise<void>`, `change(fields: SettingsInput): void`, `setGroups(groups: string[][] | undefined): void`, `preview(): Promise<void>`, `save(): Promise<SaveResult>`, `discard(): void`, `dispose(): void`. Pin one API target per editor instance.
- Add `createService(...).dispose(): void`, `createController(...).invalidate(): void`, and `client.invalidate(options?: { suppressAutomatic?: boolean }): void`.

- [ ] **Step 1: Add RED tests for save lifecycle and interrupted acknowledgements.**
  Assert validation precedes writing, conflicts/failures preserve draft, saving unchanged values does not write, and invalid drafts cannot save. With automatic mode on, assert:
  ```ts
  assert.equal(generateCallsAfterSave, generateCallsBeforeSave)
  assert.equal(oldPredictionSignal.aborted, true)
  assert.equal(oldOfferAccepted, false)
  assert.equal(composerDraft, "my existing draft")
  assert.equal((await editor.save()).kind, "saved_not_active")
  ```
  Test cancelled-but-committed writes, reload killing the RPC response, a second client, late progress/results, a service version change detected by polling, and a new completion still predicting normally. Test stale preview responses after another edit and disposed editors ignoring late responses.

- [ ] **Step 2: Run `node --test tests/setup.test.ts tests/setup-service.test.ts tests/client.test.ts tests/controller.test.ts tests/server.test.ts`; expect RED on save and same-turn regeneration.**

- [ ] **Step 3: Implement server save and shared editor.**
  Merge only changed keys against a fresh authoritative snapshot, handle explicit model removal, validate the full prospective options, and use the Task 2 write protocol. Keep fresh unknown options intact. Activation must use Task 1's proven watcher/read-back path, not a guessed reload API. Do not emulate persistence by mutating one in-memory service.
  Verify the requested known-field values in a fresh service before returning `saved`. If reload interrupts the response, the editor reconnects and reads back the global revision and effective fields; it never blindly repeats the write. Return/display saved-not-active when durable bytes are known but activation is unverified. Do not claim rollback or overwrite after an ambiguous outcome.

- [ ] **Step 4: Implement lifecycle invalidation without charging for Save.**
  Abort service-owned generation on unload, clear old offers, and prevent disposed work from publishing progress/results. `controller.invalidate()` clears cached results, attempted keys, and pending work without editing input. On config/plugin events, suppress automatic prediction for the current `{scope, completion key}` even after reconnect/reload; also detect changed service versions during polling. A new completed turn or explicit request remains eligible.
  Existing `client.invalidate()` immediately calls `tick()`, which can generate; do not reuse it unchanged. Apply suppression before the first refreshed tick, including when the plugin remounts on a completed chat. Prove the host's memory-only reload handoff or another no-persistent-settings mechanism in the host test; if remount suppression cannot be guaranteed, stop this task rather than ship extra calls.

- [ ] **Step 5: Run Task 4 unit tests, `npm run typecheck`, and `node --test tests/host/persistence.test.ts`; expect PASS, verified activation, and no extra generation in either client.**

- [ ] **Step 6: Commit save and lifecycle behavior.**
  ```sh
  git add src/setup.ts src/setup-service.ts src/rpc.ts src/index.ts src/service.ts src/client.ts src/controller.ts tests/setup.test.ts tests/setup-service.test.ts tests/client.test.ts tests/controller.test.ts tests/server.test.ts tests/host/persistence.test.ts
  git commit -m "feat: apply prediction setup changes without generating"
  ```

## Task 5: Native Desktop Settings

**Files:** Create `src/setup-gui.ts`, `tests/setup-gui.test.ts`; modify `src/gui.ts`, `src/feedback.ts`, `tests/desktop.test.ts`, `tests/client-feedback.test.ts`, `tests/feedback.test.ts`.

**Interfaces:**
- `registerSetupGUI(ctx: GUIContext, openStatus: () => Promise<void>): () => void` in `src/setup-gui.ts`; define `GUIContext` from the existing `Plugin.define` setup callback's inferred parameter type, using the public pinned SDK declaration confirmed in Task 1. Do not assume an export named `Plugin.SetupContext`.
- It registers command id `"setup"` with title **Predictions Setup**, settings page id `"predictions"`, and the same page-opening action for recovery/status links. Use `SettingsPage`, native `SettingsLayout`/`SettingsSection`/`SettingsRow` and available inputs from the pinned SDK.
- One `SetupEditor` per active page/server target. Do not read configuration from GUI storage or Node placeholders in the window process.

- [ ] **Step 1: Add failing rendered tests with host components and mocked SetupAPI.**
  Assert exact Behavior labels/order, Models second, Advanced third/collapsed, setup availability without session/completed response, and settings search entries.
  ```ts
  assert.deepEqual(sectionTitles, ["Behavior", "Models", "Advanced"])
  assert.deepEqual(behaviorLabels, ["Enable Predictions", "Predict After Replies", "Escalation Mode"])
  assert.equal(savedPatchHasOnlyEditedFields, true)
  assert.equal(submittedPrompts, 0)
  ```
  Exercise all seven settings; model/variant selection; group/entry movement; pattern preview; long/duplicate display names; keyboard-only editing; empty/loading/disconnected/read-only states; conflict and saved-not-active messages; unsaved navigation. Switching servers must request discard confirmation before creating a new pinned editor, never retarget an old save.

- [ ] **Step 2: Run `node --test tests/setup-gui.test.ts tests/desktop.test.ts tests/feedback.test.ts tests/client-feedback.test.ts`; expect RED on the new page and entry points.**

- [ ] **Step 3: Build using existing native components and Task 4's editor.**
  Load Impeccable's craft floor immediately before UI edits. Verify pinned SDK controls and settings navigation; do not invent props from newer docs. Add searchable model selection and accessible move-up/down/remove actions; preserve focus after movement/removal. Keep provider/model IDs as secondary identifiers, unavailable entries intact, and cost/ranking/escalation explanations adjacent to models.
  Update only configuration-related recovery notices to point at **Predictions Setup**; retain status actions for runtime errors. Add a setup action to the status view without converting it into an editor. If service setup methods are unavailable, show an update/read-only explanation; never fall back to client-side file writes.

- [ ] **Step 4: Run Task 5 tests and `npm run typecheck`; expect PASS.**
  Inspect native render at normal and narrow window widths, both themes, long Unicode names, error state, and keyboard focus. Batch captures under `.test-artifacts/setup-*`; screenshots of mocks alone do not prove native host behavior.

- [ ] **Step 5: Commit Desktop setup.**
  ```sh
  git add src/setup-gui.ts src/gui.ts src/feedback.ts tests/setup-gui.test.ts tests/desktop.test.ts tests/client-feedback.test.ts tests/feedback.test.ts
  git commit -m "feat: add native prediction settings on desktop"
  ```

## Task 6: Native CLI Menus

**Files:** Create `src/setup-tui.ts`, `tests/setup-tui.test.ts`; modify `src/tui.ts`, `tests/terminal.test.ts`, and any existing notification assertions affected by configuration-recovery copy.

**Interfaces:**
- `registerSetupTUI(ctx: TUIContext, openStatus: () => Promise<void>): () => void`; derive `TUIContext` from the pinned TUI setup signature if necessary.
- Palette command id `"predictions.setup"`, title **Predictions Setup**, group **Predictions**, no bind. Menu hierarchy and editors use Task 4's `SetupEditor` through selected server/location RPC.
- Use existing `ctx.ui.dialog.select`, `prompt`, `confirm`, and `alert`; nested cancel returns to the parent without discarding the shared draft.

- [ ] **Step 1: Add failing scripted-dialog tests.**
  Cover ordered sections/current-value summaries, all seven edits, absent models, adding/removing/reordering groups and entries, variants, patterns, warning previews, save/discard, and leaving dirty setup.
  ```ts
  assert.deepEqual(sectionTitles, ["Behavior", "Models", "Advanced"])
  assert.equal(draftAfterNestedCancel.debug, true)
  assert.equal(conflictPreservesDraft, true)
  assert.equal(savedOnRemoteServer, true)
  assert.equal(localConfigWrites, 0)
  assert.equal(composerDraft, "my existing draft")
  ```
  Also test disconnect during save, late metadata, no active session, unavailable service methods, long names/IDs, and read-only explanation.

- [ ] **Step 2: Run `node --test tests/setup-tui.test.ts tests/terminal.test.ts tests/notifications.test.ts`; expect RED for setup menu behavior.**

- [ ] **Step 3: Implement section-based native dialogs and recovery/status entry points.**
  Load the craft floor before UI edits. Show **Save changes**, **Discard changes**, and secondary status access at the root. Use explicit named move actions, native searchable selection, and prompts for patterns/numbers. Keep number parsing strict; no `parseInt("8000oops")` acceptance. Preserve draft through submenus and write failures; confirm discard on exit. Keep host navigation keys and Tab behavior outside setup unchanged.

- [ ] **Step 4: Run Task 6 tests and `npm run typecheck`; expect PASS.**
  Inspect wide and narrow PTY rendering, focus, wrapped warnings, and long model names with the real host in Task 7.

- [ ] **Step 5: Commit CLI setup.**
  ```sh
  git add src/setup-tui.ts src/tui.ts tests/setup-tui.test.ts tests/terminal.test.ts
  git commit -m "feat: add prediction setup menus to cli"
  ```
  Include changed notification tests if needed.

## Task 7: Packed Two-Host Proof and Documentation

**Files:** Modify `tests/host/{server,desktop,terminal}.test.ts`, `tests/host/terminal.py`, `tests/host/observer/{gui,tui}.ts`, `tests/package.test.mjs`, `scripts/test-installed.mjs`, `README.md`; rebuild committed `dist/*`.

**Interfaces:** Use Task 1's real-file fixture and `writeConfig()` for setup host scenarios. Keep existing inline-config scenarios to test read-only override handling. New observer actions may dispatch public setup/status commands and inspect draft/call counts; they must not replace UI-driven saves with direct RPC shortcuts.

- [ ] **Step 1: Add failing end-to-end tests through the public setup controls.**
  Desktop and CLI must each configure all seven settings, reorder groups, save, reopen, and verify config/status after reload. Use two API clients against the same fixture server for cross-client visibility. Preserve synthetic composer input and user-message counts through open/cancel/save/error flows.
  Include JSONC comments/other plugins, conflict between clients, interrupted acknowledgement, a zero-match warning, remote target attribution, read-only inline/project override, and a no-session setup flow. With `automatic: true` on an existing completed turn, save without new provider calls; then complete a new turn and prove automatic prediction still works.

- [ ] **Step 2: Run `npm run bundle`, then focused new server, Desktop, and CLI tests sequentially; expect RED until native integration gaps are fixed.**
  Use `node --test --test-name-pattern="setup" tests/host/server.test.ts`, then equivalent Desktop and terminal commands. Use test names containing `setup`. Do not run graphical/PTY host gates concurrently.

- [ ] **Step 3: Finish integration, package checks, and user documentation.**
  Document both entry points, Behavior/Models/Advanced order, global/server scope, overrides/read-only behavior, Save/Discard, no-generation preview, cost warnings, and conflict/activation recovery. Keep manual JSON instructions for advanced users.
  Extend package tests for setup RPC methods and ensure Node-only persistence stays out of the GUI bundle. Add persistence proof to `scripts/test-installed.mjs`; run host files sequentially so the installed gate actually tests the packed artifact, not a workspace-only dependency or inline override.

- [ ] **Step 4: Run complete verification and record exact results.**
  ```sh
  npm run check
  npm run test:package
  node --test tests/host/persistence.test.ts
  npm run test:host:server
  npm run test:host:desktop
  npm run test:host:terminal
  npm run test:host:git
  npm run test:installed
  git diff --check
  ```
  Expect every command to exit `0`; record actual counts/versions. Capture normal/narrow native Desktop and CLI setup states and inspect them. If a host is unavailable, report it as unverified, not passed. No paid model or user-install tests are required.

- [ ] **Step 5: Review the complete change and commit delivery artifacts.**
  Use the execution method selected by the user for independent review; self-review the persistence boundary even if Task 1 was green. Fix findings with regression tests and rerun affected gates. Update this plan with evidence and remaining limits.
  ```sh
  git add README.md dist tests/host tests/package.test.mjs scripts/test-installed.mjs
  git commit -m "test: verify installed prediction setup across hosts"
  ```

## Plan Self-Review

- Spec coverage: entry points and settings hierarchy in Tasks 5–6; group semantics/validation in Task 3; persistence in Tasks 1–2; save/lifecycle behavior in Task 4; accessibility/states in Tasks 5–7; packed compatibility and documentation in Task 7.
- Shared interfaces are defined above before consumers. Discovery backend details deliberately depend on a real feasibility verdict, not an assumed write API.
- Every Review Focus condition has an explicit owning test. Task 1's interleaved-writer test cannot be weakened to hide the filesystem compare-and-swap gap.
- At authoring, no execution had started. The execution record below tracks subsequent work; unchecked steps do not imply a completed feature.

## Execution Handoff

Review this plan before implementation. Recommended approach: **Native**, with a hard stop after Task 1 for the recorded feasibility verdict and one fresh whole-branch review at the end. The shared persistence, reload, RPC, and UI contracts are tightly coupled; one implementer avoids coordination churn.

Alternative: **Subagent-driven**, with fresh task implementers/reviewers after the feasibility gate. Neither method may start Tasks 2–7 after a NO-GO verdict without an approved design change.

## Execution Record

- Native execution authorized on 2026-11-15 in the existing isolated worktree.
- Task 1 halted at Step 4 with **NO-GO**. The supported API rejects plugin-option writes; the direct candidate loses a racing external edit after its final comparison.
- Added real-global-file fixture support with observed RED/GREEN tests. Added actual server API/discovery checks and deterministic negative concurrency characterizations.
- Report: `docs/research/2026-11-15-config-persistence-feasibility.md`.
- Step 5 (successful-save activation/restart), broader unsupported-source scenarios, and Tasks 2–7 remain unexecuted. No production code or user configuration changed.
- Verification: persistence/fixture checks 10/10; combined persistence/fixture/existing server compatibility 14/14; project suite 217/217; typecheck and diff whitespace checks passed.
- The gate remains NO-GO despite green characterization tests. Checkpoint and independent review pending.

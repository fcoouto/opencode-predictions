# Predictions Setup Implementation Plan

> Historical plan. Persistence and Save transport are superseded by the approved [prediction preferences plan](2026-11-18-predictions-preferences.md). Original implementation notes and findings are preserved below.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Predictions Setup for the eight scoped settings in Desktop and interactive CLI, including `includeGithubPRContext` in Advanced, with best-effort global-only configuration editing.

**Architecture:** Use the qualified server-side JSON/JSONC writer and shared draft model, retaining the accepted external-editor race. Read and preview use inspection-only network RPC; Save uses private local IPC behind independently verified native-host origin gates. Existing JSON/JSONC configuration remains the only settings source.

**Tech Stack:** TypeScript, Node `>=26.4.0`, Node test runner, `@opencode/plugin` and `@opencode/client` `2.2.6`, Solid, existing OpenCode GUI/TUI controls, Playwright and PTY host fixtures.

**Spec:** `docs/superpowers/specs/2026-11-15-predictions-setup-design.md`

**Approved amendment:** `docs/superpowers/specs/2026-11-15-predictions-setup-local-save-design.md`

> **Current resume point: Task 4.** Tasks 1–3 and the guard checkpoint (`83e3de2`) are committed. Private transport, initial production adapters, and server authority lifecycle exist but remain uncommitted and incompletely qualified. After explicit user approval, Desktop's bundled 2.3.0 server passed isolated persistence and native main-IPC Save/readback qualification. The macOS writer now accepts exact versions 2.2.6 and 2.3.0; CLI standalone origin remains restricted to 2.2.6. The RPC startup race is fixed with bounded metadata-only waiting. Full Task 4 native lifecycle, GitHub-setting, boundary, and installed gates remain open.

## Global Constraints

- Order: **Behavior**, **Models**, **Advanced**. Behavior labels: **Enable Predictions**, **Predict After Replies**, **Escalation Mode**.
- Add **Predictions Setup** to the Predictions command group without a default shortcut. Desktop also gets a native searchable **Predictions** settings page.
- Global configuration on the selected server only; overridden, ambiguous, or unsafe configurations are read-only. Never write the local client config for a remote server.
- No network Save or proof-signing RPC. Desktop writes require main-process `ServerEndpoint.sameMachine === true`. CLI writes require independently qualified `--standalone` private-server provenance; shared-service, explicit-server, overridden, conflicting, and unprovable launches remain read-only.
- Use a same-user Unix socket in a private `0700` temporary directory with socket mode `0600`. The client derives paths from its own canonical temporary directory and a strict opaque ID, never a server-supplied path. Unsafe or unavailable local IPC is read-only.
- Native origin authorization precedes socket access and repeats before dispatch. Metadata, PID, loopback URLs, launch flags alone, and relayed signatures are not proof of selected-server locality.
- Preserve comments, unrelated formatting, other plugins, unknown options, package references, omitted defaults, and unchanged settings.
- Serialize all supported setup writers addressing the same file; reject stale drafts and detected changes before replacement. Use atomic replacement and one rotating private server-local recovery copy outside active config discovery; backup failure aborts the write.
- The user accepted the last-check/replacement race with external or other non-cooperating writers, including possible loss of unrelated edits. Backups cannot guarantee capturing those edits. This exception does not weaken any cooperating-writer or source-integrity safeguard.
- No second settings store, new plugin options, new framework, provider-auth UI, paid/free presets, benchmarking, queue-reset control, or automatic test generations.
- Draft edits require **Save changes** / **Discard changes**. Preview and saving must not generate predictions or alter the composer.
- Keep current parsing, model matching, group ownership, variants, ranking, fallback, quota warnings, and privacy behavior.
- Bounds remain `timeoutMs`: integer `1..2147483647`, default `8000`; `contextTurns`: integer `1..5`, default `3`; `debug`: default `false`; `escalation`: `"off" | "manual" | "automatic"`, default `"manual"`.
- Advanced includes **Include GitHub PR context** (`includeGithubPRContext`), a boolean switch defaulting to `false` as introduced in merged PR #25. Show the parent spec's warning that linked private PR descriptions/metadata may reach every attempted prediction provider, including fallback and paid models. Setup operations must not fetch PR data or look up GitHub credentials.
- Research and tests may write only isolated synthetic fixture configuration. The user subsequently authorized native execution; changing the user's global configuration, installing into their OpenCode, and pushing remain unauthorized.

## Review Focus

- Cooperating setup writers must serialize and reject stale revisions; a detected external edit must abort. Characterize the accepted post-check race honestly; backups do not eliminate it. Tasks 1–2 own these tests.
- Environment, managed, custom-path, symlinked, or duplicate plugin sources: no guessed writable target; Tasks 1–2 pin read-only behavior.
- Reload interrupts the save response: distinguish durable-but-not-active from failure without issuing a second blind write; Task 4 tests reconciliation.
- Saving changes or client reload re-arms the same completed turn: no surprise generation, even with `automatic: true`; Tasks 4 and 7 test this.
- A user changes servers while editing or receives late metadata: no cross-server save, discarded draft, stale preview, or composer mutation; Tasks 3, 5, and 6 test this.
- A remote/proxy target advertises a local authority or relays its responses: reject it at the native origin gate before socket access. Task 4 owns negative host and transport tests; Tasks 5–7 retain rendered and installed coverage.
- Temporary-path differences, long socket paths, stale sockets, unsafe permissions, or disappearing authority: stay read-only or report an uncertain save accurately, never scan or switch targets. Task 4 owns these tests.
- `includeGithubPRContext` must stay default-off and preserve omitted/explicit-false states. Task 4 covers whitelist, validation, persistence, and activation; Tasks 5–7 cover the Advanced control, disclosure, and no GitHub/provider calls during setup.

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
| New `src/setup-local.ts`, `tests/setup-local.test.ts`, `tests/host/setup-local.test.ts` | Bounded same-user Unix socket protocol, server lifecycle, local client, origin qualification and real Save/reload proof. No config writes outside the existing server service. |
| New `src/setup-ipc.ts`, `src/setup-main.ts`, `src/setup-gui-api.ts`, `tests/setup-main.test.ts` | Window-safe IPC contract, Desktop main-process origin gate, and pinned window `SetupAPI` adapter. |
| New `src/setup-tui-api.ts`, `tests/setup-tui-api.test.ts` | Qualified standalone CLI origin gate and pinned `SetupAPI` adapter; other launch modes inspect only. |
| `src/client.ts`, `src/controller.ts`, related tests | Suppress same-turn regeneration and invalidate stale suggestions/offers. |
| New `src/setup-gui.ts`, `tests/setup-gui.test.ts`; existing `src/gui.ts` | Native Desktop settings page, model editor, entry points. Use `.ts` and existing `createComponent` pattern, not a JSX/build migration. |
| New `src/setup-tui.ts`, `tests/setup-tui.test.ts`; existing `src/tui.ts` | Native select/prompt CLI menus and entry points. No custom terminal renderer. |
| `src/feedback.ts`, feedback tests | Setup recovery copy without weakening existing safe diagnostics. |
| `tests/host/{server,desktop,terminal}.test.ts`, `tests/host/terminal.py`, `tests/host/observer/{gui,tui}.ts` | Packed real-host flows and composer/call-count evidence. |
| `README.md`, `dist/*`, `tests/package.test.mjs`, `scripts/test-installed.mjs` | User instructions, rebuilt entries, installed-package verification. |
| `package.json`, `package-lock.json` | Only if Task 1 establishes a necessary JSONC editing dependency; otherwise leave dependencies unchanged. |

## Task 1: Config Persistence Feasibility — Mandatory Go/No-Go Gate

**Files:** Reuse and extend `tests/host/fixture.mjs`, `tests/host/persistence.test.ts`, and `docs/research/2026-11-15-config-persistence-feasibility.md`; modify `tests/host-fixture.test.ts` only for newly added fixture behavior. Test-only candidate/probe code stays under `tests/host/`, never in shipping entries. Resumed evidence uses `persistence-candidate.ts`, `persistence-worker.ts`, `persistence-safeguards.test.ts`, `persistence-activation.test.ts`, and `persistence-probe/`. The evaluated JSONC parser is a dev dependency until Task 2.

**Resume state:** Real global JSON/JSONC fixtures, `writeConfig`, local-source discovery, API limitations, and negative external-editor race characterizations already exist. Read their committed evidence and run the existing checks as a baseline. Write new RED tests only for unproved safeguards; do not recreate these deliverables or force passing characterization tests to fail.

**Interfaces:**
- Keep existing `createFixture(packagePath, options, behavior)` callers unchanged.
- Add optional fourth argument `{ configSource?: "inline" | "global-json" | "global-jsonc" }`, default `"inline"`.
- Real-file mode returns `configFile: string`; inline mode returns `configFile: undefined`. Add `writeConfig(config: object): Promise<void>` so later host tests can add observers without reintroducing `OPENCODE_CONFIG_CONTENT`.
- Existing `root`, `directory`, `env`, `api`, `calls`, `config`, and cleanup remain available. All HOME/XDG paths remain inside `.test-artifacts/host-*`.
- Produce a new scoped **GO** or **NO-GO** under the amended best-effort policy. Tasks 2–7 depend on that GO, not the original strict verdict or merely a green test command.

- [ ] **Step 1: Record actual host capabilities without changing user configuration.**
  Reuse the recorded official documentation, pinned declarations, and upstream investigation. Confirm versions and the supported source/topology matrix needed for the writer; investigate only missing or changed evidence. The public config API is shell-only, and the approved path is a scoped server-side writer. Do not invent `ctx.config`, restart an upstream search as a prerequisite, or assume document metadata accessible in a client is also accessible in the server plugin.

- [ ] **Step 2: Add failing real-file fixture and persistence tests.**
  Retain existing fixture and negative race characterizations. Add tests named `persistence preserves JSONC and plugin identity`, `cooperating setup writers serialize across supported instances`, `detected stale edits abort before replacement`, `recovery-copy failure leaves active config unchanged`, `unsupported provenance is read-only`, and `saved options activate without generation`.
  Required assertions include:
  ```ts
  assert.equal(fixture.env.OPENCODE_CONFIG_CONTENT, undefined)
  assert.ok(fixture.configFile?.startsWith(fixture.root))
  assert.equal(after.includes("// keep this comment"), true)
  assert.deepEqual(otherPluginAfter, otherPluginBefore)
  assert.equal(staleSave.kind, "conflict")
  assert.equal(activeBytesAfterBackupFailure, originalBytes)
  assert.equal(recoveryBytes, validatedPreSaveBytes)
  assert.equal(fixture.calls.length, 0)
  ```
  Arrange all inputs inside the synthetic fixture. Include JSON/JSONC, custom config environment settings, both global filenames, npm/Git/local plugin references, duplicate entries, project/inline/managed overrides, malformed files, symlinks/hardlinks, and unwritable targets. Unsupported cases must refuse writes, not disappear from the report.

- [ ] **Step 3: Run RED checks and establish the sandbox.**
  Run `node --test --test-concurrency=1 tests/host-fixture.test.ts tests/host/persistence.test.ts tests/host/persistence-safeguards.test.ts tests/host/persistence-activation.test.ts tests/host/server.test.ts`.
  Existing checks should pass as a baseline; new safeguard assertions must fail before candidate support exists. A missing host prerequisite is a recorded blocker, not a passing gate. Install project dependencies with `npm ci` only in the implementation workspace if needed.

- [ ] **Step 4: Implement the minimal test-only candidate and gather evidence.**
  Use the SDK's documented configuration location and resolved plugin-source metadata where available. Never identify an entry by a loose `"predictions"` substring or trust a client-supplied file path. When no authoritative source mapping exists, return read-only.
  Extend the test-only experiment to the approved server-side policy. Use a proven JSONC syntax-tree editor, not regex or `JSON.parse`/whole-file stringify. If needed, evaluate `jsonc-parser`; document why it is necessary before adding it as a production dependency in Task 2.
  Prove complete-transaction serialization across supported setup/plugin/server instances, including supported processes targeting the same file. Inside coordination, compare the draft revision with fresh bytes/source metadata, apply only edited fields, prepare private temporary/recovery files, and recheck immediately before atomic replacement. Backup failure must leave active bytes unchanged; keep one rotating copy with no broader access than the original and never restore automatically.
  Exercise barrier-controlled external edits before the final check (must conflict), after the final check (accepted residual race), and simultaneous cooperating setup clients (must serialize; a stale revision must conflict). A local mutex or plain hash-check/rename alone is not sufficient coordination. Preserve negative race evidence; do not fail this gate solely because an uncooperative external writer wins the accepted race.

- [ ] **Step 5: Verify activation, attribution, and failure recovery on the actual host.**
  Prove source selection happens on the selected server, not a remote client's HOME. Write only fixture config; observe a real reload, query fresh status/options, restart the isolated server with the same fixture HOME/XDG paths, and read again. Interrupt reload/save acknowledgement and simulate permission/rename failures. Assert unchanged original bytes on pre-commit failure and zero provider calls. Record exact commands and observations, not presumed API behavior.

- [ ] **Step 6: Publish the verdict and stop if any release gate fails.**
  **GO requires, for enabled writable cases:** authoritative global source and entry identity; JSONC/other-content integrity; permissions preservation; serialized cooperating setup writers and detected-stale-edit rejection; private atomic replacement and bounded recovery-copy handling; accurate failure/activation/restart outcomes without generation; and server-local ownership. Document the supported/read-only matrix and accepted external-editor limitation. Remote cases remain read-only until attribution, coordination, and save/reload tests pass for that topology.
  The accepted residual external-editor race and lack of a public plugin-options patch are not NO-GO conditions. Any other mandatory safeguard missing for a case enabled for writing is a NO-GO condition. Stop UI/production advancement on such failure; do not guess a source, weaken remaining safeguards, or add a second authority. Green refusal/characterization tests alone do not establish a writable GO.

- [ ] **Step 7: Commit the isolated fixture and report checkpoint.**
  ```sh
   git add tests/host/fixture.mjs tests/host/persistence-candidate.ts tests/host/persistence-worker.ts tests/host/persistence-safeguards.test.ts tests/host/persistence-activation.test.ts tests/host/persistence-probe package.json package-lock.json docs/research/2026-11-15-config-persistence-feasibility.md docs/superpowers/plans/2026-11-15-predictions-setup.md
  git commit -m "test: establish prediction config persistence feasibility"
  ```

## Task 2: Production Global Config Store

**Depends on:** Task 1 **GO** and its documented backend.
**Files:** Create `src/config.ts`, `src/config-edit.ts`, `src/setup.ts`, `tests/config.test.ts`; modify `tests/host/persistence-probe/index.ts` to exercise production persistence. Update package files only for the JSONC editor proven necessary in Task 1; generated bundle metadata may follow that manifest change.

**Interfaces:**
- In `src/setup.ts`, introduce `SettingKey = "models" | "enabled" | "automatic" | "escalation" | "timeoutMs" | "contextTurns" | "debug"` and `SettingsInput = Partial<Record<SettingKey, unknown>>`. Unknown values allow invalid existing settings to be displayed rather than silently defaulted.
- In `src/setup.ts`, define `ConfigSnapshot = { revision: string; source?: string; scope: "global"; writable: boolean; reason?: string; fields: SettingsInput }`.
- In `src/config.ts`, define `ConfigWriteResult = { kind: "written"; revision: string } | { kind: "conflict" | "read_only" | "failed"; message: string }`.
- `createConfigStore(host: ConfigHost): { read(signal: AbortSignal): Promise<ConfigSnapshot>; write(revision: string, patch: SettingsInput, signal: AbortSignal): Promise<ConfigWriteResult> }`.
- An own `models: undefined` key in this server-local patch means remove that property; omit untouched keys. Reject explicit `undefined` for other keys. Task 4 transports model removal through `removeModels`, never serialized `undefined`.
- Define `ConfigHost` in `src/config.ts` as the minimal server context adapter to the exact backend proven in Task 1. It must not accept arbitrary RPC-supplied paths or package names.
- Export `type ConfigStore = ReturnType<typeof createConfigStore>` for the server setup service.

- [ ] **Step 1: Add failing store tests using temporary files and injected backend barriers.**
  Assert unchanged fields in the validated document retain their original bytes, comments, trailing commas, newline style, unknown options, omitted defaults, package strings, and other plugin entries. Assert:
  ```ts
  assert.deepEqual(result, { kind: "written", revision: expectedRevision })
  assert.equal((await store.write(oldRevision, { debug: true }, signal)).kind, "conflict")
  assert.equal((await unsafeStore.read(signal)).writable, false)
  assert.equal(await readFile(unsafePath, "utf8"), original)
  ```
  Cover missing/ambiguous files, string-form entries upgraded only when safely identified, invalid options objects, duplicate keys, symlinks/hardlinks, override sources, attempted extra patch keys, changed permissions, and failed commits. Port Task 1's coordination tests to the production store; test recovery-copy permissions/rotation, backup failure, temporary-file cleanup, and no automatic restore. Recovery data must never be returned in notices or RPC. Keep the accepted late external-editor race explicitly characterized rather than asserting it is prevented.

- [ ] **Step 2: Run `node --test tests/config.test.ts`; expect RED for missing store behavior.**

- [ ] **Step 3: Implement `createConfigStore` using only Task 1's verified backend.**
  Read known editable fields only into responses; never return full global config, unknown option values, or backup contents. Preserve other content from the validated source bytes. Rediscover and revalidate target/provenance under verified writer coordination and immediately before replacement. Revision is opaque to clients and covers every input needed for stale-draft/source detection; it is not a promise of atomic compare-and-swap against external writers. Carry over private atomic replacement, one rotating recovery copy, permission checks, and cleanup from the proven candidate. Return fixed safe messages, not raw file/provider errors. An aborted pre-commit operation writes nothing to the active document; a committed operation must remain reconcilable after transport cancellation.

- [ ] **Step 4: Run `node --test --test-concurrency=1 tests/config.test.ts tests/host-fixture.test.ts tests/host/persistence.test.ts tests/host/persistence-safeguards.test.ts tests/host/persistence-activation.test.ts tests/host/server.test.ts` and `npm run typecheck`; expect PASS with the same Task 1 safety guarantee.**

- [ ] **Step 5: Commit the store, its types, and tests.**
  ```sh
   git add src/config.ts src/config-edit.ts src/setup.ts tests/config.test.ts tests/host/persistence-probe tests/host/persistence-worker.ts tests/host/persistence-activation.test.ts
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
- `patchGroups(undefined)` produces a changed-field `models: undefined` deletion marker locally. Encode deletion as `removeModels: true` in the later local Save request, not JSON `undefined`; reject `removeModels` combined with `fields.models`. No other reset/deletion UI is added.

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

## Task 4: Local Save, Activation, and Zero Surprise Generation

**Files:** Preserve current changes to `src/setup.ts`, `src/setup-service.ts`, `src/index.ts`, `src/service.ts`, `src/client.ts`, `src/controller.ts`, `src/gui.ts`, `src/tui.ts` and their tests. Create `src/setup-local.ts`, `src/setup-ipc.ts`, `src/setup-main.ts`, `src/setup-gui-api.ts`, `src/setup-tui-api.ts`, `tests/setup-local.test.ts`, `tests/setup-main.test.ts`, `tests/setup-tui-api.test.ts`, and `tests/host/setup-local.test.ts`. Extend `src/config.ts`, `src/rpc.ts`, `tests/config.test.ts`, `tests/options.test.ts`, `tests/host/{fixture.mjs,persistence.test.ts,lifecycle.test.ts,terminal.py}`, native observers, and the existing feasibility report as needed.

**Resume state:** Keep the existing RED/GREEN evidence and 277/277 project, 173/173 focused, and 15/15 host checkpoint results as history. They do not prove the new boundary or actual Save. Add RED tests only for new or uncovered behavior.

**Upstream setting prerequisite:** PR #25 is merged upstream as `142dfa1ca2832e4607158fcadda7c5eae9197df8`, but its `includeGithubPRContext` runtime/parser changes are not in this worktree. Reconcile the runtime against the approved upstream base before making this control editable; do not duplicate its enrichment implementation, silently merge/cherry-pick, discard current work, or expose a setting that this runtime ignores. Origin qualification can proceed independently. Until runtime integration is authorized and present, the setting's editable round-trip gate remains pending.

**Interfaces:**
- `SaveInput = { revision: string; fields: SettingsInput; removeModels?: true }`.
- Extend `SettingKey`/`settingKeys` from completed Tasks 2–3 with `"includeGithubPRContext"`; extend `src/config.ts`'s known-field whitelist and RPC stored/effective fields and issue enums accordingly. Reuse PR #25's `Options.includeGithubPRContext: boolean`, parser validation, and `false` default. The new value must participate in changed-field detection and stored/effective activation comparisons.
- `SaveResult = { kind: "saved"; revision: string; serviceVersion: string } | { kind: "saved_not_active"; revision: string; message: string } | { kind: "invalid"; issues: SetupIssue[] } | { kind: "conflict" | "read_only" | "failed"; message: string }`.
- No network `saveSettings` method and no proof-signing RPC. Network `settings` returns inspection-only `writable: false`; preserve an existing source refusal reason or use `"Saving requires a verified local setup connection."`.
- Add `SetupLocation = { directory: string; workspaceID?: string }` and optional `SetupSnapshot.localAuthority?: { id: string }` in `src/setup.ts`. Authority IDs match `/^[0-9a-f]{16}$/` and use eight random bytes; they are locators, not credentials or origin proof. An exclusive directory-creation collision refuses that authority rather than reusing a directory.
- Extend `createSetupService` with `save(input: SaveInput, signal: AbortSignal): Promise<SaveResult>`.
- `SetupAPI = { read(signal: AbortSignal): Promise<SetupSnapshot>; preview(fields: SettingsInput, signal: AbortSignal): Promise<SetupPreview>; save(input: SaveInput, signal: AbortSignal): Promise<SaveResult> }`.
- `SetupState = { snapshot?: SetupSnapshot; fields: SettingsInput; groups?: string[][]; issues: SetupIssue[]; preview?: SetupPreview; dirty: boolean; loading: boolean; previewing: boolean; saving: boolean; lastSave?: SaveResult; error?: string }`; error contains fixed safe copy.
- `createSetupEditor(api: SetupAPI, changed: () => void): SetupEditor`; methods `state(): Readonly<SetupState>`, `load(): Promise<void>`, `change(fields: SettingsInput): void`, `setGroups(groups: string[][] | undefined): void`, `preview(): Promise<void>`, `save(): Promise<SaveResult>`, `discard(): void`, `dispose(): void`. Pin one API target per editor instance.
- Add `createService(...).dispose(): void`, `createController(...).invalidate(): void`, and `client.invalidate(options?: { suppressAutomatic?: boolean }): void`.
- `startLocalSetup(location: SetupLocation, api: Pick<SetupAPI, "read" | "save">): Promise<{ id: string; dispose(): Promise<void> } | undefined>` in `src/setup-local.ts`. Refuse creation unless the server-local source is qualified.
- `LocalSetupTarget = { id: string; serviceVersion: string; location: SetupLocation }`; `readLocalSetup(target: LocalSetupTarget, signal: AbortSignal): Promise<SetupSnapshot>` and `saveLocalSetup(target: LocalSetupTarget, input: SaveInput, signal: AbortSignal): Promise<SaveResult>`. These Node-only calls require a previously established host-origin gate; no public client-supplied locality flag creates one.
- The local JSON-line protocol carries exactly one read or Save per connection, the pinned authority ID/version/location, and `SaveInput` for Save. No config path, package name, signing key, or origin flag is accepted. Set a `65536`-byte request limit, `8388608`-byte response limit, `16` concurrent connections per authority, and a `10000` ms operation deadline. Oversized requests refuse dispatch; exceeding a response/time bound may follow a committed write and must trigger readback, never a repeat. Larger metadata responses must fail safely rather than be truncated.
- Derive the socket as `join(await realpath(tmpdir()), "pp-" + id, "s")`; reject socket paths exceeding `100` UTF-8 bytes. Create only the new authority directory, never a discovered directory. Refuse symlinked, incorrectly owned, or incorrectly permissioned authority paths.
- `SetupLocal` in `src/setup-ipc.ts` is a window-safe `Ipc` contract under `"opencode-predictions.setup"` with `read({ serverID, location }) -> SetupSnapshot` and `save({ serverID, location, input }) -> SaveResult`. Use fixed portable host schemas and preserve server validation of all Save fields.
- `registerSetupMain(ctx: Parameters<GUIPlugin.MainSetup>[0]): () => void` in `src/setup-main.ts`; resolve the exact server through `ctx.serverEndpoints.get(serverID)` and require `sameMachine`. Bind socket operations to its current endpoint and `Caller.signal`. Import `GUIPlugin` as the SDK's `Plugin` namespace.
- `createGUISetupAPI(ctx: Parameters<GUIPlugin.Setup>[0], target: { serverID: string; location: SetupLocation }): SetupAPI` in `src/setup-gui-api.ts`; local read/Save use `ctx.main(SetupLocal)`, preview uses the pinned selected-server RPC. Never retarget an instance or accept a renderer-supplied endpoint/credential.
- `createTUISetupAPI(ctx: TUIPlugin.Context, location: SetupLocation): SetupAPI` in `src/setup-tui-api.ts`. Read/preview inspect the selected client. Enable local reads/Save only with the standalone-origin mechanism actually qualified in Step 1; absence or loss of that mechanism returns read-only.

- [x] **Step 1: Qualify the native origin anchors before implementing writable adapters.**
  Extend synthetic observer probes and `tests/host/setup-local.test.ts`. Record how pinned Desktop main establishes `sameMachine`; prove it rejects other ports, unknown server IDs, and remote/proxy selections. For CLI, inspect actual private-server creation and selected-client binding under `--standalone`; cover conflicting `--server` flags, every remote endpoint override recognized by the pinned launcher, and available reconnect/target-change paths. Do not infer provenance from a matching PID or the presence of one argument. Keep secrets out of probe output.
  Run `node --test --test-concurrency=1 --test-name-pattern="setup origin" tests/host/setup-local.test.ts`. Expected: actual-host observations identify a trusted origin mechanism for every case enabled for writing, and explicit remote/shared/ambiguous cases are denied. Record the exact mechanism and invalidation conditions in the existing feasibility report. If standalone origin cannot be established, keep CLI read-only and report that gate as blocked, not passed. Do not weaken the approved gate or invent a signed challenge substitute.
  Observed: actual Desktop main classifies own/other/relay/unknown endpoints; the pinned CLI root-launch binding and OS-owned private child are characterized across nine cases. Full origin/lifecycle run passed 6/6, with 277/277 project tests and typecheck passing. This establishes the available anchors, not an implemented production origin gate. Invocation parsing, denial-before-socket dispatch, and authority binding remain Step 2 requirements.

- [ ] **Step 2: Add RED tests for local transport, native adapters, and remaining Save lifecycle behavior.**
  Guard-only slice implemented in `src/setup-origin.ts` with 15 denial, pinning, revocation, cancellation, and deadline tests in `tests/setup-origin.test.ts`. Actual native observers execute these production guards and assert positive dispatches and zero denied dispatches, including after private-child failure. Network settings are read-only, and both write/proof methods are absent. Fresh checks passed 292/292 project and 17/17 sequential host tests, typecheck, bundle, and whitespace. These are pre-transport dispatch counts, not socket/Save tests; the rest of this step remains open.
  Subsequent transport/adapter checkpoint: 11 transport and 11 adapter/window tests pass within a 314/314 project run. Typecheck and bundle pass. The 19-test native run passes 18 and fails the Desktop Save version precondition (`2.3.0 !== 2.2.6`). Actual server-owned JSONC Save, watcher activation, old-authority refusal, and stale-revision conflict pass on CLI/server 2.2.6. Full native adapter/lifecycle and GitHub-setting gates remain open; this is not Task 4 completion.
  Authorized 2.3.0 qualification supersedes that version blocker: isolated candidate production-store, bundled-server persistence/activation, and native Desktop Save/readback gates passed before changing the working-tree allowlist. Fresh checks pass 318/318 project, 26/26 store safeguards at 2.3.0, 17/17 bundled-server persistence/activation, and 19/19 sequential native tests, no skips. Initial `saved_not_active` remains valid; the native gate independently requires watcher activation and a new service version.
  Name the native-boundary regressions `Desktop main denies non-sameMachine setup before socket access`, `CLI setup denies unqualified launch origins before socket access`, and `relayed local metadata cannot authorize a selected remote server`. Their observable assertions include:
  ```ts
  assert.equal(remoteSnapshot.writable, false)
  assert.equal((await remoteAPI.save(input, signal)).kind, "read_only")
  assert.equal(socketConnectionsAfterAttempt, socketConnectionsBeforeAttempt)
  assert.equal(await readFile(localConfigFile, "utf8"), originalLocalBytes)
  ```
  In `tests/setup-local.test.ts`, assert a qualified local read can be writable, malformed IDs and arbitrary paths cannot connect, and unsafe owner/mode/symlink/overlong paths cannot dispatch. Exercise extra fields, wrong authority/version/location, oversized or unterminated frames, connection limits/timeouts, cancellation, disposal, authority replacement, and stale socket files. A metadata response larger than `65536` bytes but within `8388608` bytes must round-trip; a response exceeding its own bound must fail safely. Inspect actual temporary directory/socket modes and cleanup. No recovery/config contents or raw socket errors may appear in responses.
  Allocate a short fixture-owned `TMPDIR` under the harness-approved temporary root for socket tests and propagate it to both native client and server. Keep config HOME/XDG paths in the existing fixture. Never use the user's runtime directory, delete unknown stale sockets, or shorten an overlong path by silently falling back to `/tmp`.
  In `tests/setup-main.test.ts` and `tests/setup-tui-api.test.ts`, assert origin denial occurs before any local transport call, even when a remote/proxy fixture advertises a real local authority and relays all local metadata. Pin server/location for the editor lifetime and reject endpoint/authority replacement during dispatch. Missing IPC and unsupported hosts must preserve inspection without falling back to client file writes.
  Add real network assertions that `saveSettings` and proof-signing methods are absent, and network `settings.writable === false` even for a qualified source. Update Task 3's former source-only writability assertion to distinguish usable local write permission.
  Assert validation precedes writing, conflicts/failures preserve draft, saving unchanged values does not write, and invalid drafts cannot save. With automatic mode on, assert:
  ```ts
  assert.equal(generateCallsAfterSave, generateCallsBeforeSave)
  assert.equal(oldPredictionSignal.aborted, true)
  assert.equal(oldOfferAccepted, false)
  assert.equal(composerDraft, "my existing draft")
  assert.equal((await editor.save()).kind, "saved_not_active")
  ```
  Add regressions named `setup preserves omitted GitHub PR context during unrelated edits`, `setup round-trips explicit GitHub PR context false`, and `setup rejects nonboolean GitHub PR context before writing`. Test `true`, `false`, omitted, `null`, numeric, and string inputs, including public read/preview schemas and local Save. Keep upstream unrelated options intact. Assertions include:
  ```ts
  assert.deepEqual(changedFields({}, { debug: true }), { debug: true })
  assert.deepEqual(changedFields({ includeGithubPRContext: true }, { includeGithubPRContext: false }), { includeGithubPRContext: false })
  assert.equal(invalid.issues.some(issue => issue.field === "includeGithubPRContext" && issue.severity === "error"), true)
  assert.equal(githubRetrievalCallsAfterSetup, githubRetrievalCallsBeforeSetup)
  assert.equal(githubCredentialLookupsAfterSetup, githubCredentialLookupsBeforeSetup)
  ```
  Test cancelled-but-committed writes, reload killing the socket/main-IPC response, a second authorized local client, late progress/results, a service version change detected by polling, and a new completion still predicting normally. Test stale preview responses after another edit and disposed editors ignoring late responses. Existing passing regressions remain green; do not recreate them or force artificial failures.

- [ ] **Step 3: Run `node --test tests/setup-local.test.ts tests/setup-main.test.ts tests/setup-tui-api.test.ts tests/setup.test.ts tests/setup-service.test.ts tests/config.test.ts tests/options.test.ts tests/client.test.ts tests/controller.test.ts tests/server.test.ts`; expect RED on the missing boundary/adapters and uncovered Save cases.**

- [ ] **Step 4: Implement the private boundary, pinned host adapters, server Save, and shared editor.**
  Use only Step 1's observed native origin mechanisms. Create and advertise an authority only for the server-owned qualified source. The socket server owns its location and delegates read/Save to the existing service; client values never select a config file. Validate the complete local envelope and recheck source eligibility for each operation. Bound buffers and connections before parsing/dispatch, propagate disconnect cancellation, and clean only the directory/socket this instance created. Missing local IPC is read-only, not a guessed path.
  Keep network RPC inspection-only, without a write or challenge-signing method. The Desktop main bridge independently resolves and rechecks the pinned endpoint's `sameMachine` field; pass `Caller.signal` through operations. GUI window code imports only the IPC contract and adapter, never performs Node I/O itself. CLI standalone permission must come from the qualified native mechanism, not any serialized caller flag.
  Merge only changed keys against a fresh authoritative snapshot, handle explicit model removal, validate the full prospective options, and use the Task 2 write protocol. Keep fresh unknown options intact. Activation must use Task 1's proven watcher/read-back path, not a guessed reload API. Do not emulate persistence by mutating one in-memory service.
  Carry `includeGithubPRContext` through the setup types, store whitelist, RPC schemas, local/main IPC validation, draft helpers, and activation readback. Leave an untouched omitted value absent. An edited `false` is a persisted boolean, not deletion or an omitted transport value. Setup never invokes PR #25's enrichment or credential-retrieval functions.
  Verify requested known-field values in a fresh service before returning `saved`. If reload interrupts the response, reconnect to the original selected server and rediscover its new local authority only for readback. Compare source/revision, stored fields, effective options, and service version; never repeat the write. Return/display saved-not-active when durable bytes are known but activation is unverified. Do not claim rollback or overwrite after an ambiguous outcome.

- [ ] **Step 5: Complete lifecycle invalidation without charging for Save.**
  Abort service-owned generation on unload, clear old offers, and prevent disposed work from publishing progress/results. `controller.invalidate()` clears cached results, attempted keys, and pending work without editing input. On config/plugin events, suppress automatic prediction for the current `{scope, completion key}` even after reconnect/reload; also detect changed service versions during polling. A new completed turn or explicit request remains eligible.
  Existing `client.invalidate()` immediately calls `tick()`, which can generate; do not reuse it unchanged. Apply suppression before the first refreshed tick, including when the plugin remounts on a completed chat. Prove the host's memory-only reload handoff or another no-persistent-settings mechanism in the host test; if remount suppression cannot be guaranteed, stop this task rather than ship extra calls.

- [ ] **Step 6: Prove the boundary and actual Save on the native hosts.**
  Extend `tests/host/setup-local.test.ts` to write through the production local transport, not the research candidate. Exercise two local clients, a stale revision, watcher-driven reload, cancelled-but-committed acknowledgement loss, new authority discovery, and persisted/effective readback. Verify plain authenticated network calls and remote/proxy origin denials leave active bytes unchanged.
  Extend native Desktop/CLI lifecycle tests to exercise real Save through the main bridge/qualified standalone adapter with automatic mode on. Preserve composer text, reject old offers and late results, reload the actual predictions TUI module from a fixture-owned copy, and prove both an explicit request and a later completed turn remain eligible. An observer-only source reload does not prove predictions-plugin remount suppression.
  Run the Step 3 unit command, `npm test`, `npm run typecheck`, `npm run bundle`, then `node --test --test-concurrency=1 tests/host/persistence.test.ts tests/host/lifecycle.test.ts tests/host/setup-local.test.ts`, and `git diff --check`. Expected: every enabled writable case passes with no extra generation, detected stale edits conflict, ambiguous commits reconcile without repeat, and unsupported origins cannot write. Missing host/origin evidence is not a green gate.

- [ ] **Step 7: Commit local Save and lifecycle behavior only after its mandatory gates pass.**
   ```sh
   git add src/setup.ts src/setup-service.ts src/setup-local.ts src/setup-ipc.ts src/setup-main.ts src/setup-gui-api.ts src/setup-tui-api.ts src/config.ts src/rpc.ts src/index.ts src/service.ts src/client.ts src/controller.ts src/gui.ts src/tui.ts tests/setup-local.test.ts tests/setup-main.test.ts tests/setup-tui-api.test.ts tests/setup.test.ts tests/setup-service.test.ts tests/config.test.ts tests/options.test.ts tests/client.test.ts tests/controller.test.ts tests/server.test.ts tests/desktop.test.ts tests/terminal.test.ts tests/host/persistence.test.ts tests/host/lifecycle.test.ts tests/host/setup-local.test.ts tests/host/terminal.py tests/host/observer docs/research/2026-11-15-config-persistence-feasibility.md dist
   git commit -m "feat: apply prediction setup changes without generating"
  ```

## Task 5: Native Desktop Settings

**Files:** Create `src/setup-gui.ts`, `tests/setup-gui.test.ts`; modify `src/gui.ts`, `src/feedback.ts`, `tests/desktop.test.ts`, `tests/client-feedback.test.ts`, `tests/feedback.test.ts`.

**Interfaces:**
- `registerSetupGUI(ctx: GUIContext, openStatus: () => Promise<void>): () => void` in `src/setup-gui.ts`; define `GUIContext` from the existing `Plugin.define` setup callback's inferred parameter type, using the public pinned SDK declaration confirmed in Task 1. Do not assume an export named `Plugin.SetupContext`.
- It registers command id `"setup"` with title **Predictions Setup**, settings page id `"predictions"`, and the same page-opening action for recovery/status links. Use `SettingsPage`, native `SettingsLayout`/`SettingsSection`/`SettingsRow` and available inputs from the pinned SDK.
- One `SetupEditor` per active page/server target using Task 4's `createGUISetupAPI`. Do not read configuration from GUI storage or Node placeholders in the window process. Desktop main, not a renderer-supplied flag, grants usable local access.

- [ ] **Step 1: Add failing rendered tests with host components and mocked SetupAPI.**
  Assert exact Behavior labels/order, Models second, Advanced third/collapsed, setup availability without session/completed response, and settings search entries.
  ```ts
  assert.deepEqual(sectionTitles, ["Behavior", "Models", "Advanced"])
  assert.deepEqual(behaviorLabels, ["Enable Predictions", "Predict After Replies", "Escalation Mode"])
  assert.equal(savedPatchHasOnlyEditedFields, true)
  assert.equal(submittedPrompts, 0)
  ```
   Exercise all eight scoped settings; model/variant selection; group/entry movement; pattern preview; long/duplicate display names; keyboard-only editing; empty/loading/disconnected/read-only states; conflict and saved-not-active messages; unsaved navigation. Assert the non-blocking external-editor/recovery warning is present and introduces no repeated consent dialog. Switching servers must request discard confirmation before creating a new pinned editor, never retarget an old save.
   Assert **Include GitHub PR context** appears only in Advanced, defaults to unchecked when omitted, round-trips on/off, and has a settings-search entry. Its adjacent warning must mention private PR data and fallback/paid prediction providers. Editing, previewing, discarding, and saving it must not fetch a PR, look up credentials, generate, or submit a prompt.
  Assert remote, other-port, missing-main-IPC, and unknown endpoints render read-only even if their metadata claims a writable source or a real local authority. An endpoint change during Save must not redirect the main-process operation.

- [ ] **Step 2: Run `node --test tests/setup-gui.test.ts tests/desktop.test.ts tests/feedback.test.ts tests/client-feedback.test.ts`; expect RED on the new page and entry points.**

- [ ] **Step 3: Build using existing native components and Task 4's editor.**
  Load Impeccable's craft floor immediately before UI edits. Verify pinned SDK controls and settings navigation; do not invent props from newer docs. Add searchable model selection and accessible move-up/down/remove actions; preserve focus after movement/removal. Keep provider/model IDs as secondary identifiers, unavailable entries intact, and cost/ranking/escalation explanations adjacent to models.
  Update only configuration-related recovery notices to point at **Predictions Setup**; retain status actions for runtime errors. Add a setup action to the status view without converting it into an editor. If service setup methods are unavailable, show an update/read-only explanation; never fall back to client-side file writes.
  Show the spec's non-blocking external-editor warning beside Save, including possible loss of unrelated edits and incomplete recovery-copy coverage. Do not add repeated consent dialogs or imply saves are conflict-proof. Cover that disclosure in the rendered tests.
  Use the main-process local adapter only after Task 4's origin qualification. A disconnected or unsupported bridge displays inspection/recovery copy; do not replace it with network Save or window filesystem calls.

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
- Palette command id `"predictions.setup"`, title **Predictions Setup**, group **Predictions**, no bind. Menus use Task 4's `SetupEditor` and `createTUISetupAPI(ctx, pinnedLocation)`. Read/preview use selected-server RPC; writes use only qualified standalone local IPC.
- Use existing `ctx.ui.dialog.select`, `prompt`, `confirm`, and `alert`; nested cancel returns to the parent without discarding the shared draft.

- [ ] **Step 1: Add failing scripted-dialog tests.**
   Cover ordered sections/current-value summaries, all eight scoped edits, absent models, adding/removing/reordering groups and entries, variants, patterns, warning previews, save/discard, and leaving dirty setup. Put **Include GitHub PR context** in Advanced with a default-off summary and the same private-data/fallback-provider disclosure as Desktop. Verify toggling it has no GitHub retrieval, credential lookup, or generation side effects during setup.
  ```ts
  assert.deepEqual(sectionTitles, ["Behavior", "Models", "Advanced"])
  assert.equal(draftAfterNestedCancel.debug, true)
  assert.equal(conflictPreservesDraft, true)
   assert.equal(remoteSave.kind, "read_only")
   assert.equal(clientConfigWrites, 0)
   assert.equal(["saved", "saved_not_active"].includes(standaloneSave.kind), true)
  assert.equal(composerDraft, "my existing draft")
  ```
  Also test disconnect during save, late metadata, no active session, unavailable service methods, long names/IDs, and read-only explanation. Assert the same non-blocking external-editor/recovery warning as Desktop without a repeated consent dialog.
  Shared-service, explicit-server, conflicting/overridden launches, and remote/proxy targets must retain inspection but offer no usable Save. Show `"Local setup writes currently require a verified opencode --standalone session."` when the source is otherwise qualified but CLI provenance is not. Do not automatically spawn a replacement server or change the user's launch configuration.

- [ ] **Step 2: Run `node --test tests/setup-tui.test.ts tests/terminal.test.ts tests/notifications.test.ts`; expect RED for setup menu behavior.**

- [ ] **Step 3: Implement section-based native dialogs and recovery/status entry points.**
  Load the craft floor before UI edits. Show **Save changes**, **Discard changes**, and secondary status access at the root. Use explicit named move actions, native searchable selection, and prompts for patterns/numbers. Keep number parsing strict; no `parseInt("8000oops")` acceptance. Preserve draft through submenus and write failures; confirm discard on exit. Keep host navigation keys and Tab behavior outside setup unchanged.
  Show the same non-blocking save warning and fuller external-editor/recovery limitation as Desktop. Test its presence without requiring a second consent dialog.
  Keep the approved narrow CLI scope visible in the root menu. Read-only recovery explains the launch requirement; it does not silently switch from a selected remote/shared server to a local private server.

- [ ] **Step 4: Run Task 6 tests and `npm run typecheck`; expect PASS.**
  Inspect wide and narrow PTY rendering, focus, wrapped warnings, and long model names with the real host in Task 7.

- [ ] **Step 5: Commit CLI setup.**
  ```sh
  git add src/setup-tui.ts src/tui.ts tests/setup-tui.test.ts tests/terminal.test.ts
  git commit -m "feat: add prediction setup menus to cli"
  ```
  Include changed notification tests if needed.

## Task 7: Packed Two-Host Proof and Documentation

**Files:** Modify `tests/host/{server,desktop,terminal,setup-local,lifecycle}.test.ts`, `tests/host/terminal.py`, `tests/host/observer/{gui,tui}.ts`, `tests/package.test.mjs`, `scripts/test-installed.mjs`, `README.md`; rebuild committed `dist/*`.

**Interfaces:** Use Task 1's real-file fixture and `writeConfig()` for setup host scenarios. Keep existing inline-config scenarios to test read-only override handling. New observer actions may dispatch public setup/status commands and inspect draft/call counts; they must not replace UI-driven saves with direct RPC shortcuts.

- [ ] **Step 1: Add failing end-to-end tests through the public setup controls.**
   Desktop and CLI must each configure all eight scoped settings, reorder groups, save, reopen, and verify config/status after reload. Include `includeGithubPRContext` on/off and omitted-field preservation through unrelated edits; assert no GitHub retrieval or credential lookup during setup. Use two API clients against the same fixture server for cross-client visibility. Preserve synthetic composer input and user-message counts through open/cancel/save/error flows.
   Include JSONC comments/other plugins, conflict between clients, interrupted acknowledgement, a zero-match warning, read-only remote/proxy/shared-service CLI origins, read-only inline/project override, and a no-session setup flow. An advertised local authority or relayed metadata must not bypass native origin checks. With `automatic: true` on an existing completed turn, save without new provider calls; then complete a new turn and prove automatic prediction still works.

- [ ] **Step 2: Run `npm run bundle`, then focused new server, Desktop, and CLI tests sequentially; expect RED until native integration gaps are fixed.**
  Use `node --test --test-name-pattern="setup" tests/host/server.test.ts`, then equivalent Desktop and terminal commands. Use test names containing `setup`. Do not run graphical/PTY host gates concurrently.

- [ ] **Step 3: Finish integration, package checks, and user documentation.**
   Document both entry points, Behavior/Models/Advanced order, global/server scope, overrides/read-only behavior, Save/Discard, no-generation preview, cost warnings, and conflict/activation recovery. State the accepted external-editor race plainly; explain that recovery copies hold captured pre-save bytes, not guaranteed copies of racing edits. Document private backup location/retention and manual recovery without adding an automatic-restore feature. Keep manual JSON instructions for advanced users.
   Explain Desktop's own-server requirement and the verified standalone-only CLI writable subset. Shared-service/explicit-server/remote CLI stays read-only; do not describe normal shared-service setup as complete or tell users to change global launch settings.
   Extend package tests for inspection RPC methods, absence of network Save/proof-signing methods, and the local/main IPC entries. Ensure the server config writer stays out of the GUI bundle; Node socket code for its main-process bridge is expected, while window code performs no Node I/O. Add local persistence, lifecycle, and origin proof to `scripts/test-installed.mjs`; execute host files sequentially and load all parts from the packed artifact, not workspace-linked dependencies or an inline override.

- [ ] **Step 4: Run complete verification and record exact results.**
  ```sh
  npm run check
  npm run test:package
   node --test tests/host/persistence.test.ts
   node --test --test-concurrency=1 tests/host/setup-local.test.ts tests/host/lifecycle.test.ts
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
- Approved local-boundary coverage: Task 4 qualifies native origin anchors, private socket safety, network refusals, relay rejection, and Save/reload behavior. Tasks 5–6 consume its pinned adapters and test user-visible read-only states. Task 7 repeats actual origin/Save checks against the packed artifact.
- Type consistency: `SaveInput`/`SaveResult`/`SetupAPI` remain shared. `SetupLocation`, `LocalSetupTarget`, `SetupLocal`, and the main/window/TUI factories are defined in Task 4 before UI consumers. No task consumes a public Save or proof-signing RPC.
- Proportion and unresolved feasibility: fixed transport limits and exact entry points are planning choices, not new plugin options. Standalone provenance is an explicit observed-host gate; a launch flag or test double cannot waive it. A failed gate blocks its writable case rather than authorizing another approach.
- Every Review Focus condition has an explicit owning test. Preserve external-editor negative characterizations as accepted-limit evidence; do not weaken serialization, stale-detection, or recovery tests for cooperating setup writers.
- At authoring, no execution had started. The execution record below tracks subsequent work; unchecked steps do not imply a completed feature.

## Execution Handoff

**Native execution remains selected.** The user authorized native-origin qualification and then production guards/enforcement tests; both scoped checkpoints are recorded. Continue with the remaining Step 2 transport/adapter work only when authorized, preserving committed Tasks 1–3 and existing Task 4 changes/evidence. Do not enable local Save before its local authority, persistence, and lifecycle gates pass. Do not require another execution-method choice or reopen the accepted external-editor limitation. Retain one fresh whole-branch review at the end.

Do not treat the historical strict NO-GO as a new failure solely because the accepted external-editor race remains reproducible. Do not treat this amended plan as proof that any remaining check has passed.

## Execution Record

- Native execution authorized on 2026-11-15 in the existing isolated worktree.
- Task 1 halted at Step 4 with **NO-GO**. The supported API rejects plugin-option writes; the direct candidate loses a racing external edit after its final comparison.
- Added real-global-file fixture support with observed RED/GREEN tests. Added actual server API/discovery checks and deterministic negative concurrency characterizations.
- Report: `docs/research/2026-11-15-config-persistence-feasibility.md`.
- Step 5 (successful-save activation/restart), broader unsupported-source scenarios, and Tasks 2–7 remain unexecuted. No production code or user configuration changed.
- Verification: persistence/fixture checks 10/10; combined persistence/fixture/existing server compatibility 14/14; project suite 217/217; typecheck and diff whitespace checks passed.
- Under the original absolute external-editor guarantee, the gate remained NO-GO despite green characterization tests. Research checkpoint: `cffe431`.
- Fresh independent review accepted the research checkpoint, with no Critical/Important findings. One Minor is deferred: capability tests log the runtime schema but do not assert it; HTTP 400 also follows from omitting required `shell`.
- No production readiness or successful-save behavior was approved by that review. Tasks 2–7 require a new scoped Task 1 GO under the amended policy.
- Subsequent design amendment: the user approved option 1, best-effort edits to existing JSON/JSONC, and accepted the residual external-editor race.
- The user requested gate alignment so execution could resume. The design gate and persistence tasks now use the approved best-effort policy, including recovery copies and serialized supported setup writers. Native execution can resume at Task 1; other persistence and lifecycle checks remain unproved. This documentation edit has not resumed implementation or marked any gate passed.
- Resumed Task 1 established a scoped GO for the macOS/2.2.6, project-discovery-disabled, canonical absolute-local-entry subset documented in the feasibility report. Separate-process and real-server/Bun coordination, preserved bytes/permissions/recovery, activation/restart, and interrupted-acknowledgement reconciliation now have evidence. Other cases remain read-only; this is permission for Task 2, not production or UI readiness.
- Checkpoint review of Tasks 1–2 suspended that GO after finding comment-erasing model removal and missing direct production failure-path proof. The correction adds a shared token-aware editor, literal preservation regressions, direct production boundary tests, production process workers, and real-server sole-property deletion coverage. Fresh checks passed 59/59 combined and 242/242 project tests, plus typecheck and bundle. This restores only the documented scoped gate; Tasks 3–7 remain unbuilt and unapproved for release.
- Task 3 adds shared draft/group helpers and public settings/metadata-preview RPC. Checks passed 256/256 project tests, 121/121 focused checks, and 61/61 combined store/host checks, plus typecheck and bundle. Public RPC tests observe unchanged config bytes and zero provider calls. Save RPC/lifecycle/UI are not yet implemented; remote writes remain disabled under the user's resumption instruction.
- Task 4 checkpoint added uncommitted controller/service lifecycle safeguards, native memory handoff, event/version suppression, and internal Save/editor contracts. Checks passed 277/277 project, 173/173 focused, and 15/15 actual-host lifecycle/persistence tests, plus typecheck/bundle. These checks did not exercise a public Save or qualify the local boundary.
- User approved private local Save IPC and the revised, narrower standalone-only initial CLI write scope after a builder check rejected relayable challenge signing. Tasks 4–7 now use trusted native origin gates and inspection-only network RPC. The amended implementation plan awaits confirmation; no local-boundary implementation or new qualification is claimed by this edit.
- User requested the merged PR #25 setting `includeGithubPRContext` in Advanced. The spec and Tasks 4–7 now cover its default-off switch, full setup round trip, omission preservation, and private-data disclosure. Runtime/base integration is still pending; this documentation change neither merges PR #25 into the worktree nor claims an implemented UI.
- Native-origin qualification, explicitly authorized by the user, added only test probes, a PTY observer driver, and evidence. Desktop own/other/relay/unknown endpoint classifications and nine CLI origin/failure cases passed within a 6/6 combined host run; the project suite passed 277/277 and typecheck passed. Production origin guards/private Save transport remain unimplemented, and Task 4 is incomplete.
- Subsequent user-authorized production native-origin guards and enforcement tests passed 15/15 focused, 292/292 project, and 17/17 sequential native host checks, plus typecheck/bundle/whitespace. Network inspection now always reports read-only permission. Private Save transport and production setup adapters remain unimplemented; Task 4 remains incomplete.

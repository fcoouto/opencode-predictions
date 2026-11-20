# Usable Prediction Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Prediction Settings save during ordinary Desktop and shared-service CLI use through a dedicated server-owned preferences file.

**Architecture:** Store explicit preferences in `predictions.json`; merge them over existing plugin options and retain visible provenance/reset semantics. Use the selected OpenCode server's RPC access policy for a narrowly scoped Save instead of a separate local socket. Reuse the prediction engine, validation, native UI, transactional-write techniques, and client status/version invalidation.

**Tech Stack:** TypeScript, Node built-ins, existing `jsonc-parser`, OpenCode V2 plugin/client `2.2.6`, Solid host UI, Node test runner, existing Playwright/native fixtures.

**Spec:** `docs/superpowers/specs/2026-11-18-predictions-preferences-design.md`

## Global Constraints

- Status: approved for implementation after review and removal of write locking.
- Preference-over-configuration precedence and selected-server RPC access replace the former single-source/local-only policies.
- Keep Node `>=26.4.0` and pinned `@opencode/plugin` / `@opencode/client` `2.2.6`. No new dependencies.
- The sole active preferences filename is `predictions.json`.
- Only `models`, `enabled`, `automatic`, `escalation`, `timeoutMs`, `contextTurns`, `debug`, and `includeGithubPRContext` are editable.
- `timeoutMs` is an integer from `1` to `2147483647`; `contextTurns` is an integer from `1` to `5`; escalation is `off`, `manual`, or `automatic`.
- Existing defaults remain: enabled/automatic `true`, escalation `manual`, timeout `8000`, context turns `3`, debug/PR context `false`, no invented models.
- Bound the document and Save input to `65536` UTF-8 bytes.
- Present numeric-null preferences are invalid before activation; legacy OpenCode option parsing remains unchanged.
- No save locks, mutexes, lock files/directories, ownership leases, or writer-admission queues. The user accepts lost updates from concurrent writers; retain best-effort revision checks and atomic replacement.
- Create new directories as `0700` and files as `0600`; do not chmod an existing OpenCode configuration directory.
- Existing `opencode.json(c)` bytes and plugin references never change.
- Opening, previewing, and discarding settings create no file or directory.
- Saving, resetting, refreshing, and opening settings never generate predictions or fetch PR metadata.
- Qualify macOS Desktop `2.3.0` and CLI `2.2.6`, including ordinary shared-service CLI and existing standalone mode.
- Actual tests must omit `OPENCODE_DISABLE_PROJECT_CONFIG=1` for the normal-use acceptance cases.
- No user installation/configuration changes, paid-provider calls, dependency upgrades, publish, push, or unrelated cleanup.

## Review Focus

1. Removing the last model must suppress legacy models, while reset must restore inheritance; Task 1 and Task 6 pin both.
2. Simultaneous creators/writers can overwrite each other, and a writer can crash; Tasks 2 and 7 characterize accepted lost updates and prove fresh Save after termination without manual cleanup.
3. A reset can change provenance without changing effective values; Task 3 and Task 6 require verified activation without an unnecessary engine restart.
4. An atomic external replacement, corrupt file, or failed acknowledgement must not restore stale suggestions or silently enable defaults; Tasks 2, 3, 6, and 7 pin these paths.
5. Another selected server, inherited authentication, or administrative configuration must not become a client-local or unrestricted-path write; Tasks 4, 5, and 7 pin the boundary.

---

## Before execution

The new design replaces the persistence/local-origin decisions in the two `2026-11-15-predictions-setup*design.md` specifications **only after explicit approval**. Retain their UI, validation, privacy, and composer-preservation requirements.

The user subsequently requested implementation of this revised plan. The former local-only boundary is superseded within this approved scope; no user installation/configuration changes, publishing, or pushing are authorized.

Use the existing isolated worktree or the `using-git-worktrees` workflow at execution time. Check user changes before touching files. Dependencies are not installed in this worktree at planning time; use `npm ci --ignore-scripts` when executing, without modifying the lockfile.

## File structure and ownership

| File(s) | Responsibility |
| --- | --- |
| New `src/preferences.ts` | Pure document validation, known-field selection, fallback resolution, model-null semantics, and provenance. No Node filesystem imports. |
| New `src/preferences-store.ts` | Server path/policy discovery and dedicated-file read/transaction/backup. Exports store types; never takes a client path. |
| New `src/preferences-runtime.ts` | Owns the engine, composite/active revisions, ordered state refresh, and late-result rejection. This is not Save coordination; no new watcher or background poller. |
| `src/setup.ts`, `src/setup-service.ts` | Shared snapshot/draft/reset intent, prospective validation, changed-only Save, and persisted-versus-active reporting. |
| `src/index.ts`, `src/rpc.ts` | Server wiring and strict portable RPC contract on the existing transport. |
| `src/setup-gui-api.ts`, `src/setup-tui-api.ts` | Thin selected-client/location adapters; no OS locality proof or filesystem access. |
| `src/setup-gui.ts`, `src/setup-tui.ts`, `src/setup-copy.ts` | Existing controls plus source/provenance/reset and accurate failure copy. |
| `src/gui.ts`, `src/tui.ts`, `src/client.ts` | Remove obsolete bridge/test seams; retain polling/version-based suppression and composer behavior. |
| Retire `src/setup-{local,origin,native-api,main,ipc}.ts` | Old socket/local-origin transport, after replacement tests cover its remaining relevant guarantees. |
| Retire `src/config.ts` | Old shared-OpenCode-document writer, after production callers and persistence fixtures migrate. |
| `src/config-edit.ts` | Historical research helper still used by `tests/host/persistence-candidate.ts`; do not delete that dependency as incidental cleanup. It must not ship in production bundles. |
| New `tests/preferences{,-store,-runtime}.test.ts`, `tests/setup-rpc-api.test.ts` | Pure rules, real filesystem transactions, runtime lifecycle, and selected-client adapters. |
| Existing setup/client/server tests and `tests/host/*` | Preserve characterization; replace obsolete expectations rather than weakening safety assertions. |
| `scripts/test-installed.mjs`, `tests/package.test.mjs`, `README.md`, `PRODUCT.md`, `dist/*` | Installed-artifact proof, shipping boundaries, documentation, and regenerated bundles. |

## Shared interfaces

Define these once in the owning tasks. Later tasks consume them verbatim.

```ts
// src/setup.ts
type SettingOrigin = "preferences" | "configuration" | "default"
type SaveInput = {
  revision: string
  fields: SettingsInput
  removeModels?: true
  reset?: SettingKey[]
}
```

`reset` removes named known overrides; `removeModels` writes the explicit no-model sentinel. Reject duplicate/unknown reset keys and any overlap with `fields` or `removeModels`.

Extend `SetupSnapshot` with required `overrides: SettingsInput`, `fallbackFields: SettingsInput`, `origins: Record<SettingKey, SettingOrigin>`, and `activeRevision: string | null`. Keep `fields` as the resolved, sparse editable values, `source` as the server preferences path, `scope: "global"`, and existing `effective`, catalog, issues, and service version. Do not expose unknown preference members.

Store revision describes file state. Setup revision also includes the location's fallback options and administrative policy, so a changed fallback conflicts with a stale draft. Active revision identifies the exact setup revision adopted by the runtime, including origin-only changes.

### Task 1: Define the preference format and compatibility rules

**Files:** Create `src/preferences.ts`, `tests/preferences.test.ts`; modify `src/setup.ts` types.

**Interfaces:**
- Consumes: `parseOptions(input: unknown): OptionsResult` from `src/options.ts`; `validateSettings(fields: SettingsInput): SetupIssue[]`, `settingKeys`, `SettingsInput`, `SettingKey`, and `SetupIssue` from `src/setup.ts`.
- Produces: `PreferenceDocument = { version: 1; settings: Record<string, unknown>; [key: string]: unknown }`.
- Produces: `parsePreferences(text: string): PreferenceDocument` with fixed safe validation errors.
- Produces: `validatePreferenceFields(overrides: SettingsInput): SetupIssue[]`, validating present known overrides before defaulting. Treat only `models: null` as an allowed sentinel.
- Produces: `ResolvedPreferences = { rawOptions: unknown; fields: SettingsInput; fallbackFields: SettingsInput; origins: Record<SettingKey, SettingOrigin>; issues: SetupIssue[] }`.
- Produces: `resolvePreferences(legacy: unknown, overrides: SettingsInput): ResolvedPreferences`.
- Produces: extended `SaveInput` and snapshot metadata types above. Update existing snapshot test literals when making new members required; do not introduce a second legacy snapshot format.

- [ ] **Step 1: Add failing parser/resolution tests.** Use this central assertion and table-test every editable field, exact numeric boundary, malformed JSON, duplicate keys, unknown member preservation, unsupported version, and explicit model removal/reset. Malformed UTF-8 bytes belong to Task 2, not this string-parser test:

```ts
test("preferences override only present fields and retain configuration provenance", () => {
  const value = resolvePreferences(
    { models: "local/a", automatic: true, contextFile: "/server/context.md" },
    { automatic: false },
  )
  assert.equal(value.fields.automatic, false)
  assert.equal(value.origins.automatic, "preferences")
  assert.equal(value.origins.models, "configuration")
  assert.equal(value.origins.debug, "default")
  assert.equal((value.rawOptions as any).contextFile, "/server/context.md")
  assert.equal(Object.hasOwn(value.fields, "debug"), false)
  assert.equal(Object.hasOwn(resolvePreferences({ models: "local/a" }, { models: null }).fields, "models"), false)
  assert.equal(resolvePreferences({ models: "local/a" }, {}).fields.models, "local/a")
})

test("numeric-null preferences are invalid before fallback defaulting", () => {
  for (const field of ["timeoutMs", "contextTurns"] as const) {
    const resolved = resolvePreferences({ models: "local/a" }, { [field]: null })
    assert.equal(resolved.fields[field], null, "retain the invalid value for repair")
    assert.equal(resolved.issues.some(issue => issue.field === field && issue.severity === "error"), true)
  }
  assert.deepEqual(resolvePreferences({ timeoutMs: null, contextTurns: null }, {}).issues, [],
    "do not change the existing legacy fallback parsing contract")
  assert.deepEqual(validatePreferenceFields({ models: null }), [])
})
```

- [ ] **Step 2: Run** `node --test tests/preferences.test.ts`; expect failure because the module/exports are absent.
- [ ] **Step 3: Implement the interfaces.** Use the installed `jsonc-parser` syntax tree with comments/trailing commas disabled and recursive duplicate-key checks. Use only allowlisted own properties for resolution; never spread unknown preference settings into runtime options. `validatePreferenceFields` selects known own overrides, removes only the models-null sentinel from its validation input, and delegates to existing `validateSettings`, which already rejects numeric nulls. Preserve invalid raw fields and return their issues. Only after preference validation succeeds may `parseOptions` decide effective legacy/resolved validity. Do not change `parseOptions` to fix the separate preferences boundary. Add `SettingOrigin` and optional Save reset intent without changing current behavior yet; introduce required snapshot metadata with Task 4's coordinated fixture updates.
- [ ] **Step 4: Run** `node --test tests/preferences.test.ts tests/options.test.ts tests/setup.test.ts`; expect all pass. Assert explicit `false`, variants, groups, no-match rules, and defaults retain existing meaning.
- [ ] **Step 5: Commit** `src/preferences.ts`, `src/setup.ts`, `tests/preferences.test.ts` as `feat: define prediction preference precedence`.

### Task 2: Build the dedicated-file store

**Files:** Create `src/preferences-store.ts`, `tests/preferences-store.test.ts`; create `tests/host/preferences-worker.ts` for cross-process transaction tests.

**Interfaces:**
- Consumes: Task 1's parser/document and `SaveInput`.
- Produces: `PreferencesHost = { home: string; platform: NodeJS.Platform; env: Record<string, string | undefined>; systemPaths: readonly string[] }`; values come only from the server adapter.
- Produces: `preferencesPath(host: PreferencesHost): string`.
- Produces: `decodePreferences(bytes: Uint8Array): PreferenceDocument`, enforcing the `65536`-byte bound and fatal UTF-8 decoding before Task 1's text parser.
- Produces: `PreferenceRead = { revision: string; source: string; writable: boolean; documentValid: boolean; policy: "user" | "managed"; overrides: SettingsInput; reason?: string }`.
- Produces: `PreferencesWriteResult = { kind: "written"; revision: string } | { kind: "conflict" | "read_only" | "failed"; message: string }`.
- Produces: `createPreferencesStore(host: PreferencesHost): { read(signal: AbortSignal): Promise<PreferenceRead>; write(revision: string, input: Omit<SaveInput, "revision">, signal: AbortSignal): Promise<PreferencesWriteResult> }`; export `PreferencesStore = ReturnType<typeof createPreferencesStore>`.

- [ ] **Step 1: Add failing path and filesystem tests.** Include these exact assertions, using isolated directories and fixture-owned administrative paths. Also add safe-first-creation, canonical config-root alias, file-symlink/hardlink, ownership/mode/ACL, read-only file, missing/uncheckable administrative root, UTF-8/duplicate/future-version/oversize, duplicate/overlapping reset, abort, backup, temp-write/fsync/rename, and ambiguous post-commit cases. Assert original bytes survive pre-commit failure and unrelated `opencode.json(c)` never changes. Characterize the accepted concurrent-writer/external-editor race instead of claiming compare-and-swap. Add the termination and concurrent-replacement tests specified below.

```ts
assert.equal(preferencesPath({ home: "/u", platform: "darwin", env: {}, systemPaths: [] }),
  "/u/.config/opencode/predictions.json")
assert.equal(preferencesPath({ home: "/u", platform: "linux", env: { XDG_CONFIG_HOME: "/config" }, systemPaths: [] }),
  "/config/opencode/predictions.json")
assert.throws(() => preferencesPath({ home: "/u", platform: "linux", env: { XDG_CONFIG_HOME: "." }, systemPaths: [] }))
// Use path.win32 semantics even when this unit test runs on macOS.
assert.equal(preferencesPath({ home: "C:\\Users\\u", platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, systemPaths: [] }),
  "C:\\Users\\u\\AppData\\Roaming\\opencode\\predictions.json")
const malformedBytes = Buffer.concat([
  Buffer.from('{"version":1,"settings":{"future":"'),
  Buffer.from([0xc3, 0x28]),
  Buffer.from('"}}'),
])
assert.throws(() => decodePreferences(malformedBytes), /valid UTF-8/)
```

  Name filesystem tests `read does not create preferences`, `first save writes only changed fields`, `already committed revisions reject stale drafts`, `unknown members survive reset`, and `managed sources suppress preferences`. The sequential stale-draft test must commit one change before submitting the old revision and require `kind: "conflict"`. Do not require exactly one success from `Promise.all`; that would reintroduce an unapproved serialization guarantee.

  Add `killed writer before commit does not prevent a fresh save` and `killed writer after commit preserves the complete document`. The fixture worker must run the real store, report `"prepared"` immediately before atomic active-document replacement or `"committed"` immediately after that replacement through child-process IPC, and pause. Use test-only filesystem interception like the existing store tests; add no production pause hook. After receiving the checkpoint, send `SIGKILL` and await the child's exit. Assert persisted bytes equal the original/prepared committed document respectively. Without removing any directory/file, a new worker must read the actual revision and save a new edit successfully. A leftover private temporary file must not affect admission, become active configuration, or be deleted by that new worker. For a post-commit crash, readback must retain the committed value until the fresh edit deliberately changes it. Never automatically replay the interrupted draft or restore the backup.

  Add `concurrent replacements can lose an earlier edit` and `concurrent first creation remains whole-document atomic`. Pause both production writers after their final revision checks and before active-document replacement. For an existing file, let A change `debug` and B change `contextTurns` from the same baseline. Release A and await its completed write/readback, then release B. Assert both can report `written`, final bytes equal B's full prepared document, and A's changed `debug` value can be lost. Repeat with both writers seeing an initially absent file. This is characterization of the accepted race, not a merge guarantee. Also force another writer to replace bytes before the first writer's post-commit verification and require an uncertain failure, never a rollback or automatic retry. Assert no save creates lock artifacts, and preexisting unrelated lock-named artifacts remain untouched and do not block Save.
- [ ] **Step 2: Run** `node --test tests/preferences-store.test.ts`; expect missing exports/failing transactions.
- [ ] **Step 3: Implement the store.** Reuse file-integrity mechanics from `src/config.ts`, not its lock, plugin-entry/version/project-discovery gates. Use exclusive `.predictions.tmp-<uuid>` files and `predictions.json.backup`; strictly bound and validate all writes. Implement `decodePreferences` with `new TextDecoder("utf-8", { fatal: true })`, byte-bound checks before decoding, and the safe error `Prediction preferences must be valid UTF-8.`; route every active-document byte read through it rather than replacement decoding. Hash canonical source identity, absence/presence, bytes, and relevant file identity for revisions. Read without creating directories; create on explicit Save only. Re-read before preparing each write and compare with the supplied revision; apply `validatePreferenceFields` to the complete prospective known settings before any defaulting, preserving unknown members from that snapshot. Recheck immediately before replacement, but do not claim compare-and-swap or serialize writers. A malformed document is not writable; a valid document with invalid known values can be repaired by a fully valid prospective patch. Expose invalid known values in `PreferenceRead.overrides`; document validity refers to safe decoding/structure, not successful option validation. Re-read after commit and report an uncertain failure if a concurrent replacement changed the expected bytes. Clean up only this transaction's own temporary files; do not inspect/create/remove lock paths or sweep other writers' files.
- [ ] **Step 4: Run** `node --test tests/preferences-store.test.ts`; require every transaction and failure case from Step 1 to pass, including two actual worker processes.
- [ ] **Step 5: Commit** the three new files as `feat: persist dedicated prediction preferences`.

### Task 3: Own runtime activation without remounting the host plugin

**Files:** Create `src/preferences-runtime.ts`, `tests/preferences-runtime.test.ts`; extend `tests/client.test.ts` only if its existing version-change coverage lacks a required case.

**Interfaces:**
- Consumes: Task 1's resolver, Task 2's store, and `createService(api: ServiceAPI, rawOptions: unknown, directory: string)`.
- Produces: `PreferenceRuntimeState = { stored: PreferenceRead; resolved: ResolvedPreferences; revision: string; activeRevision: string | null; service: ReturnType<typeof createService> }`.
- Produces: `createPreferencesRuntime(store: PreferencesStore, legacy: unknown, make: (rawOptions: unknown) => ReturnType<typeof createService>): { refresh(signal: AbortSignal): Promise<void>; state(): PreferenceRuntimeState; predict(input: Request, signal: AbortSignal): Promise<Reply>; dispose(): void }`; export `PreferencesRuntime`.
- `state()` is available only after the first successful `refresh`. Startup document failure becomes a published unhealthy state, not an unhandled setup failure.

- [ ] **Step 1: Add failing lifecycle tests.** Name and assert:

```ts
// Runtime fixture counts engine construction/disposal and provider calls.
assert.equal(f.runtime.state().activeRevision, f.runtime.state().revision)
assert.equal(f.calls.generate, 0)
// After an override is reset to an equal fallback value and refreshed:
assert.equal(f.runtime.state().resolved.origins.debug, "configuration")
assert.equal(f.runtime.state().activeRevision, f.runtime.state().revision)
assert.equal(f.calls.construct, constructsBeforeReset)
```

  Also test `effective changes abort the old engine`, `late old-engine results never escape`, `corrupt replacement disables predictions`, and `administrative configuration uses legacy options without preferences`.

  Add `numeric-null preference on startup never activates` and `manual numeric-null replacement disables the old engine`. Table-test `timeoutMs` and `contextTurns` with `null`: after refresh, require a matching error issue, `activeRevision === null`, disposed prior engine on replacement, and no usable prediction or generation/PR call. Repairing the field to a valid integer and refreshing must restore healthy options and `activeRevision === revision`. Pair these with a missing-preferences/legacy-null case that retains the current `8000`/`3` defaults.
- [ ] **Step 2: Run** `node --test tests/preferences-runtime.test.ts`; expect failure because the owner is absent.
- [ ] **Step 3: Implement ordered refresh and prediction ownership.** Capture each plugin instance's legacy options; derive the composite setup revision from store revision, relevant legacy options including `contextFile`, and policy. Publish one coherent state and prevent an older refresh from overwriting a newer adopted snapshot. This orders in-memory activation only; it must not acquire a write lock or queue Save transactions. Validate the resolved preference issues before parsing/constructing effective options: nonempty error issues must publish an unhealthy engine and `activeRevision: null`, even if `parseOptions` would otherwise coalesce numeric nulls to defaults. Construct/dispose engines only when parsed effective options or health change; preserve queue learning for semantically equal options. Adopt origin-only revisions without replacing the engine. Invalid/unreadable preferences create an unhealthy engine using existing invalid-options handling, never `{}` defaults. Managed policy instead resolves only legacy options. `predict` refreshes before dispatch and before publishing completion; it returns `{ reason: "stale" }` if its engine was replaced. Disposal prevents late refreshes from resurrecting an engine.
- [ ] **Step 4: Run** `node --test tests/preferences-runtime.test.ts tests/server.test.ts tests/client.test.ts tests/controller.test.ts`; expect all pass. Use deferred promises to test an ignored abort and out-of-order refresh completion. Verify external deletion restores legacy values, a readable/unwritable file stays active, failed reads cannot enable PR context, no new generation occurs on activation, and existing `2000` ms client status/version handling suppresses the old completion without changing its composer.
- [ ] **Step 5: Commit** runtime and focused test changes as `feat: activate prediction preferences safely`.

### Task 4: Serve preference reads and Save on the selected server

**Files:** Modify `src/index.ts`, `src/rpc.ts`, `src/setup-service.ts`, `src/setup.ts`, `tests/setup-service.test.ts`; add `tests/host/preferences.test.ts`; extend `tests/host/fixture.mjs`. Update snapshot literals in `tests/setup.test.ts`, `tests/setup-native-fixture.ts`, `tests/setup-gui.test.ts`, `tests/setup-gui-api.test.ts`, and adapter tests to satisfy the required metadata contract without changing their asserted behaviors.

**Interfaces:**
- Consumes: `PreferencesStore` and `PreferencesRuntime` from Tasks 2–3.
- Produces: `createSetupService(store: PreferencesStore, models: (signal: AbortSignal) => Promise<readonly CatalogModel[]>, runtime: PreferencesRuntime)` with existing `read`, `preview`, `save` method signatures.
- Produces: `Predictions.methods.saveSettings`, consuming exactly `SaveInput` and returning the existing `SaveResult` union.
- Produces: required snapshot metadata from Shared interfaces. Stop advertising `localAuthority`; Task 5 removes it from the public RPC schema and Task 7 removes the internal optional type when its historical callers retire.
- Fixture extension: add `projectConfig?: boolean` to the existing final fixture-options argument. Default remains the historical behavior; `projectConfig: true` deletes `OPENCODE_DISABLE_PROJECT_CONFIG` before starting any server or native host. Expose `preferencesFile`, derived only from fixture-owned server configuration.

- [ ] **Step 1: Add failing service/RPC tests.** Test `normal server saves preferences without source qualification`, `Save never accepts a path or unknown setting`, `fallback changes conflict with a stale draft`, `reset validates the prospective inherited options`, and `durable bytes are not activation proof`. Preserve metadata-only model validation and privacy tests. Extend snapshot-schema tests to reject missing/invalid provenance and allow `activeRevision: null`. Require numeric-null input to return `invalid` without a write; numeric-null values already on disk remain visible with field issues and cannot be activated by an unrelated Save.

```ts
test("normal server saves preferences without source qualification", async () => {
  const f = await preferencesServiceFixture({ legacy: { models: "local/a" } })
  const before = await f.setup.read(signal())
  assert.equal(before.writable, true)
  assert.equal((await f.setup.save({ revision: before.revision, fields: { automatic: false } }, signal())).kind, "saved")
  assert.deepEqual((await f.store.read(signal())).overrides, { automatic: false })
  assert.equal(f.calls.generate, 0)
})
```

  Add `preferencesServiceFixture` locally to `tests/setup-service.test.ts`; it composes a real Task 2 store, Task 3 runtime, and synthetic engine/catalog with counters. The test supplies no plugin-source callback or project-disable environment variable.
- [ ] **Step 2: Run** `node --test tests/setup-service.test.ts tests/preferences-runtime.test.ts`; expect new service/contract assertions fail.
- [ ] **Step 3: Wire the production server.** Build `PreferencesHost` from server HOME/platform/environment and existing administrative-path discovery. Create and initially refresh the runtime before registering handlers. Route predict/status/settings through refresh; delegate Save to the service and refresh after a durable write. `read` returns one coherent runtime/store snapshot, including preference-field issues; mask unknown legacy/document values. Before Save, validate both incoming edits and the full prospective preference fields so an unrelated edit cannot hide an existing numeric-null override. Compare composite revision before Save and raw store revision in the transaction. Abort old in-flight setup work on plugin unload. Do not create a local authority. Use strict top-level and nested allowlists, byte bounds, fixed safe errors, and prospective validation; no supplied path/URL/package/locality flag. Preserve unknown input keys until an explicit validator rejects them, following the existing preview boundary; silently stripping an illegal key is not validation.
- [ ] **Step 4: Run unit tests and actual authenticated-host tests.**

  Run `node --test tests/setup-service.test.ts tests/preferences.test.ts tests/preferences-store.test.ts tests/preferences-runtime.test.ts`, then `npm run typecheck`, `npm run bundle`, and `node --test --test-concurrency=1 tests/host/preferences.test.ts`.

  Native assertions: `saveSettings` without/wrong credentials receives host `401` with unchanged preferences; the fixture's authorized client saves to its own `preferencesFile`; malformed/unknown/oversized payloads do not change bytes; normal project discovery, inline configuration, string/object plugin references, and an unrelated plugins directory do not disable Save. Keep all session/context/generation/PR counters zero. Characterize host-allowed access on an explicitly unauthenticated fixture without claiming the plugin provides another authentication layer. Record exact tested host versions. Missing authentication/native evidence blocks release.
- [ ] **Step 5: Commit** the production server/contract and its focused fixtures/tests as `feat: save prediction preferences through server RPC`.

### Task 5: Replace native Save plumbing with thin client adapters

**Files:** Modify `src/setup-gui-api.ts`, `src/setup-tui-api.ts`, `src/gui.ts`, `src/setup-tui.ts`, `src/rpc.ts`; create `tests/setup-rpc-api.test.ts`. Adapt `tests/setup-native-fixture.ts`, `tests/setup-tui.test.ts`, `tests/setup-gui.test.ts`, `tests/setup-gui-api.test.ts`, `tests/setup-tui-api.test.ts`, and `tests/host/observer/{gui,tui}.ts` to RPC fixtures. Stop production imports of the five old `src/setup-{local,origin,native-api,main,ipc}.ts` files. Keep the modules and their transport-only tests temporarily: Task 7 migrates the remaining historical host callers before deleting them, so this task does not break whole-repo typechecking.

**Interfaces:**
- Consumes: Task 4's network `settings`, `previewSettings`, and `saveSettings`.
- Produces: existing `createGUISetupAPI(ctx, target): SetupAPI`, requiring only `ctx.servers`.
- Produces: `createTUISetupAPI(ctx: Pick<TUIPlugin.Context, "client">, location: SetupLocation): SetupAPI`.
- Produces: `registerSetupTUI(ctx: TUIContext, openStatus: () => Promise<void>): () => void` without the standalone-runtime test seam.

- [ ] **Step 1: Add failing adapter tests.** Assert a shared-service CLI with no standalone arguments reads writable settings and sends exactly one Save through its captured client/location. For Desktop assert `ctx.main` is never called. Switch client/server during a deferred read and immediately before Save; require rejection without retargeting and retain the draft. A fake remote server must never cause any Node filesystem/socket operation on the client.

```ts
test("ordinary CLI Save uses only its selected RPC client", async () => {
  const calls: unknown[] = []
  const rpc = { settings: async () => snapshot, previewSettings: async () => preview,
    saveSettings: async (...args: unknown[]) => { calls.push(args); return saved } }
  const client = { rpc: () => rpc }
  const api = createTUISetupAPI({ client } as any, { directory: "/project" })
  assert.equal((await api.read(signal())).writable, true)
  await api.save({ revision: snapshot.revision, fields: { debug: true } }, signal())
  assert.equal(calls.length, 1)
  assert.deepEqual((calls[0] as any[])[1].location, { directory: "/project" })
})
```

  Define `snapshot`, `preview`, and `saved` as typed, static fixtures in `tests/setup-rpc-api.test.ts`; `snapshot` includes the required metadata and `writable: true`. No runtime/argv fixture is needed.
- [ ] **Step 2: Run** `node --test tests/setup-rpc-api.test.ts tests/setup-tui-api.test.ts`; expect failures against old local-only adapters.
- [ ] **Step 3: Implement thin adapters.** Pin client identity and a cloned location for the editor lifetime. Recheck the selected host client before and after reads and before dispatching Save. Reject a changed target; an in-flight lost/changed acknowledgement remains ambiguous rather than a guaranteed no-write result. Retry only mount reads through existing `waitForSetupSnapshot`; never retry Save. Remove Desktop `main` registration and runtime/native imports. Remove `localAuthority` from the public RPC schema; retain the internal optional member until Task 7 deletes old transport callers. Preserve the known no-arbitrary-client-file guarantee without preserving obsolete network-write denial expectations.
- [ ] **Step 4: Run** `node --test tests/setup-rpc-api.test.ts tests/setup-gui-api.test.ts tests/setup-tui-api.test.ts tests/setup-tui.test.ts tests/setup-gui.test.ts tests/setup.test.ts`, `npm run typecheck`, and `npm run bundle`; expect pass. Search production imports for old module names and require none. Keep the production GUI import graph free of Node built-ins. Do not delete modules still imported by historical host tests.
- [ ] **Step 5: Commit** only replacement adapters and connected fixture/import updates as `refactor: use selected-server RPC for prediction settings`.

### Task 6: Make preference provenance and reset usable in both hosts

**Files:** Modify `src/setup.ts`, `src/setup-gui.ts`, `src/setup-tui.ts`, `src/setup-copy.ts`, `tests/setup.test.ts`, `tests/setup-gui.test.ts`, `tests/setup-tui.test.ts`; extend `tests/client.test.ts` if needed.

**Interfaces:**
- Consumes: snapshot `overrides`, `fallbackFields`, `origins`, `activeRevision`, and Save reset semantics.
- Produces: `SetupEditor.resetPreferences(): void`, staging removal of all eight known overrides without writing.
- Produces: `SetupState.reset: SettingKey[]`; clear a field's reset intent when that field is edited again. Save patches must omit fields being reset. `removeModels` continues to mean explicit no models, not reset.

- [ ] **Step 1: Add failing draft/render tests.** Assert reset is dirty when an override equals fallback, Discard restores its origin, resetting then editing affects only that field plus remaining reset keys, and final-model removal sends `removeModels: true`. Assert each host displays the server path, `User preferences`, the three origin labels, and a staged **Use OpenCode configuration** action. All eight controls remain usable with predictions disabled. Both hosts must disclose that simultaneous saves can overwrite different settings and that the recovery copy may not contain those changes. They must not promise conflict-free saving, serialized writers, or lock recovery.

```ts
test("reset stages an origin-only change until Save", async () => {
  const f = preferenceEditorFixture({ legacy: { debug: false }, overrides: { debug: false } })
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  editor.resetPreferences()
  assert.equal(editor.state().dirty, true)
  assert.deepEqual(editor.state().reset, ["debug"])
  assert.equal(f.writes.length, 0)
  assert.equal((await editor.save()).kind, "saved")
  assert.deepEqual(f.writes[0], { revision: "r1", fields: {}, reset: ["debug"] })
})
```

  Add `preferenceEditorFixture` locally to `tests/setup.test.ts`, extending its existing editor fixture with the new metadata and recorded write inputs. Assert active revision, not an invented engine restart, in this fixture.
- [ ] **Step 2: Run** `node --test tests/setup.test.ts tests/setup-gui.test.ts tests/setup-tui.test.ts`; expect missing reset/provenance assertions fail.
- [ ] **Step 3: Implement changed-intent tracking and UI additions.** Keep resolved sparse values separate from own override/reset intent. Compute expected persisted overrides and fallback resolution for readback. Confirm **Saved** using persisted intent, effective options, and `activeRevision === revision`; do not require a new service version for a provenance-only change. Existing lost-reply readback stays bounded to `3000` ms and never repeats Save. Reset confirms before replacing dirty edits and still requires Save; add no per-field editor redesign.

  Replace old scope/standalone/shared-config warning copy in `src/setup-copy.ts` with:

  - Scope: `Settings apply to user prediction preferences on the selected server. They affect all projects using this configuration directory.`
  - Precedence: `Saved preferences override OpenCode configuration. Use OpenCode configuration removes these overrides after you save.`
  - Race: `Avoid saving prediction preferences from multiple places at once. Simultaneous saves can overwrite each other's changes, including different settings. The recovery copy may not contain those changes.`
  - Provenance labels: `Saved preference`, `OpenCode configuration`, `Default`.

  Keep GitHub provider/data disclosure and cost copy unchanged. Show actual storage/policy failure reasons, never instructions to change launch flags. Explain the accepted multiple-writer and backup limitations through the existing saving-help copy; add no lock status, timeout, cleanup procedure, or unlock control. For narrow TUI rows, use short labels and put full path/provenance in an informational alert rather than overflowing.
- [ ] **Step 4: Run** `node --test tests/setup.test.ts tests/setup-service.test.ts tests/setup-gui.test.ts tests/setup-tui.test.ts tests/client.test.ts tests/controller.test.ts`; expect pass. Require dirty-state reset-to-same-value proof, no automatic prediction on activation, stale late-result suppression, no composer mutation, retained invalid/no-match selections, and preserved drafts after conflict, disconnect, activation failure, or undecidable acknowledgement.
- [ ] **Step 5: Commit** shared editor/UI/tests as `feat: show prediction preference sources and reset`.

### Task 7: Qualify normal launches, compatibility, and failure recovery

**Files:** Extend `tests/host/preferences.test.ts`, `tests/host/setup-ui.test.ts`, `tests/host/{fixture.mjs,terminal.py,lifecycle.test.ts,git.test.ts}`, and observer probes. Replace obsolete production-writer assertions in `tests/host/persistence.test.ts`, `tests/host/persistence-worker.ts`, and `tests/host/persistence-probe/{index,rpc}.ts` with dedicated-store/production-RPC proof. Retire `src/config.ts`, `tests/config.test.ts`, the five unused `src/setup-{local,origin,native-api,main,ipc}.ts` modules, `tests/setup-{local,origin,main}.test.ts`, and obsolete local-origin host tests only after replacement coverage is mapped and their import search is empty. Remove the remaining internal `localAuthority` member. Preserve the explicitly historical candidate and its `src/config-edit.ts` dependency.

**Interfaces:**
- Consumes: production Task 4 RPC, Task 5 adapters, Task 6 UI, and fixture `projectConfig: true` / `preferencesFile`.
- Produces: native acceptance tests running through real installed hosts, without standalone/project-disable shortcuts in the normal-use cases.
- Keep test-only acknowledgement-loss injection outside the published RPC contract.

- [ ] **Step 1: Write failing native acceptance cases.** Make a checklist-to-test mapping for all spec acceptance cases before retiring old tests. Desktop `2.3.0` must edit all eight fields through rendered controls and save with project discovery enabled. CLI `2.2.6` must do the same through ordinary `opencode` connected to its normal fixture-owned shared service, not `--server` disguised as normal use. Keep an additional standalone regression. Assert preferences persist and `opencode.json(c)` bytes do not change.
- [ ] **Step 2: Run** `npm run bundle`, then `node --test --test-concurrency=1 tests/host/preferences.test.ts tests/host/setup-ui.test.ts tests/host/lifecycle.test.ts tests/host/git.test.ts`; expect uncovered native behaviors to fail until fixtures/probes are aligned. Do not hide failures with new skips or extend timeouts instead of finding the cause.
- [ ] **Step 3: Complete production-connected fixture coverage.** Cover two locations and two server processes sharing one configuration root; distinct server roots; detected stale drafts; concurrent first creation and accepted lost updates; file deletion/manual atomic replacement; invalid and future-version files; administrative refusal; reset/last-model removal; server switching; restart; write failure and a committed-but-lost reply with exactly one transaction. Include numeric-null manual edits and startup refusal, with successful repair. Carry Task 2's production-store kill-before-commit and kill-after-commit evidence into the qualification record: a fresh writer must read actual persisted state and save without filesystem cleanup or automatic replay of the interrupted operation. Exercise Git plugin references using the existing fixture-local Git install, not a fake local-source type. Keep local, string/object, inline, and packed-install cases.
- [ ] **Step 4: Run the same native command and require all enabled cases pass.** Verify all eight persisted fields, correct inheritance per location, active revision, no double write after loss, unchanged composer draft, suppressed old suggestion/offer, zero extra prediction/PR calls, and no writes to client HOME or unrelated config. Delete the obsolete production writer only after its callers/fixtures are migrated; retain equivalent transaction-failure checks in `tests/preferences-store.test.ts`. Record native evidence and genuine platform omissions in `docs/research/2026-11-18-predictions-preferences-qualification.md`.
- [ ] **Step 5: Commit** connected acceptance fixtures/tests and qualification evidence as `test: qualify normal prediction settings workflows`.

### Task 8: Ship the prebuilt artifact and document the new contract

**Files:** Modify `README.md`, `PRODUCT.md`, `tests/package.test.mjs`, `scripts/test-installed.mjs`; regenerate `dist/*`. Update the old setup plan/spec headers with supersession links only after approval; preserve historical findings.

**Interfaces:**
- Consumes: completed Tasks 1–7 and exact format/path/security copy in the new spec.
- Produces: a packed plugin with preference writes only in the server bundle, no local Save bridge, and installed-host proof.

- [ ] **Step 1: Change package assertions to the new contract.** Assert exported RPC methods are exactly `predict`, `status`, `settings`, `previewSettings`, `saveSettings`; only the server bundle owns `.predictions.tmp-` and `predictions.json.backup`. Assert no production entry retains shared-config writer, save-lock artifacts/logic, or local-origin/socket code. Keep GUI import-graph and no-client-filesystem assertions. Point `scripts/test-installed.mjs` at the new native preference suite instead of retired test paths.
- [ ] **Step 2: Run** `npm run test:package`; expect old bundle/new contract mismatches before rebuilding.
- [ ] **Step 3: Document and rebuild.** Replace “Where Save works” with normal-use instructions, server-side path/scope, exact precedence and `models: null`, explicit reset, manual-file repair/backup, administrative restrictions, and authenticated-server access policy. State that reachable callers on an unauthenticated server inherit its access; do not claim local-only authorization. Publish the accepted multiple-writer warning and explain that atomic replacement prevents partial documents but not lost updates, and that backups are last-writer-wins snapshots rather than guaranteed recovery of concurrent edits. After an interrupted Save, reopen/read actual persisted values before making a fresh change; no manual lock cleanup is needed and writes must never replay automatically. Describe no automatic migration and rollback by removing the dedicated file. Update `PRODUCT.md` to distinguish current implemented behavior from historical decisions. Run `npm run bundle`; do not change versions or publish.
- [ ] **Step 4: Run final gates.** Run `npm test`, `npm run typecheck`, `npm run bundle`, `npm run test:package`, `npm run test:installed`, and `git diff --check`. Require zero unexpected failures/skips in supported macOS native cases and inspect packed outputs. Installed tests must include ordinary shared-service CLI, Desktop with project discovery enabled, first Save/reset, Git install, unchanged OpenCode config, and zero extra generation. Linux/Windows path unit tests are not native qualification.
- [ ] **Step 5: Commit** docs, packaging assertions/scripts, and regenerated `dist/*` as `docs: ship usable prediction preferences`. Finish with whole-branch review; do not expand feature scope during review.

## Self-review and acceptance map

- Paths/format/unknown fields/exact defaults/model sentinel: Tasks 1–2.
- Sparse compatibility/no migration/precedence/provenance/reset: Tasks 1, 4, 6, and 7.
- Same-user/config-root scope and two-process race characterization: Tasks 2 and 7.
- Administrative precedence and safe filesystem reasons: Tasks 2–4 and 7.
- Host authorization/no client writes/no arbitrary paths/selected-server binding: Tasks 4–5 and 7–8.
- Atomic replacement/crash recovery/accepted multiple-writer loss: Tasks 2, 6, and 7; Task 8 publishes accurate warning and backup limitations, with no lock cleanup instructions.
- Numeric-null preference validation before startup/manual-edit activation and prospective Save: Tasks 1–4 and 7; legacy parser behavior remains unchanged.
- Strict UTF-8 byte decoding before text parsing: Task 2; malformed-byte test is intentionally not assigned to Task 1.
- Effective activation/active revision/late work/client suppression: Tasks 3–4, 6, and 7.
- Both native surfaces/eight settings/composer/accessibility: Tasks 5–7; retain existing model-editor tests.
- Installed package/Git/prebuilt graph/docs: Tasks 7–8.

The five Review Focus cases each have named tests above. Store and setup revisions are intentionally distinct; Task 4 translates between them. `removeModels` never means reset. Unknown fields are preserved only on disk, never applied or sent to the client. No unproved SDK caller-origin or config-write API is assumed.

Planning self-review checked spec coverage, step scope, type/property consistency, all five Review Focus cases, and document proportion. Physical retirement of old transport modules is deferred to Task 7 so intermediate Task 5 typechecks do not retain imports of deleted files. The separate design-only builder check found no important unanswered questions; no execution gate is marked passed.

## Astra review revision

- Numeric nulls: add preference-only validation before defaulting; carry issues into runtime unhealthy state and `activeRevision: null`; cover startup, manual replacement, repair, and prospective Save. Do not alter legacy null fallback behavior.
- Abandoned locks: the user rejected locking and accepted concurrent-writer risk. Remove the lock feature and manual-recovery flow entirely; retain atomic replacement and best-effort revision checks. Characterize lost updates and prove fresh Save after a crashed worker without cleanup.
- UTF-8: assign fatal decoding and malformed-byte tests to the store, retaining `parsePreferences(text: string)` as the JSON syntax parser.

This resolves the validation gap and supersedes the abandoned-lock problem by removing locking as explicitly requested. The user accepts lost updates between supported writers as well as external editors. Other pending architecture/security decisions remain unapproved. These are planned tests and implementation changes, not completed production fixes.

## Execution handoff

Recommend **Native** execution: the eight tasks share tightly connected contracts, existing tests already supply independent checks, and no parallel implementation is needed. Use a fresh whole-branch reviewer at the end, with particular attention to the revised authorization policy, reset/null semantics, and stale-result lifecycle.

Ask the user to review the design and plan and choose Native or Subagent-driven execution. Do not begin implementation from the request to write this plan alone.

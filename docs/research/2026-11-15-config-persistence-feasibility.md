# Predictions Setup: Config Persistence Feasibility

## Original Verdict: NO-GO

**Current status:** the user subsequently approved best-effort JSON/JSONC edits and accepted the residual external-editor race. The amended design is `docs/superpowers/specs/2026-11-15-predictions-setup-design.md`. The findings below remain valid historical evidence under the former guarantee. They do not establish a GO for the amended policy; the remaining safeguards and implementation plan require further work.

Do not start Tasks 2–7 of `docs/superpowers/plans/2026-11-15-predictions-setup.md`.

The installed OpenCode server cannot update plugin options through its supported configuration patch. A direct filesystem candidate also failed the then-approved no-lost-update requirement. This was an unsuccessful feasibility gate, not a working settings implementation.

No production code, user configuration, installed plugin, or paid provider was changed.

## Environment and Sources

- Node: `v26.13.0`.
- CLI and tested server executable: `opencode v2.2.6`.
- Pinned `@opencode/plugin` and `@opencode/client`: `2.2.6`.
- Installed Desktop application: `2.3.0`, version inspected only; not exercised during this gate.
- Official configuration documentation: <https://opencode.ai/docs/config>.
- Official server-plugin documentation: <https://opencode.ai/docs/build/plugins/server>.
- Actual isolated server OpenAPI: `/openapi.json`.
- Pinned client declarations: `node_modules/@opencode/client/dist/promise/generated/types.d.ts`, `ExperimentalConfigUpdateInput`, `ConfigEntry`, and `PluginSource`.
- Pinned server context: `node_modules/@opencode/plugin/dist/promise/plugin.d.ts`, `Context`.

Tests launch isolated servers with synthetic HOME/XDG roots under `.test-artifacts/host-*`. JSON and JSONC modes use actual global configuration files, not `OPENCODE_CONFIG_CONTENT`. The fixture's synthetic provider records every generation call.

## Verified Findings

### 1. Global files load and can be identified

Both `opencode.json` and `opencode.jsonc` load from the isolated server's XDG config directory. `config.get()` returns the corresponding document path. A metadata-only prediction status call activates the plugin without generating.

After activation, `plugin.list()` identifies `opencode-predictions` with `{ "type": "local", "path": "<package directory>" }`. Calling it before activation returned an empty list; discovery must account for lazy activation.

This proves the simple local-package case through the client API. It does not prove entry ownership for npm/Git aliases, duplicates, custom config roots, managed sources, or overrides.

### 2. The supported configuration patch cannot edit plugin options

The actual server OpenAPI exposes `PATCH /api/experimental/config` with only `shell` in `Config.Patch`. The pinned client agrees:

```ts
export type ExperimentalConfigUpdateInput = {
    readonly shell: string | null;
};
```

A real PATCH containing `plugins` returned HTTP `400`. The JSONC file remained byte-for-byte unchanged. That request also omitted required `shell`, so HTTP `400` alone does not identify the rejection cause. The inspected runtime schema and pinned declaration independently establish the current plugin-options limitation. The other config/plugin mutation routes were plugin check/update operations, not option editing.

The pinned server-plugin `Context` also exposes neither `config` nor a general authenticated `client` property. Client-side document discovery must not be assumed to exist as `ctx.config` in the server plugin.

### 3. Compare, then atomic rename, is not a safe conditional write

A test-only candidate writes precomputed next bytes to a private temporary file, syncs it, compares current bytes with the expected revision, and renames the temporary file over the original.

Deterministic barriers demonstrate:

| Scenario | Observed result |
| --- | --- |
| External edit before the final comparison | Candidate returns `conflict`; external bytes remain. |
| External edit after comparison, before rename | Candidate returns `written`; external edit is lost. |
| Two clients both compare the same original | Both return `written`; the later replacement loses the other change. |
| Failure immediately before rename | Original bytes remain unchanged. |

The race uses explicit promise barriers, not timing assumptions. Passing these characterization tests confirms the failure mechanism; it does **not** mean the candidate is safe.

An advisory lock shared only by plugin instances could serialize those instances, but an external editor does not honor that lock. A JSONC syntax-tree editor would preserve document syntax; it would not fix the comparison/replacement race. Therefore no JSONC dependency was added merely to continue an already-failed gate.

The candidate is confined to `tests/host/persistence.test.ts`, is never loaded by the plugin, and is not exported or packaged.

## Coverage and Limits

| Gate | Status |
| --- | --- |
| Real global JSON and JSONC loading | Verified for isolated local server. |
| Client API document path and local plugin source | Verified for simple local source after activation. |
| Supported plugin-option write API | Unavailable on tested server. |
| Direct-writer protection against racing external edits | Failed deterministically. |
| Pre-rename failure preserves original bytes | Verified for the candidate. |
| Full JSONC editing, permission preservation, duplicate-key handling | Not implemented or proved. |
| npm/Git aliases, duplicate entries, custom roots, both files present | Not exercised; unsupported for any proposed writer until proved. |
| Project/inline/managed overrides, symlink/hardlink/unwritable targets | Not exercised; no production writer or writable-source policy exists. |
| Remote-server attribution | Isolated server-local files verified; distinct-machine remote flow not exercised. |
| Successful save activation, acknowledgement loss, and restart | Not exercised: stopped at the required Step 4 NO-GO. |
| Desktop/CLI setup, cross-client suppression, installed artifact | Not started. |

All persistence host experiments observed zero provider-generation calls. The separate existing server-compatibility tests use the synthetic provider normally. The fixture's `writeConfig` helper creates synthetic test documents; it is not a production JSONC-preserving editor.

## Reproduction and Verification

```sh
node --test tests/host-fixture.test.ts tests/host/persistence.test.ts
npm test
npm run typecheck
```

The initial real-file fixture tests failed against the old inline-only fixture, then passed after real-file support was added. The host API and race tests are characterization experiments rather than claims that a production writer passed TDD.

Verification on 2026-11-15:

- Persistence and fixture checks: 10/10 passed, including negative race characterizations.
- Combined persistence/fixture/existing server compatibility run: 14/14 passed using `node --test --test-concurrency=1 tests/host-fixture.test.ts tests/host/persistence.test.ts tests/host/server.test.ts`.
- Existing project suite: 217/217 passed with `npm test`.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

Detailed RED/GREEN logs remain in this worktree's ignored `.superpowers/sdd/2026-11-15-predictions-setup/` workspace. Passing checks do not change the NO-GO verdict.

## Original Decision and Subsequent Approval

The original recommendation was to obtain a supported host operation for scoped plugin-option edits with source identity, JSONC preservation, and an adequate conditional-write/conflict contract.

After the upstream investigation and Astra's recommendation, the user approved the alternative: best-effort edits to the existing global JSON/JSONC, with a disclosed residual external-editor race despite atomic replacement and serialization among setup clients. This weaker external-editor promise is now authorized. Source identity, setup-writer coordination, stale checks, JSONC/permission preservation, recovery copies, and persistence/activation verification remain mandatory and unproved.

Do not silently switch to plugin storage, guess a global path, or ship the test candidate as a writer.

## Independent Review

A fresh read-only review accepted research checkpoint `cffe431` with no Critical or Important findings and retained NO-GO. The reviewer did not rerun tests.

One Minor remains deferred: assert the runtime patch schema in the capability test, rather than only logging its fields. Otherwise a future API change could leave the malformed-request test green while the report's capability conclusion becomes stale. This does not invalidate the schema/declaration evidence collected for the tested version.

The reviewer explicitly left the unimplemented editor/provenance policy, broader source matrix, save activation/restart, remote-machine behavior, generation suppression, setup draft state, native UI/accessibility, and installed setup flows unverified. No readiness claim extends to those areas.

## Upstream Follow-up: Supported API Search

The user selected investigation of a supported upstream operation rather than weakening the conflict guarantee.

### Result

No supported operation meeting the approved requirements was found. Updating this plugin's SDK to the current npm stable version would not supply it:

- npm reports `@opencode/client` stable `2.3.0`. Its published `ExperimentalConfigUpdateInput` still contains only required `shell: string | null`.
- The published `@opencode/plugin` `2.3.0` server `Context` still exposes neither a config-editing domain nor a general authenticated client.
- The current official OpenAPI still exposes only the shell patch. It provides no expected-revision or conditional-write input for configuration.
- Upstream `dev` was inspected at immutable commit `d432a06b9c07bab0be4e8d642173b1cb14137f11`. Its schema and route still accept only `Config.Patch` containing `shell`.

These are remote documentation, published declaration, and source inspections. No `2.3.0` runtime was installed or tested.

### Existing Upstream Implementation Does Not Close the Gap

Upstream's config updater already uses JSONC-preserving edits and serializes its own update calls with a semaphore. However, it edits only `shell`, writes through the filesystem service, and accepts no expected document revision.

The internal `FileMutation` service is not a supported config-editing operation on the plugin context. Its source explicitly states:

> Mutation locking is process-local and serializes cooperating OpenCode changes; external writes can still race.

Therefore, exposing the existing lock or adding plugin options to the patch alone would not establish the stronger external-editor guarantee. An upstream enhancement needs an explicit conflict/recovery contract, not merely a new endpoint or a mutex.

### Related Work

[Open issue #61617: Interactive setup questions for plugins](https://github.com/anomalyco/opencode/issues/61617) proposes collecting plugin options during installation. It does not specify runtime settings editing, revision preconditions, or protection against racing external edits. It is related work, not an available solution.

The remaining upstream requirements are the already-approved ones: scoped edits to an identified global plugin entry; JSONC/unrelated-content preservation; an explicit conditional-write/conflict contract; and inspectable persistence/activation outcomes. External-editor races must be covered honestly by that contract.

### Sources

- [Published API contract](https://opencode.ai/docs/openapi.json).
- [Stable client 2.3.0 declarations](https://unpkg.com/@opencode/client@2.3.0/dist/promise/generated/types.d.ts).
- [Stable plugin 2.3.0 server context](https://unpkg.com/@opencode/plugin@2.3.0/dist/promise/plugin.d.ts).
- [Pinned upstream config schema](https://github.com/anomalyco/opencode/blob/d432a06b9c07bab0be4e8d642173b1cb14137f11/packages/schema/src/config.ts).
- [Pinned upstream config implementation](https://github.com/anomalyco/opencode/blob/d432a06b9c07bab0be4e8d642173b1cb14137f11/packages/core/src/config.ts#L469-L491).
- [Pinned upstream file-mutation limitation](https://github.com/anomalyco/opencode/blob/d432a06b9c07bab0be4e8d642173b1cb14137f11/packages/core/src/file-mutation.ts#L67-L75).

At the end of this upstream search, NO-GO remained under the original guarantee. The later approved amendment is recorded at the top of this report. No upstream issue, comment, PR, or installation change was submitted.

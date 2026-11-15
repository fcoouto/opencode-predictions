# Predictions Setup: Config Persistence Feasibility

## Verdict: NO-GO

Do not start Tasks 2–7 of `docs/superpowers/plans/2026-11-15-predictions-setup.md`.

The installed OpenCode server cannot update plugin options through its supported configuration patch. A direct filesystem candidate also fails the approved no-lost-update requirement. This is an unsuccessful feasibility gate, not a working settings implementation.

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

A real PATCH containing `plugins` returned HTTP `400`. The JSONC file remained byte-for-byte unchanged. The other config/plugin mutation routes were plugin check/update operations, not option editing.

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

## Decision Needed

Recommended: obtain a supported host operation for scoped plugin-option edits with source identity, JSONC preservation, and an adequate conditional-write/conflict contract.

Another route requires explicit design approval: accept best-effort external-editor conflict detection, with a disclosed residual race despite atomic replacement and serialization among setup clients. That is a weaker promise and is not authorized by the current design.

Do not silently switch to plugin storage, guess a global path, or ship the test candidate as a writer.

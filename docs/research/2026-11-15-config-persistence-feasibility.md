# Predictions Setup: Config Persistence Feasibility

## Approved local-write boundary amendment

The user approved `docs/superpowers/specs/2026-11-15-predictions-setup-local-save-design.md`. Future setup writes use private same-user local IPC, not network Save RPC. Desktop requires the host-owned main-process `sameMachine` check; initial CLI writes require independently qualified standalone private-server provenance. Shared-service, explicit-server, remote, conflicting, and unprovable CLI origins remain read-only.

The source/filesystem GO below does not qualify these new origin or IPC gates. Task 4 must record actual native-origin and local Save/reload evidence before enabling a writable case. A builder check rejected relayable network challenge signing; matching metadata or a relayed signature cannot substitute for a trusted native origin anchor. This amendment preserves the accepted external-editor limitation and every existing writer safeguard.

## Task 4 Native-Origin Qualification

Scope: native-origin investigation only. No production origin guard, private Save socket, network write method, or setup UI was added by this qualification.

### Desktop: host-owned anchor observed

Actual OpenCode Desktop `2.3.0`, using the pinned `2.2.6` plugin declarations and isolated fixture configuration:

| Main-process endpoint | Known | `sameMachine` |
| --- | --- | --- |
| App-owned `sidecar` | Yes | `true` |
| Another authenticated loopback port | Yes | `false` |
| A loopback HTTP relay preserving the other server's PID/version metadata | Yes | `false` |
| Unknown server ID | No | Not authorized |

The probe reads `ctx.serverEndpoints.get(id)` in the actual Electron main process through a test-only native IPC contract. It returns only identity/classification fields, never endpoint credentials. Window-provided metadata is not the authority.

Verdict: the main-process `sameMachine === true` primitive is available and distinguishes the tested targets. The future production main bridge must resolve it itself, pin the selected ID/location, and recheck the current endpoint before local access. These observations do not qualify another port or remote server for writes.

### CLI: private-launch binding observed

Actual CLI/server `2.2.6` on macOS. The native probe reads the selected client's server metadata, then independently inspects its candidate process with `/bin/ps`. The eligible launch path must bind that process to the TUI as a same-user direct child, using the same executable and exact `serve --stdio --port 0` invocation. A PID returned over RPC is only a candidate for these OS checks.

The installed executable was also inspected read-only to trace actual endpoint ownership:

- Root TUI entry passes its parsed `server` and `standalone` options to `cli.server-connection.resolve`.
- Explicit server and standalone options together fail with `"--server and --standalone cannot be combined"`.
- The explicit standalone branch calls `cli.standalone.endpoint`, which spawns a private child through the CLI executable, generates fresh authentication in memory, and receives the endpoint through the child's stdout.
- The TUI creates its selected client from that returned endpoint. It installs endpoint-replacement/reconnect callbacks only when the resolver returned a shared-service controller; the standalone branch does not return one.
- No endpoint environment-variable selection occurs in that resolver. The password variables are authentication inputs, not server-selection authority.

Executable inspected: `/opt/homebrew/Cellar/opencode-v2/2.2.6/bin/opencode`.
SHA-256: `90e4d03597b03d2051b65b4d793467764e55bacd8e22bf4824479c7233ea0e15`.
The exact extracted resolver/launcher source and offsets are retained in the execution artifacts. Qualification depends on the observed native implementation, not on importing its private modules.

| Native launch case | Observation | Initial writable-origin eligibility |
| --- | --- | --- |
| Explicit `--standalone` | Selected server is the TUI's same-user private child, with the expected executable/command | Candidate only after the full native gate |
| Standalone with unrelated `OPENCODE_SERVER`/`OPENCODE_SERVER_URL` hints and synthetic wrong inherited password variables | Still selects its own private child | Same bounded candidate; those hints are not recognized endpoint overrides |
| Private child terminated while a usable shared service is registered | Selected client identity stays unchanged and reports the private server unavailable; it does not select the shared server | Revoke access |
| Ordinary shared-service launch | Selects the registered existing fixture server, not a TUI-owned child | Read-only |
| No standalone flag, but service disabled | Also spawns a private child | Read-only; child identity alone does not prove the approved explicit launch mode |
| Explicit `--server` | Selects the external fixture server | Read-only |
| Explicit server through an identity-preserving HTTP relay | Receives the backend's real PID/version, but no TUI-owned private-child binding | Read-only |
| Both conflicting-flag orders | Exit `1` with the conflict error before the observer mounts | No access |

Verdict: the pinned root launch path and private-child relationship are characterized; there is no public `ctx.standalone`/peer-origin field in the actual TUI context. The future guard must combine a strictly interpreted, explicitly qualified standalone invocation, the audited native client binding, OS-owned child identity, and that child's matching local authority. Neither an argument scan, a matching RPC PID, a private-looking process, nor a relayed signature suffices alone. Reject ambiguous arguments, custom/unqualified launchers, target/authority replacement, process loss, and unqualified routing/proxy environments. Shared-service and explicit-server CLI modes remain outside writable scope.

At this qualification checkpoint, production guards and local-authority binding were still pending. The later guard enforcement checkpoint below supersedes only the guard status, not the missing local authority or Save transport.

### Evidence and limits

Command:

```sh
node --test --test-concurrency=1 tests/host/setup-local.test.ts tests/host/lifecycle.test.ts
```

Fresh result: 6/6 passed, no skips. The two origin tests exercise four Desktop endpoint classes and nine CLI launch/failure cases; the other four tests retain native memory/composer/suppression coverage. No provider calls or changes to the active fixture plugin config occurred in the origin tests. Only synthetic local service registration/preferences and probe observations were written.

`npm test`: 277/277 passed. `npm run typecheck` and `git diff --check` passed. Native runs were sequential. Observations live under `.test-artifacts/host-*/origin-*-observation*.json`; command logs and executable-source extracts are in this plan's execution workspace.

Not qualified here: production Save IPC, origin enforcement in the new adapters, actual Save/reload acknowledgement handling, packed-origin flows, remote writes, other CLI/server versions, non-macOS hosts, or proxy-enabled/custom launchers. Desktop's `2.3.0` UI observation does not expand the writer's `2.2.6` server allowlist. PR #25 integration and its Advanced switch remain pending.

## Task 4 Production Native-Origin Guard Checkpoint

User authorized production guards and enforcement tests, not private Save transport or UI. `src/setup-origin.ts` now provides reusable native-only dispatch guards. The current production UI entry points do not expose Save or use these guards yet; actual native observers execute the production guard functions.

- Desktop requires Desktop `2.3.0` and the main-process registry's exact `sameMachine === true`. Each guard pins the selected ID, URL, password, and headers; a mismatch permanently revokes it. Host teardown, caller cancellation, and disposal cancel guarded work. A completion recheck rejects changed endpoint state without claiming rollback.
- Standalone requires macOS and CLI/server `2.2.6`, the qualified native executable, an explicitly recognized root `--standalone` invocation, no unqualified routing/proxy/custom-launch hints, and the same selected client. It independently verifies the server candidate as a same-user direct child with the exact executable and `serve --stdio --port 0` command. It pins PID and observed start time, rejects replacement PIDs before OS inspection, and rechecks mutable native state after asynchronous verification.
- Metadata verification has a `2000` ms deadline even if a dependency ignores cancellation. Native `/bin/ps` inspection has a `1000` ms timeout and `8192`-byte output bound. Inspection failures return fixed safe copy, not raw native errors or credentials.
- Network `settings` always returns `writable: false`. Existing source refusal reasons remain intact; otherwise it explains that saving requires a verified local setup connection. Network `saveSettings` and `proveLocalSettings` return `rpc.method_not_found`.

Initial guard tests observed RED against unguarded stubs. A separate replacement-PID test observed RED when the guard inspected a new PID before refusing it; the early rejection now passes. Native enforcement assertions also observed RED before the observers invoked the production guards.

Fresh checks:

```sh
node --test tests/setup-origin.test.ts
npm test
npm run typecheck
npm run bundle
node --test --test-concurrency=1 tests/host/persistence.test.ts tests/host/lifecycle.test.ts tests/host/setup-local.test.ts
git diff --check
```

Results: 15/15 guard tests, 292/292 project tests, and 17/17 native host tests passed with no skips. Typecheck, bundle, and whitespace checks passed. The host run retains existing persistence research and memory-handoff tests; it does not prove an actual setup Save.

Actual Desktop sidecar dispatch count was one; other port, identity-preserving relay, and unknown target counts were zero. Normal standalone dispatched once. Standalone with endpoint hints, shared service, private fallback without the explicit flag, explicit server, and relayed explicit server all dispatched zero times. Conflicting flags still fail before plugin mount. After private-child loss, the unchanged selected client reported unavailable and the guard denied with zero further local dispatches. Origin probes made no provider calls and preserved active fixture configuration bytes.

Evidence: execution logs `task-4-guard-{red,final,suite,host-final,bundle}.log`, `task-4-guard-replacement-red.log`, `task-4-native-guard-{red,green}.log`, and `task-4-network-origin-{red,green}.log`. Latest native observations: `.test-artifacts/host-7HrFNb/origin-desktop-observation.json` and `.test-artifacts/host-dsKhos/origin-cli-observations.json`.

Limits: guards establish only a pre-dispatch native-origin prerequisite. They do not bind a socket authority, location, source, or Save transaction. A cancellation or failed completion check cannot roll back already dispatched work. Future adapters must pin location and authority, verify the socket/server relationship, and preserve persistence/readback safeguards. No private socket, production main/TUI setup adapter, actual Save/reload acknowledgement, installed-package origin flow, upstream PR integration, or new writable case is claimed. Task 4 remains incomplete and Save remains disabled.

For the user-requested guard checkpoint commit, earlier lifecycle/editor changes were excluded from the index. An isolated export of the staged guard candidate passed 271/271 project tests, 13/13 sequential persistence/origin host tests, typecheck, and bundle. The 292/292 and 17/17 results above describe the broader working tree, not the guard-only commit. Only the server entry bundle and source map changed in the isolated build; those generated files accompany the checkpoint.

## Task 4 Transport/Adapter Checkpoint: Desktop Save Blocked

After guard commit `83e3de2`, the user requested proceeding with the remaining Task 4 work. Uncommitted implementation now includes private local transport, lazy server-owned authority creation/disposal, initial main/GUI/TUI adapters, the main IPC contract, and shared native read/Save binding. Network RPC still has no write/signing method and always reports read-only permission.

The local envelope also carries the expected native server PID. The server checks it before dispatch, and the response repeats its actual PID. This is a binding check after native origin authorization, not independent origin proof. Unknown fields, wrong authority/version/location/PID, unsafe path ownership/modes, oversized frames, and disposed connections refuse access. Tests cover the separate request/response bounds, sixteen-client admission, and operation deadline.

One platform limitation is explicit: Node closes a Unix listener by unlinking its original bind path, even if another listener replaced it. On detected path replacement, disposal revokes the authority and unreferences the old listener instead of deleting the replacement. That revoked listener remains until process exit. Normal disposal closes sockets and removes the original authority's paths. A `shortcut:` comment records this limitation; it must not be presented as complete cleanup under tampering.

Fresh results: 314/314 project tests passed, including 11 local transport and 11 main/TUI/GUI-adapter tests. Typecheck, bundle, and whitespace checks passed. A complete sequential native persistence/lifecycle/origin run passed 18/19 with no skips.

The failing gate is `setup local Desktop saves through production main IPC and reconciles watcher activation`. The installed Desktop UI and its bundled sidecar both report **2.3.0**. The CLI available on PATH is **2.2.6**; those versions are not interchangeable. Earlier Desktop origin classification and memory-handoff evidence did not qualify its bundled server's persistence behavior. The writer deliberately still refuses every server version except 2.2.6. The new native test records this mismatch as a failure rather than skipping it or weakening the allowlist.

Before adding the explicit version precondition, native main-process calls also found `rpc.unavailable` for the requested project location. A fixture-only fetch trace showed the expected location query; the sidecar listed custom plugins at its default location but none at the requested location. Adding a plugin-list call did not resolve it and was removed. Temporary diagnostics were removed from source. This selected-location RPC difference also needs qualification before Desktop Save can pass; do not fall back to a different location.

The actual 2.2.6 server-owned Save test passes: one JSONC edit, preserved comment, watcher-driven service/authority replacement, effective readback, rejection of the old authority, stale revision conflict, unchanged bytes after conflict, and zero provider calls. It does not substitute for Desktop or actual standalone TUI adapter Save/lifecycle evidence.

Logs: `task-4-transport-{red,binding-red,final}.log`, `task-4-adapters-{red,final}.log`, `task-4-gui-api-red.log`, `task-4-save-host-{red,green}.log`, `task-4-desktop-save-{red,green}.log`, and `task-4-remaining-{suite,bundle,host}.log` in the execution workspace.

Task 4 remains open and these changes are not committed. Remaining gates include Desktop 2.3.0 source/persistence and selected-location RPC qualification; actual standalone/native Save and composer/remount/acknowledgement tests; remaining path/collision/cancellation coverage; complete IPC validation; upstream GitHub-context runtime reconciliation and round-trip tests; installed-package flows; and final review. No native setup UI or remote write support is added.

## Authorized Desktop 2.3.0 Qualification: Scoped GO

The user explicitly approved extending Desktop qualification. This supersedes the version/startup blockers above, not the remaining Task 4 gates.

Measured bundled server: `/Applications/OpenCode.app/Contents/Resources/opencode-cli`, version `2.3.0`, SHA-256 `a903a38bb731929e0080a0d6cd828034685a756d52977d241eb19d3a8d599830`.

### RPC startup cause and fix

A fresh actual 2.3.0 server returned an empty plugin registry and `rpc.unavailable`, then returned the active predictions plugin and valid snapshot for the **same requested location** after asynchronous mount. Default-location fallback is unnecessary and remains forbidden. Source discovery and scoped RPC work after mount.

`waitForSetupSnapshot` waits at most 2000 ms for metadata, retries only `rpc.unavailable`, and respects caller cancellation even when a dependency ignores its signal. It never retries a Save, schema error, or transport failure. The new mount regression observed RED before this fix and GREEN afterward. The fixture separately waits for its configured plugin to become active before returning.

### Qualification before allowlist expansion

An isolated copy of current source changed only its candidate writer's exact version admission. Before changing the main working-tree gate, that candidate passed:

- 25/25 production-store safeguards with the host version set to 2.3.0: source/override/filesystem refusal, JSONC preservation, stale edits, cooperating writers, cancellation, recovery, real permission failures, and uncertain post-commit outcomes.
- 17/17 actual bundled-server persistence/activation checks: JSON and JSONC discovery, qualified local source, refusal of public plugin-option writes, watcher-driven remount, restart persistence, lost-acknowledgement readback without repeat, cross-process writer coordination, and sole-model removal preserving comments.
- Actual Desktop production main-IPC Save and subsequent effective readback, with zero provider calls.

The first Desktop candidate correctly returned `saved_not_active` before watcher activation. The approved result contract allows that acknowledgement. The native test now accepts either durable result, then separately requires changed effective options and a fresh service version within its deadline; it does not treat a durable write as activation proof.

After that evidence, the new working-tree 2.3.0 writer test observed RED against the old gate, then the macOS writer's exact allowlist became `2.2.6` and `2.3.0`. Other versions and every existing source/filesystem refusal remain unchanged. The independent CLI standalone-origin gate remains 2.2.6 only; this work does not qualify the 2.3.0 CLI launcher or remote origins.

### Fresh working-tree verification

- Project: 318/318 passed.
- Production store, explicitly running the full safeguard suite at version 2.3.0: 26/26 passed.
- Bundled 2.3.0 persistence/activation hosts: 17/17 passed.
- Sequential native persistence/lifecycle/origin/Save run: 19/19 passed, no skips; the formerly blocked Desktop Save now passes.
- Typecheck and bundle passed.

Logs: `task-4-mount-{red,green}.log`, `task-4-230-{source-red,source-ready,writer-red,suite,config,host,native,bundle}.log` in the execution workspace. The isolated candidate path is recorded in `task-4-230-candidate-path.txt`; its logs are `qualification-{config,host,desktop,bundle}.log`.

Scope remains narrow. Existing composer/memory-handoff tests still do not prove actual standalone Save, Save-triggered prediction-module remount, or every interrupted-acknowledgement path. GitHub runtime reconciliation, remaining local-boundary/schema tests, installed-package setup proof, and final review remain pending. Task 4 is incomplete; these changes are uncommitted. No user installation/configuration, paid-provider request, upstream merge, push, or remote-write support changed.

## Amended Task 1 Verdict: Scoped GO — Review Corrections Verified

The approved best-effort gate permits production implementation **only for the verified writable subset below**. Task 2 adds the store and Task 3 exposes metadata-only read/preview RPC; public save RPC, lifecycle, and UI remain unbuilt. The initial GO was suspended after checkpoint review exposed a preservation defect and missing production failure-path coverage. The correction checks below restore only this scoped GO, not feature or release approval. The original strict NO-GO remains recorded below.

### Verified writable subset

- macOS, OpenCode CLI/server `2.2.6`, and the pinned plugin/client `2.2.6`.
- A server launched with the verified ordinary `serve` configuration, synthetic server-owned HOME/XDG paths, and `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
- Exactly one existing `opencode.json` or `opencode.jsonc` in the server's global directory.
- One existing object-form entry whose absolute local package path matches the active plugin's server-side resolved source exactly. Its raw options must match the instance's `ctx.options`.
- Valid, duplicate-key-free UTF-8 JSON/JSONC; an owned, regular, singly linked file and an owned, non-group/world-writable canonical global directory. Unsupported ACLs and indirect paths refuse writes.
- No explicit/inline/custom-directory override, managed/system source, or automatic global plugin directory.

This deliberately does **not** establish ordinary project discovery, npm/Git/string-form targets, remote machines, embedded/custom system discovery, Linux/Windows, or server `2.3.0` as writable. Task 2 must preserve read-only behavior unless it adds evidence for a wider case.

### New evidence

The candidate remains isolated in `tests/host/persistence-candidate.ts`. The production store is `src/config.ts`; both use the corrected syntax editor in `src/config-edit.ts`. `tests/host/persistence-probe/` wraps the unchanged production entry point in a test-only server package and now exercises the production store. It obtains resolved source identity from `ctx.plugin.list()`, options from `ctx.options`, and configuration roots from the **server process**, not client RPC arguments. There is no invented `ctx.config` or unauthenticated self-request.

| Required safeguard | Evidence |
| --- | --- |
| Source attribution | Actual server RPC returns the fixture's global source although the calling process has a different HOME. JSON and JSONC both save through the server-side probe. |
| Syntax/content preservation | Pinned `jsonc-parser@3.3.1` supplies the AST/scanner. A token-aware helper avoids its comment-erasing deletion ranges and retains comments in edited model values. Exact-byte assertions cover unaffected content, first/middle/last/sole property removal, trailing commas, CRLF line comments, and comments inside removed or replaced values. The actual Bun server also removes a sole trailing-comma model property without losing its comment. |
| Permission preservation | Active mode `0640` survives replacement; owner/group are carried to staged files. Recovery mode is `0600`. Actual file/directory ACL grants refuse writes; mode-only checks were insufficient because macOS `ls` can display `@` instead of `+`. |
| Cooperating writers | Deterministic barriers prove one writer commits and the stale second writer conflicts. Separate Node processes use the production store and share the directory lock. A real OpenCode/Bun production writer also waits for an independent production Node writer and then rejects its stale revision. |
| Stale changes | Revisions cover validated bytes and source/file identity metadata. Changed bytes before replacement and changed permissions conflict. Local path aliases count toward duplicate-entry detection. |
| Atomic replacement/recovery | Exclusive temporary files start at `0600`; staged access never exceeds the active document. Atomic rename replaces the active file. One rotating server-local `.predictions-backup` contains captured pre-save bytes, is absent from active config discovery, and is not returned in RPC. |
| Pre-commit failures | Direct production tests interrupt after both files are staged, edit active bytes after recovery rename, force a real recovery rename failure, and receive kernel `EACCES` on active replacement after successful preflight. Active bytes remain unchanged or retain the detected external edit; temporary/lock files are cleaned. No automatic restore occurs. |
| Persistence versus activation | Real JSON/JSONC saves verify persisted bytes, then observe a changed plugin mount with fresh `ctx.options` and changed production status. A full isolated-server restart retains edited values. Production post-commit mismatch and verification-error tests return the fixed uncertain-save message, never falsely claiming "not saved", rolling back, or repeating replacement. The candidate's corresponding outcome remains `written_unverified`. |
| Lost acknowledgement | The server commits while its reply is delayed; the caller aborts. Fresh reads reconcile the edited options after remount. The file inode and original backup prove no repeated write. |
| No generation | Every persistence/activation probe observes zero synthetic provider calls, including enabling automatic predictions. This does not cover live GUI/TUI invalidation; those tests still belong to Tasks 4 and 7. |
| Accepted external-editor race | Both historical and new candidates deterministically lose an edit made after the final comparison. The recovery copy lacks that late edit. Atomic rename and cooperating locks do not remove this accepted limit. |

### Read-only and refusal matrix

Control fixtures are writable before each negative arrangement. The test candidate refuses inline/explicit/custom-directory configuration, simultaneous global filenames, enabled/unverified project discovery, managed paths, wrong or mismatching source/options, duplicate entries/keys and local aliases, malformed JSONC, string-form targets, npm/Git provenance, unwritable files, symlinked active/recovery files, hardlinks, ACLs, writable global directories, and automatic global plugin discovery.

These are real synthetic filesystem refusals plus supplied unsupported-source metadata, **not** successful installations of npm/Git or managed plugins. Distinct-machine remote writes remain disabled and unverified.

The lock is an atomic server-local directory, shared across processes. It covers the complete transaction. It is **never stolen by age**: an abandoned lock times out with no write and requires manual ownership-confirmed recovery. A time-based stale-lock takeover would invalidate this proof. Temporary-file recovery after process/power loss is not an automatic feature.

### Verification and remaining obligations

RED evidence: all six initial safeguard tests failed against the stub; restart failed before fixture support; both real-host save tests failed against a read-only probe; acknowledgement-loss simulation failed before delaying the response. Follow-up RED checks caught alias ambiguity, ACL handling, automatic-discovery ambiguity, unsupported deletion, and inconsistent returned revisions. Cross-process and accepted-limit checks also characterize the implemented primitive; they are not misrepresented as additional RED cycles.

### Checkpoint review correction

The independent review of `12da963..3047ab0` found two Important issues and no Critical issues. The original preservation claim was too broad: library removal erased adjacent comments and failed on a sole property with a trailing comma. Controlled failure tests also still exercised the prototype rather than the production store.

Eight literal production fixtures reproduced the removal issue; seven failed and the plain sole-property control passed before the fix. A further RED test reproduced comment loss when replacing model groups. The shared token-aware editor fixes both without whole-document serialization or regex editing.

Production failure-path tests use test-local ESM filesystem interposition around real operations, not shipping failure hooks. They verify staged edits/cancellation, real recovery and active rename failures, cleanup, uncertain post-commit outcomes, and no automatic restore/repeat. These paths already behaved correctly; the missing proof was added. Mutation checks confirmed the new tests fail if the final comparison is disabled or the committed flag is cleared. Both deliberate mutations were restored before final verification.

Commands:

```sh
node --test --test-concurrency=1 tests/config.test.ts tests/host-fixture.test.ts tests/host/persistence.test.ts tests/host/persistence-safeguards.test.ts tests/host/persistence-activation.test.ts tests/host/server.test.ts
npm test
npm run typecheck
npm run bundle
npm pack --dry-run --json
git diff --check
```

Verified after correction on 2026-11-15: the combined gate passed **59/59**, with no skips; the project suite passed **242/242**; typecheck, bundle, package dry-run, and `git diff --check` passed. The package dry-run excludes the candidate, probe, tests, fixture configs, backups, and evidence workspace. Earlier green checkpoints were 33/33 host plus 217/217 project tests for Task 1, then 42/42 combined plus 226/226 project tests for Task 2; those results did not cover the review findings. No user installation/configuration, paid provider, upstream post, push, or merge changed.

Task 2 now adds cancellation, fixed safe outcomes, supported-version/topology restrictions, and production tests rather than shipping the prototype unchanged. Task 3 adds draft helpers, shared grouped resolution, safe catalog projection, and public metadata-only read/preview RPC. Its checks passed 256/256 project tests, 121/121 focused tests, and 61/61 combined store/host tests, plus typecheck and bundle. Public RPC tests preserve file bytes and record zero provider calls; a runtime-service test also records zero session-context calls and an unchanged queue. Unknown nested input fields are preserved through the pinned decoder specifically so server validation rejects them, rather than silently stripping them.

Activation still requires separate readback. Tasks 4–7 still owe public save reconciliation, live-client suppression, composer/draft preservation, native UI/accessibility, external-editor warnings in both host flows, installed-package checks, and final feature review. Remote writes remain disabled until their topology is qualified. GO does not waive any of these obligations. The corrected persistence checkpoint has regression proof, not a second reviewer approval or release approval.

## Original Verdict: NO-GO

The following section describes the former absolute external-editor guarantee. Its instruction to stop was superseded only by the approved amendment and scoped evidence above.

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

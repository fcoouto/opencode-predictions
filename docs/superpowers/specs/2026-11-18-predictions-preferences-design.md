# Usable Prediction Settings

Status: approved for implementation in conversation after review and the explicit removal of write locking. Scope includes dedicated-file precedence and Save through the selected server's existing access controls. No automatic migration, publishing, or user-configuration edits are authorized.

Implementation evidence is recorded in the [qualification record](../../research/2026-11-18-predictions-preferences-qualification.md). Planning-stage evidence notes below predate implementation.

User decision: remove the locking feature and accept concurrent-writer risk. This supersedes the earlier serialization and manual lock-recovery proposals.

## Intent

Prediction Settings must let ordinary Desktop and CLI users change prediction settings without special launch flags, environment changes, absolute-path plugin installation, or manual JSON editing.

The current implementation meets its narrow safety contract but misses this usability goal. `src/config.ts` requires a verified global OpenCode document and disabled project discovery. `src/setup-origin.ts` additionally restricts CLI writes to a qualified standalone launch. Moving settings alone does not remove that transport restriction.

## Approved decisions

1. Store UI preferences in a dedicated, human-readable `predictions.json`, not OpenCode's database or shared `opencode.json(c)`.
2. Treat existing plugin options as fallback configuration. Explicit preferences override the eight editable fields, with visible provenance and an explicit reset.
3. Perform reads and writes on the selected server through OpenCode's existing RPC transport. Retire the plugin's separate local socket and Desktop main-process Save bridge.
4. Use the OpenCode server's access policy as the authorization boundary, rather than proving that every caller is a local OS process.
5. Keep administrative/system configurations read-only for this release, and do not apply user preferences over them.
6. **User-decided:** no save locks, mutexes, lock files/directories, ownership leases, or writer-admission queues. Concurrent writers can overwrite each other's changes.

Items 2 and 4 replace the earlier single-source/local-only persistence policies for this implementation.

## Approaches

- **Continue editing shared OpenCode JSON/JSONC:** preserves one file, but requires authoritative entry/source discovery and still needs a usable Save transport. The current local-path and no-project requirements exclude normal installs.
- **Plugin database storage:** avoids shared-file edits, but makes manual inspection, backup, and portability less obvious. SDK storage scoping/concurrency are not established by its documentation alone.
- **Dedicated file and server-owned RPC — recommended:** isolates writes, supports manual editing and normal client/server connections, and reuses existing validation and UI. Costs are explicit precedence rules and a revised network-write policy.

## Location and scope

Resolve the file using the **server process**, never the Desktop window or CLI client's HOME:

| Server platform | Default |
| --- | --- |
| macOS / Linux | `~/.config/opencode/predictions.json` |
| Windows | `%APPDATA%/opencode/predictions.json` |
| Any platform with an absolute `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/opencode/predictions.json` |

Reject a relative/empty explicit `XDG_CONFIG_HOME`. Reject a missing/nonabsolute Windows `APPDATA`; never fall back to the current project.

Scope is one OS user and configuration root on the server machine. Desktop and shared-service CLI using that same root share preferences. Separate server processes with the same root also share the file. Different users, configuration roots, or machines do not synchronize.

Project, inline, explicit OpenCode configuration, and plugin package references do not select a different preferences path. They may contribute fallback options through `ctx.options`.

Canonicalize trusted configuration-directory aliases on the server. A legitimate symlink in the config-root path is not by itself an error. Pin the resolved target during a transaction; reject a symlinked active preferences file, hard links, unsafe ownership/write permissions, or path replacement.

## Format

The sole active preferences filename is `predictions.json`.

```json
{
  "version": 1,
  "settings": {
    "automatic": false,
    "models": [["provider/model"]]
  }
}
```

- Strict UTF-8 JSON with `version: 1` and an object `settings`. No comments or trailing commas.
- Reject duplicate keys, arrays/null as the document or settings object, malformed UTF-8, and unsupported versions. Bound the document and Save input to `65536` UTF-8 bytes.
- Preserve unknown document/settings members during changed-only writes, but never apply them to prediction behavior or return their values through RPC.
- Only `models`, `enabled`, `automatic`, `escalation`, `timeoutMs`, `contextTurns`, `debug`, and `includeGithubPRContext` are editable.
- Retain validation from `src/options.ts`: `timeoutMs` is an integer from `1` to `2147483647`; `contextTurns` is an integer from `1` to `5`; escalation is `off`, `manual`, or `automatic`.
- Validate present preference values before merging or defaulting. In particular, `timeoutMs: null` and `contextTurns: null` are invalid preferences, not omitted values. The existing `parseOptions` null-coalescing behavior remains unchanged for legacy OpenCode options.
- Existing defaults remain: enabled/automatic `true`, escalation `manual`, timeout `8000`, context turns `3`, debug/PR context `false`, no invented models.
- `contextFile` remains an OpenCode option; this change adds no file-path preference or arbitrary-file write API.

`settings.models: null` has one special meaning: explicitly configure **no prediction models**, suppressing fallback models. Missing `settings.models` means inherit fallback models. Empty arrays remain invalid.

Apply preference-field validation to every disk read, runtime activation, and prospective Save, including reads after manual edits or restart. Exclude the explicit models-null sentinel from ordinary model validation, but do not exempt null values in other fields. Preserve invalid known values and field issues for repair. Invalid user preferences publish unhealthy runtime state with `activeRevision: null`; they never silently fall back to enabled/default behavior.

Strict UTF-8 validation belongs at the byte-reading boundary, before parsing JSON text. Decode bounded bytes with a fatal UTF-8 decoder; a string parser cannot detect bytes already replaced by a permissive decoder. The pure JSON parser tests syntax and duplicate keys; store tests own malformed-byte cases.

## Precedence and compatibility

For each editable field: explicit preference, then that location's `ctx.options`, then the existing parser default.

Use presence, not truthiness. Preserve explicit `false`, ordered model groups, wildcard rules, reasoning variants, and omitted defaults. Strip the models-null sentinel before calling `parseOptions`.

Expose each field's origin as `preferences`, `configuration`, or `default`. Do not claim to know which OpenCode document supplied `ctx.options`; label that source **OpenCode configuration**.

No automatic migration or startup write:

- If the preferences file is missing, predictions behave exactly as before.
- Opening, previewing, and discarding settings create no file or directory.
- The first Save creates only changed preferences, not a copy of every resolved default or location-specific option.
- Existing `opencode.json(c)` bytes and plugin references never change.
- Subsequent manual OpenCode changes affect inherited fields, not explicitly overridden ones. Both hosts explain this.

Add one **Use OpenCode configuration** action. It stages removal of all eight known overrides, requires explicit Save, and preserves unknown settings. Discard restores the old draft. Removing the last model group is different: it stages `models: null`, not inheritance.

Reset does not delete the file. Removing/renaming the dedicated file manually restores legacy behavior at the next refresh. No automatic rollback or destructive migration.

## Administrative configurations

Retain server-side detection of system/managed configuration, but separate it from ordinary global/project/inline discovery:

- macOS: `/Library/Application Support/opencode`, machine managed preferences, and the current user's managed-preferences file.
- Linux: `/etc/opencode`.
- Windows: `%ProgramData%/opencode`; inability to establish the administrative path is not permission to ignore it.

If an administrative source is present or its presence cannot be checked safely, do not apply or write user preferences. Continue using host-resolved `ctx.options` and explain the administrative restriction. Do not alter system files or pretend to provide per-field managed provenance.

Host-level plugin/provider/permission policies remain enforced by OpenCode. This release does not introduce an administrator override mechanism.

## Write authorization: explicit policy change

The proposed `saveSettings` RPC inherits the selected OpenCode server's access controls. Any client authorized to use that server's RPC can change these eight preferences for that server account/configuration root. This includes authorized remote clients.

This is deliberately **not local-only saving**. The pinned plugin RPC handler exposes cancellation and typed errors, not caller identity or an independent authentication decision. Do not invent a peer-address API, infer authorization from a PID/loopback URL, or promise client-specific write roles.

On an authenticated server, missing/invalid credentials must be rejected by the host before plugin dispatch. On a server intentionally exposed without authentication, reachable callers inherit that server's access. The plugin cannot independently promise to exclude them; document this limitation explicitly.

No new listener, credential store, bearer token, proof exchange, client filesystem access, or arbitrary target path. A Save can affect only the server-resolved preferences file. Selecting another server must never write the local client's file.

Before enabling this RPC, native tests must establish the actual default Desktop/shared-service authentication behavior. Missing evidence blocks release, not an excuse to ship a read-only normal path as complete.

## Persistence

Reuse the existing file-integrity techniques, scoped to the dedicated file, without write coordination:

- No locking or writer serialization, including within one process. Do not create, inspect, wait on, reclaim, or require cleanup of a lock artifact.
- Compare the draft revision with a fresh read and recheck immediately before replacement. Reject detected stale drafts; never silently rebase. These checks are best-effort, not an atomic compare-and-swap.
- A missing file has a valid revision and can be created on explicit Save. Concurrent creators can both pass the same missing-file check; the last replacement wins.
- Create new directories as `0700` and files as `0600`; do not chmod an existing OpenCode configuration directory. Existing readable, owner-controlled directories need not be `0700`.
- Check target ownership, links, write access, relevant ACLs, and canonical-path stability. Return a specific safe reason rather than the old generic source-verification message.
- Use exclusive same-directory temporary files, fsync, atomic replacement, and cleanup. Preserve restrictive permissions on existing files.
- Keep one private `predictions.json.backup` of existing pre-save bytes; do not back up unrelated OpenCode configuration. First creation needs no backup of nonexistent content.
- Do not restore backups automatically. Do not return backup contents or raw filesystem errors.

### Accepted multiple-writer risk

The user explicitly accepts lost updates from simultaneous setup clients, server instances/processes, and external editors. Two writers can read the same revision, both pass the final check, and each replace the file. The later replacement may erase the earlier writer's changes, including changes to different preference fields. Both writers may receive a successful acknowledgement if each verified its own bytes before the other replacement.

Atomic replacement still prevents a partially written active document. It does **not** merge concurrent changes, serialize writers, prevent lost updates, or guarantee that an acknowledged value remains current.

The single backup is also last-writer-wins. It holds a captured pre-save snapshot, not necessarily the version actually overwritten during a race; it cannot guarantee recovery of a lost concurrent edit.

Show this concise warning in both hosts:

> Avoid saving prediction preferences from multiple places at once. Simultaneous saves can overwrite each other's changes, including different settings. The recovery copy may not contain those changes.

Re-read after commit. If another writer has already replaced the expected bytes, report an uncertain outcome and preserve/reload state; do not claim rollback, silently merge, or retry the write. Normal persisted-versus-active verification still applies when the expected bytes are observed.

### Crash behavior without locks

A crash before replacement leaves the original active document intact; a crash after replacement leaves the complete new document. A killed writer may leave its private temporary file, but later saves ignore it and never require deleting it to proceed. Do not sweep other writers' temporary files or automatically restore a backup.

Require production-store child-process termination tests immediately before the active-document replacement and immediately after it, before verification/cleanup. After the child exits, a fresh worker must read the actual persisted document and save without manual filesystem cleanup or replaying the interrupted draft. Also characterize two writers deliberately paused after their final revision checks: both can commit, the last complete document wins, and one writer's changes can be lost. An already-observed newer revision must still be rejected in the ordinary sequential stale-draft case.

## Runtime activation and synchronization

Keep `createService` as the prediction engine. Add a small server-side owner that resolves preferences, owns the current engine, and disposes/replaces it when effective options change.

Refresh before settings/status/prediction operations and after a pending prediction completes, before returning its result. Reuse the existing clients' `2000` ms status polling; do not add another polling loop, watcher framework, or event channel.

When effective options change, disposal cancels old work and invalidates continuation offers. Discard a late result from an old engine. Client version changes already suppress automatic regeneration for the current completion; retain and test that behavior.

Every loaded location sees shared preferences on its next request. A connected idle client sees changes on its next status poll. Saving, resetting, refreshing, and opening settings never generate predictions or fetch PR metadata.

Track persisted revision separately from active revision. Origin-only changes or reset-to-the-same-value need not replace the engine. They still advance active revision after successful adoption.

Claim **Saved** only when the persisted intent and `activeRevision === revision` are verified. Keep **Saved, not active** for durable bytes without verified activation. A lost reply triggers bounded reads, never another write. Preserve an unresolved draft.

Malformed/unreadable/unsupported preferences must not silently enable default predictions or PR enrichment. Disable predictions with a safe configuration error until repaired; preserve the file. A readable but unwritable valid file can remain active and inspectable.

## UI

Reuse Behavior / Models / Advanced, current controls, validation, model preview, and draft handling.

Show the selected server, **User preferences**, actual server-side path, and per-field provenance. Clearly explain global effect across projects and same-root server processes. Inheritance can differ between projects because OpenCode fallback configuration differs.

Keep controls editable while predictions are disabled. Reserve read-only state for genuine storage/administrative/compatibility failures, with actionable reasons. No standalone-launch instruction or absolute-plugin-path requirement.

Reset is staged, keyboard-accessible, and confirmed before discarding existing draft edits. Preserve composer drafts, focus behavior, no-match selections, GitHub disclosure, and save-failure recovery.

## Release scope and acceptance

- Keep Node `>=26.4.0` and pinned `@opencode/plugin` / `@opencode/client` `2.2.6`. No new dependencies.
- Qualify macOS Desktop `2.3.0` and CLI `2.2.6`, including ordinary shared-service CLI and existing standalone mode. These are test targets, not a new exact-version filesystem allowlist.
- Path/model/store unit coverage includes Linux and Windows semantics; do not claim native Linux/Windows qualification without native runs.
- Actual tests must omit `OPENCODE_DISABLE_PROJECT_CONFIG=1` for the normal-use acceptance cases.
- Qualify installed prebuilt packages and Git references, not only source-linked absolute paths.
- Round-trip all eight settings, first Save, reset, last-model removal, two clients/locations/processes, restart, manual edits, stale drafts, malformed files, failed/ambiguous writes, authentication, and server switching.
- Reject numeric-null preferences before activation, on startup and after manual edits; leave legacy fallback parsing unchanged. Exercise strict UTF-8 byte rejection at the store boundary.
- Kill a production-store writer before and after commit; verify intact/complete persisted bytes, correct readback, and a successful fresh Save without manual cleanup or replay.
- Characterize concurrent first creation and existing-file lost updates without asserting serialized outcomes. Prove no lock artifacts or writer-admission waits are introduced.
- Preserve unrelated configuration bytes and prove zero provider/PR calls from settings operations.

## Non-goals

No UI redesign, account sync, project-specific preferences, import/export wizard, provider authentication UI, permission-role system, automatic migration, OpenCode configuration writes, dependency upgrades, or unrelated cleanup.

## Evidence and limits

Inspected current source, tests, original approved designs, and the persistence research ledger. Official OpenCode plugin/server/RPC/client/config documentation and published `2.2.6` declarations confirm the available interfaces, not native behavior of this proposal.

Context7 lookup was unavailable because its monthly quota was exceeded. No native host tests, runtime changes, or user-file writes were performed while planning.

An independent design-only builder check reported "nothing important left". This is an ambiguity check, not implementation or security qualification.

Astra's subsequent substantive review requested stricter numeric-null activation checks, defined abandoned-lock recovery, and UTF-8 tests at the byte boundary. Numeric validation and strict byte decoding remain planned. The user subsequently removed locking entirely and accepted multiple-writer risk; no abandoned-lock recovery feature remains. Crash/lost-update characterization is planned, not executed.

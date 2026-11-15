# Predictions Setup: Local Save Boundary

Status: approved. The user explicitly approved this revised design and the narrower initial `--standalone` CLI writable scope. Implementation and qualification are still pending; approval is not evidence that either host passes its origin gate.

Parent design: `docs/superpowers/specs/2026-11-15-predictions-setup-design.md`.

## Intent and unchanged requirements

Enable native Desktop and CLI setup on the qualified local server without exposing configuration writes to network-only callers. Keep remote connections read-only until independently qualified.

The existing global JSON/JSONC remains the only settings authority. The server plugin still owns discovery, validation, locking, recovery, atomic replacement, and activation reporting. No client writes configuration files. Preserve the approved external-editor limitation and every existing lifecycle safeguard.

No new plugin setting, settings store, dependency, HTTP listener, user installation change, or remote-write support is included.

## Findings

- Pinned Promise RPC handlers expose `signal` and `error`, not the caller's peer address or transport identity.
- Pinned Effect RPC declarations add no caller-origin control.
- Desktop main-process `ServerEndpoint.sameMachine` explicitly identifies the app's own server. It excludes other ports and WSL.
- TUI context exposes the selected client but no equivalent origin flag.
- `server.info()` reports version, PID, URLs, and a temporary path. These are metadata, not proof of local ownership.
- Builder check found that the original challenge-signing proposal was relayable: a selected remote server could forward challenges to a local server and return its proof. That did not establish endpoint binding. Reject this topology rather than treating it as an accepted limitation.

Sources: pinned `@opencode/plugin` and `@opencode/client` 2.2.6 declarations, especially `dist/promise/rpc.d.ts`, `dist/effect/rpc.d.ts`, `dist/gui/main.d.ts`, `dist/tui/context.d.ts`, and `dist/promise/generated/types.d.ts`.

## Approaches

1. **Private local IPC — selected and approved.** Send Save only through a same-user Unix-domain socket owned by the selected server plugin. Leave network RPC read-only. This changes Task 4's Save transport and requires a small Desktop main-process bridge.
2. **Capability-gated network RPC — not selected.** Preserve `saveSettings` over RPC but distribute a private local credential and manage expiry, rotation, binding, and replay. This adds network credential handling that local-only saving does not need.
3. **Client flags or loopback detection — rejected.** Client-supplied locality, PID, paths, and loopback URLs cannot establish the required boundary.

The user approved option 1 after the builder check exposed a relay gap in the original challenge-signing proposal. The approved revision requires independent native-host origin gates.

## Boundary and selected-server binding

The server plugin creates one ephemeral authority per loaded location instance, only when the existing configuration source passes write qualification. The authority holds a random instance identifier in memory.

- Bind a Unix-domain socket inside a newly created private directory under the server's canonical OS temporary directory.
- Require a directory owned by the current OS user with mode `0700`, and a socket with mode `0600`.
- Use an opaque, strictly validated identifier to derive the socket location under the client's own canonical temporary directory. Never connect to an arbitrary path supplied by RPC.
- Fail closed if ownership, permissions, path length, local availability, or source qualification cannot be established. Do not scan other directories or fall back to client-side config editing.
- Do not store settings, signing keys, bearer tokens, or configuration contents in the socket directory.

The network settings response may advertise the opaque authority identifier. It contains no write credential. An identifier, signed network challenge, matching PID, or matching path is not authorization.

Establish selected-server locality through a trusted native-host anchor **before** connecting to a socket:

1. Desktop main requires the host-owned endpoint registry's `sameMachine` value.
2. CLI initially supports writes only for a qualified `--standalone` private-server launch. Qualification must prove the selected client belongs to that private local server and cannot be redirected by a conflicting flag, environment override, or later reconnect.
3. If the native host cannot establish that anchor, return read-only. Do not try to establish locality by asking the selected network server to identify or sign for itself.
4. After the anchor passes, verify the local authority's identity, pinned location, ownership, permissions, and snapshot against that anchored target.
5. Only the resulting same-user local socket connection may inspect writable settings or submit one Save request.

Limit framing sizes, concurrent connections, and connection lifetime. Recheck the pinned target before dispatch. Do not accept network proof material as socket authorization.

There is no network proof-signing RPC and no public network `saveSettings` method. Network operations remain inspection only.

The native-host anchor must reject a selected remote/proxy server that advertises or relays a different local authority. Hostile code already running with the same OS user's privileges remains outside this boundary; a network relay alone is not excluded.

## Native host use

### Desktop

Use the existing plugin `Ipc` bridge to execute local transport code in Electron's main process, not Node placeholders in the window.

The main process resolves the selected server ID through `ctx.serverEndpoints.get()` and requires `sameMachine === true`. It obtains the selected server's current client using the host-supplied endpoint and credentials. Do not accept a renderer-supplied URL, credential, filesystem path, signing key, or locality flag.

Each editor pins the server ID and location. Main-process authorization and socket identity checks must verify that exact target. Remote, unknown, unsupported, disconnected, and mismatched targets stay read-only. No silent switch to the sidecar is allowed.

Pass the existing IPC `Caller.signal` through local operations so closing the editor, aborting its call, or unloading the main provider cancels pending work.

### CLI

Initially qualify only `opencode --standalone`, with its private local server. Shared-service, explicit-server, conflicting, overridden, and unprovable launches remain read-only with a clear explanation. The user approved this narrower initial writable subset; normal shared-service CLI writes are not part of it.

Qualification must establish trusted launch provenance, not merely the presence of `--standalone` in `argv`. Verify the pinned host's actual selection behavior and reject any mode in which the selected `ctx.client` can point elsewhere. If this cannot be established using the pinned host, do not enable CLI writes.

After that gate, use Node's built-in local socket client with the private server's pinned location and authority. A remote server's filesystem paths are never treated as local paths. Missing or mismatched authority means read-only inspection through existing RPC. PID, hostname, loopback checks, and relayed network proofs are not substitutes.

Both hosts retain the original requirement: remote selections cannot redirect a Save into a local server. No remote topology receives writable qualification from this work.

## Shared editor and server operations

Keep the existing `SetupAPI.read`, `preview`, and `save` signatures. Host adapters choose transport without changing the shared editor's draft behavior.

- Network `settings` and preview remain inspection operations. Network snapshots do not advertise usable write permission.
- A verified local read may return `writable: true`, subject to the existing source checks.
- Local Save delegates to `createSetupService().save()` and the existing `ConfigStore`; the socket supplies no path or source authority from the client.
- Apply all existing validation and stale-revision checks again at Save. Qualification at connection time is not permission to skip transaction checks.
- Explicit model removal, omitted defaults, unknown options, and changed-only patches keep their current meaning.
- Source/revision checks, metadata previews, and local identity checks never generate predictions or read session context.

## Reload, cancellation, and cleanup

Plugin unload stops admission, aborts service-owned generation and pre-commit socket work, closes connections, and removes only that authority's socket and empty private directory. Old authority connections become invalid immediately. Do not delete another instance's files or automatically clean unknown abandoned directories.

A committed write may trigger reload before its socket reply arrives. The editor must read back through its original selected server, rediscover its new local authority where available, and reconcile revision, stored fields, effective options, and service version. Never repeat the write automatically.

Durable bytes without verified activation remain **Saved, not active**. If reconciliation cannot establish the outcome, preserve the draft and require reopening settings before another write. Never claim rollback.

Existing event, polling, remount, stale-result, and composer-preservation tests remain mandatory.

## Qualification and implementation-plan changes

Replace Task 4's public `saveSettings` RPC step with private local Save transport and trusted native-host origin gates. Add shared local transport and the Desktop main bridge to Tasks 4–6 as needed; retain the existing task order and final branch review.

Before enabling local Save, prove:

- Plain authenticated network requests cannot invoke a configuration write.
- Missing authority, malformed IDs, arbitrary paths, mismatched server/location, unsafe permissions, oversized frames, and disconnected clients cannot write.
- A server selected through RPC cannot redirect Save to a different local authority.
- A remote/proxy fixture that advertises local metadata and relays local responses remains read-only; the native-origin gate, not a signed response, must reject it.
- CLI standalone qualification covers normal launch, conflicting flags, remote environment overrides, and any supported reconnect or target-change path. Other CLI modes remain read-only.
- Two authorized local clients still serialize through the production writer and reject stale revisions.
- Save survives watcher-driven reload and interrupted acknowledgements without repeating a write.
- Authority rotation and disposal revoke old connections.
- Desktop's main bridge rejects non-`sameMachine` targets without touching a local config.
- Actual native Desktop and CLI Save flows preserve composer drafts and produce no extra prediction with automatic mode enabled.
- The installed-package path works, not only source-linked tests.

Negative network tests do not qualify remote writes. Unsupported platforms and topologies remain read-only. If the pinned hosts cannot support this boundary, retain inspection rather than substituting a weaker locality check.

## Builder-owned details

Choose module names, bounded protocol limits, framing, fixed safe error copy, and internal interfaces during implementation. Use Node built-ins and pinned host APIs. Do not invent a weaker origin gate if standalone provenance cannot be established. Record material decisions in the existing Task 4 ledger.

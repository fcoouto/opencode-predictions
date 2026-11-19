# Preferences-only prediction configuration

## Intent

Make `predictions.json` the plugin's only user configuration source. Users configure predictions through Prediction Settings in Desktop or CLI, without plugin options in `opencode.json`.

This is a focused follow-up to the server-owned preferences implementation, not a new storage system.

## Approaches

- **Retain the options fallback:** preserves compatibility, but leaves two configuration paths. Rejected by the user.
- **Import options once, then use preferences only:** preserves old settings, but adds migration behavior. Rejected by the user.
- **Use preferences only, without importing options:** selected by the user. Existing plugin options have no effect; users configure settings again.

## Behavior

- Production runtime does not consume `ctx.options`. Preferences resolve directly over built-in defaults.
- Preserve existing valid `predictions.json` values. Do not clear preferences or copy anything from OpenCode configuration.
- Keep the existing preference document version and storage paths.
- Missing preferences use built-in defaults. Without a saved model selection, predictions remain unavailable and direct users to Prediction Settings.
- Support `contextFile` in `predictions.json` only through direct edits on the server. Do not accept file paths through Setup RPC: remote clients could otherwise direct the server to send private files to a model. Preserve existing path validation and file-reading limits. Explain server-side editing in Desktop and CLI.
- Replace “Use OpenCode configuration” with “Reset to defaults.” Reset remains staged until Save and removes saved editable settings, not server-only `contextFile`.
- Show only “Saved preference” and “Default” provenance. Remove fallback-specific fields and logic where no longer needed.
- Version the Setup read method and its revision tokens. Older clients must not obtain a new writable snapshot, and current clients must not edit an older server. Keep prediction and status RPC unchanged.
- Keep the existing `models: null` representation readable as no configured models; it no longer suppresses an inherited value.
- OpenCode configuration still loads the plugin. Its plugin `options` do not configure predictions, including when supplied by project or administrative configuration.

## Constraints

Preserve atomic replacement, recovery copies, strict UTF-8 and numeric validation, best-effort stale checks, cancellation, readback verification, and no automatic replay.

Preserve existing administrative refusal safeguards and selected-server RPC access rules. Administrative configuration must not become a second settings source. Changing those safeguards is outside this follow-up.

No migration, compatibility switch, automatic edits to user configuration, new dependencies, or unrelated prediction changes. Simultaneous-save lost updates remain an accepted limitation.

## Implementation scope

Update preference resolution, runtime wiring, setup snapshots and validation, RPC schemas, Desktop and CLI controls, feedback, current documentation, relevant tests, and shipped bundles.

Historical design and research documents remain historical evidence; current usage documentation must describe only the supported configuration path.

## Verification

- Prove plugin options cannot affect effective prediction settings.
- Prove saved preferences and defaults resolve correctly without configuration provenance.
- Prove a server-side `contextFile` setting activates, validates paths, and survives unrelated settings writes. Reject attempts to set it through RPC.
- Prove staged reset restores defaults and removes model selection without restoring old options.
- Retain regression coverage for unsafe files, malformed preferences, concurrent refreshes, failed Save readback, and cancellation.
- Run unit tests, installed-artifact tests, package checks, typecheck, bundle generation, and whitespace checks.

## Upgrade impact

This intentionally breaks configuration through plugin options. Users relying on those options must configure settings again. Existing saved preferences remain effective. No user files are modified automatically.

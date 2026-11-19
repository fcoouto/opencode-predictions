# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

OpenCode Desktop provides the graphical interface. The same plugin also integrates with OpenCode's interactive terminal interface.

## Users

OpenCode Desktop and interactive CLI users who want suggestions for their next prompt.

## Product Purpose

Suggest one useful next user prompt after a completed assistant response. Accepting a suggestion inserts editable text and never submits it.

## Operating Context

The plugin runs inside OpenCode V2, with server-side prediction generation and separate Desktop and CLI integrations. Users connect model providers through OpenCode.

Existing OpenCode plugin options remain an inherited fallback. Explicit user preferences live in the selected server's `predictions.json`; defaults apply last. Save never edits OpenCode configuration and performs no automatic migration.

## Capabilities and Constraints

- Model selectors support exact models, wildcards, optional reasoning variants, and ordered fallback groups.
- Editable settings are `models`, `enabled`, `automatic`, `escalation`, `timeoutMs`, `contextTurns`, `debug`, and `includeGithubPRContext`.
- Prediction status exposes resolved models, queue state, safe failures, and the current suggestion.
- Predictions consume provider quota and may incur charges. Model names and wildcard matches do not guarantee free usage.
- The plugin excludes unsent drafts, tool output, reasoning, attachments, and instruction payloads from prediction context.
- Predictions Setup supports a native Desktop settings page and equivalent section-based CLI menus, including ordinary shared-service CLI use.
- The user selected a native Desktop settings page and an equivalent section-based CLI menu rather than a sequential wizard or compact dialog.
- Settings apply across projects and server processes sharing the selected server's configuration root. Provenance is visible, and resetting to inherited configuration is staged until Save.
- The selected server's existing RPC access controls authorize Save, including authorized remote clients. There is no Desktop main-process bridge, local socket, or standalone-only gate.
- Preferences use strict UTF-8/JSON validation, safe storage checks, atomic replacement, private backups, best-effort revision checks, and verified activation.
- The user explicitly rejected write locking and accepted simultaneous-writer lost updates, including different-field edits. Backups do not guarantee recovery of concurrent changes. Interrupted writes require fresh readback, never automatic replay or manual lock cleanup.
- Administrative configuration suppresses user preference application and writes. Unsupported or invalid preference documents cannot silently activate default predictions.
- Native qualification covers macOS Desktop 2.3.0 and CLI/server 2.2.6. Linux/Windows path tests do not imply native filesystem/ACL qualification.

## Evidence on Hand

- `README.md` documents controls, settings, model groups, cost, privacy, and compatibility.
- `src/options.ts` validates plugin settings.
- `src/models.ts` resolves model selectors.
- `src/gui.ts` and `src/tui.ts` register current commands and status dialogs.
- `src/index.ts` and `src/rpc.ts` expose prediction, status, settings, metadata preview, and selected-server Save.
- `src/preferences*.ts` implement the document, store, and runtime lifecycle; `tests/host/preferences.test.ts` and connected native suites qualify normal launches.
- `docs/research/2026-11-18-predictions-preferences-qualification.md` records evidence and limits. Earlier setup designs and persistence candidates are historical, not the current write boundary.

## Product Principles

- Keep prediction acceptance separate from submission.
- Make model choices and fallback behavior inspectable.
- Keep configuration behavior consistent across Desktop and CLI.
- Preserve existing manual configuration and unrelated OpenCode settings.

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

Current settings live in the plugin entry in OpenCode's JSON or JSONC configuration.

## Capabilities and Constraints

- Model selectors support exact models, wildcards, optional reasoning variants, and ordered fallback groups.
- Existing settings are `models`, `enabled`, `automatic`, `escalation`, `timeoutMs`, `contextTurns`, and `debug`.
- Prediction status exposes resolved models, queue state, safe failures, and the current suggestion.
- Predictions consume provider quota and may incur charges. Model names and wildcard matches do not guarantee free usage.
- The plugin excludes unsent drafts, tool output, reasoning, attachments, and instruction payloads from prediction context.
- The proposed Predictions Setup command must support both Desktop and interactive CLI and let users manage all existing plugin settings without opening a configuration file.
- The user selected a native Desktop settings page and an equivalent section-based CLI menu rather than a sequential wizard or compact dialog.
- The user approved global-only editing on the selected OpenCode server for the first release. Existing OpenCode configuration remains the single settings source; safe persistence is still unproven.
- The user selected best-effort writes to existing JSON/JSONC and accepted the residual race with external editors. Serialization among supported setup writers, detected-stale-edit rejection, syntax/permission preservation, atomic replacement, recovery copies, and activation verification remain mandatory. This approval is not proof of implementation readiness.

## Evidence on Hand

- `README.md` documents controls, settings, model groups, cost, privacy, and compatibility.
- `src/options.ts` validates plugin settings.
- `src/models.ts` resolves model selectors.
- `src/gui.ts` and `src/tui.ts` register current commands and status dialogs.
- `src/index.ts` and `src/rpc.ts` expose prediction and status operations; no settings save operation exists yet.

## Product Principles

- Keep prediction acceptance separate from submission.
- Make model choices and fallback behavior inspectable.
- Keep configuration behavior consistent across Desktop and CLI.
- Preserve existing manual configuration and unrelated OpenCode settings.

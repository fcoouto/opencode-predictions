# Predictions Setup

Status: design approved by the user on 2026-11-15, including global-only editing for the first release. Native execution is authorized. The persistence feasibility gate returned NO-GO; production implementation is blocked.

## Intent and confirmed scope

Let users manage every existing prediction setting without finding or editing a hidden JSON file. The user selected a native Desktop settings page and an equivalent interactive CLI menu, both opened by **Predictions Setup**.

This is an Operate surface: completing configuration safely matters more than visual novelty. Inherit OpenCode's components, theme, typography, spacing, focus behavior, and settings conventions.

## Approaches

1. **Native settings page and CLI menu — selected.** Supports both first-time setup and small later edits. Desktop gains a searchable settings destination; CLI uses familiar selection and input dialogs.
2. **Sequential wizard — not selected.** Helpful for first use, but makes revisiting one setting unnecessarily linear.
3. **Compact dialog — not selected.** Quick to open, but ordered groups and all settings would require excessive nesting.

## Entry points and hierarchy

- Add **Predictions Setup** to the Predictions command group in both hosts. Do not assign a default shortcut.
- On Desktop, open a native **Predictions** settings page. Settings navigation and settings search reach the same page.
- In CLI, open a section menu showing current values and pending changes. Section editors return to this menu.
- Link setup from the existing status view and relevant configuration errors. Keep status and preview as a separate, read-only diagnostic destination.
- Setup must work without a completed assistant response or empty composer. It must never edit or submit the user's prompt.

Use three sections, in this user-confirmed order: **Behavior**, **Models**, **Advanced**. Use the user-confirmed title-case labels in Behavior. Expose **Prediction status and preview** as a secondary action, not another editable section.

## Behavior

| Label | Existing setting | Control and meaning |
| --- | --- | --- |
| Enable Predictions | `enabled` | Switch. Keep setup available when off. |
| Predict After Replies | `automatic` | Switch. When off, users can still request predictions manually. |
| Escalation Mode | `escalation` | Select: Off, Manually, Automatically once after no suggestion. Explain that error fallback remains automatic in all modes. |

Keep controls editable when predictions are disabled, with a clear explanation that changes apply when enabled.

## Models

Present ordered model groups rather than requiring raw selector syntax.

- Show groups as numbered priorities: **Group 1 — Try first**, followed by **Group 2 — Fallback**, and so on.
- Each group shows its selector entries, matched model count, and expandable resolved models.
- Support adding and removing groups, moving groups up/down, and adding/removing/reordering entries within a group.
- Use searchable model selection with provider and model names. Show exact IDs as secondary text when needed to distinguish models.
- Offer **Default reasoning** plus variants supported by the selected model. Do not change the main session model.
- Offer **Add model pattern** for advanced users. Preserve wildcard selectors as rules rather than expanding them into a static saved list.
- Show no-match and unsupported-variant explanations beside the responsible entry. Existing unavailable selections remain visible and editable; do not silently discard them.
- Preview overlap ownership: a repeated provider/model/variant belongs to the earliest matching group. Preserve distinct reasoning variants.
- Explain that configured entry order sets initial preference, while runtime ranking can reorder candidates within a group. Saving does not promise to pin the learned queue.
- Explain the interaction with escalation: errors fall back automatically; genuine abstention follows the escalation setting.

First use has no invented defaults: show **Add a model** and **Add model pattern**. An installed plugin without configured models can remain unconfigured or disabled.

Preview performs metadata resolution only. It must not generate predictions, send conversation content, or incur generation charges. State that paid usage is possible; never infer that a model is free from its name.

## Advanced

| Label | Existing setting | Control and meaning |
| --- | --- | --- |
| Timeout per model | `timeoutMs` | Milliseconds; positive integer up to `2147483647`. Default `8000`. |
| Recent interactions | `contextTurns` | Integer choice from 1 to 5. Default 3. |
| Debug notices | `debug` | Switch. Default off. Explain that this reveals safe progress and failure notices, not raw provider errors. |

Keep Advanced collapsed on Desktop and behind one menu entry in CLI. Use the same units, constraints, and explanations in both hosts.

## Editing, validation, and saving

Use a draft and explicit **Save changes** / **Discard changes** actions in both hosts. Disable saving when unchanged or invalid. Leaving with unsaved edits requires a discard confirmation; returning to an editor preserves the draft.

- Validate drafts on the server using the existing options parser and model resolver. UI validation is supplementary.
- Block malformed selectors, empty present groups, invalid numbers, and unsupported setting values.
- Allow syntactically valid selectors with zero current matches, but show a warning and explain that predictions cannot use them now.
- Preserve the distinction between an absent `models` setting and invalid empty arrays. Do not require model selection to save an enable/disable or behavior change.
- Changing settings must not generate a prediction by itself. After save, invalidate old suggestions and continuation offers, cancel pending prediction work, and use the new settings for subsequent eligible actions.
- Confirm **Saved** only after persistence succeeds and the effective configuration reload is verified. If activation fails, distinguish saved-on-disk from active-in-service.
- Preserve the draft after a save failure. If another client or manual edit changed configuration, refuse stale writes and ask the user to reload settings before retrying.

## Persistence proposal and feasibility gate

Approved scope: edit the plugin's existing **global configuration on the selected OpenCode server**. Do not introduce a second settings store. Show the server and scope before editing; remote CLI connections must never silently write local client configuration.

Support existing JSON and JSONC files without changing comments, unrelated formatting, other plugin entries, unknown plugin options, or package references. Do not create a second global configuration file. Change only settings the user edited, preserving unrelated values and omitted defaults.

Treat project/environment overrides explicitly. Show their source and effective value when determinable. Configurations overridden outside the editable global source, or with ambiguous provenance, remain read-only with recovery instructions. Initial scope does not include creating or modifying project overrides.

The current published OpenCode V2 API documents GUI settings pages and CLI select/prompt dialogs. Its experimental global config patch currently exposes only `shell`, not plugin options. Therefore, persistence is a release gate, not an assumed API call.

Before UI implementation, prove supported configuration discovery, plugin-entry identity, JSONC-preserving scoped writes, conflict detection, atomic persistence, and reload behavior against the supported installed OpenCode version. Prefer a supported host write operation if one becomes available. Otherwise, a narrowly scoped server-side writer needs verification. Do not switch to plugin storage silently if the writer proves unsafe; revisit that architecture decision.

If write access, provenance, or plugin-entry identity cannot be established, offer inspection with an actionable explanation rather than guessing a path or overwriting configuration. Do not broaden the supported editing scope just to make Save available.

## States and accessibility

Cover loading, no configured models, no available models, unavailable provider, unmatched pattern, invalid draft, unsaved changes, save pending, save failure, external edit conflict, saved-but-not-active, disconnected server, and read-only configuration.

Use native controls and semantic labels. Make group and entry reordering keyboard-accessible through named move actions; dragging is not required. Preserve focus when rows move or disappear. Long model names and IDs wrap or truncate with an accessible full value. Do not rely on color alone. CLI editors must remain usable in narrow terminals.

## Technical scope and proof

Extend `src/gui.ts` and `src/tui.ts` with host-native setup entry points and views. Share settings read/preview/save contracts through `src/rpc.ts`, with server ownership in `src/index.ts`. Reuse `src/options.ts` and `src/models.ts`; account for service reload and client invalidation in `src/service.ts` and `src/client.ts` without changing prediction semantics.

Acceptance checks:

- Both hosts can configure all seven existing settings and round-trip existing text, array, and nested-array model configurations without changing meaning.
- Reordering, variant changes, wildcard previews, overlap ownership, absent models, no matches, and validation behave consistently.
- Config-write tests preserve unrelated content, comments, permissions, and package entries, and cover concurrent edits and failure recovery.
- Saving creates no model-generation call; stale in-flight results cannot restore an old prediction.
- Changes survive reload, appear in status, and are visible to another client on the same supported server/scope.
- Opening, editing, cancelling, saving, and errors preserve the composer draft.
- Native Desktop and CLI flows receive rendered inspection and keyboard checks, including long names, multiple groups, narrow layouts, and error states.

Leave component extraction, internal RPC naming, and precise rendering mechanics to the implementation plan. No new framework, custom design system, paid/free presets, provider authentication UI, model benchmarking, automatic test generations, queue-reset control, or new plugin settings belong in this change.

## Approval

The user approved this design on 2026-11-15, including the native two-host structure, Behavior / Models / Advanced order, Behavior control labels, global-only server-side configuration editing, and save behavior. The user reviewed the implementation plan and selected native execution. The first feasibility gate returned NO-GO; see `docs/research/2026-11-15-config-persistence-feasibility.md`. Resuming production implementation requires an approved persistence solution or design change.

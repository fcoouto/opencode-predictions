# Predictions Setup

Status: approved design, amended by the user to select best-effort editing of existing global JSON/JSONC and accept the residual external-editor race. The original strict feasibility verdict is historical evidence, not a GO for the amended design. The implementation plan and remaining persistence checks must be updated before execution resumes.

## Intent and confirmed scope

Let users manage every existing prediction setting without finding or editing a hidden JSON file. The user selected a native Desktop settings page and an equivalent interactive CLI menu, both opened by **Predictions Setup**.

This is an Operate surface: completing configuration safely matters more than visual novelty. Inherit OpenCode's components, theme, typography, spacing, focus behavior, and settings conventions.

## Approaches

### Interface

1. **Native settings page and CLI menu — selected.** Supports both first-time setup and small later edits. Desktop gains a searchable settings destination; CLI uses familiar selection and input dialogs.
2. **Sequential wizard — not selected.** Helpful for first use, but makes revisiting one setting unnecessarily linear.
3. **Compact dialog — not selected.** Quick to open, but ordered groups and all settings would require excessive nesting.

### Persistence

1. **Best-effort edits to existing OpenCode JSON/JSONC — selected and approved.** Keeps one settings source, manual configuration, and global server-side scope without a migration. Requires serialized setup writes, stale-draft checks, syntax-preserving edits, atomic replacement, and recovery copies. A racing external editor can still lose changes; the user explicitly accepted this limit.
2. **Plugin-managed authoritative settings — not selected.** Avoids rewriting shared configuration but adds storage-scope, migration, precedence, and rollback complexity. No second settings authority is introduced.
3. **Guided setup with copy/export — not selected.** Avoids automatic writes but retains a manual configuration step.
4. **Wait for an upstream conditional-write operation — not selected as a release dependency.** None meeting the former guarantee was found. A future supported API may replace the writer only after its actual safety and scope are verified.

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
- Preserve the draft after a save failure. Refuse writes when the revision/source checks detect another client's or manual edit, and ask the user to reload settings before retrying. Do not silently rebase stale drafts.

## Approved persistence policy

Approved scope: edit the plugin's existing **global configuration on the selected OpenCode server**. Do not introduce a second settings store. Show the server and scope before editing; remote CLI connections must never silently write local client configuration.

Use a narrowly scoped server-side writer for verified configurations. OpenCode JSON/JSONC remains the sole active settings authority; no import, migration, precedence mode, or plugin-owned settings database is needed. Lack of an upstream plugin-options write API is no longer a blocker by itself.

Support existing JSON and JSONC files without changing comments, unrelated formatting, other plugin entries, unknown plugin options, or package references in the validated document. Change only settings the user edited, preserving unrelated values and omitted defaults. Do not create a second active global configuration file. Recovery copies are not configuration sources.

### Mandatory write safeguards

- Identify the authoritative global document and exact plugin entry on the selected server. Do not guess a path from a client HOME or identify a package by a loose name match.
- Serialize the complete read/validate/prepare/replace transaction for every supported setup writer targeting the same file, including supported plugin/server instances. An instance-local mutex alone does not establish coordination across instances or processes.
- Re-read under that coordination and reject stale draft revisions. Recheck document bytes, source/entry identity, and relevant file metadata immediately before replacement. A detected change aborts the save; do not silently merge or overwrite it.
- Use a proven JSONC syntax-tree editor for the targeted edits, not regex or whole-document stringify. Preserve unrelated document content and restrictive permissions.
- Write through a private same-directory temporary file and atomic replacement so failures do not leave a partially written active document. Preserve original bytes on pre-commit failure and clean up temporary files.
- Keep a bounded recovery copy of the validated pre-save bytes. Proposed default: one rotating copy per edited file, outside active config discovery, with access no broader than the original. A failure to prepare the recovery copy aborts the save. Never restore a copy automatically over newer configuration.
- After commit, verify persisted settings and effective activation separately. Retain the existing **Saved, not active** outcome when activation cannot be verified. Do not blindly repeat a write after a lost acknowledgement.

Recovery copies may contain credentials or other sensitive configuration. Keep them server-local, do not return their contents through RPC or include them in notices, and show a safe recovery location when needed.

### Accepted external-editor limit

An external editor or other non-cooperating writer can change the shared document after the final check but before replacement. That change can be overwritten, including changes to settings unrelated to Predictions. Atomic replacement prevents partial files; it is not compare-and-swap and does not eliminate this race.

The user explicitly accepted this residual race. Recovery copies contain only captured pre-save bytes; they cannot guarantee retaining or recovering a racing external edit. This acceptance does not waive stale-draft rejection, serialization among supported setup writers, source validation, unrelated-content preservation, or accurate failure reporting.

Show a concise non-blocking warning beside the save controls in both hosts, with fuller detail available:

> Avoid editing this configuration file elsewhere while saving. Changes made in another editor during a save can be overwritten, including unrelated settings. Recovery copies may not contain those changes.

Do not describe saves as conflict-proof. Do not add a repeated consent dialog for a limitation already disclosed in the setup view.

### Supported sources and remaining feasibility gate

Treat project/environment overrides explicitly. Show their source and effective value when determinable. Configurations overridden outside the editable global source, or with ambiguous provenance, remain read-only with recovery instructions. Initial scope does not include creating or modifying project overrides.

If write access, provenance, plugin-entry identity, permission preservation, or setup-writer coordination cannot be established, offer inspection rather than guessing or broadening editing scope. Malformed/duplicate-key documents and special-file targets require explicit proof; otherwise keep them read-only.

Before UI implementation, prove the amended policy against the supported installed OpenCode version: authoritative source selection; exact plugin-entry identity; JSONC/unknown-option preservation; permissions; coordination among supported setup writers; detected-stale-edit rejection; atomic replacement and recovery-copy handling; and correct persistence/activation outcomes without generation.

Remote saves stay disabled until selected-server attribution, writer coordination, and save/reload behavior have been verified for that topology. A lack of verification is not permission to write a local client's config instead.

Retain the existing negative external-editor race tests as evidence of the accepted limit, not as a requirement for the former absolute protection or as a GO result. Rewrite the implementation plan's old unconditional no-lost-update gate before resuming. All other unproved safeguards remain release gates; do not ship the research candidate as the production writer.

## States and accessibility

Cover loading, no configured models, no available models, unavailable provider, unmatched pattern, invalid draft, unsaved changes, save pending, save failure, external edit conflict, saved-but-not-active, disconnected server, and read-only configuration.

Use native controls and semantic labels. Make group and entry reordering keyboard-accessible through named move actions; dragging is not required. Preserve focus when rows move or disappear. Long model names and IDs wrap or truncate with an accessible full value. Do not rely on color alone. CLI editors must remain usable in narrow terminals.

## Technical scope and proof

Extend `src/gui.ts` and `src/tui.ts` with host-native setup entry points and views. Share settings read/preview/save contracts through `src/rpc.ts`, with server ownership in `src/index.ts`. Reuse `src/options.ts` and `src/models.ts`; account for service reload and client invalidation in `src/service.ts` and `src/client.ts` without changing prediction semantics.

Acceptance checks:

- Both hosts can configure all seven existing settings and round-trip existing text, array, and nested-array model configurations without changing meaning.
- Reordering, variant changes, wildcard previews, overlap ownership, absent models, no matches, and validation behave consistently.
- Config-write tests preserve unrelated content, comments, permissions, and package entries in the validated document; cover serialized cooperating setup clients, detected stale edits, atomic replacement, recovery copies, and failure outcomes.
- Deterministic external-editor tests document the accepted last-check/replacement race. UI copy makes no guarantee that such racing edits or their recovery copies are preserved.
- Saving creates no model-generation call; stale in-flight results cannot restore an old prediction.
- Changes survive reload, appear in status, and are visible to another client on the same supported server/scope.
- Opening, editing, cancelling, saving, and errors preserve the composer draft.
- Native Desktop and CLI flows receive rendered inspection and keyboard checks, including long names, multiple groups, narrow layouts, and error states.

Leave component extraction, internal RPC naming, and precise rendering mechanics to the implementation plan. No new framework, custom design system, paid/free presets, provider authentication UI, model benchmarking, automatic test generations, queue-reset control, or new plugin settings belong in this change.

## Approval

The user approved the native two-host structure, Behavior / Models / Advanced order, Behavior control labels, global-only server-side configuration editing, and save behavior, then selected native execution. The first feasibility gate returned NO-GO under the former absolute external-editor guarantee; see `docs/research/2026-11-15-config-persistence-feasibility.md`.

After comparing alternatives and receiving Astra's recommendation, the user explicitly approved option 1 and accepted the residual external-editor race. This amendment records that decision; it does not grant a GO to the unproved writer. UI choices and all unrelated safeguards remain unchanged. The implementation plan must be brought into line with this amendment before execution resumes.

# Models Picker and Entry Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Desktop "Add a model" dialog with the host's two-step searchable picker, add Edit to every model entry on Desktop and CLI, and make entry rows readable.

**Architecture:** `src/setup-gui.ts` gains `pickModel(current?)` built on `ctx.dialogs.select` (model, then reasoning), and an `editEntry(group, entry)` that replaces a selector in place. Shared selector parsing goes in `src/setup.ts` so GUI and TUI agree on what is a catalog model versus a pattern. `src/setup-tui.ts` reuses its existing `pickModel`/`pickPattern` with a current value.

**Tech Stack:** TypeScript, Solid (`createComponent`), host `@opencode/plugin` GUI/TUI APIs, `node --test` + Playwright fake host.

**Spec:** `docs/superpowers/specs/2026-11-26-models-picker-and-edit-design.md`

## Global Constraints

- Only host UI kit components and host dialogs; no custom-styled widgets.
- No change to stored settings, selector syntax (`provider/model[#variant]`), validation, preview or save.
- Copy: picker titles "Add a model" / "Change model"; reasoning title "Reasoning for <name>"; first reasoning option "Default reasoning"; pattern edit title "Edit model pattern", button "Save pattern"; entry reasoning line "Reasoning: <variant>"; pattern line "Pattern"; row button "Edit".
- Dismissing any picker step changes nothing.
- `npm run check` passes at the end.

## Review Focus

- Editing an entry whose model left the catalog: must open the pattern dialog prefilled with the full selector, not crash or drop it.
- A variant that no longer exists on the model: reasoning picker highlights "Default reasoning"; saving keeps whatever the user picks.
- Editing while the draft is locked (saving/read-only): Edit is disabled.
- Same model listed twice in a group: Edit replaces only the entry at that position.
- Empty catalog on Add: alert, no dialog stack left open, no change.

---

### Task 1: Shared selector parsing

**Files:**
- Modify: `src/setup.ts` (export a helper)
- Test: `tests/setup.test.ts`

**Interfaces:**
- Produces: `export function parseSelector(selector: string, catalog: readonly CatalogModel[]): { kind: "model"; model: CatalogModel; variant?: string } | { kind: "pattern" }` where `CatalogModel = SetupSnapshot["catalog"][number]`. Splits on the first `#`; `kind: "model"` only when `providerID + "/" + id` equals the base exactly.

- [ ] **Step 1: Failing tests** — `parseSelector("local/family/a#low", catalog)` → `{ kind: "model", model: <Family A>, variant: "low" }`; `"local/b"` → model, `variant` undefined; `"local/family-*"` → `{ kind: "pattern" }`; `"local/gone#low"` (not in catalog) → pattern.
- [ ] **Step 2:** `node --test tests/setup.test.ts` → FAIL (not exported).
- [ ] **Step 3:** Implement in `src/setup.ts`.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat: parse model selectors against the catalog`.

### Task 2: Desktop two-step picker replaces the Add dialog

**Files:**
- Modify: `src/setup-gui.ts` (`addDialog` → `pickModel`; `addMenu`, the empty-state "Add a model" button)
- Test: `tests/setup-gui.test.ts` (fake host gains `dialogs.select` and `dialogs.alert`; rewrite "searchable model selection…" and "Add group and the per-group Add menu…" tests)

**Interfaces:**
- Consumes: `parseSelector` (Task 1).
- Produces: `pickModel(current?: string): Promise<string | undefined>` inside `registerSetupGUI`; `addTo(destination: number | "new", selector: string)`.

- [ ] **Step 1: Fake host.** `dialogs.select: async (o) => { log.selects.push(o); return w.selectAnswers.shift()?.(o) }` and `dialogs.alert: async (o) => { log.alerts.push(o) }`. Answers are functions of the options so tests can pick by title.
- [ ] **Step 2: Failing tests.**
  - "Add a model picks a model then a reasoning level from host pickers": click "Add a model"; first select call has `title: "Add a model"`, an option with `title: "Family A"`, `description: "local/family/a"`, `group: "local"`; answer Family A; second call `title: "Reasoning for Family A"`, option titles `["Default reasoning", "low", "high"]`; answer `"high"` → save sends `{ models: [["local/family/a#high"]] }`.
  - A model with no variants (Model B) makes exactly one select call.
  - Dismissing the reasoning step (answer `undefined`) adds nothing.
  - Empty catalog (`catalog: []`): one `alert`, zero selects, no entry.
- [ ] **Step 3:** `node --test tests/setup-gui.test.ts` → new tests FAIL.
- [ ] **Step 4: Implement.** Model options: `{ title: name ?? id, description: providerID + "/" + id + (enabled ? "" : " — disabled"), group: providerID, value: model }`, `current` = parsed model when given. Reasoning options: `{ title: "Default reasoning", value: null }` then each variant `{ title: id, value: id }`; `current` = parsed variant if the model still has it, else `null`. Delete `addDialog` and its `ui.Select`. "Model…" menu item and the "Add a model" button call `pickModel()` then `addTo`.
- [ ] **Step 5:** Re-run → PASS (including untouched tests).
- [ ] **Step 6:** Commit `feat: pick prediction models with the app's searchable picker`.

### Task 3: Edit entries and readable rows on Desktop

**Files:**
- Modify: `src/setup-gui.ts` (entry row, `patternDialog`)
- Test: `tests/setup-gui.test.ts`

**Interfaces:**
- Consumes: `pickModel(current)` (Task 2), `parseSelector` (Task 1).
- Produces: `patternDialog(options: { initial?: string; onDone: (selector: string) => void })` titled "Edit model pattern"/"Save pattern" when `initial` is set; `editEntry(group: number, entry: number)`.

- [ ] **Step 1: Failing tests.**
  - "Edit on a model entry reopens the picker on the current model and reasoning": fields `[["local/family/a#low"]]`; click row `predictions-entry-0-0` button "Edit"; first select has `title: "Change model"` and `current` whose `id === "family/a"`; second has `current: "low"`; answer `"high"` → entry description contains `local/family/a` and `Reasoning: high`, not `#high`; save sends `[["local/family/a#high"]]`.
  - "Edit on a pattern opens the pattern dialog prefilled": fields `[["local/family-*"]]` → dialog "Edit model pattern" with input value `local/family-*`; change to `local/b*`, click "Save pattern" → title `1. local/b*`, description contains `Pattern`.
  - "Edit on a model missing from the catalog falls back to the pattern dialog": `[["local/gone#low"]]` → pattern dialog prefilled `local/gone#low`.
  - "Edit replaces only its own position": `[["local/b", "local/b"]]`, edit entry 2 to Family A default → titles `["1. Model B", "2. Family A"]`.
  - Edit is disabled for `readOnly: true`.
  - Update "each group is a section…": group controls with 2 groups × 1 entry become 8 (add an Edit per entry); entry menu items stay `["Move up", "Move down", "Remove"]`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Row children: `box(button("Edit", …, { disabled: locked }), <existing menu>)`. Description: `column(note(base provider/id or "Pattern"), note("Reasoning: " + variant when set), warnings)`. After an edit, `focusControl("predictions-entry-<g>-<e>", "Edit")`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: edit prediction model entries in place`.

### Task 4: CLI Edit

**Files:**
- Modify: `src/setup-tui.ts` (`pickModel`, `pickPattern`, `entry`)
- Test: `tests/setup-tui.test.ts`

**Interfaces:**
- Consumes: `parseSelector` (Task 1).
- Produces: `pickModel(editor, current?: string)`, `pickPattern(editor, current?: string)`.

- [ ] **Step 1: Failing test** — entry menu options start `["Edit", "Details", "Move up", "Move down", "Remove"]`; choosing Edit on `local/family/a#low` gives a select with `current` Family A, then a reasoning select with `current: "low"`; picking `"high"` stores `local/family/a#high` at the same position. A pattern entry's Edit opens `prompt` with `value` = the pattern.
- [ ] **Step 2:** `node --test tests/setup-tui.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Thread `current` into both pickers (`current` on selects, `value` on prompt; title "Change model" when editing). Edit replaces `next[index][position]`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: edit prediction model entries from the CLI`.

### Task 5: Verify

- [ ] `npm run check` → all pass, bundle built.
- [ ] Run the Impeccable detector: `/Users/fcouto/.config/opencode/skills/impeccable/scripts/impeccable detect --json --changed`; fix real findings.
- [ ] Look at `.test-artifacts/preferences-gui.png` for the Models section.
- [ ] Commit `dist/` if the bundle changed, `chore: rebuild bundle`.

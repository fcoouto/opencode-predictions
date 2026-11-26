# Models picker and entry editing — design

## Intent

The Models part of the Desktop Predictions settings page is hard to use:

1. An entry cannot be edited; changing a model or its reasoning level means remove and re-add.
2. The page reads poorly: selectors like `openrouter/~openai/gpt-astra-latest#low` carry the reasoning level as a raw suffix.
3. The "Add a model" dialog is a search box over a centred list of ghost buttons. After a pick, the list collapses to plain text, the search box stays empty, and the reasoning `ui.Select` renders blank because its "Default reasoning" option uses the value `""`, which the host treats as no selection.

## Goals

- Pick a model from the app's own searchable list, then its reasoning level, for both Add and Edit.
- Edit any entry in place: a model entry reopens the picker with the current model and reasoning highlighted; a pattern entry reopens the pattern dialog with its text.
- Entry rows show the model name, the `provider/id` as a muted line, and the reasoning level as words ("Reasoning: low").
- The CLI gets the same Edit action, so Desktop and CLI stay consistent (PRODUCT.md principle).

## Non-goals

- No change to stored settings, selector syntax, validation, preview, save, or fallback semantics.
- No custom-styled widgets outside the host UI kit.
- No drag-and-drop reordering.

## Constraints

- Plugins render only host components (`ctx.ui.*`); the kit has no combobox. `ctx.dialogs.select` is the host's searchable, grouped picker; only one host dialog is open at a time, so model and reasoning are two steps.
- `dialogs.select` has no description field. The cost and "does not change your session model" notes stay in the Models section intro, which already carries the cost text.

## Approaches

- **Two-step host picker (chosen).** `dialogs.select` for the model (grouped by provider, `provider/id` as the second line, current one highlighted), then a second `dialogs.select` for reasoning when the model has variants. Native look, search and keyboard handling; matches the CLI's existing `pickModel` flow. Trade-off: two steps.
- Custom dialog with `ui.Select` for the model. Rejected: hundreds of models with no search.
- Custom-built combobox from raw DOM. Rejected: off-theme, accessibility burden, outside the host kit.

The user picked the two-step host picker.

## Design

- **Picker** (`src/setup-gui.ts`): replace `addDialog` with `pickModel(current?)` returning a selector or `undefined`. Step 1 title "Add a model" or "Change model"; options `{ title: name ?? id, description: provider/id (+ " — disabled"), group: providerID, value: model }`; `current` is the catalog model matching the entry's base selector. Step 2, only when the model has variants: title "Reasoning for <name>", options "Default reasoning" plus each variant id, `current` the entry's variant or default. Dismissing either step cancels with no change. Empty catalog: `dialogs.alert` telling the user to add a pattern or connect a provider.
- **Pattern dialog**: keeps its live validation; accepts an initial value; titled "Edit model pattern" / "Save pattern" when editing.
- **Edit**: a visible small "Edit" button on each entry row, beside the existing actions menu (Move up, Move down, Remove). Model entries (base found in the catalog) use the picker; anything else uses the pattern dialog. The edit replaces the selector at the same group and position; focus returns to that row's Edit button.
- **Entry row**: title `N. <name>` (or the pattern); description is the `provider/id` without the `#variant`, then "Reasoning: <variant>" when set, then "Pattern" for patterns, then warnings.
- **CLI** (`src/setup-tui.ts`): add "Edit" to the entry menu, reusing `pickModel` and `pickPattern` with the current value highlighted or prefilled.

## Left to the builder

Exact focus timing after the picker closes, test fixture doubles for `dialogs.select` and `dialogs.alert`, and copy polish within the wording above.

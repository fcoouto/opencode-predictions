# Try another prediction

**Status:** Implemented and verified. The user authorized delivery through a merged pull request and a local plugin update. Includes the `￻` (U+FFFB) indicator prefix and faint two-line abstention placeholder with platform-specific shortcut labels and no button.

## Purpose

Let users request an alternative when a prediction is unsatisfying, not only when a model abstains. The action must also work with a single configured group containing several eligible models.

## Approaches and selected direction

1. Next group only: preserves PR #14's routing but cannot use remaining alternatives in a single group.
2. Next untried eligible candidate in the current group, then later groups: selected by the user. This preserves group precedence without equating later groups with better reasoning.
3. An explicit model picker: more precise but adds everyday choices and UI complexity; not selected.

For presentation, the user selected Fable's compact-status approach over a persistent **Try another** action or showing the original alongside progress. Use the existing shortcut, temporarily withdraw the original, and keep pending communication to one line.

## Routing

- Start from the group of the most recently attempted candidate in the current prediction cycle.
- Select the next untried eligible candidate within that group in its current learned order. Advance to later eligible groups only when no untried eligible candidate remains in the current group.
- Track attempts by configured provider/model/variant, including calls made by ordinary error fallback. Never repeat a candidate or wrap back to earlier groups within the same cycle.
- A cycle is scoped to the server/location, conversation, completion and configuration/service version. New context or configuration starts a new cycle; returning focus does not.
- Each explicit action permits at most one additional generation call. Text, valid abstention or error ends that action. Existing ordinary initial error fallback remains unchanged.
- Host verification found retries inside OpenCode's stateless-generation transport for retryable provider errors. The plugin bounds generation API requests and selected models; the current SDK exposes no retry control for underlying HTTP attempts. Document this quota limitation rather than claiming one physical provider request.
- Bind each action to an exact offered provider/model/variant. Show its model display name in the pending status. If that target becomes unavailable, refresh the offer without silently calling a replacement; another explicit action is required.
- Explain the shortcut, provider quota use and one-call limit in docs rather than persistent composer guidance. The compact interaction replaces the earlier advance per-action quota disclosure; it adds no confirmation dialog. Cancellation does not guarantee avoiding provider charges.
- If no untried eligible candidates remain, show that no alternatives are currently available. Never imply all configured models were called when some were skipped.

## User interaction

- Use `Alt+Shift+P` after a real prediction or valid abstention to request the next alternative. Show no **Try another** pill or other button, including when no prediction is available. Do not show shortcut guidance beside real prediction text.
- Without an original to restore, show abstention as faint placeholder text in the prediction slot, never an adjacent section or extra composer height: `[<source display name>] provided no prediction.` followed by `Use <shortcut> to escalate it to [<next display name>].` Include the second line only when an alternative exists. Obtain the source display name from the service's actual abstaining candidate, not the session model or offered target. Older services without that metadata use a generic message.
- Label the shortcut `Option+Shift+P` on macOS and `Alt+Shift+P` elsewhere; do not change the binding. Typing clears placeholder communication immediately in Desktop, with no insertion or submission.
- Immediately withdraw the visible original when an alternative action starts, including while client readiness is being checked. Keep the original internally for recovery. Show only one compact status line in the prediction slot: `￻▱▰▱ <Model Display Name>`.
- Initial generation shows the indicator alone. Prefix every indicator with `￻` (U+FFFB), including reduced motion. Move one filled block through three cells in a loop; never progressively fill the track or imply a completion percentage. Reduced motion uses static `￻…`, followed by the model name for alternatives.
- The indicator represents local activity, not provider progress or proof that the provider is healthy. Do not show elapsed time, routine slow-wait messages, generating/escalating sentences or an extra progress line. Stop it on every terminal outcome; preserve bounded request deadlines and concise failure feedback.
- On usable alternative text, show that text only for the same empty draft and context. On error, timeout or abstention, restore the original and its acceptance behavior without displaying a persistent explanation alongside it. Without an original, show a concise non-adoptable outcome instead.
- With no alternatives, briefly show **No alternatives available.**, then restore any original. Do not leave a recovered real prediction hidden behind a permanent status.
- Tab accepts only visible actual prediction text. While status replaces the original, prediction acceptance returns false and Tab passes through to normal host behavior; it neither accepts the hidden original nor cancels the alternative by itself. Acceptance resumes when real text is visible again.
- Plugin-only communication remains non-adoptable based on typed state, never a glyph, model name or message prefix. Use the same compact behavior in Desktop and CLI, without writing status into the editable draft.
- Ignore repeated shortcuts while pending; do not queue extra calls. Announce activity start/outcome accessibly, not animation frames. Stop animation timers and status on cancellation/disposal.
- Bound readiness waiting and continuation refresh by `timeoutMs`; restore retained text after timeout. A continuation refresh is explicitly metadata-only, including after eviction; missing state cannot restart initial generation. Typing observed between polls revokes consumed offer authority while preserving real text.
- Typing, navigation, changed context, disposal and configuration changes cancel pending work and invalidate stale actions. Keep existing safeguards against duplicate actions and late output.

## Settings

- Retain `escalation: "off" | "manual" | "automatic"`, default `"manual"`; no new preference knobs.
- `off` offers no alternative action and preserves ordinary explicit refresh.
- `manual` permits shortcut-driven alternatives without extra automatic calls.
- `automatic` may make one additional attempt after abstention using the same routing rule. It never automatically replaces a valid prediction. Further attempts require explicit action.
- Preserve `automatic` as the initial-trigger setting, existing reasoning variants, health/cooldown handling, filtered context and prompt budget. User dissatisfaction is not a provider error and must not create a cooldown.

## Scope and proof

Extend existing service offers, controller/client result state, Desktop/CLI status rendering and documentation; no new settings application, model picker, confidence scores, telemetry or dependencies. Add tests for single-group progression, crossing groups, visited candidates, withdrawn originals, compact initial/alternative activity, Tab pass-through while pending, restored originals after abstention/error, reduced motion, automatic-call limits and stale/duplicate authority.

This design changes #14's next-group-only routing. The user authorized implementation, isolated host tests, commits, PR merge and a local plugin update. Registry publication and paid prediction-quality experiments remain outside that authorization.

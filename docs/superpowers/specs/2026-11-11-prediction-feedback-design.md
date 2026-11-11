# Prediction feedback

## Intent and approved approach

Make prediction failures understandable without turning normal background work into a stream of alerts. The user selected actionable error toasts plus a reopenable status view, deduplication, and regression tests on 2026-11-11.

## Approaches

- Toasts only: smaller, but explanations disappear and cannot be recovered.
- Actionable toasts plus an on-demand status view: selected. Reuse native OpenCode dialogs instead of adding a dashboard or notification framework.
- Automatic blocking dialogs: rejected because predictions must not interrupt editing.

## Behavior

- Report invalid options, missing model selectors, zero matches, status/RPC failure, and unexpected service failures without requiring debug mode.
- Explain what failed, whether predictions are disabled or temporarily unavailable, and what the user can do next. Never invent a cause, recommend an unverified selector, or expose raw provider errors.
- Summarize safe provider failures and distinguish authentication, unavailable models, cooldowns, and timeouts. Retry timestamps mean eligibility for a future request, not a scheduled retry.
- Keep successful fallback, cancellation, stale requests, and automatic no-suggestion responses silent. Debug continues to show safe fallback progress.
- Explicit palette requests always explain why no suggestion can be produced, including intentional disabling, missing context, an occupied composer, and valid no-suggestion responses. Preserve shortcut pass-through outside an empty, eligible prompt.
- Deduplicate an unchanged background issue per connected server/location, across polling and completed turns. A changed issue or a genuinely recovered-and-recurring issue can notify again. Manual requests bypass deduplication. Do not reset deduplication for every poll, session switch, or random service instance identifier.
- Preserve current issue and last meaningful failure separately. Healthy status polls must not erase the last failure. Never display a result from an obsolete location or disposed client.
- Check configuration/service health independently of completed-session eligibility. Viewing status before a completed response must work where a location is available; otherwise explain that no location is selected.
- Desktop errors use native error toasts, persistent for configuration/access blockers, with an action opening status. Dismiss or replace tracked error toasts after recovery or scope changes. CLI uses error/warning variants and names the existing status command; it must not promise unsupported toast buttons or persistence.
- Reuse **Prediction status and preview** to open an explicitly requested native dialog, not an expiring JSON toast. Show state, cause, recovery, configured groups, matches and safe queue restrictions, retry eligibility, last outcome/failure, current suggestion, and host/plugin compatibility metadata. Offer technical details separately; do not dump JSON as the primary view.
- Keep the status view a refresh-on-open snapshot, clearly labelled as such. No continuously updating panel is needed.
- Include package version and notification capability/revision metadata for client and service. Missing metadata means unknown/legacy compatibility, not proof that a package is outdated.
- Unknown-option warnings remain visible in status; show one deduplicated warning rather than silently ignoring them.

## Constraints and non-goals

Preserve existing uncommitted shortcut and host-test changes. Use installed OpenCode 2.2.6 plugin APIs and native UI; add no dependencies. Preserve model choice, group ranking, privacy, cancellation, and billing safeguards. Keep existing RPC reason/message fields when adding structured data, and handle missing new fields safely. No provider switching, automatic credential changes, automatic retries, persistent history, telemetry, or cache repair. No commits without a separate request.

## Verification

Pin each previously silent failure path, unchanged-issue deduplication, recovery/recurrence, explicit manual feedback, debug privacy, scope isolation, and status-before-completion in deterministic tests. Check Desktop and CLI toast/status integration, existing Tab/Escape/shortcut behavior, unit tests, types, built bundles, and package exports. Run isolated host tests when their required installed applications are available; report any unchecked host behavior.

## Integration boundary

Merge this feature separately from the concurrent manual-shortcut work in PR #7. Preserve that work in its original checkout; do not add its shortcut API, bindings, or shortcut-only tests to the notification PR. The isolated notification branch must pass its complete unit and native-host suites before merge.

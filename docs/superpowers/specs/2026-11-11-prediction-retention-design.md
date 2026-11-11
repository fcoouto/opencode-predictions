# Prediction retention

## Intent

Keep a prediction available for its completed response without another model request. Navigating between chats must not lose it. After accepting, editing, and clearing the entire draft, restore the original prediction.

## Approved behavior

- Restore only the matching server/location, chat, completion, and configuration version.
- Acceptance inserts editable text without submitting. Hide the prediction while the draft is nonempty.
- A successfully accepted prediction survives later edits and navigation. When the draft becomes empty, show the original prediction again and allow acceptance again.
- Escape still dismisses the prediction. Clearing input or navigating must not undo dismissal.
- Preserve existing behavior for typing before acceptance: invalidate that unaccepted prediction, including while status loading hides its full key.
- Keep the existing 128-attempt memory bound. Plugin disposal clears the cache. Do not persist predictions to disk.
- Preserve shortcut, notification, eligibility, and stale-response cancellation behavior.

## Approaches

Retain every prediction during typing: less state, but changes the existing behavior for unaccepted predictions beyond this request.

Regenerate after clearing: rejected because it adds a model request and may produce different text.

Retain successfully accepted predictions: selected approach. Add one acceptance marker to the existing cached result. Draft invalidation removes only unaccepted entries. Acceptance hides rather than consumes successfully inserted text. Dismissal, eviction, and disposal still remove entries.

## Scope

Change the shared controller, relevant controller/client/Desktop regressions, README, and generated bundles. Both hosts already share this controller; no new host API or dependency is needed.

## Delivery

Include the behavior in the pending chat-retention PR. Run local checks and native host suites, then merge only after current-head GitHub checks pass. Do not alter installed plugin caches or user configuration.

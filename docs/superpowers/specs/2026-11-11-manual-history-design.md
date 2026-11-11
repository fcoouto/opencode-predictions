# Manual predictions from historical chats

## Approved intent

Allow the shortcut and command-palette request to predict from the latest completed, usable turn in saved history, regardless of age. Automatic predictions must keep their existing requirements. The user approved implementation, verification, PR creation, and merge after passing checks.

## Design

- Pass an optional `manual` boolean from explicit client requests through the Desktop/CLI RPC contract. Omitted or false means existing automatic behavior.
- For manual requests only, infer a local turn boundary when the latest meaningful history record is a completed assistant response without a following idle record. Do not write that boundary or anything else into chat history.
- Do not fall back to an older conclusion when the latest turn is incomplete, interrupted, empty, reasoning/tool-only, or followed by an unanswered user prompt or successful compaction.
- A historical session may also lack `time.idle`. Expose its `time.updated` as the stable request revision, but mark it ineligible for automatic generation. The service accepts this revision only for an explicit manual request with no recorded busy execution.
- Keep existing project, parent-session, busy/interrupted, composer, cancellation, and stale-revision checks. Recheck session revision before and after generation. Do not change automatic turn collection.
- Reuse existing prediction retention and dismissal behavior. No new dependency, configuration option, persistence, or installed-plugin modification.

## Approaches

Relax every prediction: rejected because it changes automatic behavior and billing.

Require another assistant response: rejected because it defeats the old-chat use case.

Explicit manual-only fallback: selected. Normalize only the local request's usable completed tail and retain strict validation of the latest turn. Use the existing revision-based cache and stale guards.

## Scope and proof

Modify the client request plumbing, Desktop/CLI state readers, RPC input schema, and server validation. Add service, client, rendered Desktop, and terminal-plugin regression coverage. Document the controls, regenerate bundles, run full/package/native checks, and obtain one independent review before merge.

The screenshot alone does not identify the exact old chat's history shape. Read-only reproduction established that age alone succeeds, while a completed tail missing an idle record reproduces `context_unavailable`. SDK types also permit missing `time.idle`; cover both historical shapes without relaxing busy-session safety.

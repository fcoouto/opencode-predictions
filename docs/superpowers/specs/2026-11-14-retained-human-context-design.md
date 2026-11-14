# Retained human prediction context

## Intent and approval

Keep the user's goal visible when assistant-only continuations fill the prediction history window. The user approved this design in chat on 2026-11-14 and authorized implementation, validation, and delivery to `main` through a PR.

## Behavior

- Keep the configured recent-turn window and latest completed assistant response.
- If the window contains no usable human input, prepend a human-only record from the latest user-bearing collected turn. Preserve all grouped human steering messages, in order, without copying that older turn's assistant replies.
- Keep the current JSON conversation array and `{ user, assistant }` record shape. The added record has an empty `assistant` string and does not consume a configured recent-turn slot.
- Preserve the latest human input and latest assistant response under the existing 32,768-byte total prompt budget. Drop older optional turns first. If this removes the human-bearing record, retain its human text separately. Once only protected human text and the latest response remain, use marked, Unicode-safe head-and-tail excerpts when needed.
- With no usable human input since compaction, preserve assistant-only prediction support. Do not fabricate human intent.
- Do not mutate collected turns or input records.

## Boundaries and non-goals

Reuse `collectTurns()` as the privacy and compaction boundary. Do not include synthetic instructions, system text, reasoning, tool output, attachments, summaries, other sessions, unfinished turns, or interrupted turns. Keep all existing latest-response, cancellation, staleness, and escalation checks.

Do not change prediction directive wording, output parsing, speaker classification, abstention policy, RPC interfaces, dependencies, package version, installed plugin, or global settings. Do not publish to npm or call prediction providers for this task.

Retention fixes missing context, not model obedience. Wrong-speaker predictions remain possible.

## Approaches

1. **Human-only anchor alongside recent turns (selected):** preserves intent without importing older assistant replies or expanding the configured recent-turn window.
2. **Expand the entire history window:** rejected because it imports unrelated assistant replies and consumes the byte budget.
3. **Change directive wording only:** rejected because it leaves human intent missing and exceeds the chosen scope.

The user approved the retention behavior. Reusing the existing JSON record shape and shared prompt builder are implementation choices.

## Verification

Add prompt-builder regressions for displaced intent, grouped steering, chronology, configured counts, duplicate prevention, missing human context, compaction, mutation safety, and budget pressure with Unicode and JSON escaping.

Add service-level coverage that captures the actual generated prompt using local stubs. Replay the inspected donation-comparison conversation locally without storing its private transcript in tracked files or making a model call.

Run full tests, typecheck, bundling, package checks, and installed-artifact server checks. Review the diff, open a PR, wait for CI, and merge the verified head into `main`.

# Completed-response prediction context

Approved scope: a completed, visible assistant reply is sufficient prediction context even without a new user record. Include user text when available. Do not infer user intent from synthetic instructions, tool output or compaction summaries.

## Approach

Relax the existing turn collector's required-user condition, retaining all text filtering and idle/compaction boundaries. Keep service validation tied to the latest completed assistant reply with nonempty visible text. A wording-only fix would leave the reproduced chats unable to predict; treating synthetic records as user input would violate privacy filtering.

When context is genuinely unavailable, show:

```text
Prediction unavailable for this response.
Continue typing your next prompt.
```

This is muted, non-adoptable communication, not an error diagnosis or a promise that opening status repairs context.

## Constraints and verification

- Keep busy, interrupted, child-session, cancellation, staleness and latest-response guards.
- Never borrow earlier conclusions for an unfinished or unusable latest response.
- Never cross a successful compaction boundary or send its summary.
- Preserve user text where available; an assistant-only turn has an empty user field.
- Cover synthetic-only continuation, continuation after compaction, and multiple synthetic continuations with synthetic fixtures and local stub generation.
- Replay the three identified real histories in memory only; never save or send their contents to a provider.
- No new dependencies, UI buttons or configuration changes.
- One independent review, then merge through a PR as authorized. Do not update the installed plugin.

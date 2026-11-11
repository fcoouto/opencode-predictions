# OpenCode Predictions

Predict the next complete user prompt in **OpenCode Desktop and the interactive CLI**.
Suggestions appear as ghost text after the assistant finishes. **Tab accepts a suggestion for editing; it never submits it.**

## How to install

Add this entry to `plugins` in your global `~/.config/opencode/opencode.jsonc`,
preserving any existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:fcoouto/opencode-predictions#main",
      "options": {
        "models": "opencode/*free*#low",
        "timeoutMs": 20000,
        "contextTurns": 3,
        "automatic": true,
        "enabled": true
      }
    }
  ]
}
```

OpenCode installs the package from GitHub. Prebuilt bundles are included; no local
build is needed. Configuration changes reload automatically; use `/reload` if needed.
The global entry loads both Desktop and CLI support. Do not put it only in `cli.json`.

Connect your chosen provider through OpenCode. No API keys belong in plugin options.
The example selects available `opencode` models whose ID or display name contains
`free` and which support the `low` variant. Use **Prediction status and preview**
to inspect matches. If none match, choose another selector or omit `#low`.

## Controls

- **Tab:** insert the visible suggestion into the editable prompt.
- **Escape:** dismiss the suggestion.
- **Predict next prompt:** command-palette action to request or refresh a suggestion.
- **Prediction status and preview:** inspect settings, resolved models, errors, and the current suggestion.

Typing hides the suggestion. Tab keeps its native behavior when no valid suggestion
is visible. Suggestions do not appear in shell mode, during IME composition, in
menus/dialogs, or while permission/form input is pending.

Avoid using another plugin that also consumes Tab for ghost text in the same prompt.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `models` | unset | Required. Model selectors with optional wildcards and reasoning variants. |
| `timeoutMs` | `8000` | Maximum wait per model attempt, in milliseconds. The installation example uses `20000`. |
| `contextTurns` | `3` | Recent interactions to consider, from `1` to `5`. |
| `automatic` | `true` | Predict after a completed response. Set `false` for manual requests only. |
| `enabled` | `true` | Enable predictions. |
| `debug` | `false` | Show safe per-model failures, fallback progress, and queue decisions. |

Use `provider/model` or `provider/model#variant`. Omit `#variant` to use the model's
default reasoning. The plugin never changes your main session model.

`*` matches model IDs or display names case-insensitively. Separate selectors with
commas to set initial preference order. Matches within each wildcard group use stable
provider/model-ID order, not speed or price. Duplicate candidates are removed.
Only enabled models supporting the requested variant are selected.

When a call fails or times out, the next eligible configured match is tried silently.
With multiple configured candidates, only final unavailability produces a notice:

```text
[opencode-predictions] No model worked at this time. Activate `debug` mode for details.
```

With one configured candidate, its safe failure reason appears even with debug off:

```text
[opencode-predictions] Model [<name>] failed with message: <message>
```

The wording uses configured selectors and resolved candidates, not attempted calls.
An already blocked or cooling queue also produces one final notice per prediction
request, without calling a model. Successful predictions, valid “no suggestion”
responses, cancellations, stale requests, and background status checks stay silent
with debug off. Explicit status remains available in either mode.

Set `"debug": true` in plugin options to show detailed progress:

```text
[opencode-predictions] Predictions failed with [<model_display_name>], moving on with [<next_model>]...
Reason: HTTP 429: Free usage limit reached.
Queue: Paused for 60 minutes.
```

Debug popups include safe failure summaries, such as a provider restriction, usage
limit, invalid response, or timeout. Raw provider errors, credentials, and conversation
contents are never included in failure notices. Debug final summaries omit the
activation hint. All plugin notifications share the `[opencode-predictions]` prefix;
no log files are created.
Each candidate is attempted once. No unselected model is called. A valid
no-suggestion response stops the chain; exhaustion shows a failure notice.

### Ranking queue

A valid response, including “no suggestion,” moves its candidate first. A failure
moves it last. Untried candidates keep their relative order. Only your configured
models and reasoning variants can be used.

- **Access, payment, or unavailable model** (`401`/`402`/`403`/`404` or equivalent
  structured errors): blocked until the server-side plugin instance is recreated.
- **Explicit budget exhaustion** (daily/monthly budgets, depleted credits, or a
  reached free-usage limit): paused for **one hour**.
- **Temporary or unknown failure** (ordinary `429`, `5xx`, timeout, network error,
  or invalid output): paused for **60 seconds**. “Quota” or “limit” alone does not
  imply an exhausted daily budget.

For retryable failures, a valid provider `retryAfterMs` replaces the default pause,
with a 60-second minimum and no cap that would shorten longer provider delays.
Access, availability, budget, and rate-limit skips cover that model's reasoning
variants; other failures affect only the candidate that failed.

Cooldown expiry makes a candidate eligible at its learned position; it does not
schedule a call. If none are eligible, no generation occurs. Check **Prediction
status and preview** for current order, safe skip reasons, and retry timestamps.
Already-skipped models do not produce individual failure popups; only the final
unavailability summary appears when the whole queue is unavailable.

Queue state stays in memory and is shared across sessions using the same server/location
plugin instance. Recreating that instance clears it; reloading only the Desktop UI
does not necessarily do so. Models that leave the available catalog lose their queue
history. Cancellation and stale requests do not change rankings.

## Cost and privacy

Predictions and fallback attempts consume provider quota or paid tokens. Free-model
names do not guarantee unlimited usage. Broad wildcards can select paid models;
check resolved candidates before use. Timeouts and cancellation do not guarantee
the provider stops generating or billing. Two clients viewing the same session
can independently incur prediction costs.

The selected provider receives recent user and assistant text, which may contain
sensitive information. Tool output, reasoning, attachments, instruction payloads,
synthetic messages, other sessions, and unsent drafts are excluded. Oversized
context uses marked excerpts that may omit details.

The plugin keeps context and suggestions in memory. It adds no conversation
archive or telemetry. OpenCode and provider retention policies still apply.
Project instruction processing and preference memory are not supported.

Git installation stores plugin code in OpenCode's managed package cache
(`~/.cache/opencode/npm/` by default, or under `XDG_CACHE_HOME`). Settings remain
in `opencode.jsonc`. The plugin does not collect or copy project files into that
cache. Normal predictions write no plugin-owned context or suggestion files.
The optional model-pilot tool writes a JSON report only when invoked, under
`.test-artifacts/` or an explicit `--output` path.

## Compatibility

Requires OpenCode V2. Tested on macOS with CLI `2.2.6` and Desktop `2.2.7`.
These are tested versions, not an allowlist. Private editor integration and the
experimental Desktop API may need updates after OpenCode changes.

OpenCode V1, Mini, browser-only clients, and noninteractive predictions are not supported.

## License

[MIT](LICENSE)

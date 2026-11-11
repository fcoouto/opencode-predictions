# OpenCode Predictions

Predict the next complete user prompt in **OpenCode Desktop and the interactive CLI**.
Suggestions appear as ghost text after the assistant finishes. **Tab accepts a suggestion for editing; it never submits it.**

## How to install

Open your existing global `~/.config/opencode/opencode.json` or
`~/.config/opencode/opencode.jsonc`. Use whichever file you already have; do not
create a second configuration file.

### If you already have a configuration file

Append **only this object** inside the existing top-level `"plugins": [ ... ]`
array. Add a comma after the preceding entry, if there is one. Preserve all other
plugins and settings.

```json
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
```

### If you do not have other pluing in your configuration file

Your `~/.config/opencode/opencode.jsonc` should look like this:

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
- **Alt+Shift+P** (**Option+Shift+P** on macOS): request a prediction after a completed response, with the empty prompt focused. It never inserts or submits text.
- **Predict next prompt:** command-palette action to request or refresh a suggestion.
- **Prediction status and preview:** reopen a readable status snapshot with settings, resolved models, safe errors, and the current suggestion. Choose **Technical details** for host/plugin versions, feedback capabilities, and timing.

Typing hides the suggestion. Tab keeps its native behavior when no valid suggestion
is visible. Suggestions do not appear in shell mode, during IME composition, in
menus/dialogs, or while permission/form input is pending.

Switching chats hides a suggestion without discarding it. Returning to the same
completed response and configuration restores it without another model call.
After accepting a suggestion, you can edit it freely; clearing the entire draft
restores the original suggestion. Escape dismisses it, and typing before acceptance
invalidates it. This bounded cache stays in memory and does not survive a plugin
reload or restart.

Avoid using another plugin that also consumes Tab for ghost text in the same prompt.

Manual requests also work with older chats: the shortcut and command-palette action
use the latest completed turn with usable conversation text, even when historical
completion markers are missing. They still require an idle chat and empty, eligible
input; an unfinished or interrupted latest turn cannot reuse an older answer.
Automatic prediction requirements are unchanged.

The prediction shortcut also works with `"automatic": false`. In the CLI, your
terminal must forward the combination distinctly, for example through CSI-u/Kitty
keyboard support. Legacy `ESC P` is ambiguous with a terminal control sequence;
if the shortcut is not delivered, use **Predict next prompt** from the command palette.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `models` | unset | Required. Selector text for one ranking group, or an ordered array of selector groups. |
| `timeoutMs` | `8000` | Maximum wait per model attempt, in milliseconds. The installation example uses `20000`. |
| `contextTurns` | `3` | Recent interactions to consider, from `1` to `5`. |
| `automatic` | `true` | Predict after a completed response. Set `false` for manual requests only. |
| `enabled` | `true` | Enable predictions. |
| `debug` | `false` | Show safe per-model failures, fallback progress, and queue decisions. |

Use `provider/model` or `provider/model#variant`. Omit `#variant` to use the model's
default reasoning. The plugin never changes your main session model.

`*` matches model IDs or display names case-insensitively. Matches within each
wildcard selector use stable provider/model-ID order, not speed or price.
Only enabled models supporting the requested variant are selected.

### Model groups

Text defines one group. An array defines groups in fixed priority order. Each
entry can be selector text or an inner array of selector strings. Selectors can
name one exact model or expand a wildcard into several models.
These are individual lines to use inside your existing plugin `options` object:

| Use case | Example |
| --- | --- |
| Text: one exact model | `"models": "opencode/beam-free#low"` |
| Text: one wildcard group | `"models": "opencode/*free*#low"` |
| Array: one exact model | `"models": ["opencode/beam-free#low"]` |
| Array: one wildcard group | `"models": ["opencode/*free*#low"]` |
| Array: two groups, free first, paid fallback | `"models": ["opencode/*free*#low", "opencode-go/deepseek*flash*#low"]` |
| Array: two exact-model groups | `"models": ["opencode/beam-free#low", "opencode/deepseek-v4.1-flash#low"]` |
| Array: combined free selectors, then paid fallback | `"models": ["opencode/*free*#low, opencode-go/*free*#low", "opencode-go/deepseek*flash*#low"]` |
| Nested arrays: explicit free and paid groups | `"models": [["opencode/deepseek-*-flash-free#low", "opencode/glm-*-free#low", "opencode/nemotron-*-free#low"], ["opencode-go/deepseek-*-flash#low", "opencode-go/glm-*#low"]]` |

Use commas **inside an entry** to combine selectors into one independently ranked
group, or use an inner array to list its selectors explicitly. Both forms have the
same behavior. For example, these explicit free and paid groups keep independent
rankings:

```json
"models": [
  ["opencode/deepseek-*-flash-free#low", "opencode/glm-*-free#low", "opencode/nemotron-*-free#low"],
  ["opencode-go/deepseek-*-flash#low", "opencode-go/glm-*#low"]
]
```

Inner arrays do not create more priority levels: they combine selectors within a
single group. Text entries and inner arrays may be mixed in the outer array.

Every request starts with the first group and skips blocked or cooling candidates.
Only after a group's eligible candidates fail or none are available does the next
group run. A valid “no suggestion” response stops the entire request; it does not
trigger paid fallback. The plugin does not infer pricing: choose and check your
selectors yourself.

Group order never changes. A paid-model success cannot promote the paid group
ahead of the free group. Recovered free models take precedence on later requests.
Within a group, comma-separated selectors set initial preference order; the ranking
queue then learns from outcomes. Legacy comma-separated text remains one group.

Overlapping provider/model/variant candidates belong to the earliest matching
group and are attempted at most once per request. Different reasoning variants
remain distinct candidates, with shared model-wide restrictions as described below.
Empty arrays, empty groups, non-string selectors, and nesting deeper than these
group arrays are rejected.

**Prediction status and preview** includes ordered `groups` and each group's
ranked candidates. Existing flat `models` and `candidates` fields remain available.

### Failure notifications

Invalid settings, missing model selectors, zero matches, and service connection
failures produce actionable notices even with debug off and before a completed
assistant response. Notices explain the effect on predictions and the next step.
Unknown options produce a warning rather than disappearing silently.

Desktop error toasts offer **Open prediction status**. Configuration and access
blockers stay until dismissed, replaced, or resolved. CLI notices use error/warning
variants and name the **Prediction status and preview** command. Neither host opens
a dialog automatically or interrupts typing.

An unchanged background issue is announced once per connected server/location,
not once per status poll or completed response. A changed issue or recovery followed
by recurrence can notify again. Explicit **Predict next prompt** requests explain
their outcome even when the same background issue was already announced, including
disabled predictions, an occupied prompt, missing context, and “no suggestion.”

When a model fails, the next eligible configured match is tried silently. If the
whole queue is unavailable, the notice includes safe causes and recovery guidance
without requiring debug mode. Cooldown notices give the earliest retry eligibility;
they do not schedule an automatic retry. Successful fallback, cancellation, stale
requests, and automatic “no suggestion” responses remain silent.

**Prediction status and preview** opens a native dialog, not an expiring JSON toast.
It shows a snapshot of current health, settings warnings, ordered model groups and
matches, queue restrictions, retry eligibility, the last meaningful failure, and
the current suggestion. Reopen it to refresh. Healthy polls do not erase the last
failure. Technical details include package versions and feedback revision metadata;
missing metadata means unknown/legacy compatibility, not proof of an outdated install.
Status and failure memory stay in this client's memory; they are not a persistent log.

Set `"debug": true` in plugin options to show detailed progress:

```text
[opencode-predictions] Predictions failed with [<model_display_name>], moving on with [<next_model>]...
Reason: HTTP 429: Free usage limit reached.
Queue: Paused for 60 minutes.
```

Debug popups include safe failure summaries, such as a provider restriction, usage
limit, invalid response, or timeout. Raw provider errors, credentials, and conversation
contents are never included in failure notices. Debug final summaries omit the
activation hint. Debug progress keeps the `[opencode-predictions]` prefix;
actionable notices use descriptive titles. No log files are created.
Each candidate is attempted once. No unselected model is called. A valid
no-suggestion response stops the chain; exhaustion shows a failure notice.

### Ranking queue

Each group has its own ranking queue. A valid response, including “no suggestion,”
moves its candidate first **within that group**. A failure moves it last within its
group. Untried candidates keep their relative order. Only your configured models
and reasoning variants can be used.

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
variants across all groups; other failures affect only the candidate that failed.

Cooldown expiry makes a candidate eligible at its learned position; it does not
schedule a call. If none are eligible, no generation occurs. Check **Prediction
status and preview** for current order, safe skip reasons, and retry timestamps.
Already-skipped models do not produce individual failure popups. The whole-queue
issue is deduplicated until it changes or recovers; manual requests still explain it.

Queue state stays in memory and is shared across sessions using the same server/location
plugin instance. Recreating that instance clears it; reloading only the Desktop UI
does not necessarily do so. Models that leave the available catalog lose their queue
history. If a catalog change moves a candidate into a different owning group, it
starts untried there while retaining any active cooldown or block. Cancellation
and stale requests do not change rankings.

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

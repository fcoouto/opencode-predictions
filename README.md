# OpenCode Predictions

Suggest a useful next user prompt in **OpenCode Desktop and the interactive CLI**.
Suggestions appear as ghost text after the assistant finishes. **Tab accepts a suggestion for editing; it never submits it.**

The default directive asks for one concise next step toward your current goal,
rather than guessing your exact next words. It prioritizes explicitly unfinished
work or delivery gaps without inventing facts or bundling optional tasks.

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

- **Tab:** insert only the visible real prediction into the editable prompt. During compact status, Tab keeps its normal host behavior and cannot accept a hidden prediction.
- **Alt+Shift+P** (**Option+Shift+P** on macOS): request a prediction after a completed response, or try another model after a prediction/abstention. The empty prompt must be focused. It never inserts or submits text.
- **Predict next prompt:** command-palette equivalent of the prediction shortcut. With escalation off, explicit requests retain ordinary refresh behavior.
- **Prediction status and preview:** reopen a readable status snapshot with settings, resolved models, safe errors, and the current suggestion. Choose **Technical details** for host/plugin versions, feedback capabilities, and timing.

Typing hides the suggestion without discarding it. Escape keeps its normal host
behavior. Tab keeps its native behavior when no valid suggestion
is visible. Suggestions do not appear in shell mode, during IME composition, in
menus/dialogs, or while permission/form input is pending.

Switching chats hides a suggestion without discarding it. Returning to the same
completed response and configuration restores it without another model call.
Typing or accepting a suggestion leaves it cached; clearing the entire draft
restores the original suggestion. This bounded cache stays in memory and does not
survive a plugin reload or restart.

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
| `escalation` | `"manual"` | `"off"` disables alternatives; `"manual"` uses **Alt+Shift+P** to try another model; `"automatic"` permits one extra call after abstention. |
| `enabled` | `true` | Enable predictions. |
| `debug` | `false` | Show safe per-model failures, fallback progress, and queue decisions. |

Use `provider/model` or `provider/model#variant`. Omit `#variant` to use the model's
default reasoning. The plugin never changes your main session model.

`*` matches model IDs or display names case-insensitively. Matches within each
wildcard selector use stable provider/model-ID order, not speed or price.
Only enabled models supporting the requested variant are selected.

### Progress and alternative predictions

Press **Alt+Shift+P** again after a prediction or a no-suggestion response to try
the next untried eligible model in the current group, then later groups. Each action
permits at most one additional stateless generation request. OpenCode/provider
transport retries may make additional HTTP attempts for that same model; this SDK
does not expose retry control. Models are not repeated within a
prediction cycle, including models called by ordinary initial error fallback.

While generating, a compact activity indicator replaces prediction text. An
alternative request also shows the model's display name, for example
`￻▱▰▱ Fixture Flash`. Indicators start with `￻` (U+FFFB). The moving block means local activity, not completion percentage
or proof that the provider is healthy. Desktop respects reduced motion; CLI respects
the existing `animations` preference in `cli.json` and `OPENCODE_CLI_CONFIG_CONTENT`.
Unreadable CLI motion settings use a static indicator.

The original prediction is temporarily withdrawn but retained internally. **Tab
passes through normally while status is visible**: it cannot insert status or accept
the hidden original, and does not itself cancel the request. Success shows the new
prediction; abstention, error or timeout restores the original. Tab accepts real text
again once it is visible. No action button is shown. Without a prediction, a muted
placeholder identifies the abstaining model and the next alternative:

```text
[First Model] provided no prediction.
Use Option+Shift+P to escalate it to [Next Model].
```

macOS uses **Option+Shift+P**; other platforms show **Alt+Shift+P**. The actual
shortcut binding is unchanged. The second line appears only when an alternative
exists. This is placeholder communication, not draft text: it does not extend the
composer and cannot be accepted with Tab. Typing dismisses it. A legacy service
without source-model metadata shows a generic no-prediction message instead.
With no alternatives, a brief **No alternatives available.** message precedes restoration.
Repeated shortcuts while pending are ignored. Typing or changing context cancels
pending work and clears status; late results cannot overwrite the draft.

```json
{
  "automatic": true,
  "escalation": "manual"
}
```

- **`"off"`:** valid `{"prompt":null}` stops. No escalation action is offered;
  the usual explicit request can still refresh from the first eligible group.
- **`"manual"` (default):** stop after a prediction or abstention. The shortcut
  requests an alternative, current group first. Skip blocked/cooling candidates
  and empty groups; never wrap to earlier groups within a cycle.
- **`"automatic"`:** valid abstention permits one additional model call in the
  current group first. If that model also abstains, another explicit action is
  needed to go further. This is not a loop until some model produces text.

`automatic: false` controls only how the initial request starts. Combining it with
`escalation: "automatic"` means a manual request can still make an extra call.
Group order expresses preference, not guaranteed quality or price. Every model call
may consume its provider's quota, including paid quota. Cancellation does not
guarantee avoiding provider charges. Pending status names the model; it is not an
advance pricing confirmation.

An escalation action stops on text, abstention or error; it does not start another
error-fallback chain. Its `timeoutMs` budget includes validation and generation.
Ordinary initial requests retain their existing per-model timeout and error fallback.
Abstention remains a healthy response, not a cooldown or failure penalty.
If the offered manual target becomes unavailable, the offer refreshes without
silently calling a different model. Old, duplicate, or changed-context offers do
not generate. If no untried eligible model is available, no additional call is made.

A cycle covers one server/location, session, completion and service configuration.
Focus changes do not restart it. The service keeps at most 128 cycles; eviction
invalidates associated tokens. Continuation refreshes use an explicit metadata-only
intent and never become initial generation when state is missing or evicted; another
explicit shortcut uses a refreshed offer. Readiness and continuation refresh are
bounded by `timeoutMs`, so a stalled lookup restores the retained original.
Configuration/service changes or new context start fresh cycles. Off mode retains
ordinary explicit refresh behavior.

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

Ordinary initial requests start with the first group and skip blocked or cooling candidates.
Only after a group's eligible candidates fail or none are available does ordinary
error fallback move to the next group. With escalation off, a valid “no suggestion”
response stops the entire request; it does not trigger paid fallback.
The plugin does not infer pricing: choose and check your
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
requests remain silent. Automatic “no suggestion” responses produce no toast;
escalation-enabled clients instead show non-editable communication near the composer.

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
Each candidate is attempted at most once per request. No unselected model is called.
A valid no-suggestion response follows the configured escalation policy;
error exhaustion shows a failure notice.

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

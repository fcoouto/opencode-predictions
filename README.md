<h1 align="center">OpenCode Predictions</h1>

<p align="center">
  <strong>Your next prompt, one Tab away.</strong><br />
  AI-powered next-prompt suggestions for OpenCode Desktop and the interactive CLI.
</p>

<p align="center">
  <a href="https://github.com/fcoouto/opencode-predictions/actions/workflows/check.yml"><img src="https://github.com/fcoouto/opencode-predictions/actions/workflows/check.yml/badge.svg" alt="Build and test status" /></a>
  <a href="#compatibility"><img src="https://img.shields.io/badge/OpenCode-V2-b9efcb?style=flat-square&amp;labelColor=27352d" alt="Requires OpenCode V2" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-b9efcb?style=flat-square&amp;labelColor=27352d" alt="MIT license" /></a>
</p>

<p align="center">
  <a href="#how-to-install">Install</a> &middot;
  <a href="#controls">Controls</a> &middot;
  <a href="#settings">Settings</a> &middot;
  <a href="#cost-and-privacy">Cost &amp; privacy</a> &middot;
  <a href="#compatibility">Compatibility</a>
</p>

<p align="center">
  <img src="readme-demo.svg" width="800" alt="Illustrative interaction: the assistant finishes, then ghost text suggests “Review the diff for regressions.” Tab accepts it for editing, without sending." />
</p>

<p align="center"><sub>Illustrative interaction, not a screenshot. You decide what gets sent.</sub></p>

## Keep the next step in sight

OpenCode Predictions is an [OpenCode](https://opencode.ai) plugin for **prompt
autocomplete**. When the assistant finishes, a useful next user prompt appears
as ghost text. Take it, edit it, or keep typing your own.

**Tab accepts a suggestion for editing. It never submits it.**

- **Stay on task.** Suggestions draw on recent conversation, not your unsent draft.
- **Keep your main model.** Choose prediction models separately, with ordered
  groups and automatic error fallback.
- **Use either interface.** One global plugin entry loads Desktop and CLI support.
- **Ask when you want.** Predict automatically after a response, or switch to
  manual requests only.

The default directive asks for one concise next step toward your current goal,
rather than guessing your exact next words. It prioritizes explicitly unfinished
work or delivery gaps without inventing facts or bundling optional tasks.
When a recommendation or single scoped approval request clearly continues your
task, it favors a short contextual reply instead of repeating the proposal.

## How to install

**Requires OpenCode V2.** See [tested versions and limitations](#compatibility).
Prebuilt bundles are included; no local build is needed.

### Add the plugin

Open your existing global `~/.config/opencode/opencode.json` or
`~/.config/opencode/opencode.jsonc`. Use whichever file you already have; do not
create a second configuration file.

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

<details>
<summary><strong>Starting without a configuration file? Copy this complete example.</strong></summary>

Create `~/.config/opencode/opencode.jsonc` with the following contents.
If your existing file has no `plugins` array, add this array to it instead of
replacing the file.

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

</details>

OpenCode installs the package from GitHub.
Configuration changes reload automatically; use `/reload` if needed.
The global entry loads both Desktop and CLI support. Do not put it only in `cli.json`.

### Check your prediction model

Connect your chosen provider through OpenCode. No API keys belong in plugin options.
The example selects available `opencode` models whose ID or display name contains
`free` and which support the `low` variant. Use **Prediction status and preview**
to inspect matches. If none match, choose another selector or omit `#low`.

> **Before your first prediction:** model calls can consume paid quota, and the
> selected provider receives recent conversation text. “Free” model names do not
> guarantee unlimited usage. Read [cost and privacy](#cost-and-privacy).

## Controls

| Action | Control | What happens |
| --- | --- | --- |
| Accept and edit | <kbd>Tab</kbd> | Insert the visible prediction into the draft. **Never submits.** |
| Request or try another | <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> | Request a prediction, or try another eligible model after a prediction or abstention. |
| Request from the palette | **Predict next prompt** | Use the command-palette equivalent of the shortcut. |
| Inspect settings and errors | **Prediction status and preview** | Open a readable status snapshot with resolved models, safe errors, and the current suggestion. |

On macOS, use <kbd>Option</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>.
The prediction shortcut requires an empty, focused prompt. It never inserts or
submits text. With escalation off, explicit requests retain ordinary refresh
behavior.

Choose **Technical details** in the status dialog for host/plugin versions,
feedback capabilities, and timing. During compact status, Tab keeps its normal
host behavior and cannot accept a hidden prediction.

<details>
<summary><strong>Typing, chat switching, history, and terminal shortcuts</strong></summary>

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
A completed assistant reply with visible text is sufficient even when a continuation
or compaction leaves no new user message. If assistant-only continuations fill the
recent-turn window, the latest eligible human request is retained separately,
including grouped steering messages but not that older turn's assistant replies.
Under the 32,768-byte prompt limit, older optional turns are dropped first; retained
human text and the latest response use marked excerpts when needed.
This preserves context but does not guarantee the model uses the correct speaker perspective.
Synthetic instructions, tool output, reasoning and compaction summaries remain excluded.
Predictions never borrow text across a successful compaction boundary or reuse an
older answer when the latest response is unfinished or has no usable visible text.
If usable context is genuinely missing, the prompt says **Prediction unavailable
for this response. Continue typing your next prompt.**, rather than claiming that
no completed reply exists or treating the status dialog as recovery.

The prediction shortcut also works with `"automatic": false`. In the CLI, your
terminal must forward the combination distinctly, for example through CSI-u/Kitty
keyboard support. Legacy `ESC P` is ambiguous with a terminal control sequence;
if the shortcut is not delivered, use **Predict next prompt** from the command palette.

</details>

## Settings

Set these fields inside the plugin's `options` object. The installation example
uses a `20000` ms timeout; the plugin default is `8000` ms.

| Setting | Default | Meaning |
| --- | --- | --- |
| `models` | unset | Required. Selector text for one ranking group, or an ordered array of selector groups. |
| `timeoutMs` | `8000` | Maximum wait per model attempt, in milliseconds. The installation example uses `20000`. |
| `contextTurns` | `3` | Recent interactions to consider, from `1` to `5`. The latest eligible human request is also retained when absent from that window. |
| `automatic` | `true` | Predict after a completed response. Set `false` for manual requests only. |
| `escalation` | `"manual"` | `"off"` disables alternatives; `"manual"` uses **Alt+Shift+P** to try another model; `"automatic"` permits one abstention-triggered transition. Errors fall back automatically in all modes. |
| `enabled` | `true` | Enable predictions. |
| `debug` | `false` | Show safe per-model failures, fallback progress, and queue decisions. |

Use `provider/model` or `provider/model#variant`. Omit `#variant` to use the model's
default reasoning. The plugin never changes your main session model.

`*` matches model IDs or display names case-insensitively. Matches within each
wildcard selector use stable provider/model-ID order, not speed or price.
Only enabled models supporting the requested variant are selected.

### Progress and alternative predictions

<details>
<summary><strong>How alternatives, activity indicators, and escalation work</strong></summary>

Press **Alt+Shift+P** again after a prediction or a no-suggestion response to try
the next untried eligible model in the current group, then later groups. Provider
errors, invalid output and model timeouts automatically advance through remaining
untried eligible models, including during an alternative request. OpenCode/provider
transport retries may make additional HTTP attempts for that same model; this SDK
does not expose retry control. Models are not repeated within a
prediction cycle, including models called by ordinary initial error fallback.

While generating, a compact activity indicator replaces prediction text. An
request also shows the actual attempted model's display name, for example
`￻▱▰▱ Fixture Flash`. Indicators start with `￻` (U+FFFB). The moving block means local activity, not completion percentage
or proof that the provider is healthy. Desktop respects reduced motion; CLI respects
the existing `animations` preference in `cli.json` and `OPENCODE_CLI_CONFIG_CONTENT`.
Unreadable CLI motion settings use a static indicator.

In Desktop, real predictions temporarily grow the empty composer to fit up to six
visible lines above its controls. Longer previews end with an ellipsis; **Tab still
accepts the full prediction**, not the shortened preview. Dismissal, typing or status
messages release the reserved space. Progress and no-prediction messages stay compact.

The original prediction is temporarily withdrawn but retained internally. **Tab
passes through normally while status is visible**: it cannot insert status or accept
the hidden original, and does not itself cancel the request. Success shows the new
prediction; abstention or terminal failure restores the original. Tab accepts real text
again once it is visible. No action button is shown. Without a prediction, a muted
placeholder identifies the abstaining model and the next alternative:

```text
[First Model] provided no prediction.
Option+Shift+P: try [Next Model].
```

macOS uses **Option+Shift+P**; other platforms show **Alt+Shift+P**. The actual
shortcut binding is unchanged. The second line appears only when an alternative
exists and a model actually returned `{"prompt":null}`. Metadata refresh never
claims model abstention. This is placeholder communication, not draft text: it does not extend the
composer and cannot be accepted with Tab. Typing dismisses it. A legacy service
without source-model metadata shows a generic no-prediction message instead.
With no alternatives, a brief **No alternatives available.** message precedes restoration.
Repeated shortcuts while pending are ignored. Typing or changing context cancels
pending work and clears status; late results cannot overwrite the draft.
If settings reload cancels an initial request before a server cycle is established,
the next explicit shortcut can request a fresh prediction. Typing and clearing before
the first prediction also permits a fresh request. These actions do not trigger
automatic retries or reuse a previous configuration's cached prediction.

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
- **`"automatic"`:** valid abstention permits one automatic transition in the
  current group first. Provider errors during that transition still fall through.
  If the next working model also abstains, another explicit action is
  needed to go further. This is not a loop until some model produces text.

`automatic: false` controls only how the initial request starts. Combining it with
`escalation: "automatic"` means a manual initial request can still advance after abstention.
Group order expresses preference, not guaranteed quality or price. Every model call
may consume its provider's quota, including paid quota. Cancellation does not
guarantee avoiding provider charges. Pending status names the model; it is not an
advance pricing confirmation.

Text or genuine abstention stops error fallback. Errors advance automatically
without asking for another shortcut. Each model attempt and metadata phase is
bounded by `timeoutMs`; a multi-model action can therefore take longer than one
timeout and consume quota on several models. Cancellation and stale context stop
the chain immediately.
When all eligible models fail, concise communication gives a recognized cause and
one recovery instruction, not a next-model hint. Unknown causes remain generic;
**Prediction status and preview** retains safe per-model details.
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

</details>

### Model groups

<details>
<summary><strong>Choose exact models, wildcard selectors, or free-first fallback groups</strong></summary>

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

</details>

### Failure notifications

<details>
<summary><strong>Understand notices, status details, and debug output</strong></summary>

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

</details>

### Ranking queue

<details>
<summary><strong>How ranking, cooldowns, and provider restrictions affect model selection</strong></summary>

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

</details>

## Cost and privacy

Predictions and fallback attempts consume provider quota or paid tokens. Free-model
names do not guarantee unlimited usage. Broad wildcards can select paid models;
check resolved candidates before use. Timeouts and cancellation do not guarantee
the provider stops generating or billing. Two clients viewing the same session
can independently incur prediction costs.

The selected provider receives recent user and assistant text and, when needed,
the latest eligible human request from before that window, within the same
compaction boundary. This text may contain sensitive information.
Tool output, reasoning, attachments, instruction payloads,
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

---

[Install the plugin](#how-to-install) &middot;
[Report a bug](https://github.com/fcoouto/opencode-predictions/issues) &middot;
[OpenCode documentation](https://opencode.ai/docs/)

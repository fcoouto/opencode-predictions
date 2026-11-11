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

Use `provider/model` or `provider/model#variant`. Omit `#variant` to use the model's
default reasoning. The plugin never changes your main session model.

`*` matches model IDs or display names case-insensitively. Separate selectors with
commas to set preference order. Matches within each wildcard group use stable
provider/model-ID order, not speed or price. Duplicate candidates are removed.
Only enabled models supporting the requested variant are selected.

When a call fails or times out, the next configured match is tried, with a notice:

```text
Predictions failed with <model_display_name>, moving on with <next_model>...
```

Each candidate is attempted once. No unselected model is called. A valid
no-suggestion response stops the chain; exhaustion shows a failure notice.

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

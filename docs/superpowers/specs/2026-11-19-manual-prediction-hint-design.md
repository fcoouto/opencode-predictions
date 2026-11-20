# Manual Prediction Hint

Status: approved in conversation. The user approved the sentence and proceeding with the change.

## Scope

Desktop's empty prompt box shows:

> Press Option + Shift + P to request a prediction.

Show it only with predictions enabled, `automatic=false`, an eligible empty composer, and a usable configured request shortcut. Use the effective host shortcut, with readable modifier names; do not advertise a disabled or remapped default.

Prediction text, requests in progress, result/error/continuation messages, user text, IME composition, menus, and unavailable session/context take precedence. Do not insert the hint into editable content or allow Tab to accept it.

Restore the original placeholder and layout when the hint withdraws or the plugin unloads. Keep native styling and accessible communication; wrap without overlapping composer controls on narrow windows. No animation.

## Approach

Reuse the Desktop adapter's existing noneditable overlay and sizing. An optional client hint callback receives availability; Desktop supplies the effective shortcut. A separate polling loop, fake prediction, native-placeholder text replacement, and terminal changes are unnecessary.

## Non-goals

No preferences-storage implementation, settings changes, automatic generation, prediction behavior changes, or unrelated design work. The earlier preferences proposal remains unapproved.

## Acceptance

Rendered Desktop integration tests cover manual versus automatic/disabled/invalid states, typing/composition/focus/menu changes, pending and completed requests, shortcut remapping/unbinding, unload, and narrow layout. Opening the hint generates nothing and preserves the composer.

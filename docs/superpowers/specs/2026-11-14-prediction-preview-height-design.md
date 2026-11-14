# Auto-growing Desktop prediction preview

Approved: actual predictions reserve enough composer space for up to six visible lines. Longer previews ellipsize without shortening the stored prediction. Dismissal restores normal height.

## Approach

Keep prediction text outside the editable draft, retaining existing overlay appearance and host Composer insertion. Measure the wrapped, six-line-clamped preview and temporarily reserve matching space in its empty editor. Restore only the temporary layout property owned by this adapter.

Fixed-height truncation was rejected in favor of auto-growth. Smaller fonts and shorter generated predictions are outside scope.

## Requirements

- Use the editor's current width, font, padding and line height, including narrow layouts, Unicode and explicit newlines.
- Grow only for real predictions, not progress, abstention or failure messages.
- Bound visible text to six lines with an ellipsis when overflowing; Tab accepts the exact full prediction.
- Keep toolbar controls below the preview; never place ghost text inside the draft or submit it.
- Restore normal height on dismissal, typing, composition, status transition, navigation, acceptance and adapter disposal.
- Reflow on resize without cumulative growth. Preserve unrelated host styles and restore original inline min-height values and priorities.
- Use existing dependencies and layout; do not change provider calls, RPC, CLI behavior or global configuration.
- Verify rendered geometry and screenshots in browser fixtures and real isolated Desktop with synthetic providers.
- The user subsequently authorized commits, PR delivery and merge into `main`. Installed-plugin updates remain outside that authorization.

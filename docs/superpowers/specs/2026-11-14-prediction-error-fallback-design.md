# Prediction error fallback

Approved follow-up to the November 13 alternative-prediction design. This supersedes its one-call-per-action and stop-on-alternative-error rules.

- Provider errors, invalid output and model timeouts advance automatically through untried eligible candidates, current group before later groups.
- Text stops generation. Genuine `{"prompt":null}` stops error fallback and may show the next-model shortcut.
- Preserve the explicit `escalation: "automatic"` opt-in: at most one abstention-triggered transition per action. Errors during that transition still fall through. Manual remains the default; off still stops at null.
- Metadata-only refresh returns `escalation_refreshed`, not `no_suggestion`. It may replace shortcut authority but never invent an abstention message.
- Exhaustion reports recognized, fixed cause summaries and one recovery instruction. Never display raw errors or next-model guidance after failure.
- Preserve tried tracking, cooldowns, stale/cancellation checks, eviction protection, retained originals, draft isolation, Tab safety and muted presentation.
- Progress always starts with U+FFFB and names the actual attempted model. Structured model-name events are separate from debug notices.
- Bound metadata and each model attempt independently. Multiple calls may consume provider quota; SDK transport retries remain outside plugin control.
- No new dependency, button, composer expansion or paid experiment. The user subsequently authorized delivery through a PR merged into `main`; installation remains outside that authorization.

Verification: service and client regressions, complete unit/rendered suite, typecheck, bundle, package, serialized native Desktop/CLI gates, server RPC, one independent review.

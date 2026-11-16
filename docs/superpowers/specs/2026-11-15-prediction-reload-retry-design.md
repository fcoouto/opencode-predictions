# Prediction recovery after settings reload

## Authority and scope

The user authorized proposing this fix, review by Opus before implementation, implementation, another Opus review, and merge after passing checks. Opus is the delegated design and final review gate; no additional human approval round is required.

## Reproduced failure

Using the real client/controller/service with a local generation stub:

1. An original prediction is visible under service version A.
2. Settings change recreates the service with version B. Old cached text is correctly hidden.
3. The client starts a replacement request, records its local attempt, and a second invalidation cancels it before the new server creates a cycle.
4. The controller suppresses another automatic request, as intended, but also treats that local attempt as proof of a server cycle.
5. Every explicit shortcut sends `escalation: "refresh"`. The service has no cycle and returns `escalation_unavailable` indefinitely.

No external prediction provider was called in the reproduction. Opus confirmed a second trigger: with automatic predictions disabled, typing and clearing a draft marks the key attempted before any server cycle exists. The first shortcut then enters the same loop.

## Goals and constraints

- A cancelled or failed initial request without established server authority must permit the next explicit request to start fresh.
- Local automatic-attempt suppression must remain independent from server continuation authority. Do not clear suppression on navigation or every settings event.
- Only current, non-aborted server reply outcomes may establish authority: `reply.text`, `no_suggestion`, or `escalation_refreshed`. Never infer authority from client-built communication or local timeout/service errors.
- Preserve established authority across failures, cancellation, typing, and `escalation_unavailable` so existing or evicted cycles cannot wrap to already-tried models.
- Clear stale offers through existing communication handling, not authority revocation. Only a never-established attempt permits the next explicit request to start fresh; never automatically retry a paid request.
- Keep cached real text available within its existing session/completion/configuration key. Do not carry old text or tokens into a new service version.
- Preserve typing cancellation, late-response isolation, expected-offer checks, scope isolation, and the existing 128-entry cache bound.
- No prediction directive, context retention, model resolution, service/RPC contract, dependencies, version metadata, or global settings changes.
- No installed-plugin update, release, npm publication, or paid prediction experiments. User-requested Opus reviews are authorized.

## Approaches

1. **Separate established continuation authority from local attempts (selected).** Store a small authority flag with existing controller results. Use it, rather than `attempted`, to decide whether a manual request without an offer should send `"refresh"`. Establish it only from accepted server replies, and keep it for that cached key even when continuation becomes unavailable.
2. **Clear all local attempts on invalidation (rejected).** Navigation and duplicate settings events share invalidation paths; clearing suppression could repeat automatic paid calls and lose cached behavior.
3. **Let the server turn missing-cycle refreshes into generation (rejected).** Metadata refresh and stale offers must not silently authorize generation, especially across configuration changes.

The exact private flag name and minimal expression are implementation choices. Prefer the existing result cache rather than a second map or public API.

## Opus design review

Claude Agent Opus approved the original design, then approved a narrower amendment after the existing server-cycle eviction cost-safety test exposed a conflict. The reviewer withdrew the original revocation recommendation.

Carry established authority forward for every reply replacing a result entry, including `escalation_unavailable`. When typing clears communication, keep entries carrying authority even without text. Only result-cache eviction, disposal, or a different key discards that authority. Keep acceptance, catch, exhaustion, server validation, and cache bounds unchanged.

The initial OpenCode Models Opus route was unavailable due insufficient credits. The successful review used `claude-agent/opus`.

## Verification

- Controller tests: interrupted initial request, typed-and-cleared draft, transport/initial failure, valid server-outcome authority surviving typing, ordinary alternative failure, unavailable continuation with retained text/authority, repeated automatic suppression, and late reply isolation.
- Server/client cost-safety test: after abstention and server-cycle eviction, typing and clearing must still send `"refresh"` and never generate again. The existing real-text eviction test must pass unchanged.
- Client/service integration: reproduce version A to B reload with duplicate invalidation and a request cancelled before reaching the server. The next shortcut must send no escalation token, generate once through the new configured local model, and restore a usable prediction. Repeated automatic ticks must not cause extra calls.
- Run existing client/controller/service tests, full tests, typecheck, bundle, package validation, relevant isolated installed-package checks, and CI.
- Opus reviews both this design before implementation and the final code before merge. Fix in-scope findings and rerun affected checks.

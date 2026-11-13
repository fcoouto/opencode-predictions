# Prediction escalation and non-accepting plugin messages

## Intent and approval

The user approved implementing the escalation behavior discussed in this conversation. They explicitly require Tab acceptance to apply only to actual predictions, never to plugin-to-user communications. Tab itself must not be disabled: normal host behavior and keyboard accessibility remain available.

## Approaches

We considered trying another candidate in the same group, automatically advancing until a model produces text, and bounded next-group escalation. The selected direction is bounded next-group escalation with a contextual **Ask another model** action, rather than requiring users to find a separate command. Continuing until text is rejected because legitimate abstention must remain possible.

## Settings and behavior

- Retain `enabled`, `automatic`, the existing model groups, reasoning variants and error fallback.
- Add `escalation: "off" | "manual" | "automatic"`, default `"manual"`. This is a plugin option, not a new standalone settings application. The status view explains the effective mode.
- `off`: valid abstention stops as before; no escalation action. Ordinary explicit refresh remains available.
- `manual`: valid abstention stops and shows a non-editable communication with **Ask another model** and the next model/provider. Clicking it in Desktop or using `Alt+Shift+P` requests one additional model call.
- `automatic`: after valid abstention, make at most one additional call to the first ready model in the earliest later eligible group. No same-group second opinions and no wraparound. If that call also abstains, further escalation requires explicit action.
- An explicit request with automatic escalation enabled may make two calls; `automatic: false` controls the initial trigger, not this behavior.
- The additional escalation call stops on text, valid abstention, or error. An error records normal health/cooldown but does not start another fallback chain. Initial ordinary error fallback is unchanged.
- Abstention is healthy, not an error or cooldown. Preserve its existing ranking treatment rather than reward models solely for producing text.
- If no later model is eligible, no extra call occurs. Explain that no other models are available without claiming every model was tried.

## Communication and acceptance

- Prediction text and plugin communication are distinct data and presentation paths. Never classify them by their visible wording.
- Only a current, visible, real prediction can be inserted by Tab. Communications, loading state, provider labels, and errors cannot be inserted and cannot trigger generation via Tab.
- Real predictions keep existing Tab acceptance, navigation restoration and draft-edit behavior.
- Display the communication outside editable draft content. No automatic modal, focus theft, or toast on every abstention.
- Desktop uses an accessible **Ask another model** button; CLI shows a shortcut hint using the native non-editable presentation. The existing command/shortcut adapts after an abstention.
- Show the target provider/model and explain that it uses that provider's quota before the action. Do not call later groups inherently better, stronger, or paid/free based only on their position.
- Keep the action usable when focused by keyboard; normal Tab focus movement must not make it vanish before activation.

## Safety and lifecycle

- Keep selection and group advancement in the service. Bind manual offers to the actual abstention, session, completion and service/configuration version. Reject invalid or replayed offers before generation.
- Bound offer state in memory. Do not persist conversations, new telemetry or escalation state.
- If the displayed target becomes unavailable, do not silently substitute another provider on that manual action. Refresh the offer without generating.
- Use the same filtered prompt and existing 32,768-byte budget. No other conversation, tool output, plan context or generated prediction is added.
- Preserve cancellation on typing/navigation/disposal, busy/interrupted/location/completion checks and guards before and after each generation.
- Bound an escalation action with the existing `timeoutMs`; no new timeout setting or unbounded retry loop.
- Hide communication after typing or a new completion. Configuration/service changes invalidate old actions. Prevent duplicate clicks/keypresses while pending.

## Scope and proof

Implement the three modes, shared service/client state, Desktop/CLI communication, RPC validation, documentation and focused regressions. Rebuild tracked distribution files. Do not publish, install, modify user configuration, commit, push, merge, or run paid prediction experiments without a separate request.

Test exact call counts and targets, ordinary fallback preservation, valid-null health, all-ineligible groups, token/config/session isolation, cancellation and timeout, messages never entering draft/history, normal Tab pass-through, real prediction acceptance, and keyboard/button activation. Repository tests, typecheck, build and package tests must pass. Native host checks depend on available prerequisites; report limitations honestly.

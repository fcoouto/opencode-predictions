import { test } from "node:test"
import assert from "node:assert/strict"
import { statusNotice, formatStatus } from "../src/feedback.ts"
import type { Status } from "../src/service.ts"

const ready: Status = { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "instance", warnings: [] }

test("configuration blockers explain the cause and recovery without debug", () => {
  for (const [reason, title, recovery] of [
    ["models must be selector text or a nonempty array of selector groups", "Prediction settings are invalid", /models.*Correct.*configuration/s],
    ["models_required", "Predictions need a model", /Set.*models.*provider\/model/s],
    ["model_unavailable", "No prediction models match", /provider.*pattern.*variant/s],
  ] as const) {
    const notice = statusNotice({ ...ready, enabled: reason === "model_unavailable", reason })
    assert.equal(notice?.title, title)
    assert.equal(notice?.severity, "error")
    assert.equal(notice?.persistent, true)
    assert.match(notice!.message, recovery)
  }
  assert.equal(statusNotice({ ...ready, enabled: false, reason: "disabled" }), undefined)
})

test("queue exhaustion includes safe causes and future eligibility, never an automatic retry promise", () => {
  const blocked = statusNotice({ ...ready, reason: "no_models_eligible", candidates: [{ providerID: "local", id: "a", name: "A", state: "blocked", reason: "HTTP 401: Provider authentication failed." }] })!
  assert.match(blocked.message, /authentication.*Check.*provider connection/s)
  assert.equal(blocked.persistent, true)
  const cooling = statusNotice({ ...ready, reason: "no_models_eligible", candidates: [{ providerID: "local", id: "a", name: "A", state: "cooling", reason: "HTTP 429: Free usage limit reached.", retryAt: 60000 }] })!
  assert.match(cooling.message, /Free usage limit reached/)
  assert.match(cooling.message, /1970-01-01T00:01:00.000Z/)
  assert.match(cooling.message, /new prediction request/i)
  assert.doesNotMatch(cooling.message, /retry automatically|automatically retry/i)
})

test("warnings are actionable and legacy compatibility is unknown rather than diagnosed as outdated", () => {
  const notice = statusNotice({ ...ready, warnings: ["Unknown option ignored: typo"] })!
  assert.equal(notice.severity, "warning")
  assert.match(notice.message, /typo.*Remove or correct/s)
  const view = formatStatus(ready, {})
  assert.match(view.summary, /snapshot/i)
  assert.match(view.summary, /Ready/)
  assert.match(view.details, /unknown.*legacy/i)
  assert.doesNotMatch(view.summary + view.details, /outdated/i)
  assert.doesNotMatch(view.summary, /^\s*\{/)
})

test("status keeps last failure, ordered model groups, retry times and preview readable", () => {
  const view = formatStatus({ ...ready, pluginVersion: "0.1.0", feedbackRevision: 1, groups: [{ selectors: "local/a", candidates: [{ providerID: "local", id: "a", name: "A", state: "cooling", reason: "Timed out after 8000 ms.", retryAt: 60000 }] }], lastOutcome: "no_suggestion" }, {
    lastNotice: { code: "service_unavailable", severity: "error", title: "Prediction service unavailable", message: "Check the service connection." }, suggestion: "Run tests.", diagnostics: { host: "CLI", clientVersion: "0.1.0", feedbackRevision: 1 },
  })
  assert.match(view.summary, /Last failure: Prediction service unavailable/)
  assert.match(view.summary, /Group 1: local\/a/)
  assert.match(view.summary, /1970-01-01T00:01:00.000Z/)
  assert.match(view.summary, /Run tests\./)
  assert.match(view.details, /0.1.0/)
  assert.match(view.details, /no_suggestion/)
})

test("status does not repeat an identical current failure's full recovery paragraph", () => {
  const status = { ...ready, enabled: false, reason: "models_required" }
  const view = formatStatus(status, { lastNotice: statusNotice(status) })
  assert.equal(view.summary.split("Set models").length - 1, 1)
  assert.match(view.summary, /Last failure:/)
})

test("disabled predictions still warn about unknown options without hiding the disabled state", () => {
  const status = { ...ready, enabled: false, reason: "disabled", warnings: ["Unknown option ignored: typo"] }
  const notice = statusNotice(status)
  assert.equal(notice?.severity, "warning")
  assert.match(notice!.message, /typo/)
  const view = formatStatus(status, { currentNotice: notice })
  assert.match(view.summary, /State: Predictions are turned off/)
  assert.match(view.summary, /Unknown option ignored: typo/)
})

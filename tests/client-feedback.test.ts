import { test } from "node:test"
import assert from "node:assert/strict"
import { startClient, type ClientHost, type ClientState } from "../src/client.ts"
import type { Notice, StatusView } from "../src/feedback.ts"
import type { Status } from "../src/service.ts"

const settle = () => new Promise(resolve => setImmediate(resolve))
const ready = (): Status => ({ enabled: true, automatic: false, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [], feedbackRevision: 1 })
function fixture(overrides: Partial<ClientHost> = {}) {
  let scope: string | undefined = "server/project"
  let state: ClientState | undefined = { key: "session/2", sessionID: "session", completion: 2, eligible: true, draft: "" }
  let status = ready()
  const notices: Notice[] = []
  const views: StatusView[] = []
  let calls = 0
  let clears = 0
  const client = startClient({ scope: () => scope, state: () => state, status: async () => status, predict: async () => { calls++; return { reason: "no_suggestion" } }, paint: () => false, insert: () => false, focus() {}, show: notice => notices.push(notice), clearNotice: () => { clears++ }, openStatus: view => { views.push(view) }, ...overrides })
  return { client, notices, views, get calls() { return calls }, get clears() { return clears }, get state() { return state }, set state(value) { state = value }, get status() { return status }, set status(value) { status = value }, set scope(value: string | undefined) { scope = value } }
}

test("invalid settings and missing models notify before any completed session without generation", async () => {
  for (const reason of ["models_required", "models must be selector text or a nonempty array of selector groups", "model_unavailable"]) {
    const f = fixture({ state: () => undefined, status: async () => ({ ...ready(), enabled: false, reason }) })
    try {
      await settle()
      assert.equal(f.notices.length, 1)
      assert.equal(f.notices[0].severity, "error")
      assert.match(f.notices[0].message, /configuration|provider|variant/)
      assert.equal(f.calls, 0)
      await f.client.status()
      assert.match(f.views[0].summary, /State:/)
      assert.doesNotMatch(f.views[0].summary, /^\s*\{/)
    } finally { f.client.dispose() }
  }
})

test("status failures notify safely once and manual requests explain unavailable service", async () => {
  const f = fixture({ status: async () => { throw new Error("PRIVATE token=SECRET") } })
  try {
    await settle()
    assert.equal(f.notices.length, 1)
    f.client.invalidate(); await settle()
    assert.equal(f.notices.length, 1)
    f.client.request(); await settle()
    assert.equal(f.notices.length, 2)
    assert.equal(f.notices[1].code, "service_unavailable")
    assert.doesNotMatch(JSON.stringify(f.notices), /PRIVATE|SECRET/)
    assert.equal(f.calls, 0)
  } finally { f.client.dispose() }
})

test("unchanged issues deduplicate across polls, completion keys, service instance IDs and revisiting a location", async () => {
  const f = fixture({ status: async () => ({ ...ready(), enabled: false, reason: "models_required", version: crypto.randomUUID() }) })
  try {
    await settle()
    f.client.invalidate(); await settle()
    f.state = { ...f.state!, key: "second/3", sessionID: "second", completion: 3 }
    f.client.invalidate(); await settle()
    assert.equal(f.notices.length, 1)
    f.scope = "other/project"; f.client.invalidate(); await settle()
    assert.equal(f.notices.length, 2)
    f.scope = "server/project"; f.client.invalidate(); await settle()
    assert.equal(f.notices.length, 2)
    f.client.request(); await settle()
    assert.equal(f.notices.length, 3)
  } finally { f.client.dispose() }
})

test("changed issue and recovery followed by recurrence notify again and dismiss obsolete errors", async () => {
  const f = fixture()
  try {
    await settle()
    f.status = { ...ready(), enabled: false, reason: "models_required" }; f.client.invalidate(); await settle()
    f.status = { ...ready(), reason: "model_unavailable" }; f.client.invalidate(); await settle()
    assert.equal(f.notices.length, 2)
    f.status = ready(); f.client.invalidate(); await settle()
    f.status = { ...ready(), reason: "model_unavailable" }; f.client.invalidate(); await settle()
    assert.equal(f.notices.length, 3)
    assert.ok(f.clears >= 2)
  } finally { f.client.dispose() }
})

test("ready model queues rearm failure notices despite warnings or a missed unhealthy poll", async () => {
  const notice: Notice = { code: "models_unavailable", severity: "error", title: "Prediction models are blocked", message: "Check your provider connection.", persistent: true }
  const available: Status = { ...ready(), automatic: true, candidates: [{ providerID: "local", id: "a", name: "A", state: "ready" }] }
  for (const pollFailure of [false, true]) for (const warning of [false, true]) {
    let status = available
    let calls = 0
    const f = fixture({ status: async () => status, predict: async () => { calls++; return { reason: "generation_failed", notice } } })
    try {
      await settle()
      if (pollFailure) {
        status = { ...available, reason: "no_models_eligible", candidates: [{ providerID: "local", id: "a", name: "A", state: "blocked", reason: "HTTP 401: Provider authentication failed." }] }
        await f.client.status()
      }
      const failuresBeforeRecovery = f.notices.filter(value => value.code === "models_unavailable").length
      status = { ...available, warnings: warning ? ["Unknown option ignored: typo"] : [] }
      await f.client.status()
      assert.doesNotMatch(f.views.at(-1)!.summary, /State: Prediction models are blocked/)
      assert.match(f.views.at(-1)!.summary, /Last failure:/)
      f.state = { ...f.state!, key: "session/3", completion: 3 }
      f.client.accept(); await settle()
      assert.equal(calls, 2)
      assert.equal(f.notices.filter(value => value.code === "models_unavailable").length, failuresBeforeRecovery + 1)
    } finally { f.client.dispose() }
  }
})

test("manual requests explain disabled, occupied, missing context and no-suggestion states", async () => {
  const f = fixture()
  try {
    await settle()
    f.client.request(); await settle()
    assert.equal(f.notices.at(-1)?.code, "no_suggestion")
    f.state = { ...f.state!, draft: "my prompt" }; f.client.request(); await settle()
    assert.equal(f.notices.at(-1)?.code, "composer_unavailable")
    f.state = undefined; f.client.request(); await settle()
    assert.equal(f.notices.at(-1)?.code, "context_unavailable")
    f.status = { ...ready(), enabled: false, reason: "disabled" }; f.client.invalidate(); await settle()
    f.client.request(); await settle()
    assert.equal(f.notices.at(-1)?.code, "disabled")
    assert.equal(f.calls, 1)
  } finally { f.client.dispose() }
})

test("automatic no-suggestion responses stay silent", async () => {
  const f = fixture({ status: async () => ({ ...ready(), automatic: true }) })
  try { await settle(); assert.equal(f.calls, 1); assert.equal(f.notices.length, 0) } finally { f.client.dispose() }
})

test("a pending initial status lookup produces exactly one final manual outcome", async () => {
  let finish!: (value: Status) => void
  const f = fixture({ status: () => new Promise(resolve => { finish = resolve }) })
  try {
    f.client.request()
    assert.equal(f.calls, 0)
    finish({ ...ready(), enabled: false, reason: "models_required" })
    await settle()
    assert.equal(f.notices.length, 1)
    assert.equal(f.calls, 0)
  } finally { f.client.dispose() }
})

test("a manual request awaiting refresh never starts an automatic duplicate from the old cache", async () => {
  const automatic = { ...ready(), automatic: true }
  let refreshing = false
  let finish!: (value: Status) => void
  const f = fixture({ status: () => refreshing ? new Promise(resolve => { finish = resolve }) : Promise.resolve(automatic) })
  try {
    await settle()
    assert.equal(f.calls, 1)
    refreshing = true
    const inspection = f.client.status()
    f.state = { ...f.state!, key: "session/3", completion: 3 }
    f.client.request()
    await settle()
    assert.equal(f.calls, 1, "manual intent owns the completion while health is pending")
    finish(automatic)
    await inspection; await settle()
    assert.equal(f.calls, 2, "the new completion incurs exactly one model request")
  } finally { f.client.dispose() }
})

test("failed replies stay visible after a healthy poll without being announced repeatedly", async () => {
  const f = fixture({ predict: async () => ({ reason: "generation_failed" }) })
  try {
    await settle()
    f.client.request(); await settle()
    f.client.invalidate(); await settle()
    await f.client.status()
    assert.equal(f.notices.length, 1)
    assert.match(f.views[0].summary, /Last failure: Prediction service unavailable/)
    await f.client.status()
    assert.equal(f.views.length, 2)
    assert.equal(f.notices.length, 1)
  } finally { f.client.dispose() }
})

test("structured final progress and reply produce one actionable notice", async () => {
  const notice: Notice = { code: "failure", severity: "error", title: "Prediction failed", message: "Check the service connection." }
  const f = fixture({ predict: async (_state, _id, _signal, progress) => { progress("Legacy final text", notice); return { reason: "generation_failed", notice } } })
  try { await settle(); f.client.request(); await settle(); assert.deepEqual(f.notices, [notice]) } finally { f.client.dispose() }
})

test("health inspection and an in-flight manual failure produce one final error", async () => {
  const blocked: Status = { ...ready(), reason: "no_models_eligible", candidates: [{ providerID: "local", id: "a", name: "A", state: "blocked", reason: "HTTP 401: Provider authentication failed." }] }
  const notice: Notice = { code: "models_unavailable", severity: "error", title: "Prediction models are blocked", message: "HTTP 401: Provider authentication failed. Check your provider connection, model access, and configuration. Blocked models remain blocked until the server plugin reloads.", persistent: true }
  let lookups = 0
  let finishStatus!: (value: Status) => void
  let finishPrediction!: (reply: { reason: string; notice: Notice }) => void
  const f = fixture({ status: () => ++lookups === 1 ? new Promise(resolve => { finishStatus = resolve }) : Promise.resolve(blocked), predict: () => new Promise(resolve => { finishPrediction = resolve }) })
  try {
    f.client.request()
    finishStatus(ready()); await settle()
    await f.client.status()
    finishPrediction({ reason: "generation_failed", notice }); await settle()
    assert.deepEqual(f.notices, [notice])
  } finally { f.client.dispose() }
})

test("an aborted request in another location cannot block or clear newer manual work", async () => {
  const attempts: string[] = []
  const finishes: ((reply: { reason: string }) => void)[] = []
  const f = fixture({ predict: async state => { attempts.push(state.sessionID); return new Promise(resolve => finishes.push(resolve)) } })
  try {
    await settle(); f.client.request()
    f.scope = "server/other"; f.state = { ...f.state!, sessionID: "second", key: "second/3", completion: 3 }
    f.client.invalidate(); await settle()
    f.client.request(); await settle()
    assert.deepEqual(attempts, ["session", "second"])
    finishes[0]({ reason: "no_suggestion" }); await settle()
    f.client.request(); await settle()
    assert.equal(f.notices.at(-1)?.code, "prediction_pending", "old finally must not release the newer request's busy state")
    finishes[1]({ reason: "no_suggestion" }); await settle()
  } finally { f.client.dispose() }
})

test("debug fallback progress does not suppress the actionable final failure", async () => {
  const notice: Notice = { code: "failure", severity: "error", title: "Prediction failed", message: "Check the service connection." }
  const f = fixture({ predict: async (_state, _id, _signal, progress) => { progress("Trying another configured model"); progress("Legacy final", notice); return { reason: "generation_failed", notice } } })
  try { await settle(); f.client.request(); await settle(); assert.equal(f.notices.length, 2); assert.deepEqual(f.notices[1], notice) } finally { f.client.dispose() }
})

test("legacy final messages become one deduplicated actionable failure across completions", async () => {
  const f = fixture({ status: async () => ({ ...ready(), feedbackRevision: undefined, automatic: true }), predict: async (_state, _id, _signal, progress) => { progress("No model worked at this time. Activate `debug` mode for details."); return { reason: "generation_failed" } } })
  try {
    await settle()
    f.state = { ...f.state!, key: "session/3", completion: 3 }
    f.client.accept(); await settle()
    assert.equal(f.notices.length, 1)
    assert.equal(f.notices[0].code, "service_unavailable")
    assert.equal(f.notices[0].severity, "error")
    assert.match(f.notices[0].message, /Check.*service connection/s)
  } finally { f.client.dispose() }
})

test("legacy debug preserves fallback details but not a duplicate unstructured final error", async () => {
  const f = fixture({ status: async () => ({ ...ready(), feedbackRevision: undefined, debug: true }), predict: async (_state, _id, _signal, progress) => { progress("First model failed; trying the next configured model."); progress("No model worked at this time."); return { reason: "generation_failed" } } })
  try {
    await settle(); f.client.request(); await settle()
    assert.equal(f.notices.length, 2)
    assert.equal(f.notices[0].code, "progress")
    assert.equal(f.notices[1].severity, "error")
  } finally { f.client.dispose() }
})

test("synchronous status exceptions settle safely instead of restarting inspection recursively", async () => {
  let calls = 0
  const f = fixture({ status: () => { if (++calls === 1) throw new Error("PRIVATE"); return Promise.resolve(ready()) } })
  try {
    await settle(); assert.equal(f.notices.length, 1); assert.equal(f.notices[0].code, "service_unavailable")
    await f.client.status()
    assert.match(f.views[0].summary, /State: Ready/)
  } finally { f.client.dispose() }
})

test("obsolete location and disposed status responses never notify or open a stale view", async () => {
  for (const dispose of [false, true]) {
    let finish!: (value: Status) => void
    const f = fixture({ status: () => new Promise(resolve => { finish = resolve }) })
    try {
      const opening = f.client.status()
      if (dispose) f.client.dispose()
      else f.scope = "another/project"
      finish({ ...ready(), enabled: false, reason: "models_required" })
      await opening; await settle()
      assert.equal(f.notices.length, 0)
      assert.equal(f.views.length, 0)
    } finally { f.client.dispose() }
  }
})

test("late failed predictions cannot notify another session before the next poll", async () => {
  let finish!: (value: { reason: string }) => void
  const f = fixture({ predict: () => new Promise(resolve => { finish = resolve }) })
  try {
    await settle(); f.client.request()
    f.state = { ...f.state!, key: "second/3", sessionID: "second", completion: 3 }
    finish({ reason: "generation_failed" }); await settle()
    assert.equal(f.notices.length, 0)
  } finally { f.client.dispose() }
})

test("unknown options warn once without disabling predictions", async () => {
  const f = fixture({ status: async () => ({ ...ready(), warnings: ["Unknown option ignored: typo"] }) })
  try { await settle(); f.client.invalidate(); await settle(); assert.equal(f.notices.length, 1); assert.equal(f.notices[0].severity, "warning"); f.client.request(); await settle(); assert.equal(f.calls, 1) } finally { f.client.dispose() }
})

test("disabled configurations emit one warning for ignored options and never generate", async () => {
  const f = fixture({ status: async () => ({ ...ready(), enabled: false, reason: "disabled", warnings: ["Unknown option ignored: typo"] }) })
  try {
    await settle(); f.client.invalidate(); await settle()
    assert.equal(f.notices.length, 1)
    assert.equal(f.notices[0].severity, "warning")
    f.client.request(); await settle()
    assert.equal(f.notices.at(-1)?.code, "disabled")
    assert.equal(f.calls, 0)
  } finally { f.client.dispose() }
})

test("accepted cached predictions stay isolated when locations share session and service version keys", async () => {
  let location = "server/first"
  let calls = 0
  let ghost: string | undefined
  const f = fixture({ scope: () => location, status: async () => ({ ...ready(), automatic: true }), predict: async () => { calls++; return { text: location === "server/first" ? "First location suggestion" : "Second location suggestion" } }, paint: text => { ghost = text; return !!text }, insert: () => true })
  try {
    await settle()
    assert.equal(ghost, "First location suggestion")
    assert.equal(f.client.accept(), true)
    location = "server/second"; f.client.invalidate(); await settle()
    assert.equal(ghost, "Second location suggestion")
    location = "server/first"; f.client.invalidate(); await settle()
    assert.equal(ghost, "First location suggestion")
    assert.equal(calls, 2)
  } finally { f.client.dispose() }
})

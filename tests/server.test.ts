import { test } from "node:test"
import assert from "node:assert/strict"
import { createService, type ServiceAPI } from "../src/service.ts"

function fixture() {
  const calls: { model: unknown; prompt: string }[] = []
  let completion = 2
  const api: ServiceAPI = {
    session: async () => ({ id: "ses_test", time: { idle: completion, busy: 1 }, location: { directory: "/project" } }),
    context: async () => [
      { type: "user", text: "Fix the test", files: [{ content: "PRIVATE" }] },
      { type: "system", text: "PRIVATE" },
      { type: "assistant", time: { completed: 2 }, content: [{ type: "reasoning", text: "PRIVATE" }, { type: "text", text: "Fixed the assertion." }] },
      { type: "idle", outcome: "succeeded" },
    ],
    models: async () => [{ providerID: "local", id: "model", enabled: true, variants: [{ id: "high" }] }],
    generate: async (model, prompt) => { calls.push({ model, prompt }); return '{"prompt":"Run the tests."}' },
  }
  return { api, calls, advance: () => { completion++ } }
}

test("server uses the exact selected model and filtered context without writing history", async () => {
  const { api, calls } = fixture()
  const service = createService(api, { models: "local/model" }, "/project")
  assert.deepEqual(await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal), { text: "Run the tests." })
  assert.deepEqual(calls[0].model, { providerID: "local", id: "model" })
  assert.equal(calls[0].prompt.includes("PRIVATE"), false)
  assert.equal(service.status().lastOutcome, "suggestion")
})

test("explicit supported reasoning is preserved; unknown model or variant never falls back", async () => {
  for (const model of ["other/model", "local/model#missing"]) {
    const { api, calls } = fixture()
    const reply = await createService(api, { models: model }, "/project").predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
    assert.equal(reply.reason, "model_unavailable")
    assert.equal(calls.length, 0)
  }
  const { api, calls } = fixture()
  await createService(api, { models: "local/model#high" }, "/project").predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  assert.deepEqual(calls[0].model, { providerID: "local", id: "model", variant: "high" })
})

test("missing model, wrong project, and outdated completion prevent paid generation", async () => {
  for (const [raw, directory, completion, reason] of [[{}, "/project", 2, "models_required"], [{ models: "local/model" }, "/wrong", 2, "wrong_location"], [{ models: "local/model" }, "/project", 1, "stale"]] as const) {
    const { api, calls } = fixture()
    assert.equal((await createService(api, raw, directory).predict({ sessionID: "ses_test", completion }, new AbortController().signal)).reason, reason)
    assert.equal(calls.length, 0)
  }
})

test("completion changed while generating invalidates the result", async () => {
  const { api, advance } = fixture()
  api.generate = async () => { advance(); return '{"prompt":"stale text"}' }
  assert.equal((await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)).reason, "stale")
})

test("trailing model-selection metadata does not discard an identifiable completed response", async () => {
  const { api } = fixture()
  const context = api.context
  api.context = async (id, signal) => [...await context(id, signal), { type: "model-switched", model: { providerID: "other", id: "main-agent-model" } }]
  assert.deepEqual(await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal), { text: "Run the tests." })
})

test("only explicit manual requests can use yesterday's completed tail without an idle record", async () => {
  const yesterday = Date.now() - 86400000
  for (const manual of [undefined, false, true]) {
    const { api, calls } = fixture()
    api.session = async () => ({ id: "ses_test", time: { idle: yesterday, busy: yesterday - 1 }, location: { directory: "/project" } })
    const history = Object.freeze([
      { type: "user", text: "Fix the test" },
      { type: "assistant", time: { completed: yesterday }, content: [{ type: "reasoning", text: "PRIVATE" }, { type: "text", text: "Fixed the assertion." }] },
      { type: "model-switched", model: { providerID: "local", id: "model" } },
    ])
    api.context = async () => history
    const reply = await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: yesterday, ...(manual === undefined ? {} : { manual }) }, new AbortController().signal)
    assert.deepEqual(reply, manual ? { text: "Run the tests." } : { reason: "context_unavailable" })
    assert.equal(calls.length, manual ? 1 : 0)
    assert.equal(history.length, 3)
    if (manual) assert.equal(calls[0].prompt.includes("PRIVATE"), false)
  }
})

test("manual history without an idle timestamp requires a matching updated revision and no busy execution", async () => {
  for (const entry of [
    { manual: true, updated: 2, directory: "/project", want: "suggestion" },
    { manual: false, updated: 2, directory: "/project", want: "stale" },
    { manual: true, updated: 3, directory: "/project", want: "stale" },
    { manual: true, updated: 2, busy: 1, directory: "/project", want: "stale" },
    { manual: true, updated: 2, directory: "/other", want: "wrong_location" },
  ]) {
    const { api, calls } = fixture()
    const context = api.context
    api.context = async (id, signal) => (await context(id, signal)).slice(0, -1)
    api.session = async () => ({ id: "ses_test", time: { updated: entry.updated, busy: entry.busy }, location: { directory: entry.directory } })
    const reply = await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2, manual: entry.manual }, new AbortController().signal)
    assert.equal(reply.text ? "suggestion" : reply.reason, entry.want)
    assert.equal(calls.length, entry.want === "suggestion" ? 1 : 0)
  }
})

test("manual history never falls back past an unusable or unfinished latest turn", async () => {
  const tails = [
    [{ type: "user", text: "Unanswered current prompt" }],
    [{ type: "user", text: "New task" }, { type: "assistant", time: {}, content: [{ type: "text", text: "Still streaming" }] }],
    [{ type: "user", text: "New task" }, { type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: " " }] }],
    [{ type: "user", text: "New task" }, { type: "assistant", time: { completed: 2 }, content: [{ type: "tool", output: "PRIVATE" }] }],
    [{ type: "user", text: "New task" }, { type: "assistant", time: { completed: 2 }, content: [{ type: "reasoning", text: "PRIVATE" }] }],
    [{ type: "compaction", status: "completed", summary: "PRIVATE" }],
    [{ type: "user", text: "New task" }, { type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: "Partial response" }] }, { type: "idle", outcome: "interrupted" }],
  ]
  for (const tail of tails) {
    const { api, calls } = fixture()
    const context = api.context
    api.context = async (id, signal) => [...await context(id, signal), ...tail]
    const reply = await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2, manual: true }, new AbortController().signal)
    assert.equal(reply.reason, "context_unavailable")
    assert.equal(calls.length, 0)
  }
})

test("manual history ignores failed compaction without mutating or including its private summary", async () => {
  const { api, calls } = fixture()
  const context = api.context
  api.context = async (id, signal) => [...(await context(id, signal)).slice(0, -1), { type: "compaction", status: "failed", summary: "PRIVATE" }]
  assert.deepEqual(await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2, manual: true }, new AbortController().signal), { text: "Run the tests." })
  assert.equal(calls[0].prompt.includes("PRIVATE"), false)
})

test("manual fallback retains busy, interrupted, parent-session, and changed-revision guards", async () => {
  for (const shape of [{ busy: 3 }, { outcome: "interrupted" }, { parentID: "ses_parent" }]) {
    const { api, calls } = fixture()
    api.session = async () => ({ id: "ses_test", time: { idle: 2, busy: shape.busy }, outcome: shape.outcome, parentID: shape.parentID, location: { directory: "/project" } })
    const reply = await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2, manual: true }, new AbortController().signal)
    assert.equal(reply.reason, shape.busy ? "stale" : "context_unavailable")
    assert.equal(calls.length, 0)
  }
  const { api } = fixture()
  let updated = 2
  const context = api.context
  api.context = async (id, signal) => (await context(id, signal)).slice(0, -1)
  api.session = async () => ({ id: "ses_test", time: { updated }, location: { directory: "/project" } })
  let generations = 0
  api.generate = async () => { generations++; updated++; return '{"prompt":"Stale prediction"}' }
  assert.equal((await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2, manual: true }, new AbortController().signal)).reason, "stale")
  assert.equal(generations, 1)
})

test("an idle turn without a completed current assistant response cannot reuse older conclusions", async () => {
  const { api, calls } = fixture()
  const context = api.context
  api.context = async (id, signal) => [...await context(id, signal), { type: "user", text: "New task" }, { type: "assistant", content: [{ type: "text", text: "streaming" }], time: {} }, { type: "idle", outcome: "failed" }]
  assert.equal((await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)).reason, "context_unavailable")
  assert.equal(calls.length, 0)
})

test("a completed current response without usable conversation text cannot fall back to older turns", async () => {
  for (const content of [[{ type: "reasoning", text: "PRIVATE reasoning" }], [{ type: "tool", output: "PRIVATE output" }], [{ type: "text", text: "   " }]]) {
    const { api, calls } = fixture()
    const context = api.context
    api.context = async (id, signal) => [...await context(id, signal), { type: "user", text: "A different current task" }, { type: "assistant", time: { completed: 2 }, content }, { type: "idle", outcome: "succeeded" }]
    assert.equal((await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)).reason, "context_unavailable")
    assert.equal(calls.length, 0)
  }
})

test("timeout returns even when provider ignores abort, and errors do not retry", async () => {
  const { api } = fixture()
  let attempts = 0
  const notices: string[] = []
  api.notice = message => { notices.push(message) }
  api.generate = async () => { attempts++; return await new Promise<string>(() => {}) }
  const service = createService(api, { models: "local/model", timeoutMs: 10 }, "/project")
  const keepAlive = setTimeout(() => {}, 1000)
  try { assert.equal((await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)).reason, "timeout") } finally { clearTimeout(keepAlive) }
  assert.equal(attempts, 1)
  assert.equal(notices[0], "Model [model] failed with message: Timed out after 10 ms.")
  api.generate = async () => { attempts++; throw new Error("provider secret") }
  assert.equal((await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)).reason, "no_models_eligible")
  assert.equal(attempts, 1)
})

test("unknown options appear in diagnostics without disabling prediction", () => {
  const { api } = fixture()
  const status = createService(api, { models: "local/model", obsolete: true }, "/project").status()
  assert.equal(status.enabled, true)
  assert.deepEqual(status.warnings, ["Unknown option ignored: obsolete"])
})

test("unexpected service failures return actionable safe notices instead of only a reason", async () => {
  for (const boundary of ["session", "context", "models"] as const) {
    const { api } = fixture()
    api[boundary] = async () => { throw new Error("PRIVATE api_key=SECRET") }
    const reply = await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
    assert.equal(reply.reason, "generation_failed")
    assert.equal(reply.notice?.severity, "error")
    assert.match(reply.notice!.message, /Check.*service connection/s)
    assert.doesNotMatch(JSON.stringify(reply), /PRIVATE|SECRET/)
  }
})

test("final structured notices preserve safe failure detail and compatibility metadata", async () => {
  const { api } = fixture()
  api.generate = async () => { throw Object.assign(new Error("PRIVATE"), { status: 401, reason: "authentication" }) }
  let final: unknown
  api.notice = (_message, _request, notice) => { final = notice }
  const service = createService(api, { models: "local/model" }, "/project")
  const reply = await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  assert.match(reply.notice!.message, /authentication.*Check.*provider connection/s)
  assert.deepEqual(final, reply.notice)
  assert.equal(service.status().pluginVersion, "0.1.0")
  assert.equal(service.status().feedbackRevision, 1)
})

test("failed model calls advance only through configured matches and announce both display names", async () => {
  const { api } = fixture()
  const notices: string[] = []
  const attempted: string[] = []
  api.models = async () => ["a", "b", "unselected"].map(id => ({ providerID: "local", id, name: id === "a" ? "First Free" : "Next Flash", enabled: true, variants: [] }))
  api.generate = async model => { attempted.push(model.id); if (model.id === "a") throw Object.assign(new Error("Free usage limit reached."), { _tag: "ProviderRequestError", status: 429, reason: "rate_limit" }); return '{"prompt":"Run the tests."}' }
  api.notice = message => { notices.push(message) }
  const service = createService(api, { models: "local/a, local/b", debug: true }, "/project")
  assert.deepEqual(await service.predict({ sessionID: "ses_test", completion: 2, requestID: "request-one" }, new AbortController().signal), { text: "Run the tests." })
  assert.deepEqual(attempted, ["a", "b"])
  assert.deepEqual(notices, ["Predictions failed with [First Free], moving on with [Next Flash]...\nReason: HTTP 429: Free usage limit reached.\nQueue: Paused for 60 minutes."])
})

test("failure popups explain provider restrictions and invalid output without exposing private error contents", async () => {
  for (const [error, expected] of [
    [Object.assign(new Error("This model is not available in your country. PRIVATE"), { _tag: "ProviderRequestError", status: 403, reason: "provider" }), "HTTP 403: This model is not available in your country."],
    [Object.assign(new Error("PRIVATE api_key=SECRET"), { _tag: "ProviderRequestError", status: 401, reason: "authentication" }), "HTTP 401: Provider authentication failed."],
    [Object.assign(new Error("PRIVATE request body"), { _tag: "ProviderRequestError", status: 429, reason: "rate_limit" }), "HTTP 429: Provider rate limit or usage quota reached."],
    [new Error("PRIVATE exception"), "Model request failed."],
    [undefined, "Model returned an invalid prediction response."],
  ] as const) {
    const { api } = fixture()
    const notices: string[] = []
    api.generate = async () => { if (error) throw error; return "PRIVATE invalid output" }
    api.notice = message => { notices.push(message) }
    const result = await createService(api, { models: "local/model" }, "/project").predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
    assert.equal(result.reason, "generation_failed")
    assert.deepEqual(notices, [`Model [model] failed with message: ${expected}`])
  }
})

test("quiet mode hides fallback failures when another configured candidate works or abstains", async () => {
  for (const output of ['{"prompt":"Run tests."}', '{"prompt":null}']) {
    const { api } = fixture()
    const notices: string[] = []
    api.models = async () => ["a", "b"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
    api.generate = async model => { if (model.id === "a") throw new Error("PRIVATE"); return output }
    api.notice = message => { notices.push(message) }
    const service = createService(api, { models: "local/*" }, "/project")
    await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
    assert.deepEqual(notices, [])
    assert.equal(service.status().debug, false)
  }
})

test("quiet exhaustion reports once per request including an already skipped queue", async () => {
  for (const models of ["local/*", "local/a, local/b", "local/missing, local/a"]) {
    const { api } = fixture()
    const notices: string[] = []
    let calls = 0
    api.models = async () => ["a", "b"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
    api.generate = async () => { calls++; throw Object.assign(new Error("PRIVATE"), { status: 403 }) }
    api.notice = message => { notices.push(message) }
    const service = createService(api, { models }, "/project")
    for (let i = 0; i < 2; i++) {
      await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
      assert.equal(notices.length, i + 1)
      assert.equal(notices[i], "No model worked at this time. Activate `debug` mode for details.")
    }
    assert.equal(calls, models.includes("missing") ? 1 : 2)
    await service.inspect(new AbortController().signal)
    assert.equal(notices.length, 2)
  }
})

test("single skipped model retains its safe failure reason without debug", async () => {
  const { api } = fixture()
  const notices: string[] = []
  api.generate = async () => { throw Object.assign(new Error("PRIVATE"), { status: 401, reason: "authentication" }) }
  api.notice = message => { notices.push(message) }
  const service = createService(api, { models: "local/model" }, "/project")
  for (let i = 0; i < 2; i++) await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  assert.deepEqual(notices, Array(2).fill("Model [model] failed with message: HTTP 401: Provider authentication failed."))
})

test("unmatched configured models produce one unavailable summary without generation", async () => {
  for (const [models, message] of [
    ["local/missing", "Model [local/missing] failed with message: No configured model is available."],
    ["local/missing, local/other", "No model worked at this time. Activate `debug` mode for details."],
  ]) {
    const { api, calls } = fixture()
    const notices: string[] = []
    api.notice = message => { notices.push(message) }
    await createService(api, { models }, "/project").predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
    assert.deepEqual(notices, [message])
    assert.equal(calls.length, 0)
  }
})

test("debug exhaustion keeps safe details and adds a final summary without activation hint", async () => {
  const { api } = fixture()
  const notices: string[] = []
  api.models = async () => ["a", "b"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async () => { throw Object.assign(new Error("PRIVATE"), { status: 503, reason: "overloaded" }) }
  api.notice = message => { notices.push(message) }
  const service = createService(api, { models: "local/*", debug: true }, "/project")
  await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  assert.equal(service.status().debug, true)
  assert.equal(notices.length, 3)
  assert.match(notices[0], /moving on with \[b\]/)
  assert.match(notices[1], /Queue: Paused for 1 minute/)
  assert.equal(notices[2], "No model worked at this time.")
  assert.equal(notices.join().includes("PRIVATE"), false)
})

test("cancelled and stale failures stay silent even with debug", async () => {
  for (const debug of [false, true]) for (const cancel of [false, true]) {
    const { api, advance } = fixture()
    const controller = new AbortController()
    const notices: string[] = []
    api.generate = async () => { if (cancel) controller.abort(); else advance(); throw new Error("PRIVATE") }
    api.notice = message => { notices.push(message) }
    const reply = await createService(api, { models: "local/model", debug }, "/project").predict({ sessionID: "ses_test", completion: 2 }, controller.signal)
    assert.equal(reply.reason, cancel ? "cancelled" : "stale")
    assert.deepEqual(notices, [])
  }
})

test("cancellation settles while final session validation or notification ignores abort", async () => {
  for (const stalled of ["session", "notice"]) {
    const { api } = fixture()
    api.models = async () => []
    const session = api.session
    let checks = 0
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    api.session = async (id, signal) => {
      if (++checks === 2 && stalled === "session") { entered(); return new Promise(() => {}) }
      return session(id, signal)
    }
    api.notice = async () => { entered(); await new Promise(() => {}) }
    const controller = new AbortController()
    const pending = createService(api, { models: "local/missing" }, "/project").predict({ sessionID: "ses_test", completion: 2 }, controller.signal)
    await ready
    controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const reply = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve("stalled"), 100) })])
      assert.deepEqual(reply, { reason: "cancelled" })
    } finally { clearTimeout(timer) }
  }
})

test("cancellation stops the fallback chain rather than spending on the next model", async () => {
  const { api } = fixture()
  const controller = new AbortController()
  const attempted: string[] = []
  api.models = async () => ["a", "b"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async model => { attempted.push(model.id); controller.abort(); throw new Error("cancelled") }
  assert.equal((await createService(api, { models: "local/*" }, "/project").predict({ sessionID: "ses_test", completion: 2 }, controller.signal)).reason, "cancelled")
  assert.deepEqual(attempted, ["a"])
})

test("invalid prediction output fails over, but a valid no-suggestion response stops the chain", async () => {
  for (const [first, expectedCalls, expectedReply] of [["malformed response", 2, { text: "Run the tests." }], ['{"prompt":null}', 1, { reason: "no_suggestion" }]] as const) {
    const { api } = fixture()
    const attempted: string[] = []
    api.models = async () => ["a", "b"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
    api.generate = async model => { attempted.push(model.id); return model.id === "a" ? first : '{"prompt":"Run the tests."}' }
    const reply = await createService(api, { models: "local/*" }, "/project").predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
    assert.deepEqual(reply, expectedReply)
    assert.equal(attempted.length, expectedCalls)
  }
})

test("working responses lead the learned queue while failures move behind untried candidates", async t => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const { api } = fixture()
  const attempted: string[] = []
  api.models = async () => ["a", "b", "c"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async model => { attempted.push(model.id); if (model.id === "a") throw Object.assign(new Error("Unavailable"), { status: 503 }); return '{"prompt":null}' }
  const service = createService(api, { models: "local/*" }, "/project")
  const request = { sessionID: "ses_test", completion: 2 }
  assert.deepEqual(await service.predict(request, new AbortController().signal), { reason: "no_suggestion" })
  assert.deepEqual(attempted, ["a", "b"])
  assert.deepEqual(service.status().candidates?.map(model => model.id), ["b", "c", "a"])
  now = 61000
  assert.equal(service.status().candidates?.at(-1)?.state, "ready")
  assert.deepEqual(attempted, ["a", "b"], "cooldown expiry must not make a background call")
  await service.predict(request, new AbortController().signal)
  assert.deepEqual(attempted, ["a", "b", "b"])
  api.generate = async model => { attempted.push(model.id); if (model.id !== "a") throw new Error("Temporary failure"); return '{"prompt":"Run tests."}' }
  await service.predict(request, new AbortController().signal)
  assert.deepEqual(attempted.slice(-3), ["b", "c", "a"])
  assert.deepEqual(service.status().candidates?.map(model => model.id), ["a", "b", "c"])
})

test("access and unavailable models stay blocked across variants until their service instance is recreated", async t => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  for (const error of [
    Object.assign(new Error("PRIVATE"), { status: 401 }),
    Object.assign(new Error("PRIVATE"), { status: 402 }),
    Object.assign(new Error("Access denied"), { status: 403 }),
    Object.assign(new Error("PRIVATE"), { status: 404 }),
    Object.assign(new Error("PRIVATE"), { _tag: "ModelNotFoundError" }),
    Object.assign(new Error("PRIVATE"), { reason: "authentication" }),
  ]) {
    const { api } = fixture()
    let calls = 0
    let contexts = 0
    const context = api.context
    api.context = async (id, signal) => { contexts++; return context(id, signal) }
    api.models = async () => [{ providerID: "local", id: "model", enabled: true, variants: [{ id: "low" }, { id: "high" }] }]
    api.generate = async () => { calls++; throw error }
    const raw = { models: "local/model#low, local/model#high" }
    const service = createService(api, raw, "/project")
    const request = { sessionID: "ses_test", completion: 2 }
    await service.predict(request, new AbortController().signal)
    const before = service.status()
    assert.equal(calls, 1)
    assert.deepEqual(before.candidates?.map(model => model.state), ["blocked", "blocked"])
    assert.equal(JSON.stringify(before).includes("PRIVATE"), false)
    now += 31536000000
    assert.equal((await service.predict(request, new AbortController().signal)).reason, "no_models_eligible")
    assert.equal(calls, 1)
    assert.equal(contexts, 1, "all-skipped predictions must not fetch conversation context")
    assert.equal((await service.inspect(new AbortController().signal)).version, before.version)
    assert.equal(service.status().enabled, true)
    api.generate = async () => { calls++; return '{"prompt":"Run tests."}' }
    assert.equal((await createService(api, raw, "/project").predict(request, new AbortController().signal)).text, "Run tests.")
  }
})

test("explicit budget evidence overrides a generic rate-limit reason and skips all variants for one hour", async t => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const { api } = fixture()
  let calls = 0
  api.models = async () => [{ providerID: "local", id: "model", enabled: true, variants: [{ id: "low" }, { id: "high" }] }]
  api.generate = async () => { calls++; throw Object.assign(new Error("Free usage limit reached. PRIVATE"), { status: 429, reason: "rate_limit" }) }
  const service = createService(api, { models: "local/model#low, local/model#high" }, "/project")
  const request = { sessionID: "ses_test", completion: 2 }
  await service.predict(request, new AbortController().signal)
  assert.equal(calls, 1)
  const before = service.status()
  assert.deepEqual(before.candidates?.map(model => [model.state, model.retryAt]), [["cooling", 3601000], ["cooling", 3601000]])
  now = 3600999
  assert.equal((await service.predict(request, new AbortController().signal)).reason, "no_models_eligible")
  assert.equal(calls, 1)
  now = 3601000
  assert.equal(service.status().version, before.version)
  assert.equal(service.status().enabled, true)
  assert.equal(calls, 1)
  api.generate = async () => { calls++; return '{"prompt":"Run tests."}' }
  await service.predict(request, new AbortController().signal)
  assert.equal(calls, 2)
})

test("temporary and unknown failures cool for sixty seconds instead of becoming permanent budget blocks", async t => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  for (const error of [
    Object.assign(new Error("Quota limit exceeded"), { status: 429, reason: "rate_limit" }),
    Object.assign(new Error("Busy"), { status: 503 }),
    new Error("Network connection failed"),
    undefined,
  ]) {
    now = 1000
    const { api } = fixture()
    let calls = 0
    api.generate = async () => { calls++; if (error) throw error; return "invalid response" }
    const service = createService(api, { models: "local/model" }, "/project")
    const request = { sessionID: "ses_test", completion: 2 }
    await service.predict(request, new AbortController().signal)
    assert.equal(service.status().candidates?.[0].retryAt, 61000)
    now = 60999
    assert.equal((await service.predict(request, new AbortController().signal)).reason, "no_models_eligible")
    assert.equal(calls, 1)
    now = 61000
    api.generate = async () => { calls++; return '{"prompt":null}' }
    assert.equal((await service.predict(request, new AbortController().signal)).reason, "no_suggestion")
    assert.equal(calls, 2)
  }
})

test("budget classification uses explicit exhaustion evidence rather than the words quota or limit alone", async t => {
  t.mock.method(Date, "now", () => 1000)
  for (const [message, retryAt] of [
    ["Daily quota exhausted", 3601000],
    ["You have exhausted your monthly budget", 3601000],
    ["Insufficient credits", 3601000],
    ["Rate limit reached", 61000],
    ["Quota exceeded", 61000],
  ] as const) {
    const { api } = fixture()
    api.generate = async () => { throw Object.assign(new Error(message), { status: 429, reason: "rate_limit" }) }
    const service = createService(api, { models: "local/model" }, "/project")
    await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
    assert.equal(service.status().candidates?.[0].retryAt, retryAt, message)
  }
})

test("provider retry delays replace retryable defaults with a sixty-second floor and no one-hour cap", async t => {
  t.mock.method(Date, "now", () => 1000)
  for (const [message, delay, retryAt] of [
    ["Rate limited", 500, 61000],
    ["Rate limited", 120000, 121000],
    ["Free usage limit reached", 90000, 91000],
    ["Free usage limit reached", 172800000, 172801000],
    ["Rate limited", 0, 61000],
    ["Rate limited", -1, 61000],
    ["Rate limited", Infinity, 61000],
    ["Rate limited", "120000", 61000],
    ["Free usage limit reached", NaN, 3601000],
  ] as const) {
    const { api } = fixture()
    api.generate = async () => { throw Object.assign(new Error(message), { status: 429, reason: "rate_limit", retryAfterMs: delay }) }
    const service = createService(api, { models: "local/model" }, "/project")
    await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
    assert.equal(service.status().candidates?.[0].retryAt, retryAt)
  }
})

test("model-level skips neither spill into other providers nor hide the next eligible fallback", async () => {
  const { api } = fixture()
  const attempted: string[] = []
  const notices: string[] = []
  api.models = async () => ["first", "second"].map(providerID => ({ providerID, id: "model", enabled: true, variants: [{ id: "low" }, { id: "high" }] }))
  api.generate = async model => { attempted.push(model.providerID + "#" + model.variant); if (model.providerID === "first") throw Object.assign(new Error("Too many requests"), { status: 429 }); return '{"prompt":null}' }
  api.notice = message => { notices.push(message) }
  const service = createService(api, { models: "first/model#low, first/model#high, second/model#low", debug: true }, "/project")
  const request = { sessionID: "ses_test", completion: 2 }
  await service.predict(request, new AbortController().signal)
  assert.deepEqual(attempted, ["first#low", "second#low"])
  assert.equal(notices.length, 1)
  await service.predict(request, new AbortController().signal)
  assert.deepEqual(attempted, ["first#low", "second#low", "second#low"])
  assert.equal(notices.length, 1, "already-skipped candidates must not create more failure popups")
})

test("cancellation and stale failures do not change health or queue order", async () => {
  for (const mode of ["cancel", "stale"] as const) {
    const { api, advance } = fixture()
    const controller = new AbortController()
    api.generate = async () => { if (mode === "cancel") controller.abort(); else advance(); throw Object.assign(new Error("Denied"), { status: 403 }) }
    const service = createService(api, { models: "local/model" }, "/project")
    assert.equal((await service.predict({ sessionID: "ses_test", completion: 2 }, controller.signal)).reason, mode === "cancel" ? "cancelled" : "stale")
    assert.equal(service.status().candidates?.[0].state, "ready")
  }
})

test("an older concurrent success cannot erase a newer failure or make its model eligible", async () => {
  const { api } = fixture()
  let finish!: (output: string) => void
  let calls = 0
  api.generate = async () => { if (++calls === 1) return new Promise(resolve => { finish = resolve }); throw Object.assign(new Error("Denied"), { status: 403 }) }
  const service = createService(api, { models: "local/model" }, "/project")
  const request = { sessionID: "ses_test", completion: 2 }
  const older = service.predict(request, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  await service.predict(request, new AbortController().signal)
  finish('{"prompt":"Run tests."}')
  await older
  assert.equal(service.status().candidates?.[0].state, "blocked")
  assert.equal((await service.predict(request, new AbortController().signal)).reason, "no_models_eligible")
  assert.equal(calls, 2)
})

test("fallback rechecks shared health instead of calling a model another request just blocked", async () => {
  const { api } = fixture()
  let failFirst!: (error: Error) => void
  const attempted: string[] = []
  api.models = async () => ["a", "b"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async model => {
    attempted.push(model.id)
    if (attempted.length === 1) return new Promise((_resolve, reject) => { failFirst = reject })
    throw Object.assign(new Error("Denied"), { status: 403 })
  }
  const service = createService(api, { models: "local/*" }, "/project")
  const request = { sessionID: "ses_test", completion: 2 }
  const older = service.predict(request, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  await service.predict(request, new AbortController().signal)
  failFirst(new Error("Temporary failure"))
  await older
  assert.deepEqual(attempted, ["a", "a", "b"])
  assert.deepEqual(service.status().candidates?.map(model => model.state), ["blocked", "blocked"])
})

test("late catalog entries retain configured priority among untried models", async () => {
  const { api } = fixture()
  let ids = ["b"]
  const attempted: string[] = []
  api.models = async () => ids.map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async model => { attempted.push(model.id); return '{"prompt":null}' }
  const service = createService(api, { models: "local/a, local/b" }, "/project")
  await service.inspect(new AbortController().signal)
  ids = ["a", "b"]
  await service.inspect(new AbortController().signal)
  assert.deepEqual(service.status().candidates?.map(model => model.id), ["a", "b"])
  await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  assert.deepEqual(attempted, ["a"])
})

test("catalog growth and status polling preserve working-first priority and keep recovered failures last", async t => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const { api } = fixture()
  let ids = ["b", "c"]
  api.models = async () => ids.map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async model => { if (model.id === "b") throw new Error("Unavailable"); return '{"prompt":null}' }
  const service = createService(api, { models: "local/a, local/b, local/c, local/d" }, "/project")
  await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  assert.deepEqual(service.status().candidates?.map(model => model.id), ["c", "b"])
  now = 61000
  ids = ["a", "b", "c", "d"]
  await service.inspect(new AbortController().signal)
  assert.deepEqual(service.status().candidates?.map(model => model.id), ["c", "a", "d", "b"])
  await service.inspect(new AbortController().signal)
  assert.deepEqual(service.status().candidates?.map(model => model.id), ["c", "a", "d", "b"])
})

test("a provider rejection does not turn into a timeout during a slow session recheck", async () => {
  const { api } = fixture()
  const session = api.session
  let checks = 0
  api.session = async (id, signal) => { if (++checks === 3) await new Promise(resolve => setTimeout(resolve, 30)); return session(id, signal) }
  api.generate = async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }) }
  const service = createService(api, { models: "local/model", timeoutMs: 10 }, "/project")
  assert.equal((await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)).reason, "generation_failed")
  assert.equal(service.status().candidates?.[0].state, "blocked")
})

test("request-specific thinking-budget errors do not impose model-wide budget cooldowns", async t => {
  t.mock.method(Date, "now", () => 1000)
  for (const reason of ["invalid_request", "content_filter"]) {
    const { api } = fixture()
    let calls = 0
    api.models = async () => [{ providerID: "local", id: "model", enabled: true, variants: [{ id: "low" }, { id: "high" }] }]
    api.generate = async () => { calls++; throw Object.assign(new Error("Exceeded the thinking budget"), { status: 400, reason }) }
    const service = createService(api, { models: "local/model#low, local/model#high" }, "/project")
    await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
    assert.equal(calls, 2)
    assert.deepEqual(service.status().candidates?.map(model => model.retryAt), [61000, 61000])
  }
})

test("groups keep free-first precedence after paid success and cooldown recovery", async t => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const { api } = fixture()
  const attempted: string[] = []
  const notices: string[] = []
  api.models = async () => ["free/a", "free/b", "paid/c", "paid/d"].map(key => { const [providerID, id] = key.split("/"); return { providerID, id, enabled: true, variants: [] } })
  let recovered = false
  api.generate = async model => {
    const id = model.providerID + "/" + model.id
    attempted.push(id)
    if (id !== "paid/d" && !(recovered && id === "free/a")) throw Object.assign(new Error("PRIVATE"), { status: 503 })
    return '{"prompt":"Run tests."}'
  }
  api.notice = message => { notices.push(message) }
  const service = createService(api, { models: ["free/*", "paid/*"] }, "/project")
  const request = { sessionID: "ses_test", completion: 2 }
  assert.deepEqual(await service.predict(request, new AbortController().signal), { text: "Run tests." })
  assert.deepEqual(attempted, ["free/a", "free/b", "paid/c", "paid/d"])
  const ids = () => service.status().groups?.map(group => group.candidates.map(model => model.id))
  assert.deepEqual(ids(), [["a", "b"], ["d", "c"]])
  await service.predict(request, new AbortController().signal)
  assert.equal(attempted.at(-1), "paid/d")
  now = 61000
  recovered = true
  await service.inspect(new AbortController().signal)
  assert.deepEqual(ids(), [["a", "b"], ["d", "c"]])
  await service.predict(request, new AbortController().signal)
  assert.equal(attempted.at(-1), "free/a")
  assert.deepEqual(service.status().candidates?.map(model => model.id), ["a", "b", "d", "c"])
  assert.deepEqual(notices, [])
})

test("singleton exact and wildcard groups work and null stops all later groups", async () => {
  for (const models of [["local/model#high"], ["local/*#high"], ["local/model#high", "paid/other"]]) {
    const { api, calls } = fixture()
    api.generate = async (model, prompt) => { calls.push({ model, prompt }); return '{"prompt":null}' }
    const service = createService(api, { models }, "/project")
    assert.deepEqual(await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal), { reason: "no_suggestion" })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].model, { providerID: "local", id: "model", variant: "high" })
    assert.equal(service.status().groups?.length, models.length)
    assert.equal(service.status().groups?.[0].selectors, models[0])
    assert.equal(service.status().models, models.join(", "))
  }
})

test("overlapping candidates belong to earliest group without repeated attempts", async () => {
  const { api } = fixture()
  const attempted: string[] = []
  api.models = async () => ["a", "b", "c"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async model => { attempted.push(model.id); throw new Error("PRIVATE") }
  const service = createService(api, { models: ["local/a, local/b", "local/*", "local/c", "local/missing"] }, "/project")
  await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  assert.deepEqual(attempted, ["a", "b", "c"])
  assert.deepEqual(service.status().groups?.map(group => group.candidates.map(model => model.id)), [["a", "b"], ["c"], [], []])
})

test("model-wide health crosses groups and variants but candidate failures do not", async () => {
  for (const status of [429, 403, 503]) {
    const { api } = fixture()
    const attempted: string[] = []
    api.models = async () => ["first", "second"].map(providerID => ({ providerID, id: "model", enabled: true, variants: [{ id: "low" }, { id: "high" }] }))
    api.generate = async model => {
      attempted.push(model.providerID + "#" + model.variant)
      if (model.providerID === "first" && model.variant === "low") throw Object.assign(new Error("PRIVATE"), { status })
      return '{"prompt":null}'
    }
    const service = createService(api, { models: ["first/model#low", "first/model#high, second/model#low"] }, "/project")
    assert.equal((await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)).reason, "no_suggestion")
    assert.deepEqual(attempted, status === 503 ? ["first#low", "first#high"] : ["first#low", "second#low"])
    const high = service.status().groups?.[1].candidates.find(model => model.providerID === "first")
    assert.equal(high?.state, status === 503 ? "ready" : status === 403 ? "blocked" : "cooling")
  }
})

test("unmatched and blocked groups fall through without repeated individual notices", async () => {
  const { api } = fixture()
  const attempted: string[] = []
  const notices: string[] = []
  api.models = async () => ["a", "b"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async model => { attempted.push(model.id); if (model.id === "a") throw Object.assign(new Error("PRIVATE"), { status: 403 }); return '{"prompt":null}' }
  api.notice = message => { notices.push(message) }
  const service = createService(api, { models: ["local/missing", "local/a", "local/b"] }, "/project")
  for (let i = 0; i < 2; i++) assert.equal((await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)).reason, "no_suggestion")
  assert.deepEqual(attempted, ["a", "b", "b"])
  assert.deepEqual(notices, [])
})

test("grouped exhaustion preserves single and multiple configured notice wording", async () => {
  for (const [models, expected] of [
    [["local/model"], "Model [model] failed with message: Model request failed."],
    [["local/model", "local/model"], "Model [model] failed with message: Model request failed."],
    [["local/missing", "local/model"], "No model worked at this time. Activate `debug` mode for details."],
    [["local/missing"], "Model [local/missing] failed with message: No configured model is available."],
  ] as const) {
    const { api } = fixture()
    const notices: string[] = []
    api.generate = async () => { throw new Error("PRIVATE") }
    api.notice = message => { notices.push(message) }
    const service = createService(api, { models }, "/project")
    for (let i = 0; i < 2; i++) await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
    assert.deepEqual(notices, [expected, expected])
  }
})

test("each group preserves learned order through catalog growth and pruning", async t => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const { api } = fixture()
  let ids = ["free/b", "paid/c", "paid/d"]
  api.models = async () => ids.map(key => { const [providerID, id] = key.split("/"); return { providerID, id, enabled: true, variants: [] } })
  api.generate = async model => { if (model.id !== "d") throw new Error("PRIVATE"); return '{"prompt":null}' }
  const service = createService(api, { models: ["free/*", "paid/*"] }, "/project")
  await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  now = 61000
  ids = ["free/a", "free/b", "paid/c", "paid/d", "paid/e"]
  await service.inspect(new AbortController().signal)
  assert.deepEqual(service.status().groups?.map(group => group.candidates.map(model => model.id)), [["a", "b"], ["d", "e", "c"]])
  ids = ["free/a", "paid/c", "paid/e"]
  await service.inspect(new AbortController().signal)
  ids.push("free/b", "paid/d")
  await service.inspect(new AbortController().signal)
  assert.deepEqual(service.status().groups?.map(group => group.candidates.map(model => model.id)), [["a", "b"], ["d", "e", "c"]])
})

test("catalog ownership transfer resets group rank while retaining shared health", async t => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const { api } = fixture()
  let transferred = false
  api.models = async () => ["a", "x", "y", "z"].map(id => ({ providerID: "local", id, name: id === "a" || id === "z" || (id === "x" && transferred) ? "Free " + id : "Paid " + id, enabled: true, variants: [] }))
  api.generate = async model => { if (model.id !== "y") throw new Error("PRIVATE"); return '{"prompt":null}' }
  const service = createService(api, { models: ["local/Free*", "local/*"] }, "/project")
  await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  transferred = true
  await service.inspect(new AbortController().signal)
  assert.deepEqual(service.status().groups?.map(group => group.candidates.map(model => model.id)), [["x", "a", "z"], ["y"]])
  assert.equal(service.status().groups?.[0].candidates[0].state, "cooling")
  now = 61000
  await service.inspect(new AbortController().signal)
  assert.deepEqual(service.status().groups?.[0].candidates.map(model => model.id), ["x", "a", "z"])
  assert.equal(service.status().groups?.[0].candidates[0].state, "ready")
})

test("older concurrent group success cannot erase newer shared failure", async () => {
  const { api } = fixture()
  let finish!: (output: string) => void
  const attempted: string[] = []
  api.models = async () => ["a", "b"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async model => {
    attempted.push(model.id)
    if (attempted.length === 1) return new Promise(resolve => { finish = resolve })
    if (model.id === "a") throw Object.assign(new Error("PRIVATE"), { status: 403 })
    return '{"prompt":null}'
  }
  const service = createService(api, { models: ["local/a", "local/b"] }, "/project")
  const request = { sessionID: "ses_test", completion: 2 }
  const older = service.predict(request, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  await service.predict(request, new AbortController().signal)
  await service.inspect(new AbortController().signal)
  assert.equal(typeof finish, "function", "grouped prediction must start generation")
  finish('{"prompt":"Run tests."}')
  await older
  assert.deepEqual(attempted, ["a", "a", "b"])
  assert.equal(service.status().groups?.[0].candidates[0].state, "blocked")
  assert.deepEqual(service.status().groups?.map(group => group.candidates.map(model => model.id)), [["a"], ["b"]])
})

test("group fallback rechecks concurrent health before calling later groups", async () => {
  const { api } = fixture()
  let failFirst!: (error: Error) => void
  const attempted: string[] = []
  api.models = async () => ["a", "b"].map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async model => {
    attempted.push(model.id)
    if (attempted.length === 1) return new Promise((_resolve, reject) => { failFirst = reject })
    throw Object.assign(new Error("PRIVATE"), { status: 403 })
  }
  const service = createService(api, { models: ["local/a", "local/b"] }, "/project")
  const request = { sessionID: "ses_test", completion: 2 }
  const older = service.predict(request, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  await service.predict(request, new AbortController().signal)
  assert.equal(typeof failFirst, "function", "grouped prediction must start generation")
  failFirst(new Error("Temporary failure"))
  await older
  assert.deepEqual(attempted, ["a", "a", "b"])
  assert.deepEqual(service.status().groups?.map(group => group.candidates[0].state), ["blocked", "blocked"])
})

test("cancellation and stale failures at group boundary never call paid fallback", async () => {
  for (const cancel of [false, true]) {
    const { api, advance } = fixture()
    const controller = new AbortController()
    const attempted: string[] = []
    const notices: string[] = []
    api.models = async () => ["free", "paid"].map(providerID => ({ providerID, id: "model", enabled: true, variants: [] }))
    api.generate = async model => { attempted.push(model.providerID); if (cancel) controller.abort(); else advance(); throw new Error("PRIVATE") }
    api.notice = message => { notices.push(message) }
    const service = createService(api, { models: ["free/model", "paid/model"], debug: true }, "/project")
    assert.equal((await service.predict({ sessionID: "ses_test", completion: 2 }, controller.signal)).reason, cancel ? "cancelled" : "stale")
    assert.deepEqual(attempted, ["free"])
    assert.deepEqual(notices, [])
    assert.deepEqual(service.status().groups?.map(group => group.candidates[0].state), ["ready", "ready"])
  }
})

test("removing a grouped candidate prunes its health before it reappears", async () => {
  const { api } = fixture()
  let ids = ["a", "b"]
  api.models = async () => ids.map(id => ({ providerID: "local", id, enabled: true, variants: [] }))
  api.generate = async model => { if (model.id === "a") throw Object.assign(new Error("PRIVATE"), { status: 403 }); return '{"prompt":null}' }
  const service = createService(api, { models: ["local/a", "local/b"] }, "/project")
  await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  assert.equal(service.status().groups?.[0].candidates[0].state, "blocked")
  ids = ["b"]
  await service.inspect(new AbortController().signal)
  assert.deepEqual(service.status().groups?.[0].candidates, [])
  ids = ["a", "b"]
  await service.inspect(new AbortController().signal)
  assert.equal(service.status().groups?.[0].candidates[0].state, "ready")
})

test("debug progress crosses group boundaries without losing safe details", async () => {
  const { api } = fixture()
  const notices: string[] = []
  api.models = async () => ["free", "paid"].map(providerID => ({ providerID, id: "model", name: providerID, enabled: true, variants: [] }))
  api.generate = async () => { throw Object.assign(new Error("PRIVATE"), { status: 503, reason: "overloaded" }) }
  api.notice = message => { notices.push(message) }
  const service = createService(api, { models: ["free/model", "paid/model"], debug: true }, "/project")
  await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  assert.equal(notices.length, 3)
  assert.match(notices[0], /failed with \[free\], moving on with \[paid\]/)
  assert.match(notices[1], /HTTP 503: Provider is overloaded/)
  assert.equal(notices[2], "No model worked at this time.")
  assert.equal(notices.join().includes("PRIVATE"), false)
})

test("an old model-wide failure preserves untried ranking after group ownership transfer", async () => {
  const { api } = fixture()
  let transferred = false
  let reject!: (error: Error) => void
  api.models = async () => ["x", ...(transferred ? ["y"] : [])].map(id => ({ providerID: "local", id, name: transferred ? "Free " + id : "Paid " + id, enabled: true, variants: [] }))
  api.generate = async () => new Promise((_resolve, fail) => { reject = fail })
  const service = createService(api, { models: ["local/Free*", "local/*"] }, "/project")
  const pending = service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof reject, "function")
  transferred = true
  await service.inspect(new AbortController().signal)
  assert.deepEqual(service.status().groups?.[0].candidates.map(model => model.id), ["x", "y"])
  reject(Object.assign(new Error("PRIVATE"), { status: 429 }))
  await pending
  assert.deepEqual(service.status().groups?.[0].candidates.map(model => model.id), ["x", "y"])
  assert.equal(service.status().groups?.[0].candidates[0].state, "cooling")
})

test("an old success cannot promote a candidate after it leaves and returns to its group", async () => {
  const { api } = fixture()
  let moved = false
  let addY = false
  let finish!: (output: string) => void
  const attempted: string[] = []
  api.models = async () => ["x", ...(addY ? ["y"] : [])].map(id => ({ providerID: "local", id, name: id === "x" && moved ? "Paid x" : "Free " + id, enabled: true, variants: [] }))
  api.generate = async model => {
    attempted.push(model.id)
    if (attempted.length === 1) return new Promise(resolve => { finish = resolve })
    return '{"prompt":null}'
  }
  const service = createService(api, { models: ["local/Free*", "local/*"] }, "/project")
  const request = { sessionID: "ses_test", completion: 2 }
  const pending = service.predict(request, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof finish, "function")
  moved = true
  addY = true
  await service.inspect(new AbortController().signal)
  await service.predict(request, new AbortController().signal)
  moved = false
  await service.inspect(new AbortController().signal)
  assert.deepEqual(service.status().groups?.[0].candidates.map(model => model.id), ["y", "x"])
  finish('{"prompt":"Run tests."}')
  await pending
  assert.deepEqual(service.status().groups?.[0].candidates.map(model => model.id), ["y", "x"])
  await service.predict(request, new AbortController().signal)
  assert.deepEqual(attempted, ["x", "y", "y"])
})

test("model-wide failures retain health but do not demote transferred sibling variants", async () => {
  const { api } = fixture()
  let transferred = false
  let reject!: (error: Error) => void
  api.models = async () => ["model", "y"].map(id => ({ providerID: "local", id, name: id === "y" || transferred ? "Free " + id : "Paid model", enabled: true, variants: [{ id: "low" }, { id: "high" }] }))
  api.generate = async () => new Promise((_resolve, fail) => { reject = fail })
  const controller = new AbortController()
  api.notice = () => { controller.abort() }
  const service = createService(api, { models: ["local/model#low", "local/Free*#high", "local/model#high"], debug: true }, "/project")
  const pending = service.predict({ sessionID: "ses_test", completion: 2 }, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof reject, "function")
  transferred = true
  await service.inspect(new AbortController().signal)
  reject(Object.assign(new Error("PRIVATE"), { status: 403 }))
  // Stop after recording the failure so fallback cannot change y's ranking.
  await pending
  assert.deepEqual(service.status().groups?.[1].candidates.map(model => model.id), ["model", "y"])
  assert.equal(service.status().groups?.[1].candidates[0].state, "blocked")
})

test("nested groups preserve independent ranking and free-first recovery without queue changes", async t => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const { api } = fixture()
  const attempted: string[] = []
  const notices: string[] = []
  let freeRecovered = false
  api.models = async () => ["a", "b", "c", "d"].map(id => ({ providerID: "local", id, enabled: true, variants: [{ id: "low" }] }))
  api.generate = async model => {
    attempted.push(model.id)
    if ((model.id === "a" || model.id === "b") && !freeRecovered || model.id === "c") throw Object.assign(new Error("PRIVATE"), { status: 503 })
    return '{"prompt":null}'
  }
  api.notice = message => { notices.push(message) }
  const service = createService(api, { models: [["local/a#low", "local/b#low"], ["local/c#low", "local/d#low"]] }, "/project")
  const request = { sessionID: "ses_test", completion: 2 }
  assert.equal((await service.predict(request, new AbortController().signal)).reason, "no_suggestion")
  assert.deepEqual(attempted, ["a", "b", "c", "d"])
  assert.deepEqual(service.status().groups?.map(group => group.candidates.map(model => model.id)), [["a", "b"], ["d", "c"]])
  assert.deepEqual(service.status().groups?.map(group => group.selectors), ["local/a#low, local/b#low", "local/c#low, local/d#low"])
  await service.predict(request, new AbortController().signal)
  assert.deepEqual(attempted, ["a", "b", "c", "d", "d"])
  freeRecovered = true
  now = 61000
  await service.predict(request, new AbortController().signal)
  assert.equal(attempted.at(-1), "a")
  assert.deepEqual(notices, [])
})

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
  assert.equal(notices[0], "Predictions failed with [model]; no configured models remain.\nReason: Timed out after 10 ms.")
  api.generate = async () => { attempts++; throw new Error("provider secret") }
  assert.equal((await service.predict({ sessionID: "ses_test", completion: 2 }, new AbortController().signal)).reason, "generation_failed")
  assert.equal(attempts, 2)
})

test("unknown options appear in diagnostics without disabling prediction", () => {
  const { api } = fixture()
  const status = createService(api, { models: "local/model", obsolete: true }, "/project").status()
  assert.equal(status.enabled, true)
  assert.deepEqual(status.warnings, ["Unknown option ignored: obsolete"])
})

test("failed model calls advance only through configured matches and announce both display names", async () => {
  const { api } = fixture()
  const notices: string[] = []
  const attempted: string[] = []
  api.models = async () => ["a", "b", "unselected"].map(id => ({ providerID: "local", id, name: id === "a" ? "First Free" : "Next Flash", enabled: true, variants: [] }))
  api.generate = async model => { attempted.push(model.id); if (model.id === "a") throw Object.assign(new Error("Free usage limit reached."), { _tag: "ProviderRequestError", status: 429, reason: "rate_limit" }); return '{"prompt":"Run the tests."}' }
  api.notice = message => { notices.push(message) }
  const service = createService(api, { models: "local/a, local/b" }, "/project")
  assert.deepEqual(await service.predict({ sessionID: "ses_test", completion: 2, requestID: "request-one" }, new AbortController().signal), { text: "Run the tests." })
  assert.deepEqual(attempted, ["a", "b"])
  assert.deepEqual(notices, ["Predictions failed with [First Free], moving on with [Next Flash]...\nReason: HTTP 429: Free usage limit reached."])
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
    assert.deepEqual(notices, [`Predictions failed with [model]; no configured models remain.\nReason: ${expected}`])
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

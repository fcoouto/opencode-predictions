import { test } from "node:test"
import assert from "node:assert/strict"
import { startClient } from "../src/client.ts"
import { createService } from "../src/service.ts"

test("all client notifications get exactly one prefix and background status stays silent", async () => {
  const messages: string[] = []
  let fail = false
  const client = startClient({
    state: () => ({ key: "session/2", sessionID: "session", completion: 2, eligible: true, draft: "" }),
    status: async () => ({ enabled: true, automatic: false, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }),
    predict: async (_state, _id, _signal, notice) => {
      if (fail) throw new Error("PRIVATE")
      notice("[opencode-predictions] Already prefixed")
      return { reason: "no_suggestion" }
    },
    paint: () => false, insert: () => false, focus() {}, show: message => { messages.push(message) },
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(messages, [])
    client.request()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(messages, ["[opencode-predictions] Already prefixed"])
    await client.status()
    assert.match(messages[1], /^\[opencode-predictions\] \{/)
    fail = true
    client.request()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(messages.at(-1), "[opencode-predictions] Prediction service unavailable")
  } finally { client.dispose() }
})

test("unmatched configurations notify through automatic and manual clients without generation", async () => {
  for (const automatic of [false, true]) for (const models of ["local/missing", ["local/missing"], ["local/missing", "local/other"]]) {
    const messages: string[] = []
    const service = createService({
      session: async () => ({ id: "session", time: { idle: 2 }, location: { directory: "/project" } }),
      models: async () => [],
      context: async () => { assert.fail("No context needed without candidates") },
      generate: async () => { assert.fail("No unmatched model may be called") },
      notice: message => { messages.push(message) },
    }, { models, automatic }, "/project")
    const client = startClient({
      state: () => ({ key: "session/2", sessionID: "session", completion: 2, eligible: true, draft: "" }),
      status: (_state, signal) => service.inspect(signal),
      predict: (state, _id, signal) => service.predict(state, signal),
      paint: () => false, insert: () => false, focus() {}, show() {},
    })
    try {
      await new Promise(resolve => setImmediate(resolve))
      if (!automatic) {
        assert.equal(messages.length, 0)
        client.request()
        await new Promise(resolve => setImmediate(resolve))
      }
      assert.deepEqual(messages, [Array.isArray(models) && models.length > 1 ? "No model worked at this time. Activate `debug` mode for details." : "Model [local/missing] failed with message: No configured model is available."])
    } finally { client.dispose() }
  }
})

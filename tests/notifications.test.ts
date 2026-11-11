import { test } from "node:test"
import assert from "node:assert/strict"
import { startClient } from "../src/client.ts"
import { createService } from "../src/service.ts"

test("all client notifications get exactly one prefix and background status stays silent", async () => {
  const messages: string[] = []
  let fail = false
  const client = startClient({
    scope: () => "server/project",
    state: () => ({ key: "session/2", sessionID: "session", completion: 2, eligible: true, draft: "" }),
    status: async () => ({ enabled: true, automatic: false, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [], feedbackRevision: 1 }),
    predict: async (_state, _id, _signal, notice) => {
      if (fail) throw new Error("PRIVATE")
      notice("[opencode-predictions] Already prefixed")
      return { reason: "no_suggestion" }
    },
    paint: () => false, insert: () => false, focus() {}, show: notice => { messages.push(notice.message) }, openStatus: view => { messages.push(view.summary) },
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(messages, [])
    client.request()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(messages, ["[opencode-predictions] Already prefixed", "Continue typing your next prompt."])
    await client.status()
    assert.match(messages.at(-1)!, /Prediction status snapshot/)
    fail = true
    client.request()
    await new Promise(resolve => setImmediate(resolve))
    assert.match(messages.at(-1)!, /Check the OpenCode service connection/)
  } finally { client.dispose() }
})

test("unmatched configurations notify from health inspection without generation", async () => {
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
      scope: () => "server/project",
      state: () => ({ key: "session/2", sessionID: "session", completion: 2, eligible: true, draft: "" }),
      status: signal => service.inspect(signal),
      predict: (state, _id, signal) => service.predict(state, signal),
      paint: () => false, insert: () => false, focus() {}, show: notice => { messages.push(notice.message) }, openStatus() {},
    })
    try {
      await new Promise(resolve => setImmediate(resolve))
      if (!automatic) {
        assert.equal(messages.length, 1)
        client.request()
        await new Promise(resolve => setImmediate(resolve))
      }
      assert.equal(messages.length, automatic ? 1 : 2)
      assert.ok(messages.every(message => message.includes("No model was called.")))
    } finally { client.dispose() }
  }
})

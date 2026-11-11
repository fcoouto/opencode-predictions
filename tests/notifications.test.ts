import { test } from "node:test"
import assert from "node:assert/strict"
import { startClient } from "../src/client.ts"

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

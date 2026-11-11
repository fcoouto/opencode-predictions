import { test } from "node:test"
import assert from "node:assert/strict"
import { startClient, type ClientState } from "../src/client.ts"
import type { Status } from "../src/service.ts"

test("automatic client uses one prediction, rechecks input on Tab, and exposes scoped progress", async () => {
  let state: ClientState | undefined = { key: "local/session/2", sessionID: "ses_test", completion: 2, eligible: true, draft: "" }
  let ghost: string | undefined
  let calls = 0
  const messages: string[] = []
  const inserted: string[] = []
  const status: Status = { enabled: true, automatic: true, debug: false, models: "local/*", timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  const client = startClient({ state: () => state, status: async () => status, predict: async (_state, id, _signal, notice) => { assert.ok(id); calls++; notice("moving on"); return { text: "Run tests." } }, paint: text => { ghost = text; return !!text }, insert: text => { inserted.push(text); return true }, focus() {}, show: message => { messages.push(message) } })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "Run tests.")
    assert.deepEqual(messages, ["[opencode-predictions] moving on"])
    assert.equal(calls, 1)
    state = { ...state!, draft: "my input" }
    assert.equal(client.accept(), false)
    assert.deepEqual(inserted, [])
    assert.equal(ghost, undefined)
    state = undefined
  } finally { client.dispose() }
})

test("manual-only client makes no generation calls until requested", async () => {
  const state: ClientState = { key: "local/session/2", sessionID: "ses_test", completion: 2, eligible: true, draft: "" }
  let calls = 0
  const status: Status = { enabled: true, automatic: false, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  const client = startClient({ state: () => state, status: async () => status, predict: async () => { calls++; return { text: "Run tests." } }, paint: text => !!text, insert: () => true, focus() {}, show() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 0)
    client.request()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
    assert.equal(client.accept(), true)
  } finally { client.dispose() }
})

test("manual shortcut falls through outside an enabled empty eligible session", async () => {
  let state: ClientState | undefined = { key: "local/session/2", sessionID: "ses_test", completion: 2, eligible: true, draft: "" }
  const status: Status = { enabled: true, automatic: false, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  let calls = 0
  let focused = 0
  const client = startClient({ state: () => state, status: async () => status, predict: async () => { calls++; return { text: "Run tests." } }, paint: text => !!text, insert: () => true, focus() { focused++ }, show() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(typeof client.requestFromShortcut, "function")
    state!.draft = "my own prompt"
    assert.equal(client.requestFromShortcut(), false)
    state!.draft = ""
    state!.eligible = false
    assert.equal(client.requestFromShortcut(), false)
    state!.eligible = true
    status.enabled = false
    client.invalidate()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(client.requestFromShortcut(), false)
    assert.equal(calls, 0)
    assert.equal(focused, 0)
    status.enabled = true
    client.invalidate()
    await new Promise(resolve => setImmediate(resolve))
    assert.notEqual(client.requestFromShortcut(), false)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
    assert.equal(focused, 1)
    assert.equal(client.accept(), true)
    state = undefined
    assert.equal(client.requestFromShortcut(), false)
  } finally { client.dispose() }
})

test("manual shortcut waits for initial status without losing the first keypress", async () => {
  const state: ClientState = { key: "local/session/2", sessionID: "ses_test", completion: 2, eligible: true, draft: "" }
  for (const enabled of [false, true]) {
    let finish!: (status: Status) => void
    let calls = 0
    const client = startClient({ state: () => state, status: () => new Promise(resolve => { finish = resolve }), predict: async () => { calls++; return { reason: "no_suggestion" } }, paint: () => false, insert: () => true, focus() {}, show() {} })
    try {
      assert.equal(typeof client.requestFromShortcut, "function")
      assert.notEqual(client.requestFromShortcut(), false)
      assert.equal(calls, 0)
      finish({ enabled, automatic: false, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(calls, enabled ? 1 : 0)
    } finally { client.dispose() }
  }
})

test("typing cancels a shortcut queued during status loading", async () => {
  const state: ClientState = { key: "local/session/2", sessionID: "ses_test", completion: 2, eligible: true, draft: "" }
  let finish!: (status: Status) => void
  let calls = 0
  const client = startClient({ state: () => state, status: () => new Promise(resolve => { finish = resolve }), predict: async () => { calls++; return { reason: "no_suggestion" } }, paint: () => false, insert: () => true, focus() {}, show() {} })
  try {
    client.requestFromShortcut()
    state.draft = "my own prompt"
    finish({ enabled: true, automatic: false, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] })
    await new Promise(resolve => setImmediate(resolve))
    state.draft = ""
    client.accept()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 0)
    client.requestFromShortcut()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
  } finally { client.dispose() }
})

test("disabled validation cancels a queued shortcut instead of replaying it after re-enable", async () => {
  const state: ClientState = { key: "local/session/2", sessionID: "ses_test", completion: 2, eligible: true, draft: "" }
  let finish!: (status: Status) => void
  let calls = 0
  const client = startClient({ state: () => state, status: () => new Promise(resolve => { finish = resolve }), predict: async () => { calls++; return { reason: "no_suggestion" } }, paint: () => false, insert: () => true, focus() {}, show() {} })
  const status: Status = { enabled: false, automatic: false, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  try {
    client.requestFromShortcut()
    finish(status)
    await new Promise(resolve => setImmediate(resolve))
    client.invalidate()
    finish({ ...status, enabled: true, version: "two" })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 0)
    client.requestFromShortcut()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
  } finally { client.dispose() }
})

test("a manual request waiting for focus cannot move to another session", async () => {
  let state: ClientState = { key: "local/first/2", sessionID: "ses_first", completion: 2, eligible: false, draft: "" }
  let calls = 0
  const status: Status = { enabled: true, automatic: false, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  const client = startClient({ state: () => state, status: async () => status, predict: async () => { calls++; return { text: "Run tests." } }, paint: text => !!text, insert: () => true, focus() {}, show() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    client.request()
    state = { key: "local/second/3", sessionID: "ses_second", completion: 3, eligible: true, draft: "" }
    client.invalidate()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 0)
  } finally { client.dispose() }
})

test("a response resolved between polling ticks never paints into a different live session", async () => {
  let state: ClientState = { key: "local/first/2", sessionID: "ses_first", completion: 2, eligible: true, draft: "" }
  let finish!: (reply: { text: string }) => void
  const painted: string[] = []
  const status: Status = { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  const client = startClient({ state: () => state, status: async () => status, predict: () => new Promise(resolve => { finish = resolve }), paint: text => { if (text) painted.push(text); return !!text }, insert: () => true, focus() {}, show() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    state = { ...state, key: "local/second/3", sessionID: "ses_second", completion: 3 }
    finish({ text: "Private first-session suggestion" })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(painted, [])
  } finally { client.dispose() }
})

test("Escape passes through when a cached suggestion loses input eligibility before the next tick", async () => {
  const state: ClientState = { key: "local/session/2", sessionID: "ses_test", completion: 2, eligible: true, draft: "" }
  let ghost: string | undefined
  const status: Status = { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  const client = startClient({ state: () => state, status: async () => status, predict: async () => ({ text: "Run tests." }), paint: text => { ghost = text; return !!text }, insert: () => true, focus() {}, show() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "Run tests.")
    state.eligible = false
    assert.equal(client.dismiss(), false)
    assert.equal(ghost, undefined)
  } finally { client.dispose() }
})

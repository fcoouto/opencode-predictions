import { test } from "node:test"
import assert from "node:assert/strict"
import { startClient as createClient, type ClientState, type ClientHost } from "../src/client.ts"
import type { Status } from "../src/service.ts"
import { communicationText, type Communication } from "../src/controller.ts"

function startClient(host: Omit<ClientHost, "scope" | "openStatus" | "show"> & { show(message: string): void }) {
  return createClient({ ...host, scope: () => "local/project", openStatus() {}, show: notice => host.show(notice.message) })
}

test("automatic client uses one prediction, rechecks input on Tab, and exposes scoped progress", async () => {
  let state: ClientState | undefined = { key: "local/session/2", sessionID: "ses_test", completion: 2, eligible: true, draft: "" }
  let ghost: string | undefined
  let calls = 0
  const messages: string[] = []
  const inserted: string[] = []
  const status: Status = { enabled: true, automatic: true, debug: false, models: "local/*", timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [], feedbackRevision: 1 }
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

test("clearing an accepted prediction restores it in automatic and manual-only clients", async () => {
  for (const automatic of [true, false]) {
    const state: ClientState = { key: "local/session/2", sessionID: "ses_test", completion: 2, eligible: true, draft: "" }
    let ghost: string | undefined
    let calls = 0
    const status: Status = { enabled: true, automatic, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
    const client = startClient({ state: () => state, status: async () => status, predict: async () => { calls++; return { text: "Run tests." } }, paint: text => { ghost = text; return !!text }, insert: text => { state.draft = text; state.eligible = false; return true }, focus() {}, show() {} })
    try {
      await new Promise(resolve => setImmediate(resolve))
      if (!automatic) { client.request(); await new Promise(resolve => setImmediate(resolve)) }
      assert.equal(ghost, "Run tests.")
      assert.equal(client.accept(), true)
      assert.equal(state.draft, "Run tests.")
      assert.equal(client.accept(), false)
      assert.equal(ghost, undefined)
      state.draft = ""
      state.eligible = true
      // Status refresh runs the same update as the polling tick, without generating a new prediction.
      await client.status()
      assert.equal(ghost, "Run tests.")
      assert.equal(calls, 1)
      assert.equal(client.accept(), true)
    } finally { client.dispose() }
  }
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

test("shortcut and palette requests carry manual intent while automatic-ineligible history never auto-generates", async () => {
  for (const automaticEligible of [true, false]) {
    const state: ClientState = { key: "old-session/2", sessionID: "ses_old", completion: 2, eligible: true, draft: "", automaticEligible }
    const flags: (boolean | undefined)[] = []
    const status: Status = { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
    const client = startClient({ state: () => state, status: async () => status, predict: async (_state, _id, _signal, _notice, manual) => { flags.push(manual); return { text: "Run tests." } }, paint: text => !!text, insert: () => true, focus() {}, show() {} })
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(flags, automaticEligible ? [false] : [])
      assert.notEqual(client.requestFromShortcut(), false)
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(flags, automaticEligible ? [false, true] : [true])
      client.request()
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(flags, automaticEligible ? [false, true, true] : [true, true])
    } finally { client.dispose() }
  }
})

test("manual historical replies stay hidden when the live session changes before the next tick", async () => {
  let state: ClientState = { key: "old/2", sessionID: "ses_old", completion: 2, eligible: true, draft: "", automaticEligible: false }
  const painted: string[] = []
  let finish!: (reply: { text: string }) => void
  let calls = 0
  const status: Status = { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  const client = startClient({ state: () => state, status: async () => status, predict: async (_state, _id, _signal, _notice, manual) => { assert.equal(manual, true); calls++; return new Promise(resolve => { finish = resolve }) }, paint: text => { if (text) painted.push(text); return !!text }, insert: () => true, focus() {}, show() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    client.requestFromShortcut()
    state = { ...state, key: "other/3", sessionID: "ses_other", completion: 3 }
    finish({ text: "Private old-chat suggestion" })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(painted, [])
    assert.equal(calls, 1)
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

test("navigation invalidation restores the original chat's exact prediction without regeneration", async () => {
  const first: ClientState = { key: "local/first/2", sessionID: "ses_first", completion: 2, eligible: true, draft: "" }
  const second: ClientState = { ...first, key: "local/second/3", sessionID: "ses_second", completion: 3 }
  let state = first
  let ghost: string | undefined
  let calls = 0
  const status: Status = { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  const client = startClient({ state: () => state, status: async () => status, predict: async current => { calls++; return { text: current.sessionID === "ses_first" ? "First chat suggestion" : "Second chat suggestion" } }, paint: text => { ghost = text; return !!text }, insert: () => true, focus() {}, show() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "First chat suggestion")
    state = second; client.invalidate()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "Second chat suggestion")
    state = first; client.invalidate()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "First chat suggestion")
    assert.equal(calls, 2)
  } finally { client.dispose() }
})

test("typing while a returning chat's status loads preserves both chats' cached suggestions", async () => {
  const first: ClientState = { key: "local/first/2", sessionID: "ses_first", completion: 2, eligible: true, draft: "" }
  const second: ClientState = { ...first, key: "local/second/3", sessionID: "ses_second", completion: 3 }
  const status: Status = { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  let state = first
  let ghost: string | undefined
  let predictions = 0
  let lookups = 0
  let finish!: (value: Status) => void
  const client = startClient({ state: () => state, status: () => ++lookups === 3 ? new Promise(resolve => { finish = resolve }) : Promise.resolve(status), predict: async current => { predictions++; return { text: current.sessionID === "ses_first" ? "First chat suggestion" : "Second chat suggestion" } }, paint: text => { ghost = text; return !!text }, insert: () => true, focus() {}, show() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    state = second; client.invalidate(); await new Promise(resolve => setImmediate(resolve))
    state = first; client.invalidate()
    first.draft = "typed while status was loading"; client.accept()
    first.draft = ""; client.accept()
    finish(status); await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "First chat suggestion")
    assert.equal(predictions, 2)
    state = second; client.invalidate(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "Second chat suggestion")
    assert.equal(predictions, 2)
  } finally { client.dispose() }
})

test("accepted edits survive navigation and clearing while status reloads without regeneration", async () => {
  const first: ClientState = { key: "local/first/2", sessionID: "ses_first", completion: 2, eligible: true, draft: "" }
  const second: ClientState = { ...first, key: "local/second/3", sessionID: "ses_second", completion: 3 }
  const status: Status = { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  let state = first
  let ghost: string | undefined
  let predictions = 0
  let lookups = 0
  let finish!: (value: Status) => void
  const client = startClient({ state: () => state, status: () => ++lookups === 3 ? new Promise(resolve => { finish = resolve }) : Promise.resolve(status), predict: async current => { predictions++; return { text: current.sessionID === "ses_first" ? "First chat suggestion" : "Second chat suggestion" } }, paint: text => { ghost = text; return !!text }, insert: text => { state.draft = text; return true }, focus() {}, show() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(client.accept(), true)
    assert.equal(first.draft, "First chat suggestion")
    first.draft = "edited accepted text"
    assert.equal(client.accept(), false)
    state = second; client.invalidate(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "Second chat suggestion")
    state = first; client.invalidate()
    first.draft = "edited again during status loading"
    assert.equal(client.accept(), false)
    first.draft = ""
    assert.equal(client.accept(), false)
    finish(status); await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "First chat suggestion")
    assert.equal(client.accept(), true)
    assert.equal(first.draft, "First chat suggestion")
    assert.equal(predictions, 2)
  } finally { client.dispose() }
})

test("an aborted request cannot repaint a retained prediction in a new location between ticks", async () => {
  const first: ClientState = { key: "first/2", sessionID: "ses_first", completion: 2, eligible: true, draft: "" }
  const second: ClientState = { ...first, key: "second/2", sessionID: "ses_second" }
  let state = first
  let scope = "server/original"
  let predictions = 0
  let finish!: (reply: { text: string }) => void
  const painted: { scope: string; text: string }[] = []
  const status: Status = { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  const client = createClient({ scope: () => scope, state: () => state, status: async () => status, predict: async current => { predictions++; return current.sessionID === "ses_second" ? new Promise(resolve => { finish = resolve }) : { text: "Private first-chat prediction" } }, paint: text => { if (text) painted.push({ scope, text }); return !!text }, insert: text => { state.draft = text; return true }, focus() {}, show() {}, openStatus() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(client.accept(), true)
    first.draft = ""
    state = second; client.invalidate(); await new Promise(resolve => setImmediate(resolve))
    state = first; client.invalidate(); await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(painted.at(-1), { scope: "server/original", text: "Private first-chat prediction" })
    painted.length = 0
    scope = "server/other-location"
    finish({ text: "Late second-chat prediction" })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(painted, [])
    assert.equal(predictions, 2)
  } finally { client.dispose() }
})

test("Tab passes through when a cached suggestion loses input eligibility before the next tick", async () => {
  const state: ClientState = { key: "local/session/2", sessionID: "ses_test", completion: 2, eligible: true, draft: "" }
  let ghost: string | undefined
  const status: Status = { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  const client = startClient({ state: () => state, status: async () => status, predict: async () => ({ text: "Run tests." }), paint: text => { ghost = text; return !!text }, insert: () => true, focus() {}, show() {} })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "Run tests.")
    state.eligible = false
    assert.equal(client.accept(), false)
    assert.equal(ghost, undefined)
  } finally { client.dispose() }
})
test("manual escalation renders non-accepting communication and stale callbacks never request in another chat", async () => {
  let state = { key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft: "" }
  let message: any
  let activate: (() => void) | undefined
  let calls = 0
  const tokens: (string | undefined)[] = []
  const inserted: string[] = []
  const client = createClient({
    scope: () => "/project", state: () => state,
    status: async () => ({ enabled: true, automatic: true, escalation: "manual", debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }),
    predict: async (_state, _id, _signal, _notice, manual, token) => {
      calls++; tokens.push(token)
      if (token) { assert.equal(manual, true); return { text: "Run the tests." } }
      return { reason: "no_suggestion", escalation: { token: "next", group: 2, model: { providerID: "paid", id: "model" }, name: "Next model" } }
    },
    paint: text => !!text, insert: text => { inserted.push(text); return true }, focus() {}, show() {}, openStatus() {},
    communicate: (value, run) => { message = value; activate = run },
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
    assert.equal(message.offer.model.providerID, "paid")
    assert.equal(client.accept(), false)
    assert.deepEqual(tokens, [undefined])
    const stale = activate!
    client.requestFromShortcut()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(tokens, [undefined, "next"])
    assert.equal(client.accept(), true)
    assert.deepEqual(inserted, ["Run the tests."])
    stale()
    assert.equal(calls, 2)
    state = { ...state, key: "two", sessionID: "ses_two" }
    stale()
    assert.equal(calls, 2)
  } finally { client.dispose() }
})

test("queued escalation is cancelled by config changes or typing, never converted into an ordinary request", async () => {
  for (const change of ["config", "typing"]) {
    let draft = ""
    let calls = 0
    let activate!: () => void
    let hold = false
    let resolve!: (status: Status) => void
    const status: Status = { enabled: true, automatic: false, escalation: "manual", debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
    const client = createClient({
      scope: () => "/project", state: () => ({ key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft }),
      status: async () => { if (hold) { hold = false; return new Promise(done => { resolve = done }) } return status },
      predict: async () => { calls++; return { reason: "no_suggestion", escalation: { token: "next", group: 2, model: { providerID: "paid", id: "model" }, name: "Next model" } } },
      paint: () => false, insert: () => false, focus() {}, show() {}, openStatus() {}, communicate: (value, run) => { if (value?.offer) activate = run },
    })
    try {
      await new Promise(done => setImmediate(done))
      client.request(); await new Promise(done => setImmediate(done))
      assert.equal(calls, 1)
      hold = true
      const checking = client.status()
      activate()
      if (change === "config") { status.version = "two"; client.invalidate() }
      else { draft = "typed"; client.accept(); draft = "" }
      resolve(status)
      await checking; await new Promise(done => setImmediate(done))
      assert.equal(calls, 1, change)
    } finally { client.dispose() }
  }
})

test("alternative shortcut withdraws text before readiness and restores adoption despite all-cooling status", async () => {
  const state: ClientState = { key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft: "" }
  const status: Status = { enabled: true, automatic: false, escalation: "manual", debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
  let hold = false
  let ready!: (value: Status) => void
  let finish!: (value: any) => void
  let ghost: string | undefined
  let message: any
  let calls = 0
  const client = createClient({
    scope: () => "/project", state: () => state,
    status: async () => hold ? new Promise(resolve => { ready = resolve }) : status,
    predict: async (_state, _id, _signal, _notice, _manual, token) => {
      calls++
      return token ? new Promise(resolve => { finish = resolve }) : { text: "Run the targeted tests.", escalation: { token: "next", group: 1, model: { providerID: "local", id: "b" }, name: "Second Model" } }
    },
    paint: text => { ghost = text; return !!text }, insert: text => { state.draft = text; return true },
    communicate: value => { message = value }, focus() {}, show() {}, openStatus() {},
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    client.requestFromShortcut(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "Run the targeted tests.")
    hold = true
    const checking = client.status()
    client.requestFromShortcut()
    assert.equal(ghost, undefined)
    assert.deepEqual(message?.activity, { kind: "alternative", name: "Second Model" })
    assert.equal(client.accept(), false)
    client.requestFromShortcut()
    hold = false; ready(status); await checking
    assert.equal(calls, 2)
    assert.equal(client.accept(), false)
    finish({ reason: "generation_failed" }); await new Promise(resolve => setImmediate(resolve))
    status.reason = "no_models_eligible"
    await client.status()
    assert.equal(ghost, "Run the targeted tests.")
    assert.equal(client.accept(), true)
    assert.equal(state.draft, "Run the targeted tests.")
  } finally { client.dispose() }
})

test("exhausted local authority can refresh without generation when an untried model recovers", async () => {
  let calls = 0
  let modelCalls = 0
  let ghost: string | undefined
  const tokens: (string | undefined)[] = []
  const offer = { token: "recovered", group: 1, model: { providerID: "local", id: "b" }, name: "Recovered model" }
  const client = createClient({
    scope: () => "/project", state: () => ({ key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft: "" }),
    status: async () => ({ enabled: true, automatic: false, escalation: "manual", debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }),
    predict: async (_state, _id, _signal, _notice, _manual, token) => {
      calls++; tokens.push(token)
      if (calls === 1) { modelCalls++; return { text: "Original prediction." } }
      if (calls === 2) return { reason: "escalation_refreshed", escalation: offer }
      modelCalls++; return { text: "Replacement." }
    },
    paint: text => { ghost = text; return !!text }, insert: () => true, focus() {}, show() {}, openStatus() {},
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    client.requestFromShortcut(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(ghost, "Original prediction.")
    client.requestFromShortcut(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 2, "explicit action must be able to refresh exhausted authority")
    assert.equal(modelCalls, 1, "refresh spends no generation call")
    client.requestFromShortcut(); await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(tokens, [undefined, "refresh", "recovered"])
    assert.equal(ghost, "Replacement.")
  } finally { client.dispose() }
})

test("failure communication shows cause and recovery but never a next-model hint", async () => {
  for (const reason of ["generation_failed", "timeout", "service_unavailable", "escalation_refreshed"]) {
    let message: Communication | undefined
    const notices: string[] = []
    const client = createClient({
      scope: () => "/project", state: () => ({ key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft: "" }),
      status: async () => ({ enabled: true, automatic: true, escalation: "manual", debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }),
      predict: async () => ({ reason, ...(reason === "generation_failed" ? { notice: { code: reason, severity: "error" as const, title: "Provider authentication failed.", message: "Reconnect the provider, then reload the server plugin." } } : {}), escalation: { token: "next", group: 1, model: { providerID: "local", id: "b" }, name: "Second Model" } }),
      paint: () => false, insert: () => { assert.fail("communication must not be adopted") }, focus() {}, show: notice => { notices.push(notice.title) }, openStatus() {},
      communicate: value => { message = value },
    })
    try {
      await new Promise(resolve => setImmediate(resolve))
      const text = message ? communicationText(message) : ""
      assert.equal(text.includes("Second Model"), false, reason)
      assert.equal(text.includes("provided no prediction"), false, reason)
      assert.equal(client.accept(), false)
      if (reason === "generation_failed") {
        assert.match(text, /authentication failed/)
        assert.match(text, /Reconnect/)
      } else if (reason === "escalation_refreshed") {
        assert.equal(text, "")
        assert.deepEqual(notices, [], "refresh is not a service failure")
      }
      else {
        assert.match(text, reason === "timeout" ? /timed out/i : /service unavailable/i)
        assert.match(text, /Prediction status and preview/)
      }
    } finally { client.dispose() }
  }
})

test("missing context shows usable recovery instead of denying an existing completed reply", async () => {
  let message: Communication | undefined
  const client = createClient({
    scope: () => "/project", state: () => ({ key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft: "" }),
    status: async () => ({ enabled: true, automatic: true, escalation: "manual", debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }),
    predict: async () => ({ reason: "context_unavailable", escalation: { token: "next", group: 1, model: { providerID: "local", id: "b" }, name: "Second Model" } }),
    paint: () => false, insert: () => { assert.fail("communication is not draft text") }, focus() {}, show() {}, openStatus() {}, communicate: value => { message = value },
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(communicationText(message!), "Prediction unavailable for this response.\nContinue typing your next prompt.")
    assert.equal(client.accept(), false)
    assert.equal(message?.offer, undefined)
  } finally { client.dispose() }
})

test("live fallback progress names actual model, preserves prefix, and ignores stale events", async () => {
  let draft = ""
  let message: Communication | undefined
  let progress!: Parameters<ClientHost["predict"]>[3]
  const shown: string[] = []
  const client = createClient({
    scope: () => "/project", state: () => ({ key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft }),
    status: async () => ({ enabled: true, automatic: true, escalation: "manual", debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [], feedbackRevision: 1 }),
    predict: async (_state, _id, _signal, notice) => { progress = notice; return new Promise(() => {}) },
    paint: () => false, insert: () => true, focus() {}, show: notice => { shown.push(notice.message) }, openStatus() {},
    communicate: value => { message = value },
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    progress("", undefined, "First Model")
    assert.equal(communicationText(message!, true), "\uFFFB… First Model")
    await client.status()
    assert.equal(communicationText(message!, true), "\uFFFB… First Model", "polls must not overwrite actual model")
    progress("", undefined, "Fallback Model")
    assert.equal(communicationText(message!, true), "\uFFFB… Fallback Model")
    assert.deepEqual(shown, [], "model progress is not a toast or debug notice")
    draft = "typed"
    progress("", undefined, "Late Model")
    client.accept()
    assert.equal(message, undefined)
  } finally { client.dispose() }
})

test("a multi-model alternative is not cut off by the old single-model client deadline", async () => {
  let calls = 0
  let ghost: string | undefined
  const client = createClient({
    scope: () => "/project", state: () => ({ key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft: "" }),
    status: async () => ({ enabled: true, automatic: false, escalation: "manual", debug: false, timeoutMs: 20, contextTurns: 3, version: "one", warnings: [], candidates: ["a", "b", "c"].map(id => ({ providerID: "local", id, name: id, state: "ready" as const })) }),
    predict: async () => {
      if (++calls === 1) return { text: "Original.", escalation: { token: "next", group: 1, model: { providerID: "local", id: "b" }, name: "b" } }
      await new Promise(resolve => setTimeout(resolve, 35))
      return { text: "Recovered." }
    },
    paint: text => { ghost = text; return !!text }, insert: () => true, focus() {}, show() {}, openStatus() {},
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    client.requestFromShortcut(); await new Promise(resolve => setImmediate(resolve))
    client.requestFromShortcut()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(ghost, "Recovered.")
  } finally { client.dispose() }
})

test("progress from a settled request cannot rename the next alternative", async () => {
  const callbacks: Parameters<ClientHost["predict"]>[3][] = []
  let message: Communication | undefined
  const client = createClient({
    scope: () => "/project", state: () => ({ key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft: "" }),
    status: async () => ({ enabled: true, automatic: true, escalation: "manual", debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }),
    predict: async (_state, _id, _signal, notice) => {
      callbacks.push(notice)
      return callbacks.length === 1 ? { text: "Original.", escalation: { token: "next", group: 1, model: { providerID: "local", id: "b" }, name: "Second" } } : new Promise(() => {})
    },
    paint: text => !!text, insert: () => true, focus() {}, show() {}, openStatus() {}, communicate: value => { message = value },
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    client.requestFromShortcut()
    await new Promise(resolve => setImmediate(resolve))
    callbacks[1]("", undefined, "Second")
    callbacks[0]("", undefined, "Old Model")
    assert.equal(communicationText(message!, true), "\uFFFB… Second")
  } finally { client.dispose() }
})

test("legacy metadata refresh cannot create abstention guidance", async () => {
  let calls = 0
  let message: Communication | undefined
  const client = createClient({
    scope: () => "/project", state: () => ({ key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft: "" }),
    status: async () => ({ enabled: true, automatic: false, escalation: "manual", debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }),
    predict: async () => ++calls === 1 ? { reason: "no_suggestion", modelName: "First" } : { reason: "no_suggestion", escalation: { token: "next", group: 1, model: { providerID: "local", id: "b" }, name: "Second" } },
    paint: () => false, insert: () => true, focus() {}, show() {}, openStatus() {}, communicate: value => { message = value },
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    client.requestFromShortcut(); await new Promise(resolve => setImmediate(resolve))
    assert.match(communicationText(message!), /First.*provided no prediction/)
    client.requestFromShortcut(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(communicationText(message!), "")
    assert.equal(message?.offer?.name, "Second", "refresh may update shortcut authority without claiming abstention")
  } finally { client.dispose() }
})

test("timed-out readiness restores the original and does not generate an alternative", async () => {
  let hold = false
  let ghost: string | undefined
  let calls = 0
  const client = createClient({
    scope: () => "/project", state: () => ({ key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft: "" }),
    status: async () => hold ? new Promise(() => {}) : { enabled: true, automatic: false, escalation: "manual", timeoutMs: 20, contextTurns: 3, debug: false, warnings: [], version: "one" },
    predict: async () => { calls++; return { text: "Original.", escalation: { token: "next", group: 1, model: { providerID: "local", id: "b" }, name: "Second" } } },
    paint: text => { ghost = text; return !!text }, insert: () => true, focus() {}, show() {}, openStatus() {},
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    client.requestFromShortcut(); await new Promise(resolve => setImmediate(resolve))
    hold = true
    const checking = client.status()
    client.requestFromShortcut()
    assert.equal(ghost, undefined)
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(ghost, "Original.")
    assert.equal(client.accept(), true)
    assert.equal(calls, 1)
    await checking
  } finally { client.dispose() }
})

test("typing observed between polls revokes spent authority before a continuation refresh", async () => {
  let draft = ""
  let finish!: (reply: any) => void
  const tokens: (string | undefined)[] = []
  const client = createClient({
    scope: () => "/project", state: () => ({ key: "one", sessionID: "ses_one", completion: 2, eligible: true, draft }),
    status: async () => ({ enabled: true, automatic: false, escalation: "manual", timeoutMs: 8000, contextTurns: 3, debug: false, warnings: [], version: "one" }),
    predict: async (_state, _id, _signal, _notice, _manual, token) => {
      tokens.push(token)
      if (tokens.length === 1) return { text: "Original.", escalation: { token: "spent", group: 1, model: { providerID: "local", id: "b" }, name: "Second" } }
      if (tokens.length === 2) return new Promise(resolve => { finish = resolve })
      return { reason: "escalation_unavailable" }
    },
    paint: text => !!text, insert: () => true, focus() {}, show() {}, openStatus() {},
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    client.requestFromShortcut(); await new Promise(resolve => setImmediate(resolve))
    client.requestFromShortcut()
    draft = "typed"
    finish({ text: "Late." }); await new Promise(resolve => setImmediate(resolve))
    draft = ""
    client.requestFromShortcut(); await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(tokens, [undefined, "spent", "refresh"])
  } finally { client.dispose() }
})

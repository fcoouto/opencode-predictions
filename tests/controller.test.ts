import { test } from "node:test"
import assert from "node:assert/strict"
import { createController, communicationText } from "../src/controller.ts"

const offer = { token: "offer-one", group: 2, model: { providerID: "paid", id: "model", variant: "low" }, name: "Next model" }

test("activity indicators carry the requested leading character, never real prediction payloads", () => {
  const activity = { kind: "alternative" as const, name: "Next model" }
  assert.match(communicationText({ message: "", activity }), /^\uFFFB[▰▱]{3} Next model$/)
  assert.equal(communicationText({ message: "", activity }, true), "\uFFFB… Next model")
  assert.equal(communicationText({ message: "No suggestion." }), "No suggestion.")
})

test("abstention placeholder names the source and target and uses the host shortcut label", () => {
  const value = { message: "[First Model] provided no prediction.", offer }
  assert.equal(communicationText(value), "[First Model] provided no prediction.\nAlt+Shift+P: try [Next model].")
})

test("plugin communications never accept via Tab and an explicit request consumes the offered token", async () => {
  let message: any
  let ghost: string | undefined
  const inserted: string[] = []
  const tokens: (string | undefined)[] = []
  const controller = createController({
    predict: async (_signal, token) => { tokens.push(token); return token ? { text: "Ask another model" } : { reason: "no_suggestion", communication: { message: "No suggestion from this model.", offer } } },
    paint: text => { ghost = text; return !!text }, insert: text => { inserted.push(text); return true },
    communicate: value => { message = value },
  })
  controller.update({ key: "one", eligible: true, draft: "" })
  await controller.request()
  assert.equal(ghost, undefined)
  assert.ok(message)
  assert.equal(controller.accept(), false)
  assert.deepEqual(inserted, [])
  assert.deepEqual(tokens, [undefined])
  await controller.request(true)
  assert.deepEqual(tokens, [undefined, "offer-one"])
  assert.equal(message, undefined)
  assert.equal(controller.accept(), true)
  assert.deepEqual(inserted, ["Ask another model"])
})

test("pending communication prevents duplicate escalation and vanishes on typing without later resurrection", async () => {
  let finish!: (reply: any) => void
  let message: any
  let calls = 0
  const controller = createController({
    predict: async (_signal, token) => { calls++; return token ? new Promise(resolve => { finish = resolve }) : { communication: { message: "No suggestion.", offer } } },
    paint: () => false, insert: () => { throw Error("communication inserted") }, communicate: value => { message = value },
  })
  controller.update({ key: "one", eligible: true, draft: "" })
  await controller.request()
  const pending = controller.request(true)
  await controller.request(true)
  assert.equal(calls, 2)
  assert.equal(message.pending, true)
  assert.equal(controller.accept(), false)
  controller.update({ key: "one", eligible: true, draft: "typed" })
  assert.equal(message, undefined)
  finish({ text: "too late" }); await pending
  controller.update({ key: "one", eligible: true, draft: "" })
  assert.equal(message, undefined)
  assert.equal(controller.accept(), false)
})

test("a no-more-models communication cannot wrap manual requests back to group one", async () => {
  let calls = 0
  const controller = createController({ predict: async () => { calls++; return { communication: { message: "No other models available." } } }, paint: () => false, insert: () => true })
  controller.update({ key: "one", eligible: true, draft: "" })
  await controller.request()
  await controller.request(true)
  assert.equal(calls, 1)
  assert.equal(controller.accept(), false)
})

function setup(predict = async (_signal: AbortSignal) => ({ text: "Run the tests." })) {
  let ghost: string | undefined
  const inserted: string[] = []
  let calls = 0
  const controller = createController({ predict: signal => { calls++; return predict(signal) }, paint: text => { ghost = text; return !!text }, insert: text => { inserted.push(text); return true } })
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  return { controller, inserted, ghost: () => ghost, calls: () => calls }
}

test("alternative activity withdraws the original, passes Tab through and restores on failure", async () => {
  for (const outcome of [{ reason: "no_suggestion" }, { reason: "generation_failed" }, { reason: "timeout" }, new Error("offline")]) {
    let finish!: (reply: any) => void
    let reject!: (error: unknown) => void
    let ghost: string | undefined
    let message: any
    let signal!: AbortSignal
    const inserted: string[] = []
    const controller = createController({
      predict: async (value, token) => {
        signal = value
        return token ? new Promise((resolve, fail) => { finish = resolve; reject = fail }) : { text: "Run the targeted tests.", escalation: offer }
      },
      paint: text => { ghost = text; return !!text }, insert: text => { inserted.push(text); return true }, communicate: value => { message = value },
    })
    controller.update({ key: "one", eligible: true, draft: "" })
    await controller.request()
    const pending = controller.request(true)
    assert.equal(ghost, undefined)
    assert.deepEqual(message?.activity, { kind: "alternative", name: "Next model" })
    assert.equal(controller.accept(), false)
    assert.equal(signal.aborted, false)
    assert.deepEqual(inserted, [])
    if (outcome instanceof Error) reject(outcome); else finish(outcome)
    await pending
    assert.equal(ghost, "Run the targeted tests.")
    assert.equal(message?.offer, undefined, "a consumed offer must not survive failure")
    assert.equal(controller.accept(), true)
    assert.deepEqual(inserted, ["Run the targeted tests."])
    controller.dispose()
  }
})

test("typing during replacement cancels it but preserves cached real text, including status-like prefixes", async () => {
  let finish!: (reply: any) => void
  let signal!: AbortSignal
  let ghost: string | undefined
  const controller = createController({
    predict: async (value, token) => { signal = value; return token ? new Promise(resolve => { finish = resolve }) : { text: "▱▰▱ Run the targeted tests.", escalation: offer } },
    paint: text => { ghost = text; return !!text }, insert: () => true,
  })
  controller.update({ key: "one", eligible: true, draft: "" })
  await controller.request()
  const pending = controller.request(true)
  assert.equal(ghost, undefined)
  controller.update({ key: "one", eligible: true, draft: "typed" })
  assert.equal(signal.aborted, true)
  finish({ text: "Explain the failure." }); await pending
  controller.update({ key: "one", eligible: true, draft: "" })
  assert.equal(ghost, "▱▰▱ Run the targeted tests.")
  assert.equal(controller.accept(), true)
  controller.dispose()
})

test("exhaustion status is temporary and restores the original without another generation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let ghost: string | undefined
  let message: any
  let calls = 0
  const controller = createController({
    predict: async () => { calls++; return { text: "Original.", communication: { message: "" } } },
    paint: text => { ghost = text; return !!text }, insert: () => true, communicate: value => { message = value },
  })
  controller.update({ key: "one", eligible: true, draft: "" })
  await controller.request()
  await controller.request(true)
  assert.equal(ghost, undefined)
  assert.equal(message.message, "No alternatives available.")
  assert.equal(controller.accept(), false)
  t.mock.timers.tick(1500)
  assert.equal(ghost, "Original.")
  assert.equal(calls, 1)
  assert.equal(controller.accept(), true)
  controller.dispose()
})

test("initial generation emits activity without adoptable text and disposal clears it", async () => {
  let finish!: (reply: any) => void
  let message: any
  const inserted: string[] = []
  const controller = createController({
    predict: async () => new Promise(resolve => { finish = resolve }), paint: text => !!text,
    insert: text => { inserted.push(text); return true }, communicate: value => { message = value },
  })
  controller.update({ key: "one", eligible: true, draft: "" })
  const pending = controller.request()
  assert.deepEqual(message.activity, { kind: "initial" })
  assert.match(communicationText(message), /^\uFFFB[▰▱]{3}$/)
  assert.equal(controller.accept(), false)
  controller.dispose()
  assert.equal(message, undefined)
  finish({ text: "Late." }); await pending
  assert.equal(message, undefined)
  assert.deepEqual(inserted, [])
})

test("Tab accepts visible current text once, leaves it editable, and otherwise passes through", async () => {
  const { controller, inserted, ghost } = setup()
  assert.equal(controller.accept(), false)
  await controller.request()
  assert.equal(ghost(), "Run the tests.")
  assert.equal(controller.accept(), true)
  assert.deepEqual(inserted, ["Run the tests."])
  assert.equal(controller.accept(), false)
  assert.equal(ghost(), undefined)
})

test("clearing accepted or edited text restores the original prediction without regenerating", async () => {
  for (const draft of ["Run the tests.", "My edited accepted text"]) {
    const { controller, inserted, ghost, calls } = setup()
    await controller.request()
    assert.equal(controller.accept(), true)
    controller.update({ key: "server/session/completion/config", eligible: true, draft: "Run the tests." })
    controller.update({ key: "server/session/completion/config", eligible: true, draft })
    assert.equal(ghost(), undefined)
    assert.equal(controller.accept(), false)
    controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
    assert.equal(ghost(), "Run the tests.")
    await controller.request()
    assert.equal(calls(), 1)
    assert.equal(controller.accept(), true)
    assert.equal(controller.accept(), false)
    assert.deepEqual(inserted, ["Run the tests.", "Run the tests."])
  }
})

test("unaccepted predictions survive edits and navigation without regenerating", async () => {
  const { controller, ghost, calls } = setup()
  await controller.request()
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "more edits" })
  assert.equal(ghost(), undefined)
  controller.update({ key: "other/session/completion/config", eligible: true, draft: "" })
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  await controller.request()
  assert.equal(ghost(), "Run the tests.")
  assert.equal(calls(), 1)
})

test("failed insertion keeps the prediction available after clearing typed text", async () => {
  let ghost: string | undefined
  const controller = createController({ predict: async () => ({ text: "Run the tests." }), paint: text => { ghost = text; return !!text }, insert: () => false })
  controller.update({ key: "first", eligible: true, draft: "" })
  await controller.request()
  assert.equal(controller.accept(), false)
  controller.update({ key: "first", eligible: true, draft: "my own text" })
  controller.update({ key: "first", eligible: true, draft: "" })
  assert.equal(ghost, "Run the tests.")
  assert.equal(controller.accept(), false)
})

test("typing hides a prediction and clearing restores it without another paid request", async () => {
  const { controller, inserted, ghost, calls } = setup()
  await controller.request()
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "my text" })
  assert.equal(ghost(), undefined)
  assert.equal(controller.accept(), false)
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  await controller.request()
  assert.equal(ghost(), "Run the tests.")
  assert.equal(calls(), 1)
  assert.deepEqual(inserted, [])
})

test("automatic requests reuse a prediction but a deliberate manual request can refresh", async () => {
  const { controller, ghost, calls } = setup()
  await controller.request()
  await controller.request()
  assert.equal(ghost(), "Run the tests.")
  assert.equal(calls(), 1)
  await controller.request(true)
  assert.equal(calls(), 2)
  assert.equal(ghost(), "Run the tests.")
})

test("shell/menu/focus ineligibility hides suggestions and prevents acceptance", async () => {
  const { controller, ghost, inserted } = setup()
  await controller.request()
  controller.update({ key: "server/session/completion/config", eligible: false, draft: "" })
  assert.equal(ghost(), undefined)
  assert.equal(controller.accept(), false)
  assert.deepEqual(inserted, [])
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  assert.equal(ghost(), "Run the tests.")
})

test("switching chats restores each unaccepted prediction without another model call", async () => {
  const { controller, ghost, calls } = setup()
  await controller.request()
  controller.update({ key: "other/session/completion/config", eligible: true, draft: "" })
  assert.equal(ghost(), undefined)
  await controller.request()
  controller.update({ eligible: false, draft: "" })
  assert.equal(ghost(), undefined)
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  assert.equal(ghost(), "Run the tests.")
  await controller.request()
  assert.equal(calls(), 2)
})

test("typing cancels an unfinished prediction without retrying after clearing", async () => {
  let finish!: (reply: { text: string }) => void
  let signal!: AbortSignal
  const { controller, ghost, calls } = setup(async value => { signal = value; return new Promise(resolve => { finish = resolve }) })
  const pending = controller.request()
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "my text" })
  assert.equal(signal.aborted, true)
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  finish({ text: "late suggestion" })
  await pending
  await controller.request()
  assert.equal(ghost(), undefined)
  assert.equal(calls(), 1)
})

test("cached suggestions never appear for a newer completion or configuration", async () => {
  const { controller, ghost } = setup()
  await controller.request()
  assert.equal(controller.accept(), true)
  for (const key of ["server/session/new-completion/config", "server/session/completion/new-config"]) {
    controller.update({ key, eligible: true, draft: "" })
    assert.equal(ghost(), undefined)
    assert.equal(controller.preview(), undefined)
  }
})

test("accepted predictions share the 128-attempt cache bound", async () => {
  const { controller, ghost, calls } = setup()
  await controller.request()
  assert.equal(controller.accept(), true)
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  assert.equal(ghost(), "Run the tests.")
  for (let index = 1; index <= 128; index++) {
    controller.update({ key: "completion/" + index, eligible: true, draft: "" })
    await controller.request()
  }
  controller.update({ key: "completion/1", eligible: true, draft: "" })
  assert.equal(ghost(), "Run the tests.")
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  assert.equal(ghost(), undefined)
  assert.equal(controller.preview(), undefined)
  assert.equal(calls(), 129)
})

test("disposal removes accepted predictions and blocks restoration", async () => {
  const { controller, ghost } = setup()
  await controller.request()
  assert.equal(controller.accept(), true)
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  assert.equal(ghost(), "Run the tests.")
  controller.dispose()
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  assert.equal(ghost(), undefined)
  assert.equal(controller.preview(), undefined)
  assert.equal(controller.accept(), false)
})

test("late responses after session/config changes are aborted and never painted", async () => {
  let finish!: (reply: { text: string }) => void
  let signal!: AbortSignal
  const { controller, ghost, inserted } = setup(async value => { signal = value; return new Promise(resolve => { finish = resolve }) })
  const pending = controller.request()
  controller.update({ key: "another/session/completion/config", eligible: true, draft: "" })
  assert.equal(signal.aborted, true)
  finish({ text: "wrong session" })
  await pending
  assert.equal(ghost(), undefined)
  assert.equal(controller.accept(), false)
  assert.deepEqual(inserted, [])
})

test("repeated ticks share one pending request and disposal blocks late output", async () => {
  let finish!: (reply: { text: string }) => void
  const { controller, ghost, calls } = setup(() => new Promise(resolve => { finish = resolve }))
  const pending = controller.request()
  await controller.request()
  assert.equal(calls(), 1)
  controller.dispose()
  finish({ text: "after unload" })
  await pending
  assert.equal(ghost(), undefined)
})

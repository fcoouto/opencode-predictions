import { test } from "node:test"
import assert from "node:assert/strict"
import { createController } from "../src/controller.ts"

function setup(predict = async (_signal: AbortSignal) => ({ text: "Run the tests." })) {
  let ghost: string | undefined
  const inserted: string[] = []
  let calls = 0
  const controller = createController({ predict: signal => { calls++; return predict(signal) }, paint: text => { ghost = text; return !!text }, insert: text => { inserted.push(text); return true } })
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  return { controller, inserted, ghost: () => ghost, calls: () => calls }
}

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

test("typing invalidates a prediction and clearing does not start another paid request", async () => {
  const { controller, inserted, calls } = setup()
  await controller.request()
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "my text" })
  assert.equal(controller.accept(), false)
  controller.update({ key: "server/session/completion/config", eligible: true, draft: "" })
  await controller.request()
  assert.equal(calls(), 1)
  assert.deepEqual(inserted, [])
})

test("Escape dismisses automatic prediction but a deliberate manual request can refresh", async () => {
  const { controller, ghost, calls } = setup()
  await controller.request()
  controller.dismiss()
  await controller.request()
  assert.equal(ghost(), undefined)
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

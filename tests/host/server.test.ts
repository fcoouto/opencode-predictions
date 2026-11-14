import { test } from "node:test"
import assert from "node:assert/strict"
import { createFixture, isPredictionCall } from "./fixture.mjs"
import { Predictions } from "../../src/rpc.ts"
import type { Reply, Status } from "../../src/service.ts"

test("packed server API generates from a real session without changing its history", { timeout: 60000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE)
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, title: "Prediction fixture", model: { providerID: "fixture", id: "model" } })
  await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion in the test." })
  await fixture.api.session.wait({ sessionID: session.id })
  const completed = await fixture.api.session.get({ sessionID: session.id })
  const history = await fixture.api.session.context({ sessionID: session.id })
  const rpc = fixture.api.rpc(Predictions)
  const status = await rpc.status({}, { location: session.location }) as Status
  assert.equal(status.enabled, true, JSON.stringify(status) + fixture.output())
  assert.equal(status.candidates?.[0].name, "Fixture Flash")
  assert.ok(status.warnings.includes("Unknown option ignored: obsolete"))
  const reply = await rpc.predict({ sessionID: session.id, completion: completed.time.idle!, requestID: crypto.randomUUID() }, { location: session.location }) as Reply
  assert.deepEqual(reply, { text: "Run the targeted tests." }, fixture.output())
  assert.deepEqual(await fixture.api.session.context({ sessionID: session.id }), history)
})

test("real server RPC preserves text plus same-group offers and rejects reuse without history writes", { timeout: 60000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { models: [["fixture/model", "fixture/second"]], escalation: "manual" }, { predictionOutputs: { model: '{"prompt":"Original prediction."}', second: '{"prompt":"Run the targeted tests."}' } })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion." })
  await fixture.api.session.wait({ sessionID: session.id })
  const completed = await fixture.api.session.get({ sessionID: session.id })
  const history = await fixture.api.session.context({ sessionID: session.id })
  const rpc = fixture.api.rpc(Predictions)
  const input = { sessionID: session.id, completion: completed.time.idle!, requestID: crypto.randomUUID() }
  const first = await rpc.predict(input, { location: session.location }) as Reply
  assert.equal(first.text, "Original prediction.")
  assert.ok(first.escalation)
  assert.equal(first.escalation.model.id, "second")
  assert.equal(first.escalation.group, 1)
  const refreshed = await rpc.predict({ ...input, requestID: crypto.randomUUID(), manual: true, escalation: "refresh" }, { location: session.location }) as Reply
  assert.equal(refreshed.escalation?.model.id, "second")
  assert.equal(fixture.calls.filter(isPredictionCall).length, 1)
  const escalation = { ...input, requestID: crypto.randomUUID(), manual: true, escalation: refreshed.escalation!.token }
  assert.deepEqual(await rpc.predict(escalation, { location: session.location }), { text: "Run the targeted tests." })
  assert.deepEqual(await rpc.predict({ ...escalation, requestID: crypto.randomUUID() }, { location: session.location }), { reason: "escalation_unavailable" })
  assert.deepEqual(await fixture.api.session.context({ sessionID: session.id }), history)
})

test("real server RPC preserves the abstaining display name for placeholder communication", { timeout: 60000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { models: [["fixture/model", "fixture/second"]] }, { predictionOutputs: { model: '{"prompt":null}', second: '{"prompt":"Run tests."}' } })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion." })
  await fixture.api.session.wait({ sessionID: session.id })
  const completed = await fixture.api.session.get({ sessionID: session.id })
  const reply = await fixture.api.rpc(Predictions).predict({ sessionID: session.id, completion: completed.time.idle!, requestID: crypto.randomUUID() }, { location: session.location }) as Reply
  assert.equal(reply.modelName, "Fixture Flash")
  assert.equal(reply.escalation?.name, "Fixture second")
})

test("real server RPC falls through alternative errors, stops at null and keeps refresh distinct", { timeout: 60000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { models: [["fixture/model", "fixture/second", "fixture/third"], "fixture/fourth"] }, {
    predictionOutputs: { model: '{"prompt":"Original."}', second: '{"prompt":null}', third: '{"prompt":null}', fourth: '{"prompt":"Recovered."}' },
    predictionStatuses: { second: 401 },
  })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion." })
  await fixture.api.session.wait({ sessionID: session.id })
  const completed = await fixture.api.session.get({ sessionID: session.id })
  const history = await fixture.api.session.context({ sessionID: session.id })
  const rpc = fixture.api.rpc(Predictions)
  const input = { sessionID: session.id, completion: completed.time.idle!, requestID: crypto.randomUUID() }
  const first = await rpc.predict(input, { location: session.location }) as Reply
  const second = await rpc.predict({ ...input, manual: true, escalation: first.escalation!.token }, { location: session.location }) as Reply
  assert.equal(second.reason, "no_suggestion")
  assert.equal(second.modelName, "Fixture third")
  assert.equal(second.escalation?.model.id, "fourth")
  assert.deepEqual(fixture.calls.filter(isPredictionCall).map(call => call.model), ["model", "second", "third"])
  const refreshed = await rpc.predict({ ...input, manual: true, escalation: "refresh" }, { location: session.location }) as Reply
  assert.equal(refreshed.reason, "escalation_refreshed")
  assert.equal(refreshed.modelName, undefined)
  assert.equal(fixture.calls.filter(isPredictionCall).length, 3)
  assert.equal((await rpc.predict({ ...input, manual: true, escalation: refreshed.escalation!.token }, { location: session.location }) as Reply).text, "Recovered.")
  assert.deepEqual(await fixture.api.session.context({ sessionID: session.id }), history)
})

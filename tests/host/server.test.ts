import { test } from "node:test"
import assert from "node:assert/strict"
import { createFixture } from "./fixture.mjs"
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

test("real server RPC preserves escalation offers and rejects their reuse without history writes", { timeout: 60000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { models: ["fixture/model", "fixture/second"], escalation: "manual" }, { predictionOutputs: { model: '{"prompt":null}', second: '{"prompt":"Run the targeted tests."}' } })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion." })
  await fixture.api.session.wait({ sessionID: session.id })
  const completed = await fixture.api.session.get({ sessionID: session.id })
  const history = await fixture.api.session.context({ sessionID: session.id })
  const rpc = fixture.api.rpc(Predictions)
  const input = { sessionID: session.id, completion: completed.time.idle!, requestID: crypto.randomUUID() }
  const first = await rpc.predict(input, { location: session.location }) as Reply
  assert.equal(first.reason, "no_suggestion")
  assert.ok(first.escalation)
  assert.equal(first.escalation.model.id, "second")
  const escalation = { ...input, requestID: crypto.randomUUID(), manual: true, escalation: first.escalation.token }
  assert.deepEqual(await rpc.predict(escalation, { location: session.location }), { text: "Run the targeted tests." })
  assert.deepEqual(await rpc.predict({ ...escalation, requestID: crypto.randomUUID() }, { location: session.location }), { reason: "escalation_unavailable" })
  assert.deepEqual(await fixture.api.session.context({ sessionID: session.id }), history)
})

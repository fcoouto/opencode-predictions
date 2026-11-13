import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve, join } from "node:path"
import { createFixture, isPredictionCall } from "./fixture.mjs"

for (const automatic of [true, false]) test(`real CLI PTY ${automatic ? "automatically" : "via Alt+Shift+P"} shows a ghost and Tab edits without running a prompt`, { timeout: 80000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion." })
  await fixture.api.session.wait({ sessionID: session.id })
  const initial = fixture.calls.filter(call => !isPredictionCall(call)).length
  const observation = join(fixture.root, "draft.json")
  const config = { ...fixture.config, plugins: [...fixture.config.plugins, { package: resolve("tests/host/observer") }] }
  const { stdout } = await promisify(execFile)("python3", [resolve("tests/host/terminal.py"), process.env.OPENCODE_BIN ?? "opencode", session.id, fixture.directory, observation], { env: { ...fixture.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), PREDICTIONS_OBSERVER: observation, PREDICTIONS_MANUAL_TEST: automatic ? "0" : "1" }, timeout: 65000, maxBuffer: 1024 * 1024 })
  assert.equal(JSON.parse(stdout).typedInputPreserved, true)
  assert.equal(fixture.calls.filter(call => !isPredictionCall(call)).length, initial)
})

test("real CLI PTY exposes invalid settings and reopenable status without generation", { timeout: 80000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { models: 42 })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  const observation = join(fixture.root, "feedback.json")
  const config = { ...fixture.config, plugins: [...fixture.config.plugins, { package: resolve("tests/host/observer") }] }
  const { stdout } = await promisify(execFile)("python3", [resolve("tests/host/terminal.py"), process.env.OPENCODE_BIN ?? "opencode", session.id, fixture.directory, observation], { env: { ...fixture.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), PREDICTIONS_OBSERVER: observation, PREDICTIONS_FEEDBACK_TEST: "1" }, timeout: 65000, maxBuffer: 1024 * 1024 })
  assert.equal(JSON.parse(stdout).statusReopened, true)
  assert.equal(fixture.calls.length, 0)
})

test("real CLI PTY leaves communication unadopted and escalates only on the manual shortcut", { timeout: 80000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { models: ["fixture/model", "fixture/second"], escalation: "manual" }, { predictionOutputs: { model: '{"prompt":null}', second: '{"prompt":"Run the targeted tests."}' } })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion." })
  await fixture.api.session.wait({ sessionID: session.id })
  const initial = fixture.calls.filter(call => !isPredictionCall(call)).length
  const observation = join(fixture.root, "escalation.json")
  const config = { ...fixture.config, plugins: [...fixture.config.plugins, { package: resolve("tests/host/observer") }] }
  const { stdout } = await promisify(execFile)("python3", [resolve("tests/host/terminal.py"), process.env.OPENCODE_BIN ?? "opencode", session.id, fixture.directory, observation], { env: { ...fixture.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), PREDICTIONS_OBSERVER: observation, PREDICTIONS_ESCALATION_TEST: "1" }, timeout: 65000, maxBuffer: 1024 * 1024 })
  assert.equal(JSON.parse(stdout).escalationValidated, true)
  assert.equal(fixture.calls.filter(isPredictionCall).length, 2)
  assert.equal(fixture.calls.filter(call => !isPredictionCall(call)).length, initial)
})

for (const outcome of ["success", "abstention", "error", "timeout", "typing"]) test(`real CLI PTY compact alternative status and ${outcome} recovery`, { timeout: 80000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { models: [["fixture/model", "fixture/second"]], escalation: "manual", timeoutMs: outcome === "timeout" ? 1200 : 8000 }, {
    predictionOutputs: { model: '{"prompt":"Original prediction."}', second: outcome === "abstention" ? '{"prompt":null}' : '{"prompt":"Run the targeted tests."}' },
    predictionDelayMs: { model: 600, second: 2500 }, predictionStatuses: outcome === "error" ? { second: 503 } : {},
  })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion." })
  await fixture.api.session.wait({ sessionID: session.id })
  const initial = fixture.calls.filter(call => !isPredictionCall(call)).length
  const observation = join(fixture.root, "alternative.json")
  const config = { ...fixture.config, plugins: [...fixture.config.plugins, { package: resolve("tests/host/observer") }] }
  const { stdout } = await promisify(execFile)("python3", [resolve("tests/host/terminal.py"), process.env.OPENCODE_BIN ?? "opencode", session.id, fixture.directory, observation], {
    env: { ...fixture.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CLI_CONFIG_CONTENT: '{"animations":false}', PREDICTIONS_OBSERVER: observation, PREDICTIONS_ALTERNATIVE_OUTCOME: outcome }, timeout: 65000, maxBuffer: 1024 * 1024,
  })
  assert.equal(JSON.parse(stdout).compactValidated, true)
  const generated = fixture.calls.filter(isPredictionCall)
  assert.equal(generated[0].model, "model")
  assert.ok(generated.slice(1).every(call => call.model === "second"), "provider retries cannot move to another model")
  if (outcome !== "error") assert.equal(generated.length, 2)
  assert.equal(fixture.calls.filter(call => !isPredictionCall(call)).length, initial)
})

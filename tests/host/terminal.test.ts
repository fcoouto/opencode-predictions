import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve, join } from "node:path"
import { createFixture } from "./fixture.mjs"

test("real CLI PTY shows a ghost and Tab edits without running a prompt", { timeout: 80000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE)
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion." })
  await fixture.api.session.wait({ sessionID: session.id })
  const initial = fixture.calls.filter(call => !JSON.stringify(call).includes("Predict the user's next complete prompt")).length
  const observation = join(fixture.root, "draft.json")
  const config = { ...fixture.config, plugins: [...fixture.config.plugins, { package: resolve("tests/host/observer") }] }
  const { stdout } = await promisify(execFile)("python3", [resolve("tests/host/terminal.py"), process.env.OPENCODE_BIN ?? "opencode", session.id, fixture.directory, observation], { env: { ...fixture.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), PREDICTIONS_OBSERVER: observation }, timeout: 65000, maxBuffer: 1024 * 1024 })
  assert.equal(JSON.parse(stdout).typedInputPreserved, true)
  assert.equal(fixture.calls.filter(call => !JSON.stringify(call).includes("Predict the user's next complete prompt")).length, initial)
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

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseOptions } from "../src/options.ts"

test("model selector preserves nested model IDs and explicit reasoning", () => {
  assert.deepEqual(parseOptions({ models: "openai/team/model#high" }), {
    ok: true,
    value: { enabled: true, models: ["openai/team/model#high"], timeoutMs: 8000, contextTurns: 3, automatic: true, debug: false },
    warnings: [],
  })
})

test("omitted reasoning stays omitted rather than overriding the model default", () => {
  const result = parseOptions({ models: "local/model" })
  assert.ok(result.ok)
  assert.deepEqual(result.value.models, ["local/model"])
})

test("unknown options warn without disabling supported options", () => {
  const result = parseOptions({ models: "local/model", preferences: ["unused"], timeoutMs: 60000 })
  assert.ok(result.ok)
  assert.equal(result.value.timeoutMs, 60000)
  assert.deepEqual(result.warnings, ["Unknown option ignored: preferences"])
  assert.equal("preferences" in result.value, false)
})

test("missing model remains unselected, and disabling/manual controls survive parsing", () => {
  const result = parseOptions({ enabled: false, automatic: false, contextTurns: 1, timeoutMs: 1 })
  assert.ok(result.ok)
  assert.deepEqual(result.value, { enabled: false, automatic: false, contextTurns: 1, timeoutMs: 1, debug: false })
})

test("debug defaults false and accepts only booleans", () => {
  for (const debug of [false, true]) {
    const result = parseOptions({ debug })
    assert.ok(result.ok)
    assert.equal(result.value.debug, debug)
    assert.deepEqual(result.warnings, [])
  }
  for (const debug of [null, 0, 1, "true", "false", {}]) assert.equal(parseOptions({ debug }).ok, false)
})

test("invalid supported options cannot silently select a different paid model", () => {
  for (const input of [null, [], { models: "model" }, { models: "/model" }, { models: "provider/" }, { models: "provider/model#" }, { models: "provider/model#high#low" }, { models: 42 }, { models: "provider/a,,provider/b" }, { enabled: "false" }, { automatic: 0 }, { contextTurns: 0 }, { contextTurns: 6 }, { contextTurns: 1.5 }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2147483648 }]) {
    assert.equal(parseOptions(input).ok, false, JSON.stringify(input))
  }
})

test("wildcard selectors support spaces and ordered alternatives in one text field", () => {
  for (const models of ["opencode-go/deepseek-*-flash#low", "opencode-go/*flash*#low", "opencode-go/* free*#low", "opencode-go/*flash*, opencode/* free*"]) {
    const result = parseOptions({ models })
    assert.ok(result.ok)
    assert.deepEqual(result.value.models, [models])
  }
})

test("text and single-entry arrays normalize exact and wildcard selectors into one group", () => {
  for (const models of ["opencode/*free*#low", "opencode/beam-free#low", "opencode/a, opencode/b"]) {
    assert.deepEqual(parseOptions({ models: [models] }), parseOptions({ models }))
    const parsed = parseOptions({ models: [" " + models + " "] })
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.value.models, [models])
  }
})

test("array entries retain group boundaries even when each group contains several selectors", () => {
  const models = ["free/*#low, local/*free*#low", "paid/exact#high"]
  const parsed = parseOptions({ models })
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.value.models, models)
  assert.deepEqual(parsed.warnings, [])
})

test("invalid model arrays reject the entire configuration", () => {
  for (const models of [[], [""], ["  "], ["local/a", 7], [["local/a"]], null, ["local/a", null], ["local/a", "paid/"], ["local/a,"], [",local/a"], ["local/a,,local/b"], ["local/a#"]]) {
    assert.equal(parseOptions({ models }).ok, false, JSON.stringify(models))
  }
})

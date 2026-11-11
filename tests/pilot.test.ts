import { test } from "node:test"
import assert from "node:assert/strict"
import { runPilot } from "../src/pilot.ts"

test("pilot compares identical synthetic context across categories and records failures without retry", async () => {
  const seen: string[] = []
  const results = await runPilot([
    { category: "go", providerID: "opencode-go", id: "a", name: "Go Free" },
    { category: "free", providerID: "opencode", id: "b", name: "Outside Free" },
  ], async (model, prompt) => { seen.push(prompt); if (model.id === "a") throw Object.assign(new Error("Quota"), { status: 429 }); return '{"prompt":"Run tests."}' })
  assert.equal(seen.length, 2)
  assert.equal(seen[0], seen[1])
  assert.equal(results[0].status, "failed")
  assert.equal(results[0].httpStatus, 429)
  assert.equal(results[1].suggestion, "Run tests.")
  assert.equal(results[1].category, "free")
})

test("pilot needs at least two categories before any LLM call", async () => {
  let calls = 0
  await assert.rejects(runPilot([{ category: "go", providerID: "opencode-go", id: "a", name: "Go Free" }], async () => { calls++; return "" }), /two categories/)
  assert.equal(calls, 0)
})

test("pilot distinguishes rejected output from a valid no-suggestion response", async () => {
  for (const output of ["not JSON", '{"prompt":"\\u001bunsafe"}', JSON.stringify({ prompt: "x".repeat(2001) }), '{"prompt":42}']) {
    const results = await runPilot([
      { category: "go", providerID: "opencode-go", id: "a", name: "Go Free" },
      { category: "free", providerID: "opencode", id: "b", name: "Outside Free" },
    ], async model => model.id === "a" ? output : '{"prompt":null}')
    assert.equal(results[0].status, "failed")
    assert.equal(results[1].status, "no_suggestion")
  }
})

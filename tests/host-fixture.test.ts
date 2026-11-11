import { test } from "node:test"
import assert from "node:assert/strict"
import { buildPrompt } from "../src/predict.ts"
import * as fixture from "./host/fixture.mjs"

test("native fixture recognizes the prediction protocol independently of directive wording", () => {
  assert.equal(typeof fixture.isPredictionCall, "function")
  const prompt = buildPrompt([{ user: ["Fix the assertion."], assistant: ["The assertion is fixed; checks remain."] }], 3)!
  assert.equal(fixture.isPredictionCall({ messages: [{ role: "user", content: prompt }] }), true)
  assert.equal(fixture.isPredictionCall({ messages: [{ role: "user", content: [{ type: "text", text: "Reworded instructions.\nConversation:\n[]" }] }] }), true)
  assert.equal(fixture.isPredictionCall({ messages: [{ role: "user", content: "Explain 'Predict the user's next complete prompt'." }] }), false)
  assert.equal(fixture.isPredictionCall({ messages: [{ role: "user", content: "Fix the assertion." }] }), false)
})

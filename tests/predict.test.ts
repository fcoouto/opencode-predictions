import { test } from "node:test"
import assert from "node:assert/strict"
import { buildPrompt, collectTurns, parseSuggestion } from "../src/predict.ts"

const user = (text: string) => ({ type: "user", text })
const assistant = (text: string, completed = true) => ({ type: "assistant", id: text, time: completed ? { completed: 1 } : {}, content: [{ type: "text", text }] })
const idle = { type: "idle", outcome: "succeeded" }

test("conversation payload contains only user and assistant text, grouping steered inputs", () => {
  const messages = [user("first"), assistant("working"), { type: "synthetic", text: "PRIVATE" }, user("steer"), { ...assistant("done"), content: [{ type: "reasoning", text: "PRIVATE" }, { type: "tool", state: { content: "PRIVATE" } }, { type: "text", text: "done" }] }, idle]
  assert.deepEqual(collectTurns(messages), [{ user: ["first", "steer"], assistant: ["working", "done"] }])
  assert.equal(buildPrompt(collectTurns(messages), 3)?.includes("PRIVATE"), false)
})

test("unusable older records do not disable current context; compaction summaries are excluded", () => {
  const messages = [user("old"), assistant("old answer"), idle, { type: "compaction", summary: "PRIVATE" }, null, { type: "assistant", content: "bad record" }, user("new"), assistant("new answer"), { type: "idle", outcome: "failed" }]
  assert.deepEqual(collectTurns(messages), [{ user: ["new"], assistant: ["new answer"] }])
  assert.equal(buildPrompt(collectTurns(messages), 3)?.includes("PRIVATE"), false)
  assert.deepEqual(collectTurns([user("unfinished"), assistant("streaming", false)]), [])
  assert.deepEqual(collectTurns([user("stopped"), assistant("partial"), { type: "idle", outcome: "interrupted" }]), [])
})

test("newest turns stay ordered and configured history count is respected", () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({ user: [`user-${i}`], assistant: [`answer-${i}`] }))
  const prompt = buildPrompt(turns, 3)!
  assert.equal(prompt.includes("user-1"), false)
  assert.ok(prompt.indexOf("user-2") < prompt.indexOf("user-4"))
  assert.ok(buildPrompt(turns, 5)!.includes("user-0"))
})

test("oversized newest interaction produces marked Unicode-safe excerpts within the byte budget", () => {
  const prompt = buildPrompt([{ user: ["BEGIN" + "😀".repeat(20000) + "END"], assistant: ["latest conclusion"] }], 3)!
  assert.ok(prompt)
  assert.ok(new TextEncoder().encode(prompt).length <= 32768)
  assert.ok(prompt.includes("excerpt"))
  assert.ok(prompt.includes("BEGIN") && prompt.includes("END") && prompt.includes("latest conclusion"))
  assert.equal(prompt.includes("\uFFFD"), false)
})

test("suggestion parser permits multiline Unicode and whitespace but rejects terminal controls", () => {
  assert.equal(parseSuggestion('{"prompt":"Run tests.\\nThen explain failures. 😀"}'), "Run tests.\nThen explain failures. 😀")
  for (const prompt of ["hello\u0000", "hello\u001b[2J", "hello\u009b31m", "x".repeat(2001)]) assert.equal(parseSuggestion(JSON.stringify({ prompt })), undefined)
  assert.equal(parseSuggestion('{"prompt":null}'), undefined)
  assert.equal(parseSuggestion("not JSON"), undefined)
})

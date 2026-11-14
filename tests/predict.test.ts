import { test } from "node:test"
import assert from "node:assert/strict"
import { buildPrompt, collectTurns, parseSuggestion } from "../src/predict.ts"

const user = (text: string) => ({ type: "user", text })
const assistant = (text: string, completed = true) => ({ type: "assistant", id: text, time: completed ? { completed: 1 } : {}, content: [{ type: "text", text }] })
const idle = { type: "idle", outcome: "succeeded" }
const conversation = (prompt: string) => JSON.parse(prompt.split("Conversation:\n")[1]) as { user: string; assistant: string }[]

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

test("completed assistant-only turns retain visible text without treating synthetic records as user intent", () => {
  const messages = [
    { type: "synthetic", text: "PRIVATE continuation instruction" },
    { ...assistant("Visible reply."), content: [{ type: "reasoning", text: "PRIVATE reasoning" }, { type: "tool", state: { content: "PRIVATE tool output" } }, { type: "text", text: "Visible reply." }] },
    idle,
  ]
  assert.deepEqual(collectTurns(messages), [{ user: [], assistant: ["Visible reply."] }])
  assert.equal(buildPrompt(collectTurns(messages), 3)?.includes("PRIVATE"), false)
})

test("assistant-only replies after compaction cannot inherit earlier user text or compaction summaries", () => {
  const messages = [user("PRIVATE earlier goal"), assistant("PRIVATE earlier reply"), idle, { type: "compaction", status: "completed", summary: "PRIVATE summary" }, assistant("Current visible reply."), idle]
  assert.deepEqual(collectTurns(messages), [{ user: [], assistant: ["Current visible reply."] }])
  assert.equal(buildPrompt(collectTurns(messages), 3)?.includes("PRIVATE"), false)
  assert.deepEqual(collectTurns([assistant("unfinished", false), idle]), [])
  assert.deepEqual(collectTurns([assistant("interrupted"), { type: "idle", outcome: "interrupted" }]), [])
  assert.deepEqual(collectTurns([user("Unanswered."), idle]), [])
})

test("newest turns stay ordered and configured history count is respected", () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({ user: [`user-${i}`], assistant: [`answer-${i}`] }))
  const prompt = buildPrompt(turns, 3)!
  assert.equal(prompt.includes("user-1"), false)
  assert.ok(prompt.indexOf("user-2") < prompt.indexOf("user-4"))
  assert.ok(buildPrompt(turns, 5)!.includes("user-0"))
})

test("assistant-only windows retain grouped human intent without importing the older assistant reply", () => {
  const turns = [
    { user: ["Compare the two payment routes.", "Meanwhile, merge the README."], assistant: ["Older reply outside the window."] },
    { user: [], assistant: ["First update."] },
    { user: [], assistant: ["Second update."] },
    { user: [], assistant: ["Latest reply."] },
  ]
  for (const count of [1, 2, 3]) {
    const payload = conversation(buildPrompt(turns, count)!)
    assert.deepEqual(payload[0], { user: "Compare the two payment routes.\n\nMeanwhile, merge the README.", assistant: "" })
    assert.deepEqual(payload.slice(1), [
      { user: "", assistant: "First update." },
      { user: "", assistant: "Second update." },
      { user: "", assistant: "Latest reply." },
    ].slice(-count))
  }
  assert.deepEqual(conversation(buildPrompt(turns, 4)!), [
    { user: "Compare the two payment routes.\n\nMeanwhile, merge the README.", assistant: "Older reply outside the window." },
    { user: "", assistant: "First update." },
    { user: "", assistant: "Second update." },
    { user: "", assistant: "Latest reply." },
  ], "in-window human text must not be duplicated")
})

test("retention uses the latest usable human turn rather than older intent or whitespace-only messages", () => {
  const turns = [
    { user: ["Obsolete goal."], assistant: ["Obsolete reply."] },
    { user: ["Current goal.", "Current constraint."], assistant: ["Out-of-window reply."] },
    { user: [" \n "], assistant: ["Whitespace-only input reply."] },
    { user: [], assistant: ["Latest reply."] },
  ]
  assert.deepEqual(conversation(buildPrompt(turns, 1)!), [
    { user: "Current goal.\n\nCurrent constraint.", assistant: "" },
    { user: "", assistant: "Latest reply." },
  ])
  assert.deepEqual(conversation(buildPrompt(turns, 2)!), [
    { user: "Current goal.\n\nCurrent constraint.", assistant: "" },
    { user: " \n ", assistant: "Whitespace-only input reply." },
    { user: "", assistant: "Latest reply." },
  ])
})

test("retention never mutates frozen turns and remains stable across repeated calls", () => {
  const turns = [
    { user: ["Keep the goal."], assistant: ["Older answer."] },
    { user: [], assistant: ["Latest answer."] },
  ]
  for (const turn of turns) { Object.freeze(turn.user); Object.freeze(turn.assistant); Object.freeze(turn) }
  Object.freeze(turns)
  const before = structuredClone(turns)
  for (let i = 0; i < 2; i++) assert.deepEqual(conversation(buildPrompt(turns, 1)!), [
    { user: "Keep the goal.", assistant: "" },
    { user: "", assistant: "Latest answer." },
  ])
  assert.deepEqual(turns, before)
})

test("retained human context honors compaction and excludes private continuation payloads", () => {
  for (const status of ["completed", "failed"]) {
    const turns = collectTurns([
      user("Retain only if compaction failed."), assistant("Older reply."), idle,
      { type: "compaction", status, summary: "PRIVATE summary" },
      { type: "system", text: "PRIVATE system" }, { type: "synthetic", text: "PRIVATE instruction" },
      { ...assistant("First update."), content: [{ type: "reasoning", text: "PRIVATE reasoning" }, { type: "tool", state: { content: "PRIVATE tool" } }, { type: "text", text: "First update." }] }, idle,
      assistant("Latest reply."), idle,
    ])
    const prompt = buildPrompt(turns, 1)!
    assert.deepEqual(conversation(prompt), [
      ...(status === "failed" ? [{ user: "Retain only if compaction failed.", assistant: "" }] : []),
      { user: "", assistant: "Latest reply." },
    ])
    assert.equal(prompt.includes("PRIVATE"), false)
    assert.equal(prompt.includes("Older reply."), false)
  }
})

test("budget eviction preserves human intent from inside or outside the initial window", () => {
  const turns = [
    { user: ["Keep this request."], assistant: ["OLD" + "x".repeat(40000)] },
    { user: [], assistant: ["OPTIONAL" + "x".repeat(40000)] },
    { user: [], assistant: ["Latest conclusion."] },
  ]
  for (const count of [1, 2, 3]) {
    const prompt = buildPrompt(turns, count)!
    assert.ok(Buffer.byteLength(prompt) <= 32768)
    assert.deepEqual(conversation(prompt), [
      { user: "Keep this request.", assistant: "" },
      { user: "", assistant: "Latest conclusion." },
    ])
  }
})

test("oversized retained human and assistant fields use Unicode-safe JSON excerpts within budget", () => {
  const goal = "USER-BEGIN" + '😀"\\\n'.repeat(20000) + "USER-END"
  const reply = "REPLY-BEGIN" + '🧪"\\\n'.repeat(20000) + "REPLY-END"
  const turns = [
    { user: [goal], assistant: ["Do not import this older reply."] },
    { user: [], assistant: [reply] },
  ]
  const prompt = buildPrompt(turns, 1)!
  const payload = conversation(prompt)
  assert.equal(payload.length, 2)
  assert.ok(Buffer.byteLength(prompt) <= 32768)
  assert.match(payload[0].user, /^USER-BEGIN[\s\S]*\[excerpt: middle omitted\][\s\S]*USER-END$/)
  assert.equal(payload[0].assistant, "")
  assert.equal(payload[1].user, "")
  assert.match(payload[1].assistant, /^REPLY-BEGIN[\s\S]*\[excerpt: middle omitted\][\s\S]*REPLY-END$/)
  assert.equal(prompt.includes("\uFFFD"), false)
  assert.equal(prompt.includes("Do not import"), false)
})

test("retention keeps short protected fields whole when the other field needs excerpting", () => {
  for (const oversized of ["user", "assistant"]) {
    const turns = [
      { user: [oversized === "user" ? "BEGIN" + "😀".repeat(20000) + "END" : "Short goal."], assistant: ["Excluded reply."] },
      { user: [], assistant: [oversized === "assistant" ? "BEGIN" + "😀".repeat(20000) + "END" : "Short reply."] },
    ]
    const prompt = buildPrompt(turns, 1)!
    const payload = conversation(prompt)
    assert.ok(Buffer.byteLength(prompt) <= 32768)
    assert.equal(oversized === "user" ? payload[1].assistant : payload[0].user, oversized === "user" ? "Short reply." : "Short goal.")
    assert.match(oversized === "user" ? payload[0].user : payload[1].assistant, /^BEGIN[\s\S]*\[excerpt: middle omitted\][\s\S]*END$/)
  }
})

test("no human context retains only the configured assistant-only history", () => {
  const turns = [
    { user: [], assistant: ["Older update."] },
    { user: [], assistant: ["Latest reply."] },
  ]
  assert.deepEqual(conversation(buildPrompt(turns, 1)!), [{ user: "", assistant: "Latest reply." }])
  assert.equal(buildPrompt([], 3), undefined)
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

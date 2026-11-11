import { test } from "node:test"
import assert from "node:assert/strict"
import { buildArms, classifyOutput, blindTrials, summarize, type Trial } from "../scripts/directive-experiment.ts"

test("experiment distinguishes runtime-valid abstention from invalid output and strict schema compliance", () => {
  assert.deepEqual(classifyOutput('{"prompt":" CSV. "}'), { kind: "suggestion", prompt: "CSV.", strict: true })
  assert.deepEqual(classifyOutput('{"prompt":null}'), { kind: "abstention", strict: true })
  assert.deepEqual(classifyOutput('{"prompt":null,"extra":true}'), { kind: "abstention", strict: false })
  for (const output of ["not JSON", "null", "[]", '{"prompt":42}', '{"prompt":""}', '{"prompt":"\\u001b"}', JSON.stringify({ prompt: "x".repeat(2001) })]) {
    assert.deepEqual(classifyOutput(output), { kind: "invalid", strict: false })
  }
})

test("experimental arms share exactly the same production-selected conversation, including excerpts", () => {
  const arms = buildArms([{ user: ["BEGIN" + "😀".repeat(20000) + "END"], assistant: ["Still need the example."] }])
  assert.deepEqual(arms.map(arm => arm.arm), ["baseline", "candidate", "reminder", "fewshot"])
  const conversations = arms.map(arm => arm.conversation)
  assert.ok(conversations.every(value => value === conversations[0]))
  const parsed = JSON.parse(conversations[0])
  assert.equal(parsed.length, 1)
  assert.ok(parsed[0].user.includes("[excerpt: middle omitted]"))
  assert.ok(parsed[0].user.startsWith("BEGIN") && parsed[0].user.endsWith("END"))
  assert.ok(Buffer.byteLength(arms[1].prompt) <= 32768)
  assert.ok(arms[0].prompt.endsWith(conversations[0]))
  assert.ok(arms[1].prompt.endsWith(conversations[0]))
  assert.ok(arms[2].prompt.endsWith("Return only the JSON object for the user's next message, or {\"prompt\":null}."))
  assert.ok(arms[3].prompt.endsWith(conversations[0]))
  assert.throws(() => buildArms([]), /No usable conversation/)
})

const trial = (overrides: Partial<Trial> = {}): Trial => ({
  caseID: "unfinished", model: "provider/model#low", arm: "candidate", repeat: 0,
  conversation: '[{"user":"Show an example.","assistant":"Not shown yet."}]',
  latencyMs: 100, kind: "suggestion", prompt: "Show the example.", strict: true, ...overrides,
})

test("blind review hides models, arms, repetitions, and latency while deduplicating identical judgments", () => {
  const trials = [trial(), trial({ model: "other/model#low", arm: "baseline", latencyMs: 300 }), trial({ kind: "abstention", prompt: undefined }), trial({ kind: "failed", prompt: undefined, strict: false })]
  const rows = blindTrials(trials)
  assert.equal(rows.length, 2)
  assert.equal(trials[0].reviewID, trials[1].reviewID)
  assert.notEqual(trials[0].reviewID, trials[2].reviewID)
  assert.equal(trials[3].reviewID, undefined)
  assert.deepEqual(Object.keys(rows[0]).sort(), ["conversation", "id", "prompt"])
  assert.ok(rows.some(row => row.prompt === null))
})

test("summary reports precision and useful coverage separately without hiding invalid output or failures", () => {
  const trials = [
    trial({ reviewID: "useful", latencyMs: 10 }),
    trial({ reviewID: "wrong", latencyMs: 20 }),
    trial({ reviewID: "null", kind: "abstention", prompt: undefined, latencyMs: 30 }),
    trial({ kind: "invalid", prompt: undefined, strict: false, latencyMs: 40 }),
    trial({ kind: "failed", prompt: undefined, strict: false, latencyMs: 50 }),
  ]
  const scores = [
    { id: "useful", useful: true, unsupported: false, languageCorrect: true },
    { id: "wrong", useful: false, unsupported: true, languageCorrect: false },
    { id: "null", useful: false, unsupported: false, languageCorrect: true },
  ]
  assert.deepEqual(summarize(trials, scores), {
    attempts: 5, suggestions: 2, abstentions: 1, invalid: 1, failures: 1,
    strictCompliance: 0.75, coverage: 0.4, nullRate: 0.2, precision: 0.5,
    usefulCoverage: 0.2, unsupportedRate: 0.5, languageAccuracy: 0.5,
    unscored: 0, p50Ms: 20, p95Ms: 40,
  })
  assert.equal(summarize([], []).precision, null)
  assert.equal(summarize([trial()], []).precision, null)
  assert.equal(summarize([trial()], []).unscored, 1)
  assert.equal(summarize([trial({ kind: "failed", strict: false })], []).strictCompliance, null)
})

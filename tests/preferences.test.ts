import { test } from "node:test"
import assert from "node:assert/strict"
import { parsePreferences, resolvePreferences, validatePreferenceFields } from "../src/preferences.ts"
import { parseOptions } from "../src/options.ts"

test("preferences use only present known fields and built-in defaults", () => {
  const value = resolvePreferences({ automatic: false }, "/server/context.md")
  assert.equal(value.fields.automatic, false)
  assert.equal(value.origins.automatic, "preferences")
  assert.equal(value.origins.models, "default")
  assert.equal(value.origins.debug, "default")
  assert.equal((value.rawOptions as any).contextFile, "/server/context.md")
  assert.equal(Object.hasOwn(value.fields, "debug"), false)
  assert.deepEqual(value.issues, [])
  assert.equal(parseOptions(value.rawOptions).ok, true)
})

test("preferences leave other defaults intact", () => {
  const value = resolvePreferences({ enabled: false, timeoutMs: 9000 })
  const parsed = parseOptions(value.rawOptions)
  assert.ok(parsed.ok)
  assert.equal(parsed.value.enabled, false)
  assert.equal(parsed.value.timeoutMs, 9000)
  assert.equal(parsed.value.contextTurns, 3)
})

test("numeric-null preferences are invalid before defaulting without changing legacy parsing", () => {
  for (const field of ["timeoutMs", "contextTurns"] as const) {
    const value = resolvePreferences({ [field]: null })
    assert.equal(value.fields[field], null)
    assert.equal(value.issues.some(issue => issue.field === field && issue.severity === "error"), true)
    assert.equal(parseOptions({ [field]: null }).ok, true)
  }
})

test("existing explicit no-model preferences remain valid", () => {
  const empty = resolvePreferences({ models: null })
  assert.equal(Object.hasOwn(empty.fields, "models"), false)
  assert.equal(Object.hasOwn(empty.rawOptions as object, "models"), false)
  assert.equal(empty.origins.models, "preferences")
  assert.deepEqual(empty.issues, [])
  assert.equal(resolvePreferences({}).fields.models, undefined)
})

test("strict JSON structure rejects duplicate keys, comments, trailing commas and future versions", () => {
  for (const text of [
    "", "null", "[]", "{}", '{"version":2,"settings":{}}', '{"version":1,"settings":null}',
    '{"version":1,"settings":[]}', '{"version":1,"settings":{},"version":1}',
    '{"version":1,"settings":{"debug":false,"debug":true}}',
    '{"version":1,"settings":{"future":{"a":1,"a":2}}}',
    '// comment\n{"version":1,"settings":{}}', '{"version":1,"settings":{},}',
  ]) assert.throws(() => parsePreferences(text), /preferences/i, text)
})

test("unknown document members survive parsing but never become effective options", () => {
  const doc = parsePreferences('{"version":1,"future":{"keep":true},"settings":{"debug":false,"future":"PRIVATE","__proto__":{"polluted":true}}}')
  assert.deepEqual(doc.future, { keep: true })
  assert.equal(doc.settings.future, "PRIVATE")
  assert.equal(Object.hasOwn(doc.settings, "__proto__"), true)
  const value = resolvePreferences(doc.settings)
  assert.deepEqual(value.fields, { debug: false })
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|polluted/)
  assert.equal(({} as any).polluted, undefined)
})

test("known preference fields retain exact validation bounds and explicit false", () => {
  for (const [field, values] of Object.entries({
    timeoutMs: [0, 2147483648, 1.5, null, "8000"],
    contextTurns: [0, 6, 1.5, null, "3"],
    enabled: [null, 0, "false"], automatic: [null, 1], debug: [null, "true"],
    includeGithubPRContext: [null, "false"], escalation: [null, "other"],
    models: [[], [[]], "broken"],
  })) for (const value of values) assert.ok(validatePreferenceFields({ [field]: value }).length, `${field}: ${JSON.stringify(value)}`)
  assert.deepEqual(validatePreferenceFields({ timeoutMs: 2147483647, contextTurns: 5, escalation: "automatic", models: [["local/*#low"], ["other/model"]] }), [])
  assert.deepEqual(validatePreferenceFields({ timeoutMs: 1, contextTurns: 1, escalation: "off" }), [])
  assert.deepEqual(validatePreferenceFields({ models: null }), [])
  const value = resolvePreferences({ enabled: false, automatic: false, debug: false, includeGithubPRContext: false })
  assert.deepEqual(value.fields, { enabled: false, automatic: false, debug: false, includeGithubPRContext: false })
})

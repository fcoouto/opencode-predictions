import { test } from "node:test"
import assert from "node:assert/strict"
import { changedFields, patchGroups, readGroups } from "../src/setup.ts"
import { parseOptions } from "../src/options.ts"

test("setup normalizes existing selector forms without flattening groups or expanding patterns", () => {
  assert.equal(readGroups({}), undefined)
  assert.deepEqual(readGroups({ models: "local/a, local/b#low" }), [["local/a", "local/b#low"]])
  assert.deepEqual(readGroups({ models: ["local/a, local/b", ["local/family/*#low"]] }), [["local/a", "local/b"], ["local/family/*#low"]])
})

test("edited groups use nested arrays and an empty model editor means absence", () => {
  assert.deepEqual(patchGroups(undefined), { models: undefined })
  assert.deepEqual(patchGroups([]), { models: undefined })
  const groups = [["local/a", "local/b#low"], ["local/family/*"]]
  const patch = patchGroups(groups)
  assert.deepEqual(patch, { models: [["local/a", "local/b#low"], ["local/family/*"]] })
  groups[0].push("local/c")
  assert.deepEqual(patch.models, [["local/a", "local/b#low"], ["local/family/*"]])
  assert.equal(parseOptions(patchGroups([[]])).ok, false)
})

test("invalid stored groups are not silently replaced with an empty model editor", () => {
  for (const models of [[], [[]], "broken", null, ["local/a", ""]]) assert.throws(() => readGroups({ models }))
})

test("only changed own fields are saved, preserving raw model syntax for unrelated edits", () => {
  const original = { models: "local/a, local/b", automatic: false }
  assert.deepEqual(changedFields(original, { ...original, debug: true }), { debug: true })
  assert.deepEqual(changedFields(original, { ...original, models: undefined }), { models: undefined })
  assert.deepEqual(changedFields({ models: [["local/a"]] }, { models: [["local/a"]] }), {})
  assert.deepEqual(changedFields({}, { models: undefined }), {})
  assert.deepEqual(changedFields(original, { debug: true }), { debug: true })
})

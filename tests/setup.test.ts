import { test } from "node:test"
import assert from "node:assert/strict"
import { changedFields, patchGroups, readGroups, waitForSetupSnapshot } from "../src/setup.ts"
import { parseOptions } from "../src/options.ts"
import { createSetupEditor, type SetupAPI, type SetupSnapshot } from "../src/setup.ts"

function editorFixture() {
  const snapshot: SetupSnapshot = { revision: "r1", source: "/server/config.jsonc", scope: "global", writable: true, fields: { automatic: false, models: "local/a" }, effective: { enabled: true, automatic: false, escalation: "manual", timeoutMs: 8000, contextTurns: 3, debug: false, includeGithubPRContext: false, models: ["local/a"] }, serviceVersion: "one", catalog: [], issues: [] }
  let writes = 0, reads = 0
  const api: SetupAPI = {
    read: async () => { reads++; return structuredClone(snapshot) },
    preview: async () => ({ groups: [], issues: [] }),
    save: async input => {
      writes++
      assert.equal(input.revision, "r1")
      snapshot.fields = { ...snapshot.fields, ...input.fields }
      if (input.removeModels) delete snapshot.fields.models
      snapshot.revision = "r2"; snapshot.serviceVersion = "two"
      const parsed = parseOptions(snapshot.fields)
      assert.equal(parsed.ok, true)
      if (parsed.ok) snapshot.effective = parsed.value
      return { kind: "saved", revision: "r2", serviceVersion: "two" }
    },
  }
  return { api, snapshot, counts: () => ({ writes, reads }) }
}

test("setup mounting retries do not retry schema or transport failures", async () => {
  for (const type of ["rpc.invalid_output", "rpc.invalid_input", "Transport"]) {
    let calls = 0
    await assert.rejects(waitForSetupSnapshot(async () => { calls++; throw { type } }, new AbortController().signal))
    assert.equal(calls, 1, type)
  }
})

test("setup mounting waits have a deadline even when a metadata call ignores cancellation", async () => {
  let calls = 0
  const pending = assert.rejects(waitForSetupSnapshot(async () => { calls++; return new Promise(() => {}) }, new AbortController().signal))
  await Promise.all([pending, new Promise(resolve => setTimeout(resolve, 2100))])
  assert.equal(calls, 1)
})

test("setup editor stages changed keys, discards locally, and never saves unchanged values", async () => {
  const f = editorFixture()
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  await editor.save()
  assert.equal(f.counts().writes, 0)
  editor.change({ debug: true })
  assert.equal(editor.state().dirty, true)
  assert.equal(f.snapshot.fields.debug, undefined)
  editor.discard()
  assert.equal(editor.state().dirty, false)
  editor.change({ debug: true })
  const save = f.api.save
  f.api.save = async (input, signal) => { assert.deepEqual(input.fields, { debug: true }); return save(input, signal) }
  assert.equal((await editor.save()).kind, "saved")
  assert.equal(editor.state().dirty, false)
  assert.equal(editor.state().snapshot?.revision, "r2")
  editor.dispose()
})

test("invalid drafts cannot write and stale preview responses cannot replace later edits", async () => {
  const f = editorFixture()
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  editor.setGroups([[]])
  assert.equal((await editor.save()).kind, "invalid")
  assert.equal(f.counts().writes, 0)
  editor.discard()
  let finish!: (value: { groups: []; issues: [] }) => void
  f.api.preview = async () => new Promise(resolve => { finish = resolve })
  const pending = editor.preview()
  editor.change({ debug: true })
  finish({ groups: [], issues: [] })
  await pending
  assert.equal(editor.state().preview, undefined)
  assert.equal(editor.state().fields.debug, true)
  editor.dispose()
})

test("save conflicts preserve the draft and require reload rather than repeat", async () => {
  const f = editorFixture()
  let writes = 0
  f.api.save = async () => { writes++; return { kind: "conflict", message: "Reload settings." } }
  const editor = createSetupEditor(f.api, () => {})
  await editor.load(); editor.change({ debug: true })
  assert.equal((await editor.save()).kind, "conflict")
  assert.equal(editor.state().fields.debug, true)
  assert.equal(editor.state().dirty, true)
  await editor.save()
  assert.equal(writes, 1)
  editor.dispose()
})

for (const active of [false, true]) test(`lost save acknowledgement reconciles durable fields with activation ${active}`, async () => {
  const f = editorFixture()
  let writes = 0
  f.api.save = async () => {
    writes++
    f.snapshot.revision = "r2"; f.snapshot.fields.debug = true
    if (active) { f.snapshot.effective!.debug = true; f.snapshot.serviceVersion = "two" }
    throw new Error("PRIVATE disconnected after commit")
  }
  const editor = createSetupEditor(f.api, () => {})
  await editor.load(); editor.change({ debug: true })
  const result = await editor.save()
  assert.equal(result.kind, active ? "saved" : "saved_not_active")
  assert.doesNotMatch(JSON.stringify(editor.state()), /PRIVATE/)
  assert.equal(editor.state().snapshot?.revision, "r2")
  assert.equal(editor.state().dirty, false)
  await editor.save()
  assert.equal(writes, 1)
  editor.dispose()
})

test("lost acknowledgement with unrelated newer bytes does not claim saved or rebase the draft", async () => {
  const f = editorFixture()
  f.api.save = async () => { f.snapshot.revision = "r2"; f.snapshot.fields.automatic = true; throw new Error("Lost") }
  const editor = createSetupEditor(f.api, () => {})
  await editor.load(); editor.change({ debug: true })
  assert.equal((await editor.save()).kind, "failed")
  assert.equal(editor.state().snapshot?.revision, "r1")
  assert.equal(editor.state().fields.debug, true)
  assert.equal(editor.state().dirty, true)
  editor.dispose()
})

test("disposed editor ignores late read responses and notifications", async () => {
  const f = editorFixture()
  let finish!: (value: SetupSnapshot) => void, notifications = 0
  f.api.read = async () => new Promise(resolve => { finish = resolve })
  const editor = createSetupEditor(f.api, () => { notifications++ })
  const loading = editor.load()
  editor.dispose()
  const before = notifications
  finish(f.snapshot)
  await loading
  assert.equal(notifications, before)
  assert.equal(editor.state().snapshot, undefined)
})

test("lost reply retries reads across reconnect but never repeats the save", async () => {
  const f = editorFixture()
  const read = f.api.read
  let disconnected = false, attempts = 0, writes = 0
  f.api.read = async signal => {
    if (disconnected && ++attempts === 1) throw new Error("Disconnected")
    return read(signal)
  }
  f.api.save = async () => {
    writes++; disconnected = true
    f.snapshot.revision = "r2"; f.snapshot.fields.debug = true
    f.snapshot.effective!.debug = true; f.snapshot.serviceVersion = "two"
    throw new Error("Lost reply")
  }
  const editor = createSetupEditor(f.api, () => {})
  await editor.load(); editor.change({ debug: true })
  assert.equal((await editor.save()).kind, "saved")
  assert.equal(writes, 1)
  assert.equal(attempts, 2)
  editor.dispose()
})

test("model removal uses its explicit wire flag and keeps unrelated omitted defaults absent", async () => {
  const f = editorFixture()
  const save = f.api.save
  f.api.save = async (input, signal) => {
    assert.deepEqual(input, { revision: "r1", fields: {}, removeModels: true })
    return save(input, signal)
  }
  const editor = createSetupEditor(f.api, () => {})
  await editor.load(); editor.setGroups(undefined)
  assert.equal((await editor.save()).kind, "saved")
  assert.equal(Object.hasOwn(f.snapshot.fields, "enabled"), false)
  assert.equal(Object.hasOwn(f.snapshot.fields, "models"), false)
  editor.dispose()
})

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

test("a read-only target shows the values predictions actually use, not an empty stored file", async () => {
  const { api, snapshot } = editorFixture()
  snapshot.writable = false
  snapshot.reason = "This configuration source is not verified for setup writes."
  snapshot.fields = {}
  const parsed = parseOptions({ models: [["local/a", "local/b#low"], "local/*"], automatic: false, timeoutMs: 9000, includeGithubPRContext: true })
  assert.equal(parsed.ok, true)
  if (parsed.ok) snapshot.effective = parsed.value
  const editor = createSetupEditor(api, () => {})
  await editor.load()
  const state = editor.state()
  assert.deepEqual(readGroups(state.fields), [["local/a", "local/b#low"], ["local/*"]])
  assert.deepEqual({ automatic: state.fields.automatic, timeoutMs: state.fields.timeoutMs, includeGithubPRContext: state.fields.includeGithubPRContext }, { automatic: false, timeoutMs: 9000, includeGithubPRContext: true })
  assert.equal(state.dirty, false, "showing effective values is not an edit")
})

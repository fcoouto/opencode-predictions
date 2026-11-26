import { test } from "node:test"
import assert from "node:assert/strict"
import { changedFields, patchGroups, readGroups, waitForSetupSnapshot } from "../src/setup.ts"
import { parseOptions } from "../src/options.ts"
import { createSetupEditor, type SaveInput, type SettingsInput, type SetupAPI, type SetupSnapshot } from "../src/setup.ts"
import { applyPreferenceChange, resolvePreferences } from "../src/preferences.ts"

function editorFixture() {
  const snapshot: SetupSnapshot = { revision: "r1", activeRevision: "r1", overrides: { automatic: false, models: "local/a" }, origins: resolvePreferences({ automatic: false, models: "local/a" }).origins, source: "/server/predictions.json", scope: "global", writable: true, fields: { automatic: false, models: "local/a" }, effective: { enabled: true, automatic: false, escalation: "manual", timeoutMs: 30000, contextTurns: 3, debug: false, includeGithubPRContext: false, models: ["local/a"] }, serviceVersion: "one", catalog: [], issues: [] }
  let writes = 0, reads = 0
  const api: SetupAPI = {
    read: async () => { reads++; return structuredClone(snapshot) },
    preview: async () => ({ groups: [], issues: [] }),
    save: async input => {
      writes++
      assert.equal(input.revision, "r1")
      snapshot.fields = { ...snapshot.fields, ...input.fields }
      if (input.removeModels) delete snapshot.fields.models
      snapshot.overrides = { ...snapshot.fields, ...(input.removeModels ? { models: null } : {}) }
      snapshot.revision = "r2"; snapshot.serviceVersion = "two"
      snapshot.activeRevision = "r2"
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

function preferenceEditorFixture(overrides: SettingsInput = {}) {
  const resolved = resolvePreferences(overrides), parsed = parseOptions(resolved.rawOptions)
  assert.ok(parsed.ok)
  const snapshot: SetupSnapshot = { revision: "r1", activeRevision: "r1", source: "/server/predictions.json", scope: "global", writable: true,
    fields: resolved.fields, overrides, origins: resolved.origins, effective: parsed.value,
    serviceVersion: "same-engine", catalog: [], issues: [] }
  const writes: SaveInput[] = []
  const api: SetupAPI = {
    read: async () => structuredClone(snapshot),
    preview: async () => ({ groups: [], issues: [] }),
    save: async input => {
      writes.push(structuredClone(input))
      const { revision: _, ...change } = input
      snapshot.overrides = applyPreferenceChange(snapshot.overrides, change)
      const next = resolvePreferences(snapshot.overrides), parsed = parseOptions(next.rawOptions)
      assert.ok(parsed.ok)
      Object.assign(snapshot, { fields: next.fields, origins: next.origins, effective: parsed.value, revision: "r2", activeRevision: "r2" })
      return { kind: "saved", revision: "r2", serviceVersion: "same-engine" }
    },
  }
  return { api, snapshot, writes }
}

test("reset stages an origin-only change until Save without restarting an equal-value engine", async () => {
  const f = preferenceEditorFixture({ debug: false })
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  editor.resetPreferences()
  assert.equal(editor.state().dirty, true)
  assert.deepEqual(editor.state().reset, ["debug"])
  assert.equal(editor.state().origins.debug, "default")
  assert.equal(f.writes.length, 0)
  assert.equal((await editor.save()).kind, "saved")
  assert.deepEqual(f.writes[0], { revision: "r1", fields: {}, reset: ["debug"] })
  assert.equal(editor.state().snapshot?.serviceVersion, "same-engine")
  editor.dispose()
})

test("Discard restores saved origins and editing after reset clears only the edited field's reset intent", async () => {
  const f = preferenceEditorFixture({ debug: true, automatic: false, timeoutMs: 8000 })
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  editor.resetPreferences()
  assert.equal(editor.state().origins.debug, "default")
  assert.equal(editor.state().origins.automatic, "default")
  editor.discard()
  assert.equal(editor.state().origins.debug, "preferences")
  assert.deepEqual(editor.state().reset, [])
  editor.resetPreferences()
  editor.change({ debug: true })
  assert.deepEqual(editor.state().reset, ["automatic", "timeoutMs"])
  assert.equal((await editor.save()).kind, "saved")
  assert.deepEqual(f.writes[0], { revision: "r1", fields: {}, reset: ["automatic", "timeoutMs"] })
  assert.deepEqual(f.snapshot.overrides, { debug: true })
  editor.dispose()
})

test("last-model removal leaves no models configured", async () => {
  const f = preferenceEditorFixture({ models: "local/first" })
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  editor.setGroups([])
  assert.equal((await editor.save()).kind, "saved")
  assert.deepEqual(f.writes[0], { revision: "r1", fields: {}, removeModels: true })
  assert.deepEqual(f.snapshot.overrides, { models: null })
  assert.equal(f.snapshot.fields.models, undefined)
  assert.equal(editor.state().origins.models, "preferences")
  editor.dispose()
})

test("lost reply cannot claim Saved for matching effective values with different persisted intent", async () => {
  const f = preferenceEditorFixture({ debug: false })
  f.api.save = async input => { f.writes.push(input); throw new Error("Disconnected") }
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  editor.resetPreferences()
  assert.equal((await editor.save()).kind, "failed")
  assert.equal(editor.state().dirty, true)
  assert.deepEqual(editor.state().reset, ["debug"])
  editor.dispose()
})

test("administrative masking cannot prove a reset persisted after a lost acknowledgement", async () => {
  const f = preferenceEditorFixture({ debug: false })
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  editor.resetPreferences()
  f.api.save = async () => {
    Object.assign(f.snapshot, { revision: "managed", activeRevision: "managed", writable: false, overrides: {}, fields: { debug: false }, reason: "Administrative configuration prevents user prediction preferences." })
    throw new Error("Disconnected before acknowledgement")
  }
  assert.equal((await editor.save()).kind, "failed")
  assert.equal(editor.state().dirty, true)
  assert.deepEqual(editor.state().reset, ["debug"])
  editor.dispose()
})

for (const intent of ["edit", "reset"] as const) test(`unverified Save preserves ${intent} intent and original revision after another writer replaces preferences`, async () => {
  const f = preferenceEditorFixture({ debug: false })
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  const before = structuredClone(editor.state().snapshot)
  if (intent === "reset") editor.resetPreferences()
  else editor.change({ debug: true })
  const draft = structuredClone(editor.state().fields), reset = [...editor.state().reset]
  let writes = 0
  f.api.save = async () => {
    writes++
    const resolved = resolvePreferences({ automatic: true })
    const parsed = parseOptions(resolved.rawOptions)
    assert.ok(parsed.ok)
    Object.assign(f.snapshot, { revision: "external", activeRevision: "external", overrides: { automatic: true }, fields: resolved.fields, origins: resolved.origins, effective: parsed.value })
    return { kind: "saved_not_active", revision: "external", message: "Saved on disk. Effective activation is not verified." }
  }
  assert.equal((await editor.save()).kind, "saved_not_active")
  assert.equal(editor.state().dirty, true)
  assert.equal(editor.state().blocked, true)
  assert.deepEqual(editor.state().snapshot, before, "another writer's revision cannot be attached to this draft")
  assert.deepEqual(editor.state().fields, draft)
  assert.deepEqual(editor.state().reset, reset)
  assert.equal((await editor.save()).kind, "failed")
  assert.equal(writes, 1, "a blocked draft requires explicit reload, not another automatic or manual transaction")
  editor.dispose()
})

test("durable acknowledgement without readback retains the unresolved draft and reset", { timeout: 4000 }, async () => {
  const f = preferenceEditorFixture({ debug: false })
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  editor.resetPreferences()
  const before = structuredClone(editor.state().snapshot)
  f.api.save = async () => {
    f.api.read = async () => new Promise(() => {})
    return { kind: "saved_not_active", revision: "r2", message: "Saved on disk." }
  }
  assert.equal((await editor.save()).kind, "saved_not_active")
  assert.equal(editor.state().dirty, true)
  assert.equal(editor.state().blocked, true)
  assert.deepEqual(editor.state().snapshot, before)
  assert.deepEqual(editor.state().reset, ["debug"])
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
    f.snapshot.revision = "r2"; f.snapshot.fields.debug = true; f.snapshot.overrides.debug = true
    f.snapshot.activeRevision = active ? "r2" : null
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
    f.snapshot.overrides.debug = true; f.snapshot.activeRevision = "r2"
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

test("after a conflict the next Save explains that settings must be reloaded, and reloading clears the block", async () => {
  const { api, snapshot } = editorFixture()
  const editor = createSetupEditor({ ...api, save: async () => ({ kind: "conflict", message: "Configuration changed. Reload settings before trying again." }) }, () => {})
  await editor.load()
  editor.change({ debug: true })
  assert.equal((await editor.save()).kind, "conflict")
  assert.equal(editor.state().blocked, true)
  editor.change({ debug: false }); editor.change({ debug: true })
  const again = await editor.save()
  assert.equal(again.kind, "failed")
  assert.match((again as { message: string }).message, /Reload settings/)
  assert.deepEqual(editor.state().lastSave, again, "the page can show why Save did nothing")
  await editor.load()
  assert.equal(editor.state().blocked, false)
  void snapshot
})

test("a failed preview is reported separately and never looks like a load failure that discards the draft", async () => {
  const { api } = editorFixture()
  const editor = createSetupEditor({ ...api, preview: async () => { throw new Error("PRIVATE") } }, () => {})
  await editor.load()
  editor.change({ debug: true })
  await editor.preview()
  const state = editor.state()
  assert.equal(state.error, undefined, "state.error means settings could not be loaded")
  assert.equal(state.previewError, "Model preview is unavailable.")
  assert.equal(state.dirty, true)
  assert.equal(state.fields.debug, true, "the draft is intact")
})

test("parseSelector tells catalog models from patterns and splits the reasoning variant", async () => {
  const { parseSelector } = await import("../src/setup.ts")
  const familyA = { providerID: "local", id: "family/a", name: "Family A", enabled: true, variants: [{ id: "low" }, { id: "high" }] }
  const modelB = { providerID: "local", id: "b", name: "Model B", enabled: true, variants: [] }
  const catalog = [familyA, modelB] as unknown as SetupSnapshot["catalog"]
  assert.deepEqual(parseSelector("local/family/a#low", catalog), { kind: "model", model: familyA, variant: "low" })
  assert.deepEqual(parseSelector("local/b", catalog), { kind: "model", model: modelB, variant: undefined })
  assert.deepEqual(parseSelector("local/family-*", catalog), { kind: "pattern" })
  assert.deepEqual(parseSelector("local/gone#low", catalog), { kind: "pattern" })
})

function contextEditorFixture(status: unknown = { set: false }) {
  const f = editorFixture()
  const inputs: SaveInput[] = []
  let stored = structuredClone(status) as unknown
  const save = f.api.save
  f.api.save = async (input, signal) => {
    inputs.push(structuredClone(input))
    const result = await save(input, signal)
    // A successful save leaves the stored path that the server's status reports.
    if (input.contextFile === "managed") stored = { set: true, path: "~/predictions-context.md", absolute: "/server/predictions-context.md", managed: true, state: "empty", bytes: 0 }
    if (input.contextFile === "none") stored = { set: false }
    return result
  }
  f.api.contextStatus = async () => structuredClone(stored) as never
  return { ...f, inputs }
}

test("staging the managed context file dirties the draft and sends it beside the field changes", async () => {
  const f = contextEditorFixture()
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  assert.equal(editor.state().dirty, false)
  editor.setContextFile("managed")
  assert.equal(editor.state().contextChange, "managed")
  assert.equal(editor.state().dirty, true)
  assert.equal((await editor.save()).kind, "saved")
  assert.deepEqual(f.inputs[0], { revision: "r1", fields: {}, contextFile: "managed" })
  assert.equal(editor.state().contextChange, undefined)
  assert.equal(editor.state().dirty, false)
  editor.dispose()
})

test("discard and load clear a staged context change while reset leaves it", async () => {
  const f = contextEditorFixture({ set: false })
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  editor.setContextFile("none")
  editor.discard()
  assert.equal(editor.state().contextChange, undefined)
  assert.equal(editor.state().dirty, false)
  editor.setContextFile("managed")
  await editor.load()
  assert.equal(editor.state().contextChange, undefined)
  assert.equal(editor.state().dirty, false)
  editor.setContextFile("none")
  editor.resetPreferences()
  assert.equal(editor.state().contextChange, "none")
  assert.equal(editor.state().dirty, true)
  editor.dispose()
})

test("an unsafe context file refusal keeps the draft unblocked so the next Save can retry", async () => {
  const f = contextEditorFixture()
  const save = f.api.save
  const refusal = { kind: "invalid" as const, issues: [{ field: "contextFile" as const, severity: "error" as const, code: "unsafe_context_file", message: "predictions-context.md exists but is not safe to use: it is a link. Fix or remove it, then save again." }] }
  f.api.save = async input => { f.inputs.push(structuredClone(input)); return refusal }
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  editor.setContextFile("managed")
  assert.deepEqual(await editor.save(), refusal)
  assert.equal(editor.state().blocked, false)
  assert.equal(editor.state().dirty, true)
  assert.equal(editor.state().contextChange, "managed")
  assert.equal(editor.state().issues.find(issue => issue.field === "contextFile")?.code, "unsafe_context_file")
  f.api.save = save
  assert.equal((await editor.save()).kind, "saved")
  assert.equal(f.inputs.length, 2)
  assert.deepEqual(f.inputs[1], { revision: "r1", fields: {}, contextFile: "managed" })
  editor.dispose()
})

for (const status of ["unsupported", "unavailable"] as const) test(`context status "${status}" leaves the context change unstageable`, async () => {
  const f = contextEditorFixture(status)
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  assert.equal(editor.state().context, status)
  editor.setContextFile("managed")
  assert.equal(editor.state().contextChange, undefined)
  assert.equal(editor.state().dirty, false)
  editor.dispose()
})

test("a read-only snapshot or an unknown context status cannot stage a context change", async () => {
  const readOnly = contextEditorFixture({ set: false })
  readOnly.snapshot.writable = false
  readOnly.snapshot.reason = "This configuration source is not verified for setup writes."
  const readOnlyEditor = createSetupEditor(readOnly.api, () => {})
  await readOnlyEditor.load()
  readOnlyEditor.setContextFile("managed")
  assert.equal(readOnlyEditor.state().contextChange, undefined)
  readOnlyEditor.dispose()

  const absent = editorFixture()
  const absentEditor = createSetupEditor(absent.api, () => {})
  await absentEditor.load()
  absentEditor.setContextFile("managed")
  assert.equal(absentEditor.state().contextChange, undefined)
  absentEditor.dispose()
})

test("a missing contextStatus method reports unavailable and stages nothing", async () => {
  const f = editorFixture()
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  assert.equal(editor.state().context, "unavailable")
  editor.setContextFile("managed")
  assert.equal(editor.state().contextChange, undefined)
  editor.dispose()
})

test("a lost managed save is confirmed only when the stored context status shows the managed file", async () => {
  const managed = { set: true, path: "~/predictions-context.md", absolute: "/server/predictions-context.md", managed: true, state: "empty", bytes: 0 } as const
  for (const [status, confirmed] of [[managed, true], [{ set: false }, false], [{ set: true, path: "~/other.md", absolute: "/server/other.md", managed: false, state: "ok", bytes: 3 }, false], ["unavailable", false], ["unsupported", false]] as const) {
    const f = contextEditorFixture({ set: false })
    f.api.save = async input => {
      f.inputs.push(structuredClone(input))
      // An unrelated writer changes the revision while fields and overrides still match.
      Object.assign(f.snapshot, { revision: "external", activeRevision: "external" })
      throw new Error("Lost reply")
    }
    const editor = createSetupEditor(f.api, () => {})
    await editor.load()
    // Stage from a readable status first, then let the save's own readback see the status under test.
    f.api.contextStatus = async () => ({ set: false })
    await editor.refreshContext()
    editor.setContextFile("managed")
    f.api.contextStatus = async () => structuredClone(status) as never
    const result = await editor.save()
    assert.equal(f.inputs[0]?.contextFile, "managed")
    if (confirmed) {
      assert.notEqual(result.kind, "failed")
      assert.equal(editor.state().contextChange, undefined)
      assert.equal(editor.state().dirty, false)
    } else {
      assert.deepEqual(result, { kind: "failed", message: "Changes may have been saved. Reopen settings before trying again." })
      assert.equal(editor.state().contextChange, "managed")
      assert.equal(editor.state().dirty, true)
      assert.equal(editor.state().blocked, true)
      assert.equal(editor.state().snapshot?.revision, "r1", "an unverified readback is not adopted")
    }
    editor.dispose()
  }
})

test("a durable saved_not_active acknowledgment survives an unconfirmed context status and keeps the draft blocked", async () => {
  for (const status of [{ set: false }, "unavailable", "unsupported"] as const) {
    const f = contextEditorFixture({ set: false })
    f.api.save = async input => {
      f.inputs.push(structuredClone(input))
      // The server acknowledges the write; the stored path does not show the requested managed file.
      Object.assign(f.snapshot, { revision: "r2", activeRevision: "r2" })
      return { kind: "saved_not_active", revision: "r2", message: "Saved on disk. Effective activation is not verified." }
    }
    const editor = createSetupEditor(f.api, () => {})
    await editor.load()
    f.api.contextStatus = async () => structuredClone(status) as never
    editor.setContextFile("managed")
    const result = await editor.save()
    assert.deepEqual(result, { kind: "saved_not_active", revision: "r2", message: "Saved on disk. Effective activation is not verified." }, JSON.stringify(status))
    assert.equal(editor.state().contextChange, "managed")
    assert.equal(editor.state().dirty, true)
    assert.equal(editor.state().blocked, true)
    assert.equal(editor.state().snapshot?.revision, "r1", "an unconfirmed readback is not adopted")
    editor.dispose()
  }
})

test("a lost none save is confirmed only when the stored context status shows no context file", async () => {
  for (const [status, confirmed] of [[{ set: false }, true], [{ set: true, path: "~/notes.md", absolute: "/server/notes.md", managed: false, state: "ok", bytes: 3 }, false]] as const) {
    const f = contextEditorFixture({ set: false })
    f.api.save = async () => {
      Object.assign(f.snapshot, { revision: "external", activeRevision: "external" })
      throw new Error("Lost reply")
    }
    f.api.contextStatus = async () => structuredClone(status) as never
    const editor = createSetupEditor(f.api, () => {})
    await editor.load()
    editor.setContextFile("none")
    const result = await editor.save()
    if (confirmed) assert.notEqual(result.kind, "failed")
    else {
      assert.equal(result.kind, "failed")
      assert.equal(editor.state().contextChange, "none")
      assert.equal(editor.state().blocked, true)
    }
    editor.dispose()
  }
})

test("overlapping context refreshes keep the newer reply", async () => {
  const f = contextEditorFixture()
  const editor = createSetupEditor(f.api, () => {})
  await editor.load()
  const replies: ((value: unknown) => void)[] = []
  f.api.contextStatus = () => new Promise(resolve => replies.push(resolve as (value: unknown) => void))
  const older = editor.refreshContext(), newer = editor.refreshContext()
  assert.equal(editor.state().contextLoading, true)
  const fresh = { set: true, path: "~/notes.md", absolute: "/home/notes.md", managed: false, state: "ok", bytes: 3 }
  replies[1]!(fresh)
  await newer
  replies[0]!({ set: false })
  await older
  assert.deepEqual(editor.state().context, fresh)
  assert.equal(editor.state().contextLoading, false)
  editor.dispose()
})

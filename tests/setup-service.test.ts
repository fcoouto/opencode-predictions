import { test } from "node:test"
import assert from "node:assert/strict"
import { createSetupService } from "../src/setup-service.ts"
import { createPreferencesRuntime } from "../src/preferences-runtime.ts"
import { createPreferencesStore, managedContextPath, type PreferenceRead, type PreferencesStore } from "../src/preferences-store.ts"
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { CatalogModel } from "../src/models.ts"
import { changedFields, type SaveInput, type SettingsInput } from "../src/setup.ts"
import { Predictions } from "../src/rpc.ts"
import { createService, type ServiceAPI } from "../src/service.ts"
import { JsonSchema, Schema, SchemaRepresentation } from "effect"

test("save validates full prospective fields before writing and rejects stale revisions", async () => {
  const f = fixture({ models: "broken" })
  await f.runtime.refresh(signal())
  let revision = f.runtime.state().revision
  assert.equal((await f.service.save({ revision, fields: { debug: true } }, signal())).kind, "invalid")
  assert.deepEqual(f.counts(), { metadataCalls: 0, writes: 0 })
  f.snapshot.overrides = { automatic: false }; f.snapshot.revision = "r2"
  assert.equal((await f.service.save({ revision: "old", fields: { debug: true } }, signal())).kind, "conflict")
  assert.equal((await f.service.save({ revision, fields: { timeoutMs: null } }, signal())).kind, "invalid")
  await assert.rejects(f.service.save({ revision, fields: {}, source: "/client/config" } as any, signal()), /Unknown/)
  assert.equal(f.counts().writes, 0)
})

test("durable bytes are not activation proof", async () => {
  const f = fixture()
  let patch: SettingsInput | undefined
  f.store.write = async (revision, input) => {
    assert.equal(revision, "r1")
    patch = input.fields
    return { kind: "written", revision: "r2" }
  }
  await f.runtime.refresh(signal())
  const result = await f.service.save({ revision: f.runtime.state().revision, fields: { automatic: false, debug: true } }, signal())
  assert.deepEqual(patch, { debug: true })
  assert.equal(result.kind, "saved_not_active")
  assert.equal(f.counts().metadataCalls, 0)
})

test("save unchanged settings avoids replacement and explicit removal does not invent model defaults", async () => {
  const f = fixture()
  await f.runtime.refresh(signal())
  const revision = f.runtime.state().revision
  assert.equal((await f.service.save({ revision, fields: { automatic: false } }, signal())).kind, "saved")
  assert.equal(f.counts().writes, 0)
  f.store.write = async (_revision, input) => {
    assert.deepEqual(input, { fields: {}, removeModels: true })
    f.snapshot.overrides = { automatic: false, models: null }; f.snapshot.revision = "r2"
    return { kind: "written", revision: "r2" }
  }
  assert.equal((await f.service.save({ revision, fields: {}, removeModels: true }, signal())).kind, "saved")
})

const catalog = [
  { providerID: "local", id: "family/a", name: "模型 A", enabled: true, variants: [{ id: "low", private: "PRIVATE_VARIANT" }], private: "PRIVATE_CATALOG" },
  { providerID: "local", id: "family/b", name: "Disabled", enabled: false, variants: [], private: "PRIVATE_CATALOG" },
  { providerID: "local", id: "other", name: "Other", enabled: true, variants: [], private: "PRIVATE_CATALOG" },
]
const signal = () => new AbortController().signal
// Context-file paths are not used by these fixtures; any call is a test mistake.
const noPaths = { managed: (): never => { throw new Error("Unexpected managed path") }, home: "/server-home", platform: process.platform }
function fixture(fields: SettingsInput = { models: "local/family/a#low", automatic: false }) {
  let metadataCalls = 0, writes = 0
  const snapshot: PreferenceRead = { revision: "r1", source: "/server/predictions.json", writable: true, documentValid: true, policy: "user", overrides: fields }
  const store: PreferencesStore = { read: async () => structuredClone(snapshot), write: async () => { writes++; throw new Error("Unexpected write") } }
  const runtime = createPreferencesRuntime(store, options => createService({
    session: async () => { throw new Error("Unexpected session") },
    context: async () => { throw new Error("Unexpected context") },
    models: async () => catalog,
    generate: async () => { throw new Error("Unexpected generation") },
  }, options, "/server"))
  const service = createSetupService(store, async () => { metadataCalls++; return catalog }, runtime, noPaths)
  return { service, store, snapshot, runtime, counts: () => ({ metadataCalls, writes }) }
}

test("setup reads stored and effective fields separately and returns only safe model metadata", async () => {
  const f = fixture()
  const snapshot = await f.service.read(signal())
  assert.equal(snapshot.source, "/server/predictions.json")
  assert.equal(snapshot.revision, f.runtime.state().revision)
  assert.deepEqual(snapshot.fields, { models: "local/family/a#low", automatic: false })
  assert.equal(snapshot.serviceVersion, f.runtime.state().service.status().version)
  assert.equal(snapshot.activeRevision, snapshot.revision)
  assert.equal(snapshot.origins.models, "preferences")
  assert.deepEqual(snapshot.overrides, snapshot.fields)
  assert.deepEqual(snapshot.effective, { enabled: true, models: ["local/family/a#low"], automatic: false, escalation: "manual", timeoutMs: 30000, contextTurns: 3, debug: false, includeGithubPRContext: false })
  assert.deepEqual(snapshot.catalog, catalog.map(({ providerID, id, name, enabled, variants }) => ({ providerID, id, name, enabled, variants: variants.map(({ id }) => ({ id })) })))
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/)
  assert.deepEqual(f.counts(), { metadataCalls: 1, writes: 0 })
})

test("metadata preview shares earliest-group ownership while preserving distinct variants and selector rules", async () => {
  const f = fixture()
  const fields = { models: [["local/family/a#low"], ["local/family/*#low", "local/family/a", "local/other"]] }
  const before = JSON.stringify(fields)
  const preview = await f.service.preview(fields, signal())
  assert.deepEqual(preview.groups.map(group => group.selectors), fields.models)
  assert.deepEqual(preview.groups.map(group => group.candidates.map(model => model.id + "#" + (model.variant ?? ""))), [["family/a#low"], ["family/a#", "other#"]])
  const overlap = preview.issues.find(issue => issue.code === "overlap")
  assert.equal(overlap?.group, 1)
  assert.equal(overlap?.entry, 0)
  assert.match(overlap?.message ?? "", /Group 1/)
  assert.equal(JSON.stringify(fields), before)
  assert.deepEqual(f.counts(), { metadataCalls: 1, writes: 0 })
})

test("no match, disabled model and unsupported variant are warnings, not removed selections", async () => {
  const f = fixture()
  for (const [entry, code] of [["local/missing", "no_match"], ["local/family/b", "disabled_model"], ["local/family/a#high", "unsupported_variant"]]) {
    const preview = await f.service.preview({ models: [[entry]] }, signal())
    assert.deepEqual(preview.groups[0]?.selectors, [entry])
    assert.equal(preview.issues.some(issue => issue.code === code && issue.severity === "warning" && issue.group === 0 && issue.entry === 0), true, entry)
    assert.equal(preview.issues.some(issue => issue.severity === "error"), false)
  }
})

test("draft validation uses exact setting bounds and rejects null numbers without changing runtime defaults", async () => {
  const f = fixture()
  const invalid: [SettingsInput, string][] = [
    [{ timeoutMs: 0 }, "timeoutMs"], [{ timeoutMs: 2147483648 }, "timeoutMs"], [{ timeoutMs: 1.5 }, "timeoutMs"],
    [{ timeoutMs: null }, "timeoutMs"], [{ contextTurns: null }, "contextTurns"],
    [{ contextTurns: 0 }, "contextTurns"], [{ contextTurns: 6 }, "contextTurns"], [{ escalation: "other" }, "escalation"],
    [{ enabled: "yes" }, "enabled"], [{ models: [] }, "models"], [{ models: "broken" }, "models"],
  ]
  for (const [fields, field] of invalid) {
    const preview = await f.service.preview(fields, signal())
    assert.equal(preview.issues.some(issue => issue.field === field && issue.severity === "error"), true, field)
  }
  for (const escalation of ["off", "manual", "automatic"]) {
    const preview = await f.service.preview({ timeoutMs: 2147483647, contextTurns: 5, escalation }, signal())
    assert.deepEqual(preview.issues, [])
  }
  assert.deepEqual((await f.service.preview({ timeoutMs: 1, contextTurns: 1 }, signal())).issues, [])
})

test("invalid stored settings remain visible and do not become invented effective defaults", async () => {
  const f = fixture({ models: "broken" })
  f.snapshot.writable = false
  const snapshot = await f.service.read(signal())
  assert.equal(snapshot.fields.models, "broken")
  assert.equal(snapshot.effective, null)
  assert.equal(snapshot.writable, false)
  assert.equal(snapshot.issues.some(issue => issue.field === "models" && issue.severity === "error"), true)
})

test("unknown transport fields are rejected before metadata access", async () => {
  const f = fixture()
  await assert.rejects(f.service.preview({ secret: "PRIVATE" } as SettingsInput, signal()), /Unknown setting/)
  assert.deepEqual(f.counts(), { metadataCalls: 0, writes: 0 })
})

test("metadata failures return fixed safe errors and cancellation does not wait for ignored signals", async () => {
  const f = fixture()
  const failed = createSetupService(f.store, async () => { throw new Error("PRIVATE provider error") }, f.runtime, noPaths)
  await assert.rejects(failed.preview({}, signal()), error => error instanceof Error && error.message === "Model metadata is unavailable.")
  const pending = createSetupService(f.store, async () => new Promise<readonly CatalogModel[]>(() => {}), f.runtime, noPaths)
  const controller = new AbortController()
  const work = pending.preview({}, controller.signal)
  controller.abort()
  await assert.rejects(work)
})

test("setup metadata leaves runtime queue, session context and provider generation untouched", async () => {
  const f = fixture()
  let providerGenerateCalls = 0, sessionContextCalls = 0
  const api: ServiceAPI = {
    session: async id => ({ id, time: { idle: 1 }, location: { directory: "/server" } }),
    context: async () => { sessionContextCalls++; return [] },
    models: async () => catalog,
    generate: async () => { providerGenerateCalls++; return '{"prompt":null}' },
  }
  const owner = createPreferencesRuntime(f.store, options => createService(api, options, "/server"))
  await owner.refresh(signal())
  const runtime = owner.state().service, before = runtime.status()
  const setup = createSetupService(f.store, api.models, owner, noPaths)
  await setup.read(signal())
  await setup.preview({ models: ["local/other", "local/family/*"] }, signal())
  assert.deepEqual(runtime.status(), before)
  assert.equal(providerGenerateCalls, 0)
  assert.equal(sessionContextCalls, 0)
})

test("public RPC declares Save without a client-supplied target", () => {
  assert.ok("settingsV2" in Predictions.methods)
  assert.ok("previewSettings" in Predictions.methods)
  assert.equal("saveSettings" in Predictions.methods, true)
})

test("snapshot RPC requires complete valid provenance and accepts inactive revisions", async () => {
  const f = fixture()
  const snapshot = await f.service.read(signal())
  const schema = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(Predictions.methods.settingsV2.output)) as Schema.Codec<unknown>
  const read = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })
  read({ ...snapshot, activeRevision: null, effective: null })
  for (const key of ["overrides", "origins", "activeRevision"]) {
    const value = { ...snapshot } as Record<string, unknown>
    delete value[key]
    assert.throws(() => read(value))
  }
  assert.throws(() => read({ ...snapshot, origins: { ...snapshot.origins, debug: "server" } }))
  assert.throws(() => read({ ...snapshot, origins: {} }))
  assert.throws(() => read({ ...snapshot, activeRevision: 1 }))
  f.runtime.dispose()
})

test("setup rejects nonboolean GitHub PR context before writing and never retrieves PR data", async () => {
  const realFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (async () => { fetches++; throw new Error("PRIVATE network") }) as typeof fetch
  try {
    const f = fixture()
    for (const value of [null, 1, "true", [], {}]) {
      const input = { includeGithubPRContext: value } as SettingsInput
      assert.equal((await f.service.preview(input, signal())).issues.some(issue => issue.field === "includeGithubPRContext" && issue.severity === "error"), true, String(value))
      const result = await f.service.save({ revision: "r1", fields: input }, signal())
      assert.equal(result.kind, "invalid", String(value))
    }
    assert.equal((await f.service.preview({ includeGithubPRContext: true }, signal())).issues.length, 0)
    await f.service.read(signal())
    assert.deepEqual(f.counts().writes, 0)
    assert.equal(fetches, 0, "setup must not retrieve PR metadata")
  } finally { globalThis.fetch = realFetch }
})

test("GitHub PR context participates in changed-field detection and saved-not-active comparison", async () => {
  assert.deepEqual(changedFields({}, { debug: true }), { debug: true })
  assert.deepEqual(changedFields({ includeGithubPRContext: true }, { includeGithubPRContext: false }), { includeGithubPRContext: false })
  assert.deepEqual(changedFields({}, { includeGithubPRContext: false }), { includeGithubPRContext: false })
  const f = fixture()
  f.store.write = async () => ({ kind: "written", revision: "r2" })
  await f.runtime.refresh(signal())
  const result = await f.service.save({ revision: f.runtime.state().revision, fields: { includeGithubPRContext: true } }, signal())
  assert.equal(result.kind, "saved_not_active", "unchanged effective value means activation is unverified")
})

async function preferencesServiceFixture() {
  await mkdir(".test-artifacts", { recursive: true })
  const home = await mkdtemp(resolve(".test-artifacts/preferences-service-"))
  const host = { home, platform: process.platform, env: {}, systemPaths: [] }
  const store = createPreferencesStore(host)
  const calls = { session: 0, context: 0, generate: 0, pr: 0 }
  const runtime = createPreferencesRuntime(store, options => createService({
    session: async () => { calls.session++; throw new Error("Unexpected session") },
    context: async () => { calls.context++; return [] },
    generate: async () => { calls.generate++; return '{"prompt":null}' },
    includeGithubPRContext: async () => { calls.pr++; return [] },
    models: async () => catalog,
  }, options, "/server"))
  // Context-file status reads the temp home only; the real home is never inspected.
  const paths = { managed: () => managedContextPath(host), home, platform: process.platform }
  const setup = createSetupService(store, async () => catalog, runtime, paths)
  return { store, runtime, setup, calls, home, file: join(home, ".config/opencode/predictions.json"), managed: join(home, ".config/opencode/predictions-context.md") }
}

test("normal server saves preferences without source qualification", async () => {
  const f = await preferencesServiceFixture()
  const before = await f.setup.read(signal())
  assert.equal(before.writable, true)
  const saved = await f.setup.save({ revision: before.revision, fields: { automatic: false } }, signal())
  assert.equal(saved.kind, "saved")
  assert.deepEqual((await f.store.read(signal())).overrides, { automatic: false })
  const after = await f.setup.read(signal())
  assert.equal(after.origins.automatic, "preferences")
  assert.equal(after.activeRevision, after.revision)
  assert.deepEqual(f.calls, { session: 0, context: 0, generate: 0, pr: 0 })
  f.runtime.dispose()
})

test("server context path activates from disk and cannot be changed through Setup", async () => {
  const f = await preferencesServiceFixture()
  const before = await f.setup.read(signal())
  assert.equal((await f.setup.save({ revision: before.revision, fields: { debug: true } }, signal())).kind, "saved")
  const text = '{"version":1,"settings":{"contextFile":"/server/prediction-context.md","debug":true}}\n'
  await writeFile(f.file, text)
  const after = await f.setup.read(signal())
  assert.equal(f.runtime.state().service.status().contextFile, "/server/prediction-context.md")
  await assert.rejects(f.setup.save({ revision: after.revision, fields: { contextFile: "/server/private.txt" } as SettingsInput }, signal()), /Unknown setting/)
  await assert.rejects(f.setup.save({ revision: after.revision, fields: {}, reset: ["contextFile"] } as unknown as SaveInput, signal()), /changes are invalid/)
  assert.equal(await readFile(f.file, "utf8"), text)
  assert.equal((await f.setup.save({ revision: after.revision, fields: {}, reset: ["debug"] }, signal())).kind, "saved")
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).settings, { contextFile: "/server/prediction-context.md" })
  await writeFile(f.file, '{"version":1,"settings":{"contextFile":"relative.md"}}\n')
  const invalid = await f.setup.read(signal())
  assert.equal(invalid.effective, null)
  assert.equal(invalid.issues[0]?.field, "contextFile")
  assert.equal((await f.setup.save({ revision: invalid.revision, fields: { debug: true } }, signal())).kind, "invalid")
  f.runtime.dispose()
})

test("Save never accepts a path or unknown setting", async () => {
  const f = await preferencesServiceFixture()
  const { revision } = await f.setup.read(signal())
  for (const input of [
    { revision, fields: {}, path: "/client/path" }, { revision, fields: { unknown: true } },
    { revision, fields: {}, reset: ["debug", "debug"] }, { revision, fields: { debug: true }, reset: ["debug"] },
    { revision, fields: {}, reset: ["models"], removeModels: true }, { revision, fields: {}, reset: ["unknown"] },
    { revision, fields: {}, extra: "x".repeat(65537) },
  ]) await assert.rejects(f.setup.save(input as any, signal()))
  await assert.rejects(readFile(f.file), { code: "ENOENT" })
  f.runtime.dispose()
})

test("external preference changes conflict with a stale draft", async () => {
  const f = await preferencesServiceFixture()
  const before = await f.setup.read(signal())
  await f.store.write((await f.store.read(signal())).revision, { fields: { debug: true } }, signal())
  assert.equal((await f.setup.save({ revision: before.revision, fields: { automatic: false } }, signal())).kind, "conflict")
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).settings, { debug: true })
  f.runtime.dispose()
})

test("reset restores the default and clears the saved value", async () => {
  const f = await preferencesServiceFixture()
  let raw = await f.store.read(signal())
  assert.equal((await f.store.write(raw.revision, { fields: { timeoutMs: 8000 } }, signal())).kind, "written")
  const before = await f.setup.read(signal())
  assert.equal((await f.setup.save({ revision: before.revision, fields: {}, reset: ["timeoutMs"] }, signal())).kind, "saved")
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).settings, {})
  assert.equal((await f.setup.read(signal())).effective?.timeoutMs, 30000)
  f.runtime.dispose()
})

for (const field of ["timeoutMs", "contextTurns"] as const) test(`numeric-null ${field} stays visible and blocks unrelated Save`, async () => {
  const f = fixture({ [field]: null })
  const before = await f.service.read(signal())
  assert.equal(before.fields[field], null)
  assert.equal(before.activeRevision, null)
  assert.equal(before.effective, null)
  assert.equal(before.issues.some(issue => issue.field === field), true)
  assert.equal((await f.service.save({ revision: before.revision, fields: { debug: true } }, signal())).kind, "invalid")
  assert.equal(f.counts().writes, 0)
  f.runtime.dispose()
})

test("Save creates the managed context file and status reports it empty without contents", async () => {
  const f = await preferencesServiceFixture()
  assert.deepEqual(await f.setup.contextStatus(signal()), { set: false })
  const before = await f.setup.read(signal())
  assert.equal((await f.setup.save({ revision: before.revision, fields: {}, contextFile: "managed" }, signal())).kind, "saved")
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).settings, { contextFile: "~/.config/opencode/predictions-context.md" })
  assert.deepEqual(await f.setup.contextStatus(signal()), { set: true, path: "~/.config/opencode/predictions-context.md", absolute: f.managed, managed: true, state: "empty", bytes: 0 })
  assert.ok(f.managed.startsWith(f.home))
  f.runtime.dispose()
})

test("Save rejects any context file value other than managed or none before writing", async () => {
  const f = await preferencesServiceFixture()
  const { revision } = await f.setup.read(signal())
  for (const contextFile of ["/tmp/x", "~/x.md", "", null, true]) {
    await assert.rejects(f.setup.save({ revision, fields: {}, contextFile } as unknown as SaveInput, signal()), { name: "Error", message: "Invalid save input." })
  }
  await assert.rejects(readFile(f.file), { code: "ENOENT" })
  f.runtime.dispose()
})

test("none clears an invalid stored context path", async () => {
  const f = await preferencesServiceFixture()
  await mkdir(dirname(f.file), { recursive: true })
  await writeFile(f.file, '{"version":1,"settings":{"contextFile":"relative.md"}}\n')
  const invalid = await f.setup.read(signal())
  assert.equal(invalid.effective, null)
  assert.deepEqual(await f.setup.contextStatus(signal()), { set: true, path: "relative.md", absolute: "", managed: false, state: "unreadable" })
  assert.equal((await f.setup.save({ revision: invalid.revision, fields: {}, contextFile: "none" }, signal())).kind, "saved")
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).settings, {})
  assert.deepEqual(await f.setup.contextStatus(signal()), { set: false })
  f.runtime.dispose()
})

test("managed Save with a models edit is refused by a symlink and changes neither setting", async () => {
  const f = await preferencesServiceFixture()
  const original = '{"version":1,"settings":{"debug":true}}\n'
  await mkdir(dirname(f.file), { recursive: true })
  await writeFile(f.file, original)
  await writeFile(join(f.home, "target.md"), "")
  await symlink(join(f.home, "target.md"), f.managed)
  const before = await f.setup.read(signal())
  const result = await f.setup.save({ revision: before.revision, fields: { models: ["local/other"] }, contextFile: "managed" }, signal())
  assert.deepEqual(result, { kind: "invalid", issues: [{ field: "contextFile", severity: "error", code: "unsafe_context_file", message: "predictions-context.md exists but is not safe to use: it is a link. Fix or remove it, then save again." }] })
  assert.equal(await readFile(f.file, "utf8"), original)
  assert.deepEqual((await f.setup.read(signal())).overrides, { debug: true })
  f.runtime.dispose()
})

test("managed Save recreates a missing managed file and reports saved", async () => {
  const f = await preferencesServiceFixture()
  const first = await f.setup.read(signal())
  assert.equal((await f.setup.save({ revision: first.revision, fields: {}, contextFile: "managed" }, signal())).kind, "saved")
  await unlink(f.managed)
  assert.deepEqual(await f.setup.contextStatus(signal()), { set: true, path: "~/.config/opencode/predictions-context.md", absolute: f.managed, managed: true, state: "missing" })
  const second = await f.setup.read(signal())
  assert.equal((await f.setup.save({ revision: second.revision, fields: {}, contextFile: "managed" }, signal())).kind, "saved")
  assert.deepEqual(await f.setup.contextStatus(signal()), { set: true, path: "~/.config/opencode/predictions-context.md", absolute: f.managed, managed: true, state: "empty", bytes: 0 })
  f.runtime.dispose()
})

test("status reports a hand-set path as not managed and a 9000-byte managed file as too large", async () => {
  const f = await preferencesServiceFixture()
  await mkdir(join(f.home, "notes"), { recursive: true })
  await writeFile(join(f.home, "notes/context.md"), "hello")
  await mkdir(dirname(f.file), { recursive: true })
  await writeFile(f.file, '{"version":1,"settings":{"contextFile":"~/notes/context.md"}}\n')
  assert.deepEqual(await f.setup.contextStatus(signal()), { set: true, path: "~/notes/context.md", absolute: join(f.home, "notes/context.md"), managed: false, state: "ok", bytes: 5 })
  const before = await f.setup.read(signal())
  assert.equal((await f.setup.save({ revision: before.revision, fields: {}, contextFile: "managed" }, signal())).kind, "saved")
  await writeFile(f.managed, "a".repeat(9000))
  assert.deepEqual(await f.setup.contextStatus(signal()), { set: true, path: "~/.config/opencode/predictions-context.md", absolute: f.managed, managed: true, state: "too_large", bytes: 9000 })
  f.runtime.dispose()
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { createSetupService } from "../src/setup-service.ts"
import type { ConfigStore } from "../src/config.ts"
import type { CatalogModel } from "../src/models.ts"
import type { ConfigSnapshot, SettingsInput } from "../src/setup.ts"
import { Predictions } from "../src/rpc.ts"
import { createService, type ServiceAPI } from "../src/service.ts"

test("save validates full prospective fields before writing and rejects stale revisions", async () => {
  const f = fixture({ models: "broken" })
  assert.equal((await f.service.save({ revision: "r1", fields: { debug: true } }, signal())).kind, "invalid")
  assert.deepEqual(f.counts(), { metadataCalls: 0, writes: 0 })
  f.snapshot.fields = { automatic: false }
  assert.equal((await f.service.save({ revision: "old", fields: { debug: true } }, signal())).kind, "conflict")
  assert.equal((await f.service.save({ revision: "r1", fields: { timeoutMs: null } }, signal())).kind, "invalid")
  await assert.rejects(f.service.save({ revision: "r1", fields: {}, source: "/client/config" } as any, signal()), /Unknown/)
  assert.equal(f.counts().writes, 0)
})

test("save writes changed fields only and distinguishes durable bytes from effective activation", async () => {
  const f = fixture()
  let patch: SettingsInput | undefined
  f.store.write = async (revision, fields) => {
    assert.equal(revision, "r1")
    patch = fields
    f.snapshot.fields = { ...f.snapshot.fields, ...fields }
    f.snapshot.revision = "r2"
    return { kind: "written", revision: "r2" }
  }
  const result = await f.service.save({ revision: "r1", fields: { automatic: false, debug: true } }, signal())
  assert.deepEqual(patch, { debug: true })
  assert.equal(result.kind, "saved_not_active")
  assert.equal(f.counts().metadataCalls, 0)
})

test("save unchanged settings avoids replacement and explicit removal does not invent model defaults", async () => {
  const f = fixture()
  assert.equal((await f.service.save({ revision: "r1", fields: { automatic: false } }, signal())).kind, "saved")
  assert.equal(f.counts().writes, 0)
  f.store.write = async (_revision, fields) => {
    assert.deepEqual(fields, { models: undefined })
    f.snapshot.fields = { automatic: false }; f.snapshot.revision = "r2"
    return { kind: "written", revision: "r2" }
  }
  assert.equal((await f.service.save({ revision: "r1", fields: {}, removeModels: true }, signal())).kind, "saved_not_active")
})

const catalog = [
  { providerID: "local", id: "family/a", name: "模型 A", enabled: true, variants: [{ id: "low", private: "PRIVATE_VARIANT" }], private: "PRIVATE_CATALOG" },
  { providerID: "local", id: "family/b", name: "Disabled", enabled: false, variants: [], private: "PRIVATE_CATALOG" },
  { providerID: "local", id: "other", name: "Other", enabled: true, variants: [], private: "PRIVATE_CATALOG" },
]
const signal = () => new AbortController().signal
function fixture(fields: SettingsInput = { models: "local/family/a#low", automatic: false }) {
  let metadataCalls = 0, writes = 0
  const snapshot: ConfigSnapshot = { revision: "r1", source: "/server/global/opencode.jsonc", scope: "global", writable: true, fields }
  const store: ConfigStore = { read: async () => snapshot, write: async () => { writes++; throw new Error("Unexpected write") } }
  const current = { options: { ...fields, unknown: "PRIVATE_OPTION" } as unknown, version: "mount-one" }
  const service = createSetupService(store, async () => { metadataCalls++; return catalog }, () => current)
  return { service, store, snapshot, current, counts: () => ({ metadataCalls, writes }) }
}

test("setup reads stored and effective fields separately and returns only safe model metadata", async () => {
  const f = fixture()
  const snapshot = await f.service.read(signal())
  assert.equal(snapshot.source, "/server/global/opencode.jsonc")
  assert.equal(snapshot.revision, "r1")
  assert.deepEqual(snapshot.fields, { models: "local/family/a#low", automatic: false })
  assert.equal(snapshot.serviceVersion, "mount-one")
  assert.deepEqual(snapshot.effective, { enabled: true, models: ["local/family/a#low"], automatic: false, escalation: "manual", timeoutMs: 8000, contextTurns: 3, debug: false })
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
  const failed = createSetupService(f.store, async () => { throw new Error("PRIVATE provider error") }, () => f.current)
  await assert.rejects(failed.preview({}, signal()), error => error instanceof Error && error.message === "Model metadata is unavailable.")
  const pending = createSetupService(f.store, async () => new Promise<readonly CatalogModel[]>(() => {}), () => f.current)
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
  const runtime = createService(api, f.current.options, "/server")
  await runtime.inspect(signal())
  const before = runtime.status()
  const setup = createSetupService(f.store, api.models, () => ({ options: f.current.options, version: runtime.status().version }))
  await setup.read(signal())
  await setup.preview({ models: ["local/other", "local/family/*"] }, signal())
  assert.deepEqual(runtime.status(), before)
  assert.equal(providerGenerateCalls, 0)
  assert.equal(sessionContextCalls, 0)
})

test("public RPC declares read and preview without a write or client-supplied target", () => {
  assert.ok("settings" in Predictions.methods)
  assert.ok("previewSettings" in Predictions.methods)
  assert.equal("saveSettings" in Predictions.methods, false)
})

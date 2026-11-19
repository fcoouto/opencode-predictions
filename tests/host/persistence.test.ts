import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { createFixture } from "./fixture.mjs"
import { Predictions } from "../../src/rpc.ts"
import type { Status } from "../../src/service.ts"
import type { SetupSnapshot, SetupPreview } from "../../src/setup.ts"

for (const configSource of ["global-jsonc", "inline"] as const) {
  test(`setup settings and previews use public RPC without generating or editing ${configSource}`, { timeout: 60000 }, async () => {
    await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false }, {}, { configSource, projectConfig: true })
    const location = { directory: fixture.directory }
    const original = fixture.configFile ? await readFile(fixture.configFile, "utf8") : undefined
    const api = fixture.api.rpc(Predictions)
    let snapshot: SetupSnapshot | undefined
    await assert.doesNotReject(async () => { snapshot = await api.settingsV2({}, { location }) as SetupSnapshot })
    assert.ok(snapshot)
    assert.equal(snapshot.scope, "global")
    assert.equal(snapshot.effective?.automatic, false)
    assert.equal(snapshot.serviceVersion, (await api.status({}, { location }) as Status).version)
    assert.equal(snapshot.writable, true, "the selected server owns preference writes")
    assert.equal(snapshot.source, fixture.preferencesFile)
    assert.equal(snapshot.fields.models, "fixture/model")
    for (const model of snapshot.catalog) {
      assert.ok(Object.keys(model).every(key => ["providerID", "id", "name", "enabled", "variants"].includes(key)))
      assert.ok(model.variants.every(variant => Object.keys(variant).every(key => key === "id")))
    }
    assert.equal(Object.hasOwn(snapshot.fields, "obsolete"), false)
    const preview = await api.previewSettings({ fields: { models: [["fixture/model"], ["fixture/*", "fixture/missing"]] } }, { location }) as SetupPreview
    assert.equal(preview.groups[0].candidates.some(model => model.providerID === "fixture" && model.id === "model"), true)
    assert.equal(preview.groups[1].candidates.some(model => model.providerID === "fixture" && model.id === "model"), false)
    assert.equal(preview.issues.some(issue => issue.code === "overlap" && issue.group === 1), true)
    assert.equal(preview.issues.some(issue => issue.code === "no_match" && issue.group === 1 && issue.entry === 1), true)
    const invalid = await api.previewSettings({ fields: { timeoutMs: null } }, { location }) as SetupPreview
    assert.equal(invalid.issues.some(issue => issue.field === "timeoutMs" && issue.severity === "error"), true)
    await assert.rejects(api.settingsV2({ source: "/client/home/never-write.json" }, { location }))
    await assert.rejects(api.previewSettings({ fields: { source: "/client/home/never-write.json" } }, { location }))
    for (const method of ["proveLocalSettings"]) {
      await assert.rejects(fixture.api.rpc.call({ rpcID: Predictions.id, method, input: {}, location }), (error: any) => error.type === "rpc.method_not_found")
    }
    if (fixture.configFile) assert.equal(await readFile(fixture.configFile, "utf8"), original)
    assert.equal(fixture.calls.length, 0)
  })
}

for (const configSource of ["global-json", "global-jsonc"] as const) {
  test(`real-file fixture ${configSource} has no inline config override`, { timeout: 60000 }, async () => {
    await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false }, {}, { configSource })
    assert.equal(fixture.env.OPENCODE_CONFIG_CONTENT, undefined)
    assert.ok(fixture.configFile?.startsWith(fixture.root))
    const text = await readFile(fixture.configFile!, "utf8")
    if (configSource === "global-jsonc") assert.match(text, /\/\/ Synthetic global fixture configuration\./)
    const documents = await fixture.api.config.get({ location: { directory: fixture.directory } })
    assert.ok(documents.some(document => document.type === "document" && document.path === fixture.configFile))
    const status = await fixture.api.rpc(Predictions).status({}, { location: { directory: fixture.directory } }) as Status
    assert.equal(status.automatic, false)
    assert.equal(fixture.calls.length, 0)
  })
}

test("real-file fixture writeConfig changes the file rather than the inline environment", { timeout: 60000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false }, {}, { configSource: "global-json" })
  assert.equal(typeof fixture.writeConfig, "function")
  await fixture.writeConfig({ ...fixture.config, username: "synthetic-config-probe" })
  assert.equal(JSON.parse(await readFile(fixture.configFile!, "utf8")).username, "synthetic-config-probe")
  assert.equal(fixture.env.OPENCODE_CONFIG_CONTENT, undefined)
  assert.equal(fixture.calls.length, 0)
})

test("persistence API refuses plugin-option writes without touching global configuration", { timeout: 60000 }, async t => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false }, {}, { configSource: "global-jsonc" })
  const before = await readFile(fixture.configFile!, "utf8")
  const schemaResponse = await fetch(fixture.address + "/openapi.json", { headers: fixture.headers })
  assert.equal(schemaResponse.status, 200)
  const schema = await schemaResponse.json()
  const update = schema.paths["/api/experimental/config"].patch
  const reference = update.requestBody.content["application/json"].schema.$ref
  const patch = schema.components.schemas[reference.split("/").at(-1)]
  t.diagnostic("Config patch fields: " + JSON.stringify(Object.keys(patch.properties)))
  t.diagnostic("Config/plugin mutations: " + JSON.stringify(Object.entries(schema.paths).filter(([path]) => /config|plugin/.test(path)).flatMap(([path, methods]: [string, any]) => Object.keys(methods).filter(method => method !== "get").map(method => method.toUpperCase() + " " + path))))
  const response = await fetch(fixture.address + "/api/experimental/config", {
    method: "PATCH",
    headers: { ...fixture.headers, "content-type": "application/json" },
    body: JSON.stringify({ plugins: [{ package: fixture.config.plugins[0].package, options: { debug: true } }] }),
  })
  assert.equal(response.status, 400)
  assert.equal(await readFile(fixture.configFile!, "utf8"), before)
  assert.equal(fixture.calls.length, 0)
})

test("persistence discovery identifies the server's global document and local plugin source", { timeout: 60000 }, async t => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false }, {}, { configSource: "global-json" })
  const location = { directory: fixture.directory }
  const documents = await fixture.api.config.get({ location })
  const document = documents.find(entry => entry.type === "document" && entry.path === fixture.configFile)
  assert.ok(document?.type === "document")
  assert.equal(document.info.plugins?.some(entry => typeof entry !== "string" && entry.package === fixture.config.plugins[0].package), true)
  await fixture.api.rpc(Predictions).status({}, { location })
  const plugins = await fixture.api.plugin.list({ location })
  const plugin = plugins.data.find(entry => entry.id === "opencode-predictions")
  assert.ok(plugin)
  assert.equal(plugin.source.type, "local")
  t.diagnostic("Plugin source: " + JSON.stringify(plugin.source))
  assert.equal(fixture.calls.length, 0)
})

// Research candidate only: precomputed bytes isolate commit safety from JSONC editing.
async function optimisticReplace(file: string, expected: string, next: string, beforeRename = async () => {}) {
  const temporary = file + "." + crypto.randomUUID()
  try {
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(next); await handle.sync() } finally { await handle.close() }
    if (await readFile(file, "utf8") !== expected) return { kind: "conflict" }
    await beforeRename()
    await rename(temporary, file)
    return { kind: "written" }
  } finally { await rm(temporary, { force: true }) }
}

async function raceFixture() {
  await mkdir(".test-artifacts", { recursive: true })
  const root = await mkdtemp(resolve(".test-artifacts/persistence-race-"))
  const file = join(root, "opencode.jsonc")
  const original = '// keep this comment\n{"plugins":[{"package":"synthetic-predictions","options":{"debug":false}}],"username":"before"}\n'
  await writeFile(file, original, { mode: 0o600 })
  return { file, original, edited: original.replace('"debug":false', '"debug":true'), external: original.replace('"username":"before"', '"username":"external"') }
}

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("persistence candidate detects an edit made before the final comparison", async () => {
  const f = await raceFixture()
  await writeFile(f.file, f.external)
  assert.equal((await optimisticReplace(f.file, f.original, f.edited)).kind, "conflict")
  assert.equal(await readFile(f.file, "utf8"), f.external)
})

test("persistence candidate hash-check then rename loses an external edit after the final comparison", { timeout: 5000 }, async () => {
  const f = await raceFixture()
  const compared = barrier()
  const release = barrier()
  const pending = optimisticReplace(f.file, f.original, f.edited, async () => { compared.resolve(); await release.promise })
  await compared.promise
  try { await writeFile(f.file, f.external) } finally { release.resolve() }
  assert.equal((await pending).kind, "written")
  // A successful return has lost the external edit. This is NO-GO evidence, not a safe writer.
  assert.equal(await readFile(f.file, "utf8"), f.edited)
  assert.equal((await readFile(f.file, "utf8")).includes('"username":"external"'), false)
})

test("persistence candidate allows two stale clients to commit after both have compared", { timeout: 5000 }, async () => {
  const f = await raceFixture()
  const compared = barrier()
  const release = barrier()
  const first = optimisticReplace(f.file, f.original, f.edited, async () => { compared.resolve(); await release.promise })
  await compared.promise
  let second: { kind: string }
  try { second = await optimisticReplace(f.file, f.original, f.external) } finally { release.resolve() }
  assert.equal(second.kind, "written")
  assert.equal((await first).kind, "written")
  assert.equal(await readFile(f.file, "utf8"), f.edited)
})

test("persistence candidate leaves original bytes intact when commit is interrupted before rename", async () => {
  const f = await raceFixture()
  await assert.rejects(optimisticReplace(f.file, f.original, f.edited, async () => { throw new Error("Synthetic pre-commit failure") }), /Synthetic pre-commit failure/)
  assert.equal(await readFile(f.file, "utf8"), f.original)
})

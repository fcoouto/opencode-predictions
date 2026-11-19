import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { createFixture } from "./fixture.mjs"
import { Predictions } from "../../src/rpc.ts"
import { createSetupEditor, type SetupSnapshot, type SaveResult } from "../../src/setup.ts"
import { OpenCode } from "@opencode/client"

const signal = () => new AbortController().signal
const location = (f: Awaited<ReturnType<typeof createFixture>>) => ({ directory: f.directory })
const read = (f: Awaited<ReturnType<typeof createFixture>>, at = location(f)) => f.api.rpc(Predictions).settingsV2({}, { location: at }) as Promise<SetupSnapshot>
const save = (f: Awaited<ReturnType<typeof createFixture>>, input: unknown, at = location(f)) => f.api.rpc(Predictions).saveSettings(input, { location: at }) as Promise<SaveResult>

test("plugin options never affect two locations sharing one preference root", { timeout: 60000 }, async () => {
  await using a = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { projectConfig: true, configSource: "global-jsonc", seedPreferences: false, legacyOptions: { models: "fixture/model", contextTurns: 2 } })
  const other = join(a.root, "other-project")
  await mkdir(other)
  await writeFile(join(other, "opencode.json"), JSON.stringify({ plugins: [{ package: a.config.plugins[0].package, options: { models: "fixture/model", contextTurns: 1 } }] }))
  const first = await read(a), second = await read(a, { directory: other })
  await assert.rejects(a.api.rpc.call({ rpcID: Predictions.id, method: "settings", input: {}, location: location(a) }), (error: any) => error.type === "rpc.method_not_found")
  assert.equal((await save(a, { revision: "a".repeat(64), fields: {}, reset: ["models"] })).kind, "conflict")
  assert.equal(first.effective?.contextTurns, 3)
  assert.equal(second.effective?.contextTurns, 3)
  assert.equal(first.effective?.models, undefined)
  assert.equal(second.effective?.models, undefined)
  assert.equal(first.revision, second.revision)
  assert.equal((await save(a, { revision: first.revision, fields: { automatic: false } }, { directory: other })).kind, "saved")
  assert.equal((await read(a, { directory: other })).effective?.automatic, false)
  await using b = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { projectConfig: true, configHome: a.env.XDG_CONFIG_HOME, legacyOptions: { contextTurns: 4 } })
  const peer = await read(b)
  assert.equal(peer.source, first.source)
  assert.equal(peer.effective?.automatic, false)
  assert.equal(peer.effective?.contextTurns, 3)
  assert.equal((await save(b, { revision: peer.revision, fields: { debug: true } })).kind, "saved")
  assert.equal((await read(a)).effective?.debug, true)
  await a.restart()
  assert.equal((await read(a)).effective?.debug, true)
  assert.deepEqual(a.calls, []); assert.deepEqual(b.calls, [])
})

test("distinct server roots and pinned clients never write to another selected server", { timeout: 60000 }, async () => {
  await using a = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { projectConfig: true })
  await using b = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { projectConfig: true, seedPreferences: false })
  const before = await read(a)
  assert.equal((await save(a, { revision: before.revision, fields: { debug: true } })).kind, "saved")
  assert.equal((await read(b)).origins.debug, "default")
  await assert.rejects(readFile(b.preferencesFile), { code: "ENOENT" })
  assert.deepEqual(a.calls, []); assert.deepEqual(b.calls, [])
})

test("manual replacement and deletion invalidate stale drafts without editing OpenCode configuration", { timeout: 60000 }, async () => {
  await using f = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { configSource: "global-jsonc", projectConfig: true, legacyOptions: { debug: true } })
  const original = await readFile(f.configFile!), before = await read(f)
  assert.equal((await save(f, { revision: before.revision, fields: { debug: true } })).kind, "saved")
  const previous = await read(f), replacement = f.preferencesFile + ".external"
  await writeFile(replacement, '{"version":1,"settings":{"timeoutMs":7000},"future":{"keep":true}}\n', { mode: 0o600 })
  await rename(replacement, f.preferencesFile)
  assert.equal((await read(f)).effective?.timeoutMs, 7000)
  assert.equal((await save(f, { revision: previous.revision, fields: { automatic: false } })).kind, "conflict")
  await unlink(f.preferencesFile)
  const deleted = await read(f)
  assert.equal(deleted.effective?.timeoutMs, 8000)
  assert.equal(deleted.effective?.debug, false)
  assert.equal((await save(f, { revision: deleted.revision, fields: { automatic: false } })).kind, "saved")
  assert.deepEqual(await readFile(f.configFile!), original)
  assert.deepEqual(f.calls, [])
})

test("malformed and future preference files disable activation and cannot be overwritten", { timeout: 60000 }, async () => {
  await using f = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { projectConfig: true })
  for (const text of ["{bad", '{"version":2,"settings":{"debug":true}}']) {
    await writeFile(f.preferencesFile, text, { mode: 0o600 })
    const snapshot = await read(f)
    assert.equal(snapshot.writable, false)
    assert.equal(snapshot.activeRevision, null)
    assert.equal(snapshot.effective, null)
    assert.equal((await save(f, { revision: snapshot.revision, fields: { debug: false } })).kind, "read_only")
    assert.equal(await readFile(f.preferencesFile, "utf8"), text)
  }
  assert.deepEqual(f.calls, [])
})

for (const field of ["timeoutMs", "contextTurns"]) test(`numeric-null ${field} disables manual and startup activation and permits explicit repair`, { timeout: 60000 }, async () => {
  await using f = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { projectConfig: true })
  await writeFile(f.preferencesFile, JSON.stringify({ version: 1, settings: { [field]: null } }), { mode: 0o600 })
  for (const startup of [false, true]) {
    if (startup) await f.restart()
    const snapshot = await read(f)
    assert.equal(snapshot.fields[field as keyof typeof snapshot.fields], null)
    assert.equal(snapshot.activeRevision, null)
    assert.equal(snapshot.issues.some(issue => issue.field === field), true)
    assert.equal((await save(f, { revision: snapshot.revision, fields: { debug: true } })).kind, "invalid")
  }
  const before = await read(f)
  assert.equal((await save(f, { revision: before.revision, fields: { [field]: field === "timeoutMs" ? 8000 : 3 } })).kind, "saved")
  const after = await read(f)
  assert.equal(after.activeRevision, after.revision)
  assert.deepEqual(f.calls, [])
})

test("clearing and resetting models never restores legacy models", { timeout: 60000 }, async () => {
  await using f = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { projectConfig: true, legacyOptions: { models: "fixture/ignored" } })
  const before = await read(f)
  assert.equal((await save(f, { revision: before.revision, fields: {}, removeModels: true })).kind, "saved")
  const noModels = await read(f)
  assert.equal(noModels.fields.models, undefined)
  assert.equal(noModels.overrides.models, null)
  assert.equal((await save(f, { revision: noModels.revision, fields: {}, reset: ["models"] })).kind, "saved")
  const reset = await read(f)
  assert.equal(reset.fields.models, undefined)
  assert.equal(reset.origins.models, "default")
  await chmod(f.preferencesFile, 0o400)
  const readonly = await read(f)
  assert.equal(readonly.writable, false)
  assert.equal(readonly.activeRevision, readonly.revision)
  assert.equal((await save(f, { revision: readonly.revision, fields: { debug: true } })).kind, "read_only")
  await chmod(f.preferencesFile, 0o600)
  assert.deepEqual(f.calls, [])
})

test("a committed but lost HTTP acknowledgement reconciles through exactly one production Save", { timeout: 60000 }, async () => {
  await using f = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { projectConfig: true })
  let transactions = 0
  const client = OpenCode.make({ baseUrl: f.address, headers: f.headers, fetch: async (input, init) => {
    if (!String(input).includes("/saveSettings")) return fetch(input, init)
    transactions++
    const response = await fetch(input, init)
    await response.arrayBuffer()
    throw new Error("Test-only lost acknowledgement after commit")
  } })
  const rpc = client.rpc(Predictions), at = location(f)
  const editor = createSetupEditor({
    read: async () => await rpc.settingsV2({}, { location: at }) as SetupSnapshot,
    preview: async () => ({ groups: [], issues: [] }),
    save: async input => await rpc.saveSettings(input, { location: at }) as SaveResult,
  }, () => {})
  await editor.load(); editor.change({ debug: true })
  assert.equal((await editor.save()).kind, "saved")
  assert.equal(transactions, 1)
  const inode = (await stat(f.preferencesFile)).ino
  await editor.save()
  assert.equal(transactions, 1)
  assert.equal((await stat(f.preferencesFile)).ino, inode)
  assert.equal(editor.state().snapshot?.activeRevision, editor.state().snapshot?.revision)
  assert.deepEqual(f.calls, [])
  editor.dispose()
})

test("a server filesystem write failure preserves active bytes and never claims activation", { timeout: 60000 }, async () => {
  await using f = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { projectConfig: true })
  const before = await read(f)
  assert.equal((await save(f, { revision: before.revision, fields: { automatic: false } })).kind, "saved")
  const draft = await read(f), bytes = await readFile(f.preferencesFile), directory = join(f.env.XDG_CONFIG_HOME!, "opencode")
  await chmod(directory, 0o500)
  try {
    assert.equal((await save(f, { revision: draft.revision, fields: { debug: true } })).kind, "failed")
    assert.deepEqual(await readFile(f.preferencesFile), bytes)
  } finally { await chmod(directory, 0o700) }
  assert.deepEqual(f.calls, [])
})

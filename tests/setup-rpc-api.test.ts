import { test } from "node:test"
import assert from "node:assert/strict"
import { createTUISetupAPI } from "../src/setup-tui-api.ts"
import { createGUISetupAPI } from "../src/setup-gui-api.ts"
import { createSetupEditor, type SaveResult, type SetupPreview, type SetupSnapshot } from "../src/setup.ts"
import { resolvePreferences } from "../src/preferences.ts"
import fs from "node:fs/promises"
import net from "node:net"
import { syncBuiltinESMExports } from "node:module"

const snapshot: SetupSnapshot = {
  revision: "r1", activeRevision: "r1", scope: "global", source: "/remote/predictions.json", writable: true,
  fields: {}, overrides: {}, origins: resolvePreferences({}).origins,
  effective: { enabled: true, automatic: true, escalation: "manual", timeoutMs: 8000, contextTurns: 3, debug: false, includeGithubPRContext: false },
  serviceVersion: "one", catalog: [], issues: [],
}
const preview: SetupPreview = { groups: [], issues: [] }
const saved: SaveResult = { kind: "saved_not_active", revision: "r2", message: "Saved on disk." }
const signal = () => new AbortController().signal

for (const host of ["CLI", "Desktop"] as const) {
  test(`${host} cannot edit a server that only offers the legacy settings RPC`, async () => {
    let writes = 0
    const client = { rpc: () => ({ settings: async () => structuredClone(snapshot), saveSettings: async () => { writes++; return saved } }) }
    const location = { directory: "/project" }
    const api = host === "CLI" ? createTUISetupAPI({ client } as any, location)
      : createGUISetupAPI({ servers: { get: () => ({ client }) } } as any, { serverID: "remote", location })
    const editor = createSetupEditor(api, () => {})
    await editor.load()
    assert.equal(editor.state().snapshot, undefined)
    editor.resetPreferences()
    assert.equal((await editor.save()).kind, "failed")
    assert.equal(writes, 0)
    editor.dispose()
  })

  function fixture() {
    const calls: unknown[][] = []
    const rpc = { settingsV2: async () => structuredClone(snapshot), previewSettings: async () => preview,
      saveSettings: async (...args: unknown[]) => { calls.push(args); return saved } }
    let client = { rpc: () => rpc }
    let mainCalls = 0
    const ctx = { get client() { return client }, servers: { get: () => ({ client }) }, main() { mainCalls++; throw new Error("Do not use IPC") } }
    const location = { directory: "/project", workspaceID: "workspace" }
    const api = host === "CLI" ? createTUISetupAPI(ctx as any, location) : createGUISetupAPI(ctx as any, { serverID: "remote", location })
    return { api, rpc, calls, location, replace() { client = { rpc: () => rpc } }, mainCalls: () => mainCalls }
  }
  test(`ordinary ${host} Save uses only its selected RPC client`, async t => {
    const f = fixture()
    const deny = () => { throw new Error("Client touched local files or sockets") }
    t.mock.method(fs, "open", deny); t.mock.method(fs, "readFile", deny); t.mock.method(net, "createConnection", deny)
    syncBuiltinESMExports()
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    f.location.directory = "/changed-after-open"
    assert.equal((await f.api.read(signal())).writable, true)
    await f.api.preview({}, signal())
    assert.deepEqual(await f.api.save({ revision: "r1", fields: { debug: true } }, signal()), saved)
    assert.equal(f.calls.length, 1)
    assert.deepEqual((f.calls[0][1] as any).location, { directory: "/project", workspaceID: "workspace" })
    assert.equal(f.mainCalls(), 0)
  })
  test(`${host} rejects a client change during read and before Save without retargeting`, async () => {
    const f = fixture()
    let finish!: (value: SetupSnapshot) => void
    f.rpc.settingsV2 = () => new Promise(resolve => { finish = resolve })
    const pending = f.api.read(signal())
    f.replace(); finish(snapshot)
    await assert.rejects(pending, /target changed/)
    await assert.rejects(f.api.save({ revision: "r1", fields: { debug: true } }, signal()), /target changed/)
    assert.equal(f.calls.length, 0)
  })
  test(`${host} preserves the draft after target replacement and never repeats Save`, async () => {
    const f = fixture(), editor = createSetupEditor(f.api, () => {})
    await editor.load()
    editor.change({ debug: true })
    f.replace()
    assert.equal((await editor.save()).kind, "failed")
    assert.equal(editor.state().fields.debug, true)
    assert.equal(editor.state().dirty, true)
    assert.equal(f.calls.length, 0)
    editor.dispose()
  })
  test(`${host} treats a changed acknowledgement as ambiguous after one dispatched Save`, async () => {
    const f = fixture()
    const save = f.rpc.saveSettings
    f.rpc.saveSettings = async (...args) => { const result = await save(...args); f.replace(); return result }
    await assert.rejects(f.api.save({ revision: "r1", fields: { debug: true } }, signal()), /target changed/)
    assert.equal(f.calls.length, 1)
  })
}

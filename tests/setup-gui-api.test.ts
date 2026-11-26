import { test } from "node:test"
import assert from "node:assert/strict"
import { createGUISetupAPI } from "../src/setup-gui-api.ts"
import { createSetupEditor } from "../src/setup.ts"
import { nativeFixture } from "./setup-native-fixture.ts"
const signal = () => new AbortController().signal

test("GUI setup saves with no main IPC and no local file fallback", async t => {
  const f = await nativeFixture(t)
  const ctx = { servers: { get: () => ({ client: f.client }) }, main() { throw new Error("PRIVATE unavailable IPC") } }
  const api = createGUISetupAPI(ctx as any, { serverID: "sidecar", location: f.location })
  assert.equal((await api.read(signal())).writable, true)
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "saved_not_active")
  assert.equal(f.counts().saves, 1)
})
test("GUI setup rejects selected-client replacement instead of retargeting Save", async t => {
  const f = await nativeFixture(t)
  let client = f.client, saves = 0
  const ctx = {
    servers: { get: () => ({ client }) },
    main: () => ({ read: async () => f.snapshot, save: async () => { saves++; return { kind: "saved_not_active", revision: "two", message: "Saved on disk." } } }),
  }
  const api = createGUISetupAPI(ctx as any, { serverID: "sidecar", location: f.location })
  await api.read(signal())
  client = { ...f.client }
  await assert.rejects(api.save({ revision: "revision-one", fields: { debug: true } }, signal()), /target changed/)
  assert.equal(saves, 0)
})
test("closing a setup editor disposes its native target", async t => {
  const f = await nativeFixture(t)
  let disposed = 0
  const editor = createSetupEditor({ read: async () => f.snapshot, preview: async () => ({ groups: [], issues: [] }), save: async () => ({ kind: "read_only", message: "Read-only." }), dispose() { disposed++ } }, () => {})
  editor.dispose()
  assert.equal(disposed, 1)
})
test("GUI setup ignores a main provider that never starts", { timeout: 4000 }, async t => {
  const f = await nativeFixture(t)
  const ctx = { servers: { get: () => ({ client: f.client }) }, main: () => ({ read: () => new Promise(() => {}) }) }
  const api = createGUISetupAPI(ctx as any, { serverID: "sidecar", location: f.location })
  const result = await Promise.race([api.read(signal()), new Promise<undefined>(resolve => setTimeout(resolve, 2300))])
  assert.equal(result?.writable, true, "RPC must not wait for main IPC")
})
test("GUI setup reads the context file status and retries a mounting RPC", async t => {
  const f = await nativeFixture(t)
  const ctx = { servers: { get: () => ({ client: f.client }) } }
  const api = createGUISetupAPI(ctx as any, { serverID: "sidecar", location: f.location })
  f.hooks.contextErrors.push("rpc.unavailable")
  f.hooks.context = { set: true, path: "~/notes.md", absolute: "/home/fixture/notes.md", managed: false, state: "ok", bytes: 12 }
  assert.deepEqual(await api.contextStatus!(signal()), f.hooks.context)
  assert.equal(f.counts().contextReads, 2)
})
test("GUI setup maps an old server to unsupported and other failures to unavailable", async t => {
  const f = await nativeFixture(t)
  const ctx = { servers: { get: () => ({ client: f.client }) } }
  const api = createGUISetupAPI(ctx as any, { serverID: "sidecar", location: f.location })
  f.hooks.contextErrors.push("rpc.method_not_found")
  assert.equal(await api.contextStatus!(signal()), "unsupported")
  f.hooks.contextErrors.push("rpc.internal")
  assert.equal(await api.contextStatus!(signal()), "unavailable")
  const gone = createGUISetupAPI({ servers: { get: () => undefined } } as any, { serverID: "sidecar", location: f.location })
  assert.equal(await gone.contextStatus!(signal()), "unavailable")
})

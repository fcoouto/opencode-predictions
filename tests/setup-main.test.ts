import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createMainSetupAPI, registerSetupMain } from "../src/setup-main.ts"
import { nativeFixture } from "./setup-native-fixture.ts"

const signal = () => new AbortController().signal
test("Desktop main reads and saves through its pinned sidecar authority", async t => {
  const f = await nativeFixture(t)
  const api = createMainSetupAPI(f.host, "sidecar", f.location)
  const snapshot = await api.read(signal())
  assert.equal(snapshot.writable, true)
  assert.equal((await api.save({ revision: snapshot.revision, fields: { debug: true } }, signal())).kind, "saved_not_active")
  assert.equal(await readFile(f.file, "utf8"), '{"debug":true}')
  assert.equal(f.counts().saves, 1)
})
test("Desktop main denies non-sameMachine setup before socket access", async t => {
  const f = await nativeFixture(t)
  f.endpoint.sameMachine = false
  const before = f.counts().socketReads
  const api = createMainSetupAPI(f.host, "sidecar", f.location)
  assert.equal((await api.read(signal())).writable, false)
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "read_only")
  assert.equal(f.counts().socketReads, before)
  assert.equal(await readFile(f.file, "utf8"), "{}")
})
test("Desktop main refuses endpoint and authority replacement after reading a draft", async t => {
  const f = await nativeFixture(t)
  const api = createMainSetupAPI(f.host, "sidecar", f.location)
  assert.equal((await api.read(signal())).writable, true)
  f.endpoint.url += "/retarget"
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "read_only")
  assert.equal(f.counts().saves, 0)
})
test("Desktop main does not follow a rotated authority during Save", async t => {
  const f = await nativeFixture(t)
  const api = createMainSetupAPI(f.host, "sidecar", f.location)
  assert.equal((await api.read(signal())).writable, true)
  f.snapshot.serviceVersion = "replacement"
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "read_only")
  assert.equal(f.counts().saves, 0)
})
test("Desktop setup waits for its selected location's RPC mount without changing targets", async t => {
  const f = await nativeFixture(t)
  f.unavailableReads(1)
  const api = createMainSetupAPI(f.host, "sidecar", f.location)
  assert.equal((await api.read(signal())).writable, true)
  assert.equal(f.counts().metadataReads, 2)
  assert.equal(f.counts().saves, 0)
})

function registered(f: Awaited<ReturnType<typeof nativeFixture>>) {
  let impl: any, closed: ((window: { id: number }) => void) | undefined, disposed = 0
  const ctx = {
    ...f.host,
    provide: (_token: unknown, value: unknown) => { impl = value; return { dispose() { disposed++ } } },
    windows: { on: (_event: string, handler: (window: { id: number }) => void) => { closed = handler; return () => {} } },
  }
  const stop = registerSetupMain(ctx as any)
  const caller = (window = 1) => ({ window, signal: signal() })
  return { stop, impl: () => impl, caller, closeWindow: (id: number) => closed?.({ id }), disposed: () => disposed }
}
const read = (extra: object = {}, location: object = { directory: "/fixture/project" }) => ({ serverID: "sidecar", location, ...extra }) as any

test("main IPC rejects unknown envelope fields, relative locations and Save envelopes without leaking details", async t => {
  const f = await nativeFixture(t)
  const r = registered(f)
  t.after(() => r.stop())
  assert.equal((await r.impl().read(read(), r.caller())).writable, true)
  const saves = f.counts().saves
  const bad = [
    () => r.impl().read(read({ path: "/client/config.json" }), r.caller()),
    () => r.impl().read(read({}, { directory: "relative/path" }), r.caller()),
    () => r.impl().read(read({}, { directory: "/fixture/project", extra: true }), r.caller()),
    () => r.impl().save({ ...read({ path: "/x" }), input: { revision: "revision-one", fields: { debug: true } } }, r.caller()),
    () => r.impl().save({ ...read(), input: { revision: "revision-one", fields: { debug: true }, source: "/x" } }, r.caller()),
    () => r.impl().save({ ...read(), input: { revision: "revision-one", fields: { unknown: true } } }, r.caller()),
  ]
  for (const [index, attempt] of bad.entries()) {
    // A refusal may reject or resolve as a non-saving result; either way no file is written and no detail leaks.
    const outcome = await attempt().then((value: unknown) => ({ value }), (error: Error) => ({ error }))
    if (index < 4) assert.ok("error" in outcome, "envelope violations must be rejected: attempt " + index)
    if ("error" in outcome) assert.doesNotMatch(outcome.error.message, /PRIVATE|\/client|\/fixture/, "attempt " + index)
    else assert.ok(["invalid", "read_only", "failed"].includes((outcome.value as { kind: string }).kind), "attempt " + index)
  }
  const unknown = await r.impl().read({ serverID: "unknown-server", location: { directory: "/fixture/project" } }, r.caller())
  assert.equal(unknown.writable, false, "an endpoint that does not belong to the requested server must stay read-only")
  assert.equal((await r.impl().save({ serverID: "unknown-server", location: { directory: "/fixture/project" }, input: { revision: "revision-one", fields: { debug: true } } }, r.caller())).kind, "read_only")
  assert.equal(f.counts().saves, saves)
  assert.equal(await readFile(f.file, "utf8"), "{}")
})

test("main IPC isolates windows, disposes a closed window's targets and bounds simultaneous targets", async t => {
  const f = await nativeFixture(t)
  const r = registered(f)
  t.after(() => r.stop())
  await r.impl().read(read(), r.caller(1))
  r.closeWindow(1)
  assert.equal((await r.impl().read(read(), r.caller(1))).writable, true, "a reopened window gets a fresh pinned target")
  for (let index = 0; index < 63; index++) await r.impl().read(read({}, { directory: "/fixture/p" + index }), r.caller(2))
  await assert.rejects(r.impl().read(read({}, { directory: "/fixture/overflow" }), r.caller(2)), /Local setup is unavailable/, "the 65th target in a window must be refused")
  r.stop()
  assert.equal(r.disposed(), 1)
})

test("a window cannot save through another window's unread target", async t => {
  const f = await nativeFixture(t)
  const r = registered(f)
  t.after(() => r.stop())
  await r.impl().read(read(), r.caller(1))
  const result = await r.impl().save({ ...read(), input: { revision: "revision-one", fields: { debug: true } } }, r.caller(2))
  assert.equal(result.kind, "read_only")
  assert.equal(f.counts().saves, 0)
})

test("an origin change after a Save committed is an ambiguous failure for readback, never read-only", async t => {
  const f = await nativeFixture(t)
  const api = createMainSetupAPI(f.host, "sidecar", f.location)
  assert.equal((await api.read(signal())).writable, true)
  f.hooks.afterWrite = () => { f.endpoint.url += "/rotated" }
  await assert.rejects(api.save({ revision: "revision-one", fields: { debug: true } }, signal()), /Local setup is unavailable/)
  assert.equal(await readFile(f.file, "utf8"), '{"debug":true}', "the write committed")
  assert.equal(f.counts().saves, 1)
  assert.equal((await api.read(signal())).writable, false, "afterwards only read-only inspection remains")
})

test("a revoked target is rebuilt on the next read instead of staying read-only until the window closes", async t => {
  const f = await nativeFixture(t)
  const r = registered(f)
  t.after(() => r.stop())
  const original = f.endpoint.url
  assert.equal((await r.impl().read(read(), r.caller())).writable, true)
  f.endpoint.url = original + "/transient"
  assert.equal((await r.impl().read(read(), r.caller())).writable, false)
  f.endpoint.url = original
  assert.equal((await r.impl().read(read(), r.caller())).writable, true)
})

test("main IPC Save failures expose only the fixed safe copy", async t => {
  const f = await nativeFixture(t)
  const r = registered(f)
  t.after(() => r.stop())
  await r.impl().read(read(), r.caller())
  f.endpoint.url = "http://127.0.0.1:1/PRIVATE-port"
  const outcome = await r.impl().save({ ...read(), input: { revision: "revision-one", fields: { debug: true } } }, r.caller()).then((value: { kind: string }) => ({ value }), (error: Error) => ({ error }))
  if ("error" in outcome) assert.doesNotMatch(outcome.error.message, /PRIVATE|127\.0\.0\.1/)
  else assert.equal(outcome.value.kind, "read_only")
  assert.equal(f.counts().saves, 0)
})

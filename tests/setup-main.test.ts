import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createMainSetupAPI } from "../src/setup-main.ts"
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

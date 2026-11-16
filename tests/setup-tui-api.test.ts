import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createTUISetupAPI } from "../src/setup-tui-api.ts"
import { nativeFixture } from "./setup-native-fixture.ts"
const signal = () => new AbortController().signal
test("standalone setup reads and saves through its independently owned server", async t => {
  const f = await nativeFixture(t)
  const api = createTUISetupAPI({ app: { version: "2.2.6" } as any, client: f.client }, f.location, f.runtime)
  assert.equal((await api.read(signal())).writable, true)
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "saved_not_active")
  assert.equal(f.counts().saves, 1)
})
test("CLI setup denies unqualified launch origins before socket access", async t => {
  const f = await nativeFixture(t)
  f.runtime.argv = ["/native/opencode", "/native/opencode", "--server", f.endpoint.url]
  const before = f.counts().socketReads
  const api = createTUISetupAPI({ app: { version: "2.2.6" } as any, client: f.client }, f.location, f.runtime)
  assert.equal((await api.read(signal())).writable, false)
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "read_only")
  assert.equal(f.counts().socketReads, before)
  assert.equal(await readFile(f.file, "utf8"), "{}")
})
test("relayed local metadata cannot authorize a selected remote server", async t => {
  const f = await nativeFixture(t)
  f.runtime.inspect = async () => ({ parent: 99999, uid: 501, command: "/native/opencode serve --stdio --port 0", started: "Sun Nov 15 12:00:00 2026" })
  const before = f.counts().socketReads
  const api = createTUISetupAPI({ app: { version: "2.2.6" } as any, client: f.client }, f.location, f.runtime)
  assert.equal((await api.read(signal())).writable, false)
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "read_only")
  assert.equal(f.counts().socketReads, before)
  assert.equal(f.counts().saves, 0)
})

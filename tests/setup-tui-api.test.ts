import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createTUISetupAPI } from "../src/setup-tui-api.ts"
import { nativeFixture } from "./setup-native-fixture.ts"
const signal = () => new AbortController().signal
test("shared-service setup reads and saves through its selected server", async t => {
  const f = await nativeFixture(t, true)
  const api = createTUISetupAPI({ client: f.client }, f.location)
  assert.equal((await api.read(signal())).writable, true)
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "saved_not_active")
  assert.equal(f.counts().saves, 1)
})
test("CLI setup does not require standalone launch arguments", async t => {
  const f = await nativeFixture(t, true)
  f.runtime.argv = ["/native/opencode", "/native/opencode", "--server", f.endpoint.url]
  const before = f.counts().socketReads
  const api = createTUISetupAPI({ client: f.client }, f.location)
  assert.equal((await api.read(signal())).writable, true)
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "saved_not_active")
  assert.equal(f.counts().socketReads, before)
  assert.equal(await readFile(f.file, "utf8"), '{"debug":true}')
})
test("selected remote settings do not probe a local server process", async t => {
  const f = await nativeFixture(t, true)
  f.runtime.inspect = async () => ({ parent: 99999, uid: 501, command: "/native/opencode serve --stdio --port 0", started: "Sun Nov 15 12:00:00 2026" })
  const before = f.counts().socketReads
  const api = createTUISetupAPI({ client: f.client }, f.location)
  assert.equal((await api.read(signal())).writable, true)
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "saved_not_active")
  assert.equal(f.counts().socketReads, before)
  assert.equal(f.counts().saves, 1)
})

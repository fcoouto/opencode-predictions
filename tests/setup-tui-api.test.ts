import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createTUISetupAPI } from "../src/setup-tui-api.ts"
import { nativeFixture } from "./setup-native-fixture.ts"
const signal = () => new AbortController().signal
test("shared-service setup reads and saves through its selected server without inspecting a local process", async t => {
  const f = await nativeFixture(t)
  t.mock.method(f.client.server, "info", () => { throw new Error("Do not inspect the server process") })
  const api = createTUISetupAPI({ client: f.client }, f.location)
  assert.equal((await api.read(signal())).writable, true)
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "saved_not_active")
  assert.equal(f.counts().saves, 1)
  assert.equal(await readFile(f.file, "utf8"), '{"debug":true}')
})
test("CLI setup retries a mounting RPC without repeating a Save", async t => {
  const f = await nativeFixture(t)
  f.unavailableReads(1)
  const api = createTUISetupAPI({ client: f.client }, f.location)
  assert.equal((await api.read(signal())).writable, true)
  assert.equal(f.counts().metadataReads, 2)
  assert.equal((await api.save({ revision: "revision-one", fields: { debug: true } }, signal())).kind, "saved_not_active")
  assert.equal(f.counts().saves, 1)
})

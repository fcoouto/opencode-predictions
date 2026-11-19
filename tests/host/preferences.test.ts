import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { createFixture } from "./fixture.mjs"
import { Predictions } from "../../src/rpc.ts"
import type { SetupSnapshot } from "../../src/setup.ts"

for (const [configSource, pluginReference] of [["inline", "object"], ["global-jsonc", "object"], ["global-json", "string"]] as const) {
  test(`authorized normal server saves ${configSource}/${pluginReference} preferences without editing OpenCode`, { timeout: 60000 }, async t => {
    await using f = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { configSource, projectConfig: true, pluginReference })
    assert.equal(f.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined)
    await mkdir(join(f.root, "config/opencode/plugins"), { recursive: true })
    const original = f.configFile ? await readFile(f.configFile) : undefined
    const rpc = f.api.rpc(Predictions), location = { directory: f.directory }
    const before = await rpc.settings({}, { location }) as SetupSnapshot
    assert.equal(before.writable, true, f.output())
    assert.equal(before.source, f.preferencesFile)
    assert.equal(before.localAuthority, undefined)
    for (const headers of [{}, { authorization: "Basic " + Buffer.from("opencode:wrong").toString("base64") }] as Record<string, string>[]) {
      const denied = await fetch(f.address + "/api/rpc/fcoouto.predictions/saveSettings", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ input: { revision: before.revision, fields: { debug: true } }, location }) })
      assert.equal(denied.status, 401)
      await denied.arrayBuffer()
      await assert.rejects(readFile(f.preferencesFile), { code: "ENOENT" })
    }
    const result = await rpc.saveSettings({ revision: before.revision, fields: { automatic: false } }, { location }) as any
    assert.equal(result.kind, "saved", JSON.stringify(result) + f.output())
    assert.deepEqual(JSON.parse(await readFile(f.preferencesFile, "utf8")), { version: 1, settings: { automatic: false } })
    const after = await rpc.settings({}, { location }) as SetupSnapshot
    assert.equal(after.activeRevision, after.revision)
    assert.equal(after.effective?.automatic, false)
    assert.equal(after.origins.automatic, "preferences")
    assert.equal(after.revision, result.revision)
    const bytes = await readFile(f.preferencesFile)
    for (const input of [
      { revision: after.revision, fields: {}, source: "/client/target" },
      { revision: after.revision, fields: { path: "/client/target" } },
      { revision: after.revision, fields: { debug: "x".repeat(65537) } },
      { revision: after.revision, fields: {}, reset: ["debug", "debug"] },
    ]) {
      await assert.rejects(f.api.rpc.call({ rpcID: Predictions.id, method: "saveSettings", input: JSON.parse(JSON.stringify(input)), location }))
      assert.deepEqual(await readFile(f.preferencesFile), bytes)
    }
    const invalid = await rpc.saveSettings({ revision: after.revision, fields: { timeoutMs: null } }, { location }) as any
    assert.equal(invalid.kind, "invalid")
    assert.deepEqual(await readFile(f.preferencesFile), bytes)
    if (f.configFile) assert.deepEqual(await readFile(f.configFile), original)
    assert.deepEqual(f.calls, [])
    t.diagnostic("Host version: " + (await f.api.server.info()).version)
  })
}

test("empty password still requires host-generated credentials on OpenCode 2.2.6", { timeout: 60000 }, async t => {
  await using f = await createFixture(process.env.PREDICTIONS_PACKAGE, {}, {}, { projectConfig: true, emptyPassword: true })
  const client = OpenCode.make({ baseUrl: f.address }), rpc = f.api.rpc(Predictions), location = { directory: f.directory }
  await assert.rejects(client.rpc(Predictions).settings({}, { location }), (error: any) => error._tag === "UnauthorizedError")
  const before = await rpc.settings({}, { location }) as SetupSnapshot
  assert.equal((await rpc.saveSettings({ revision: before.revision, fields: { debug: true } }, { location }) as any).kind, "saved")
  assert.deepEqual(JSON.parse(await readFile(f.preferencesFile, "utf8")).settings, { debug: true })
  assert.deepEqual(f.calls, [])
  t.diagnostic("Host version: " + (await f.api.server.info()).version)
})

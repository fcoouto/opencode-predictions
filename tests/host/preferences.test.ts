import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"
import { Service } from "@opencode/client/service"
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
    assert.equal("localAuthority" in before, false)
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

for (const launch of ["shared", "standalone"]) test(`ordinary ${launch} CLI edits all eight settings without OpenCode config changes`, { timeout: 90000 }, async () => {
  await using f = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false, models: [["fixture/model"], ["nomatch/*"]] }, {}, { configSource: "global-jsonc", projectConfig: true })
  const session = await f.api.session.create({ location: { directory: f.directory }, model: { providerID: "fixture", id: "model" } })
  await f.writeConfig({ ...f.config, plugins: [...f.config.plugins, { package: resolve("tests/host/observer"), options: {} }] })
  const original = await readFile(f.configFile!), observation = join(f.root, "preferences-cli.json")
  const { stdout } = await promisify(execFile)("python3", [resolve("tests/host/terminal.py"), process.env.OPENCODE_BIN ?? "opencode", session.id, f.directory, observation], {
    env: { ...f.env, PREDICTIONS_OBSERVER: observation, PREDICTIONS_SETUP_FULL: "1", PREDICTIONS_SHARED_SERVICE: launch === "shared" ? "1" : "0" },
    timeout: 80000, maxBuffer: 1024 * 1024,
  })
  const result = JSON.parse(stdout)
  assert.equal(result.fullSetup, true)
  assert.equal(result.host.hostVersion, "2.2.6")
  assert.equal(result.host.sharedService, launch === "shared")
  assert.equal(result.host.standalone, launch === "standalone")
  if (launch === "shared") {
    const endpoint = await Service.discover({ file: join(f.root, "state/opencode/service.json"), version: "2.2.6" })
    assert.ok(endpoint, "the ordinary shared service remains discoverable after the CLI exits")
    assert.equal(JSON.parse(await readFile(join(f.root, "state/opencode/service.json"), "utf8")).pid, result.host.serverPid)
  }
  assert.deepEqual(JSON.parse(await readFile(f.preferencesFile, "utf8")).settings, {
    models: [["nomatch/*"], ["fixture/model"]], enabled: false, automatic: true, escalation: "automatic", timeoutMs: 9000, contextTurns: 5, includeGithubPRContext: true, debug: true,
  })
  assert.deepEqual(await readFile(f.configFile!), original)
  assert.deepEqual(f.calls, [])
})

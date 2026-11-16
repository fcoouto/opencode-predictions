import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { createServer, request } from "node:http"
import { _electron as electron } from "playwright"
import { build } from "esbuild"
import { Service } from "@opencode/client/service"
import { createFixture, isPredictionCall } from "./fixture.mjs"
import { Predictions } from "../../src/rpc.ts"
import { readLocalSetup, saveLocalSetup } from "../../src/setup-local.ts"
import type { SetupSnapshot } from "../../src/setup.ts"

async function startRelay(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const relay = createServer((incoming, outgoing) => {
    const upstream = request(new URL(incoming.url!, fixture.address), { method: incoming.method, headers: { ...incoming.headers, ...fixture.headers } }, response => {
      outgoing.writeHead(response.statusCode!, response.headers)
      response.pipe(outgoing)
    })
    upstream.on("error", () => outgoing.destroy())
    incoming.on("aborted", () => upstream.destroy())
    outgoing.on("close", () => upstream.destroy())
    incoming.pipe(upstream)
  })
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve))
  return relay
}

test("setup local Desktop saves through production main IPC and reconciles watcher activation", { timeout: 50000, skip: process.platform !== "darwin" }, async () => {
  await build({ entryPoints: ["tests/host/observer/gui.ts"], outfile: "tests/host/observer/gui-experimental.cjs", bundle: true, format: "cjs", platform: "browser", packages: "external" })
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: true }, {}, { configSource: "global-jsonc" })
  const observer = { package: resolve("tests/host/observer"), options: { directory: fixture.directory, setupProbe: true } }
  await fixture.writeConfig({ ...fixture.config, plugins: [...fixture.config.plugins, observer] })
  const app = await electron.launch({
    executablePath: process.env.OPENCODE_DESKTOP_BIN ?? "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
    args: ["--user-data-dir=" + join(fixture.root, "save-desktop-profile")],
    env: fixture.env as Record<string, string>, timeout: 30000,
  })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), undefined, { timeout: 15000 })
    await page.waitForFunction(() => (window as any).__predictionFixture?.setupReady(), undefined, { timeout: 5000 })
    const version = await page.evaluate(() => (window as any).__predictionFixture.setupServerVersion())
    assert.equal(version, "2.3.0", "scope this gate to the qualified bundled Desktop server")
    const before = await page.evaluate(() => (window as any).__predictionFixture.setupRead())
    assert.equal(before.writable, true)
    const result = await page.evaluate(() => (window as any).__predictionFixture.setupSave())
    assert.ok(["saved", "saved_not_active"].includes(result.kind), "a durable acknowledgement must not overclaim activation")
    let after = before
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      after = await page.evaluate(() => (window as any).__predictionFixture.setupRead())
      if (after?.effective.debug === true && after.serviceVersion !== before.serviceVersion) break
      await page.waitForTimeout(100)
    }
    assert.equal(after.effective.debug, true)
    assert.notEqual(after.serviceVersion, before.serviceVersion)
    assert.equal(fixture.calls.length, 0)
    assert.match(await readFile(fixture.configFile!, "utf8"), /"debug": true/)
  } finally { await app.close() }
})

test("setup local Desktop Save preserves the composer draft and creates no prediction", { timeout: 90000, skip: process.platform !== "darwin" }, async () => {
  await build({ entryPoints: ["tests/host/observer/gui.ts"], outfile: "tests/host/observer/gui-experimental.cjs", bundle: true, format: "cjs", platform: "browser", packages: "external" })
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: true }, {}, { configSource: "global-jsonc" })
  const observer = { package: resolve("tests/host/observer"), options: { directory: fixture.directory, setupProbe: true } }
  await fixture.writeConfig({ ...fixture.config, plugins: [...fixture.config.plugins, observer] })
  const app = await electron.launch({
    executablePath: process.env.OPENCODE_DESKTOP_BIN ?? "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
    args: ["--user-data-dir=" + join(fixture.root, "save-composer-profile")],
    env: fixture.env as Record<string, string>, timeout: 30000,
  })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), undefined, { timeout: 20000 })
    await page.waitForFunction(() => (window as any).__predictionFixture?.setupReady(), undefined, { timeout: 5000 })
    await page.evaluate(() => (window as any).__predictionFixture.launch())
    const editor = page.locator('[data-component="composer-editor"][contenteditable="true"]')
    await editor.waitFor({ state: "visible", timeout: 20000 })
    await page.waitForFunction(() => document.querySelector('[data-component="composer-editor"]')?.textContent === "Fix the assertion.")
    await page.getByRole("button", { name: "Fixture / Fixture Flash", exact: true }).waitFor({ state: "visible" })
    await editor.press("Enter")
    await page.locator("[data-opencode-prediction]").waitFor({ state: "visible", timeout: 15000 })
    const before = await page.evaluate(() => (window as any).__predictionFixture.setupRead())
    assert.equal(before.writable, true)
    const callsBefore = fixture.calls.filter(isPredictionCall).length
    await editor.fill("my existing draft")
    const result = await page.evaluate(() => (window as any).__predictionFixture.setupSave())
    assert.ok(["saved", "saved_not_active"].includes(result.kind))
    let after = before
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      after = await page.evaluate(() => (window as any).__predictionFixture.setupRead())
      if (after?.effective.debug === true && after.serviceVersion !== before.serviceVersion) break
      await page.waitForTimeout(100)
    }
    assert.equal(after.effective.debug, true, "the Save must activate through the real watcher")
    assert.equal(await editor.innerText(), "my existing draft", "Save and reload must not touch the composer")
    await editor.fill("")
    await page.waitForTimeout(2300)
    assert.equal(fixture.calls.filter(isPredictionCall).length, callsBefore, "Save must not cause a prediction call")
    assert.equal(await page.locator("[data-opencode-prediction]").count(), 0)
  } finally { await app.close() }
})

test("setup local Save writes the server-owned JSONC and rediscovers watcher activation without retry", { timeout: 30000 }, async t => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: true }, {}, { configSource: "global-jsonc" })
  const oldTemporary = process.env.TMPDIR
  process.env.TMPDIR = fixture.env.TMPDIR
  t.after(() => { if (oldTemporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTemporary })
  const location = { directory: fixture.directory }
  const rpc = fixture.api.rpc(Predictions)
  const before = await rpc.settings({}, { location }) as SetupSnapshot
  assert.equal(before.writable, false)
  assert.ok(before.localAuthority, "qualified server must advertise its local authority")
  const pid = (await fixture.api.server.info()).pid
  const target = { id: before.localAuthority.id, serviceVersion: before.serviceVersion, serverPid: pid, location }
  const local = await readLocalSetup(target, new AbortController().signal)
  assert.equal(local.writable, true)
  const original = await readFile(fixture.configFile!, "utf8")
  // Watcher unload may destroy the committed write's response. Do not repeat Save.
  const outcome = await saveLocalSetup(target, { revision: local.revision, fields: { debug: true } }, new AbortController().signal).then(value => ({ value }), error => ({ error }))
  if ("value" in outcome) assert.equal(outcome.value.kind, "saved_not_active")
  const bytes = await readFile(fixture.configFile!, "utf8")
  assert.notEqual(bytes, original)
  assert.match(bytes, /Synthetic global fixture configuration/)
  let after!: SetupSnapshot
  const until = Date.now() + 10000
  while (Date.now() < until) {
    try {
      after = await rpc.settings({}, { location }) as SetupSnapshot
      if (after.serviceVersion !== before.serviceVersion && after.effective?.debug === true && after.localAuthority) break
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.notEqual(after.serviceVersion, before.serviceVersion)
  assert.equal(after.effective?.debug, true)
  assert.equal(after.fields.debug, true)
  assert.notEqual(after.localAuthority?.id, target.id)
  await assert.rejects(readLocalSetup(target, new AbortController().signal))
  const next = { ...target, id: after.localAuthority!.id, serviceVersion: after.serviceVersion }
  assert.equal((await saveLocalSetup(next, { revision: local.revision, fields: { debug: false } }, new AbortController().signal)).kind, "conflict")
  assert.equal(await readFile(fixture.configFile!, "utf8"), bytes)
  assert.equal(fixture.calls.length, 0)
})

test("setup origin: Desktop main distinguishes its own server from another port and a metadata relay", { timeout: 90000, skip: process.platform !== "darwin" }, async () => {
  await build({ entryPoints: ["tests/host/observer/gui.ts"], outfile: "tests/host/observer/gui-experimental.cjs", bundle: true, format: "cjs", platform: "browser", packages: "external" })
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false }, {}, { configSource: "global-jsonc" })
  const relay = await startRelay(fixture)
  const port = (relay.address() as { port: number }).port
  const password = Buffer.from(fixture.headers.authorization.slice(6), "base64").toString().slice("opencode:".length)
  await fixture.writeConfig({ ...fixture.config, plugins: [...fixture.config.plugins, {
    package: resolve("tests/host/observer"),
    options: { directory: fixture.directory, originProbe: true, originTargets: [
      { id: "other", url: fixture.address, password },
      { id: "relay", url: `http://127.0.0.1:${port}`, password },
    ] },
  }] })
  const original = await readFile(fixture.configFile!, "utf8")
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({
      executablePath: process.env.OPENCODE_DESKTOP_BIN ?? "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
      args: ["--user-data-dir=" + join(fixture.root, "origin-desktop-profile")],
      env: fixture.env as Record<string, string>, timeout: 45000,
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), undefined, { timeout: 30000 })
    await page.waitForFunction(() => (window as any).__predictionFixture?.originReady?.(), undefined, { timeout: 15000 })
    const observation = await page.evaluate(async () => (window as any).__predictionFixture.origin())
    assert.deepEqual(observation.entries.map((entry: any) => [entry.id, entry.known, entry.sameMachine]), [
      ["sidecar", true, true],
      ["prediction-test-observer:other", true, false],
      ["prediction-test-observer:relay", true, false],
      ["missing-origin-target", false, false],
    ])
    assert.deepEqual(observation.entries.map((entry: any) => [entry.guardAllowed, entry.localDispatches]), [[true, 1], [false, 0], [false, 0], [false, 0]])
    assert.equal(observation.relayMatchesOtherServer, true, "relay must preserve backend identity metadata")
    assert.equal(fixture.calls.length, 0)
    assert.equal(await readFile(fixture.configFile!, "utf8"), original)
    await writeFile(join(fixture.root, "origin-desktop-observation.json"), JSON.stringify(observation, null, 2))
  } finally {
    await app?.close()
    relay.closeAllConnections()
    await new Promise<void>(resolve => relay.close(() => resolve()))
  }
})

test("setup origin: CLI binds its private child, rejects conflicts and does not fall back after child failure", { timeout: 120000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false }, {}, { configSource: "global-jsonc" })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  const observer = { package: resolve("tests/host/observer"), options: {} }
  await fixture.writeConfig({ ...fixture.config, plugins: [...fixture.config.plugins, observer] })
  const original = await readFile(fixture.configFile!, "utf8")
  const backend = await fixture.api.server.info()
  const password = Buffer.from(fixture.headers.authorization.slice(6), "base64").toString().slice("opencode:".length)
  const registration = join(fixture.root, "state", "opencode", "service.json")
  await writeFile(registration, JSON.stringify({ id: "origin-fixture-service", version: backend.version, pid: backend.pid, url: fixture.address, password }), { mode: 0o600 })
  assert.equal((await Service.discover({ file: registration, version: backend.version }))?.url, fixture.address)
  const serviceConfig = join(fixture.root, "config", "opencode", "service.json")
  const originalServiceConfig = await readFile(serviceConfig, "utf8")
  const relay = await startRelay(fixture)
  const relayURL = `http://127.0.0.1:${(relay.address() as { port: number }).port}`
  const variants = [
    { name: "standalone", args: ["--standalone"], env: {} },
    { name: "standalone-env", args: ["--standalone"], env: { OPENCODE_SERVER_URL: fixture.address, OPENCODE_SERVER: fixture.address, OPENCODE_PASSWORD: "synthetic-wrong-password", OPENCODE_SERVER_PASSWORD: "synthetic-wrong-password" } },
    { name: "standalone-failure", args: ["--standalone"], env: { PREDICTIONS_ORIGIN_WATCH: "1" } },
    { name: "shared", args: [], env: {} },
    { name: "fallback", args: [], env: {}, disabled: true },
    { name: "explicit", args: ["--server", fixture.address], env: { OPENCODE_PASSWORD: password } },
    { name: "explicit-relay", args: ["--server", relayURL], env: { OPENCODE_PASSWORD: password } },
    { name: "conflict", args: ["--standalone", "--server", fixture.address], env: { OPENCODE_PASSWORD: password } },
    { name: "conflict-reversed", args: ["--server", fixture.address, "--standalone"], env: { OPENCODE_PASSWORD: password } },
  ]
  const observations: unknown[] = []
  try {
    for (const variant of variants) {
      await writeFile(serviceConfig, variant.disabled ? JSON.stringify({ ...JSON.parse(originalServiceConfig), disabled: true }) : originalServiceConfig)
      const observationFile = join(fixture.root, "origin-" + variant.name + ".json")
      const { stdout } = await promisify(execFile)("python3", [resolve("tests/host/origin.py"), process.env.OPENCODE_BIN ?? "opencode", session.id, fixture.directory, observationFile, JSON.stringify(variant.args)], {
        env: { ...fixture.env, ...variant.env, PREDICTIONS_ORIGIN_OBSERVER: observationFile },
        timeout: 20000, maxBuffer: 1024 * 1024,
      })
      const value = JSON.parse(stdout)
      observations.push({ name: variant.name, ...value })
      if (variant.name.startsWith("conflict")) {
        assert.equal(value.started, false, variant.name)
        assert.equal(value.conflictingFlagsRejected, true, variant.name)
      } else {
        assert.equal(value.started, true, variant.name)
        assert.equal(value.guardAllowed, variant.name === "standalone" || variant.name === "standalone-failure", variant.name)
        assert.equal(value.localDispatches, value.guardAllowed ? 1 : 0, variant.name)
        if (variant.name.startsWith("standalone") || variant.name === "fallback") {
          assert.notEqual(value.serverPid, backend.pid)
          assert.equal(value.serverParentPid, value.clientPid)
          assert.equal(value.privateServerCommand, true)
          assert.equal(value.serverSameUser, true)
          assert.equal(value.serverExecutableMatches, true)
          if (variant.name === "standalone-failure") {
            assert.ok(value.afterFailure.clientExited === true || value.afterFailure.serverAvailable === false)
            if (!value.afterFailure.clientExited) {
              assert.equal(value.afterFailure.clientIdentityStable, true)
              assert.equal(value.afterFailure.guardAllowed, false)
              assert.equal(value.afterFailure.localDispatches, 0)
            }
          }
        } else {
          assert.equal(value.serverPid, backend.pid)
          assert.notEqual(value.serverParentPid, value.clientPid)
        }
      }
    }
    assert.equal(fixture.calls.length, 0)
    assert.equal(await readFile(fixture.configFile!, "utf8"), original)
    await writeFile(join(fixture.root, "origin-cli-observations.json"), JSON.stringify(observations, null, 2))
  } finally {
    await writeFile(serviceConfig, originalServiceConfig)
    relay.closeAllConnections()
    await new Promise<void>(resolve => relay.close(() => resolve()))
  }
})

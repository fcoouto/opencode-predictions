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
import { createFixture } from "./fixture.mjs"

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

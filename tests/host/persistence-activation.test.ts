import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { fork } from "node:child_process"
import { readFile, stat, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { createFixture } from "./fixture.mjs"
import { PersistenceProbe } from "./persistence-probe/rpc.ts"
import type { ProbeHost, ProbeSnapshot } from "./persistence-candidate.ts"
import { Predictions } from "../../src/rpc.ts"
import type { Status } from "../../src/service.ts"

test("isolated fixture can restart with the same HOME and global file", { timeout: 60000 }, async () => {
  await using fixture = await createFixture(undefined, { automatic: false }, {}, { configSource: "global-jsonc" })
  assert.equal(typeof fixture.restart, "function")
  const file = fixture.configFile, home = fixture.env.HOME, oldAddress = fixture.address
  await fixture.restart()
  assert.equal(fixture.configFile, file)
  assert.equal(fixture.env.HOME, home)
  assert.notEqual(fixture.address, oldAddress)
  const documents = await fixture.api.config.get({ location: { directory: fixture.directory } })
  assert.ok(documents.some(entry => entry.type === "document" && entry.path === file))
  assert.equal(fixture.calls.length, 0)
})

describe("macOS server persistence probe", { skip: process.platform !== "darwin" }, () => {
for (const configSource of ["global-json", "global-jsonc"] as const) {
  test(`saved options activate without generation: ${configSource}`, { timeout: 60000 }, async () => {
    await using fixture = await createFixture(resolve("tests/host/persistence-probe"), { automatic: false }, {}, { configSource })
    const location = { directory: fixture.directory }
    const probe = () => fixture.api.rpc(PersistenceProbe)
    const before = await probe().read({}, { location }) as ProbeSnapshot & { mount: string; version: string }
    assert.equal(before.writable, true)
    assert.equal(before.version, (await fixture.api.server.info()).version)
    assert.ok(["2.2.6", "2.3.0"].includes(before.version), "scope this gate to the explicitly qualified server versions")
    assert.equal(before.source, fixture.configFile)
    assert.notEqual(fixture.env.HOME, process.env.HOME, "client HOME must not choose the server's target")
    const original = await readFile(fixture.configFile!, "utf8")
    const saved = await probe().save({ revision: before.revision!, patch: { automatic: true, contextTurns: 5 } }, { location }) as { kind: string }
    assert.equal(saved.kind, "written")
    let after = before
    for (let tries = 0; tries < 100; tries++) {
      after = await probe().read({}, { location }) as typeof before
      if (after.writable && after.fields?.contextTurns === 5 && after.mount !== before.mount) break
      await delay(30)
    }
    assert.equal(after.writable, true, JSON.stringify(after))
    assert.equal(after.fields?.contextTurns, 5)
    assert.notEqual(after.mount, before.mount, "real host must remount with fresh ctx.options")
    const status = await fixture.api.rpc(Predictions).status({}, { location }) as Status
    assert.equal(status.automatic, true)
    assert.equal(await readFile(fixture.configFile! + ".predictions-backup", "utf8"), original)
    const documents = await fixture.api.config.get({ location })
    assert.equal(documents.some(entry => entry.type === "document" && entry.path === fixture.configFile! + ".predictions-backup"), false)
    assert.equal(fixture.calls.length, 0)
    await fixture.restart()
    const restarted = await probe().read({}, { location }) as typeof before
    assert.equal(restarted.writable, true)
    assert.equal(restarted.fields?.contextTurns, 5)
    assert.equal(restarted.fields?.automatic, true)
    assert.equal(fixture.calls.length, 0)
  })
}

test("lost save acknowledgement reconciles persisted and active values without repeating the write", { timeout: 60000 }, async () => {
  await using fixture = await createFixture(resolve("tests/host/persistence-probe"), { automatic: false }, {}, { configSource: "global-jsonc" })
  const location = { directory: fixture.directory }
  const api = fixture.api.rpc(PersistenceProbe)
  const before = await api.read({}, { location }) as ProbeSnapshot & { mount: string }
  const original = await readFile(fixture.configFile!, "utf8")
  const controller = new AbortController()
  const pending = api.save({ revision: before.revision!, patch: { contextTurns: 4 }, loseAck: true }, { location, signal: controller.signal })
  // Attach immediately: host remounts can cancel an in-flight RPC before the caller aborts.
  const outcome = pending.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
  for (let tries = 0; tries < 100; tries++) {
    if ((await readFile(fixture.configFile!, "utf8")).includes('"contextTurns": 4')) break
    await delay(20)
  }
  assert.match(await readFile(fixture.configFile!, "utf8"), /"contextTurns": 4/)
  controller.abort()
  assert.equal((await outcome).ok, false, "caller must not receive a successful acknowledgement")
  const inode = (await stat(fixture.configFile!)).ino
  let after: typeof before = before
  for (let tries = 0; tries < 100; tries++) {
    after = await api.read({}, { location }) as typeof before
    if (after.writable && after.fields?.contextTurns === 4 && after.mount !== before.mount) break
    await delay(30)
  }
  assert.equal(after.fields?.contextTurns, 4)
  assert.notEqual(after.mount, before.mount)
  assert.equal((await stat(fixture.configFile!)).ino, inode, "reconciliation must not replace the file a second time")
  assert.equal(await readFile(fixture.configFile! + ".predictions-backup", "utf8"), original)
  assert.equal(fixture.calls.length, 0)
})

test("server-side Bun writer and independent Node writer coordinate on the same file", { timeout: 60000 }, async t => {
  await using fixture = await createFixture(resolve("tests/host/persistence-probe"), { automatic: false }, {}, { configSource: "global-jsonc" })
  const location = { directory: fixture.directory }
  const api = fixture.api.rpc(PersistenceProbe)
  const snapshot = await api.read({}, { location }) as ProbeSnapshot
  assert.equal(snapshot.writable, true)
  const source = (await fixture.api.plugin.list({ location })).data.find(entry => entry.id === "opencode-predictions")!.source
  assert.equal(source.type, "local")
  if (source.type !== "local") throw new Error("Expected local fixture")
  const host: ProbeHost = {
    home: fixture.root, directory: fixture.directory, source, options: fixture.config.plugins[0].options,
    env: Object.fromEntries(["XDG_CONFIG_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_DISABLE_PROJECT_CONFIG"].map(key => [key, fixture.env[key]])),
    systemPaths: [join(fixture.root, "managed")],
  }
  const worker = fork(new URL("./persistence-worker.ts", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  t.after(() => worker.kill())
  const locked = new Promise<void>(resolve => worker.on("message", (message: any) => { if (message.kind === "locked") resolve() }))
  const result = new Promise<any>(resolve => worker.on("message", (message: any) => { if (message.kind === "result") resolve(message.result) }))
  worker.send({ host, revision: snapshot.revision, patch: { debug: true }, hold: true })
  await locked
  let settled = false
  const serverSave = api.save({ revision: snapshot.revision!, patch: { contextTurns: 5 }, markStarted: true }, { location }).finally(() => { settled = true })
  let started = false
  for (let tries = 0; tries < 100; tries++) {
    try { started = (await readFile(join(fixture.root, ".persistence-probe-write-started"), "utf8")) === "started" } catch {}
    if (started) break
    await delay(20)
  }
  assert.equal(started, true)
  assert.equal(settled, false, "server cannot finish while another process owns the transaction")
  worker.send({ kind: "release" })
  assert.equal((await result).kind, "written")
  assert.equal((await serverSave as { kind: string }).kind, "conflict")
  assert.equal(fixture.calls.length, 0)
})

test("real server removes sole model property with trailing comma without losing its comment", { timeout: 60000 }, async () => {
  await using fixture = await createFixture(resolve("tests/host/persistence-probe"), { timeoutMs: undefined, obsolete: undefined, automatic: undefined }, {}, { configSource: "global-jsonc" })
  const location = { directory: fixture.directory }
  const original = (await readFile(fixture.configFile!, "utf8")).replace('"models": "fixture/model"', '"models": "fixture/model", /* keep setup note */')
  await writeFile(fixture.configFile!, original)
  const api = fixture.api.rpc(PersistenceProbe)
  const before = await api.read({}, { location }) as ProbeSnapshot & { mount: string }
  assert.equal(before.writable, true)
  assert.deepEqual(before.fields, { models: "fixture/model" })
  const result = await api.save({ revision: before.revision!, patch: {}, removeModels: true }, { location }) as { kind: string }
  assert.equal(result.kind, "written")
  let after = before
  for (let tries = 0; tries < 100; tries++) {
    after = await api.read({}, { location }) as typeof before
    if (after.writable && after.mount !== before.mount) break
    await delay(30)
  }
  assert.equal(after.writable, true)
  assert.notEqual(after.mount, before.mount)
  assert.deepEqual(after.fields, {})
  assert.match(await readFile(fixture.configFile!, "utf8"), /\/\* keep setup note \*\//)
  assert.equal(await readFile(fixture.configFile! + ".predictions-backup", "utf8"), original)
  assert.equal(fixture.calls.length, 0)
})
})

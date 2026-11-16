import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { createServer } from "node:net"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseOptions } from "../src/options.ts"
import { startLocalSetup, readLocalSetup, saveLocalSetup, type LocalSetupTarget } from "../src/setup-local.ts"
import type { SetupSnapshot, SaveInput } from "../src/setup.ts"

const signal = () => new AbortController().signal
const temporaryRoot = process.env.PREDICTIONS_TEST_TMP_ROOT ?? join(tmpdir(), "opencode")
const location = { directory: "/fixture/project" }
async function fixture(t: TestContext) {
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, "l-"))
  const previous = process.env.TMPDIR
  process.env.TMPDIR = root
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous })
  const file = join(root, "config.json")
  await writeFile(file, '{"debug":false}\n')
  const parsed = parseOptions({})
  assert.ok(parsed.ok)
  let writable = true, reads = 0, saves = 0
  const snapshot: SetupSnapshot = { scope: "global", source: file, revision: "before", writable: true, fields: {}, effective: parsed.value, catalog: [], issues: [], serviceVersion: "instance-one" }
  const api = {
    async read() { reads++; return { ...snapshot, writable } },
    async save(input: SaveInput) {
      saves++
      if (input.revision !== snapshot.revision) return { kind: "conflict" as const, message: "Stale revision." }
      await writeFile(file, JSON.stringify(input.fields))
      snapshot.revision = "after"; snapshot.fields = { ...snapshot.fields, ...input.fields }
      return { kind: "saved_not_active" as const, revision: "after", message: "Saved on disk." }
    },
  }
  const authority = await startLocalSetup(location, api)
  if (authority) t.after(() => authority.dispose())
  const target: LocalSetupTarget = { id: authority?.id ?? "0000000000000000", serviceVersion: snapshot.serviceVersion, location, serverPid: process.pid }
  const path = join(root, "pp-" + target.id, "s")
  return { root, file, path, target, snapshot, api, authority, counts: () => ({ reads, saves }), readonly() { writable = false } }
}

test("local setup round-trips a qualified snapshot and one Save without retry", async t => {
  const f = await fixture(t)
  assert.ok(f.authority, "a qualified source must create a private authority")
  assert.match(f.authority.id, /^[0-9a-f]{16}$/)
  assert.equal((await lstat(join(f.root, "pp-" + f.authority.id))).mode & 0o777, 0o700)
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600)
  assert.equal((await readLocalSetup(f.target, signal())).writable, true)
  assert.equal((await saveLocalSetup(f.target, { revision: "before", fields: { debug: true } }, signal())).kind, "saved_not_active")
  assert.equal(await readFile(f.file, "utf8"), '{"debug":true}')
  assert.equal((await saveLocalSetup(f.target, { revision: "before", fields: { debug: false } }, signal())).kind, "conflict")
  assert.equal(f.counts().saves, 2)
  await f.authority.dispose()
  await assert.rejects(lstat(f.path))
  await assert.rejects(lstat(join(f.root, "pp-" + f.authority.id)))
})

test("local setup refuses malformed targets, server replacement and wrong pinned location", async t => {
  const f = await fixture(t)
  for (const target of [
    { ...f.target, id: "../config.json" }, { ...f.target, id: f.path }, { ...f.target, id: "f".repeat(16) },
    { ...f.target, serviceVersion: "replacement" }, { ...f.target, serverPid: process.pid + 1 },
    { ...f.target, location: { directory: "/other" } }, { ...f.target, path: f.path },
  ]) await assert.rejects(readLocalSetup(target, signal()), /Local setup is unavailable/)
  assert.equal(f.counts().saves, 0)
  assert.equal(await readFile(f.file, "utf8"), '{"debug":false}\n')
})

test("local setup rechecks source qualification before Save", async t => {
  const f = await fixture(t)
  assert.ok(f.authority)
  f.readonly()
  assert.equal((await saveLocalSetup(f.target, { revision: "before", fields: { debug: true } }, signal())).kind, "read_only")
  assert.equal(f.counts().saves, 0)
})

test("local setup refuses unsafe directory and socket modes and symlinked authority paths", async t => {
  const f = await fixture(t)
  assert.ok(f.authority)
  const directory = join(f.root, "pp-" + f.authority.id)
  await chmod(directory, 0o755)
  await assert.rejects(readLocalSetup(f.target, signal()))
  await chmod(directory, 0o700)
  await chmod(f.path, 0o666)
  await assert.rejects(readLocalSetup(f.target, signal()))
  await chmod(f.path, 0o600)
  await rename(directory, directory + "-owned")
  await symlink(directory + "-owned", directory)
  await assert.rejects(readLocalSetup(f.target, signal()))
  assert.equal(f.counts().saves, 0)
})

test("local setup bounds response independently from its request", async t => {
  const f = await fixture(t)
  assert.ok(f.authority)
  f.snapshot.catalog = Array.from({ length: 1000 }, (_, index) => ({ providerID: "fixture", id: String(index), name: "x".repeat(100), enabled: true, variants: [] }))
  assert.equal((await readLocalSetup(f.target, signal())).catalog.length, 1000)
  f.snapshot.catalog = [{ providerID: "fixture", id: "huge", name: "x".repeat(8388608), enabled: true, variants: [] }]
  await assert.rejects(readLocalSetup(f.target, signal()), /Local setup is unavailable/)
})

async function raw(path: string, input: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let output = ""
    socket.on("connect", () => socket.end(input))
    socket.on("data", chunk => { output += chunk })
    socket.on("error", reject)
    socket.on("close", () => resolve(output))
  })
}

test("local setup rejects oversized, incomplete and extra-field requests before Save dispatch", async t => {
  const f = await fixture(t)
  assert.ok(f.authority)
  const envelope = { id: f.target.id, serviceVersion: f.target.serviceVersion, serverPid: process.pid, location, method: "save", input: { revision: "before", fields: { debug: true } } }
  for (const input of [
    "x".repeat(65537), JSON.stringify(envelope), JSON.stringify({ ...envelope, path: f.file }) + "\n",
    JSON.stringify({ ...envelope, input: { ...envelope.input, source: f.file } }) + "\n",
    JSON.stringify({ ...envelope, input: { ...envelope.input, fields: { unknown: true } } }) + "\n",
    JSON.stringify(envelope) + "\n{}\n",
  ]) {
    const output = await raw(f.path, input)
    assert.doesNotMatch(output, /before|fixture|debug|config\.json/)
  }
  assert.equal(f.counts().saves, 0)
  assert.equal(await readFile(f.file, "utf8"), '{"debug":false}\n')
})

test("local setup caller cancellation and disposal prevent late operations", async t => {
  const f = await fixture(t)
  assert.ok(f.authority)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(saveLocalSetup(f.target, { revision: "before", fields: { debug: true } }, abort.signal))
  await f.authority.dispose()
  await assert.rejects(readLocalSetup(f.target, signal()))
  assert.equal(f.counts().saves, 0)
})

test("local setup refuses an overlong socket path and unqualified source without creating an authority", async t => {
  const f = await fixture(t)
  const long = join(f.root, "x".repeat(80))
  await mkdir(long)
  process.env.TMPDIR = long
  assert.equal(await startLocalSetup(location, f.api), undefined)
  process.env.TMPDIR = f.root
  f.readonly()
  assert.equal(await startLocalSetup(location, f.api), undefined)
})

test("local setup rejects the wrong native server PID before Save", async t => {
  const f = await fixture(t)
  await assert.rejects(saveLocalSetup({ ...f.target, serverPid: process.pid + 1 }, { revision: "before", fields: { debug: true } }, signal()))
  assert.equal(f.counts().saves, 0)
  assert.equal(await readFile(f.file, "utf8"), '{"debug":false}\n')
})

test("local setup disposal preserves a replacement socket", async t => {
  const f = await fixture(t)
  assert.ok(f.authority)
  await rename(f.path, f.path + "-original")
  const replacement = createServer()
  await new Promise<void>(resolve => replacement.listen(f.path, resolve))
  await chmod(f.path, 0o600)
  t.after(() => new Promise<void>(resolve => replacement.close(() => resolve())))
  await f.authority.dispose()
  assert.equal((await lstat(f.path)).isSocket(), true, "cleanup must not unlink another listener")
})

test("local setup caps simultaneous idle clients and expires unterminated frames", { timeout: 15000 }, async t => {
  const f = await fixture(t)
  assert.ok(f.authority)
  const clients = await Promise.all(Array.from({ length: 16 }, () => new Promise<ReturnType<typeof createConnection>>(resolve => {
    const socket = createConnection(f.path)
    socket.on("error", () => {})
    socket.on("connect", () => resolve(socket))
  })))
  t.after(() => clients.forEach(socket => socket.destroy()))
  const extra = createConnection(f.path)
  extra.on("error", () => {})
  await new Promise<void>(resolve => extra.on("close", resolve))
  await Promise.all(clients.map(socket => new Promise<void>(resolve => socket.on("close", resolve))))
  assert.equal(f.counts().saves, 0)
})

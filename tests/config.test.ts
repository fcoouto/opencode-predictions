import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join, resolve } from "node:path"
import { createConfigStore, type ConfigHost } from "../src/config.ts"

const signal = () => new AbortController().signal

async function fixture() {
  await mkdir(".test-artifacts", { recursive: true })
  const home = await mkdtemp(resolve(".test-artifacts/store-"))
  const global = join(home, "config/opencode")
  await mkdir(global, { recursive: true })
  const file = join(global, "opencode.jsonc")
  const options: Record<string, unknown> = { models: "fixture/model", automatic: false, unknown: "synthetic-private-option" }
  const original = `// keep this comment\r\n{\r\n\t"plugins": [{"package": ${JSON.stringify(resolve("."))}, "options": {"models": "fixture/model", "automatic": false, "unknown": "synthetic-private-option"}}],\r\n\t"username": "synthetic-private-config",\r\n}\r\n`
  await writeFile(file, original, { mode: 0o640 })
  const host: ConfigHost = {
    version: "2.2.6", home, directory: home,
    env: { XDG_CONFIG_HOME: join(home, "config"), OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    systemPaths: [join(home, "managed")],
    source: async () => ({ type: "local", path: resolve(".") }),
    options: () => options,
  }
  return { home, file, global, host, options, original, store: createConfigStore(host) }
}

describe("verified macOS global config store", { skip: process.platform !== "darwin" }, () => {
test("store exposes only known fields and changes only the requested bytes", async () => {
  const f = await fixture()
  const before = await f.store.read(signal())
  assert.equal(before.writable, true)
  assert.equal(before.scope, "global")
  assert.equal(before.source, f.file)
  assert.deepEqual(before.fields, { models: "fixture/model", automatic: false })
  assert.doesNotMatch(JSON.stringify(before), /synthetic-private/)
  const result = await f.store.write(before.revision, { debug: true }, signal())
  assert.equal(result.kind, "written")
  f.options.debug = true
  const after = await f.store.read(signal())
  assert.deepEqual(result, { kind: "written", revision: after.revision })
  assert.equal((await readFile(f.file, "utf8")).replace(',"debug": true', ""), f.original)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), f.original)
  assert.equal((await stat(f.file)).mode & 0o777, 0o640)
  assert.equal((await stat(f.file + ".predictions-backup")).mode & 0o777, 0o600)
  assert.equal((await f.store.write(before.revision, { contextTurns: 5 }, signal())).kind, "conflict")
  assert.deepEqual((await readdir(f.global)).sort(), ["opencode.jsonc", "opencode.jsonc.predictions-backup"])
})

test("store instances serialize cooperating saves instead of rebasing the stale draft", async () => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  const second = createConfigStore(f.host)
  const results = await Promise.all([
    f.store.write(snapshot.revision, { debug: true }, signal()),
    second.write(snapshot.revision, { contextTurns: 5 }, signal()),
  ])
  assert.deepEqual(results.map(result => result.kind).sort(), ["conflict", "written"])
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), f.original)
})

test("unsupported source, version, override and filesystem cases refuse writes", async () => {
  const cases: [string, (f: Awaited<ReturnType<typeof fixture>>) => unknown][] = [
    ["version", f => { f.host.version = "2.3.0" }],
    ["unknown source", f => { f.host.source = async () => undefined }],
    ["wrong source", f => { f.host.source = async () => ({ type: "local", path: f.home }) }],
    ["options mismatch", f => { f.host.options = () => ({ models: "elsewhere/model" }) }],
    ["inline", f => { f.host.env.OPENCODE_CONFIG_CONTENT = "{}" }],
    ["explicit", f => { f.host.env.OPENCODE_CONFIG = "/unsupported" }],
    ["custom directory", f => { f.host.env.OPENCODE_CONFIG_DIR = "/unsupported" }],
    ["relative XDG", f => { f.host.env.XDG_CONFIG_HOME = "." }],
    ["project discovery", f => { delete f.host.env.OPENCODE_DISABLE_PROJECT_CONFIG }],
    ["both filenames", f => writeFile(join(f.global, "opencode.json"), "{}")],
    ["managed", f => mkdir(f.host.systemPaths[0])],
    ["automatic discovery", f => mkdir(join(f.global, "plugins"))],
    ["unwritable", f => chmod(f.file, 0o400)],
    ["hardlink", f => link(f.file, join(f.home, "linked"))],
    ["recovery symlink", f => symlink(f.file, f.file + ".predictions-backup")],
    ["active symlink", async f => { await rename(f.file, join(f.home, "indirect")); await symlink(join(f.home, "indirect"), f.file) }],
    ["file ACL", f => promisify(execFile)("/bin/chmod", ["+a", "everyone allow read", f.file])],
    ["directory ACL", f => promisify(execFile)("/bin/chmod", ["+a", "everyone allow read", f.global])],
    ["duplicate alias", f => writeFile(f.file, f.original.replace('"plugins": [', `"plugins": [{"package": ${JSON.stringify(resolve(".") + "/.")}, "options": {}},`))],
    ["source lookup error", f => { f.host.source = async () => { throw new Error("synthetic-private-source-failure") } }],
    ["duplicate keys", f => writeFile(f.file, f.original.replace('"username":', '"username": "before", "username":'))],
    ["malformed", f => writeFile(f.file, "{ invalid")],
    ["string form", f => writeFile(f.file, JSON.stringify({ plugins: [resolve(".")] }))],
  ]
  for (const [name, arrange] of cases) {
    const f = await fixture()
    const snapshot = await f.store.read(signal())
    assert.equal(snapshot.writable, true, name + ": control")
    await arrange(f)
    const bytes = await readFile(f.file)
    const unsafe = await f.store.read(signal())
    assert.equal(unsafe.writable, false, name)
    const result = await f.store.write(snapshot.revision, { debug: true }, signal())
    assert.notEqual(result.kind, "written", name)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private|EACCES|ENOENT/)
    assert.deepEqual(await readFile(f.file), bytes, name)
  }
})

test("invalid stored values remain visible without being replaced by defaults", async () => {
  const f = await fixture()
  f.options.contextTurns = "wrong"
  await writeFile(f.file, f.original.replace('"automatic": false', '"automatic": false, "contextTurns": "wrong"'))
  const snapshot = await f.store.read(signal())
  assert.equal(snapshot.writable, false)
  assert.equal(snapshot.fields.contextTurns, "wrong")
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-private/)
})

test("store validates changed keys and permits deletion only for models", async () => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  for (const patch of [{ enabled: undefined }, { contextTurns: 8 }, { unknown: "overwrite" }, { models: [] }]) {
    assert.notEqual((await f.store.write(snapshot.revision, patch, signal())).kind, "written")
    assert.equal(await readFile(f.file, "utf8"), f.original)
  }
  assert.equal((await f.store.write(snapshot.revision, { models: undefined }, signal())).kind, "written")
  assert.equal((await readFile(f.file, "utf8")).includes('"models"'), false)
})

test("aborted or failed pre-commit saves preserve bytes and never restore automatically", async () => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  assert.equal(snapshot.writable, true)
  const controller = new AbortController()
  controller.abort()
  assert.notEqual((await f.store.write(snapshot.revision, { debug: true }, controller.signal)).kind, "written")
  assert.equal(await readFile(f.file, "utf8"), f.original)
  await mkdir(f.file + ".predictions-backup")
  assert.notEqual((await f.store.write(snapshot.revision, { debug: true }, signal())).kind, "written")
  assert.equal(await readFile(f.file, "utf8"), f.original)
  assert.equal((await readdir(f.global)).some(name => name.includes(".tmp-") || name.endsWith(".lock")), false)
})

test("source and permission changes after opening setup reject the stale revision", async () => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  await chmod(f.file, 0o600)
  assert.equal((await f.store.write(snapshot.revision, { debug: true }, signal())).kind, "conflict")
  assert.equal(await readFile(f.file, "utf8"), f.original)
  await unlink(f.file)
  assert.equal((await f.store.read(signal())).writable, false)
  assert.notEqual((await f.store.write(snapshot.revision, { debug: true }, signal())).kind, "written")
})

test("cancelling while another writer owns the lock never removes that lock", async () => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  const lock = join(f.global, ".predictions-setup.lock")
  await mkdir(lock, { mode: 0o700 })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30)
  try {
    const result = await f.store.write(snapshot.revision, { debug: true }, controller.signal)
    assert.notEqual(result.kind, "written")
    assert.equal(await readFile(f.file, "utf8"), f.original)
    assert.equal((await stat(lock)).isDirectory(), true)
  } finally { clearTimeout(timer); await rmdir(lock) }
})

test("recovery copy rotates once without growing history or changing package references", async () => {
  const f = await fixture()
  const before = await f.store.read(signal())
  assert.equal((await f.store.write(before.revision, { debug: true }, signal())).kind, "written")
  f.options.debug = true
  const once = await readFile(f.file, "utf8")
  const after = await f.store.read(signal())
  assert.equal((await f.store.write(after.revision, { timeoutMs: 4000 }, signal())).kind, "written")
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), once)
  assert.deepEqual((await readdir(f.global)).sort(), ["opencode.jsonc", "opencode.jsonc.predictions-backup"])
})
})

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { execFile, fork } from "node:child_process"
import { promisify } from "node:util"
import { join, resolve } from "node:path"
import { createCandidate, type ProbeHost } from "./persistence-candidate.ts"

describe("macOS persistence research candidate", { skip: process.platform !== "darwin" }, () => {
const sourcePackage = resolve(".")
const original = `{
  // keep this comment
  "plugins": [
    {"package": ${JSON.stringify(sourcePackage)}, "options": {"models": "fixture/model", "automatic": false, "unknown": "keep"}},
    {"package": "other-plugin", "options": {"token": "synthetic-private"}}
  ],
  "username": "untouched",
}
`

async function fixture() {
  await mkdir(".test-artifacts", { recursive: true })
  const home = await mkdtemp(resolve(".test-artifacts/config-guard-"))
  const global = join(home, "config", "opencode")
  const directory = join(home, "project")
  await mkdir(global, { recursive: true })
  await mkdir(directory)
  const file = join(global, "opencode.jsonc")
  await writeFile(file, original, { mode: 0o640 })
  const host: ProbeHost = {
    home, directory, env: { XDG_CONFIG_HOME: join(home, "config"), OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    source: { type: "local", path: sourcePackage },
    options: { models: "fixture/model", automatic: false, unknown: "keep" },
    systemPaths: [join(home, "managed")],
  }
  return { home, global, directory, file, host }
}

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("persistence preserves JSONC and plugin identity", async () => {
  const f = await fixture()
  const store = createCandidate(f.host)
  const before = await store.read()
  assert.equal(before.writable, true, before.reason ?? "Source must be writable")
  assert.equal(before.source, f.file)
  assert.equal((await store.write(before.revision!, { debug: true })).kind, "written")
  const text = await readFile(f.file, "utf8")
  assert.equal(text.replace(',"debug": true', ""), original, "only the requested property may change")
  assert.ok(text.includes("// keep this comment"))
  assert.ok(text.includes('"unknown": "keep"'))
  assert.ok(text.includes('{"package": "other-plugin", "options": {"token": "synthetic-private"}}'))
  assert.ok(text.includes('"username": "untouched"'))
  assert.ok(text.includes('"debug": true'))
  assert.equal((await stat(f.file)).mode & 0o777, 0o640)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), original)
  assert.equal((await stat(f.file + ".predictions-backup")).mode & 0o777, 0o600)
  assert.doesNotMatch(JSON.stringify(before), /synthetic-private|unknown.*keep/)
  assert.deepEqual((await readdir(f.global)).sort(), ["opencode.jsonc", "opencode.jsonc.predictions-backup"])
})

test("cooperating setup writers serialize across supported instances", { timeout: 10000 }, async () => {
  const f = await fixture()
  const entered = barrier(), release = barrier()
  const first = createCandidate(f.host, { afterLock: async () => { entered.resolve(); await release.promise } })
  const second = createCandidate(f.host)
  const snapshot = await first.read()
  assert.equal(snapshot.writable, true, snapshot.reason ?? "Source must be writable")
  const one = first.write(snapshot.revision!, { debug: true })
  await entered.promise
  const two = second.write(snapshot.revision!, { contextTurns: 5 })
  release.resolve()
  assert.equal((await one).kind, "written")
  assert.equal((await two).kind, "conflict")
  assert.ok((await readFile(f.file, "utf8")).includes('"debug": true'))
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), original)
})

test("detected stale edits abort before replacement", async () => {
  const f = await fixture()
  const externallyEdited = original.replace('"username": "untouched"', '"username": "external"')
  const store = createCandidate(f.host, { beforeBackup: () => writeFile(f.file, externallyEdited) })
  const snapshot = await store.read()
  assert.equal(snapshot.writable, true, snapshot.reason ?? "Source must be writable")
  assert.equal((await store.write(snapshot.revision!, { debug: true })).kind, "conflict")
  assert.equal(await readFile(f.file, "utf8"), externallyEdited)
  assert.equal((await readdir(f.global)).some(name => name.includes(".tmp-") || name.endsWith(".lock")), false)
})

test("recovery-copy failure leaves active config unchanged", async () => {
  const f = await fixture()
  const store = createCandidate(f.host)
  const snapshot = await store.read()
  assert.equal(snapshot.writable, true, snapshot.reason ?? "Source must be writable")
  await mkdir(f.file + ".predictions-backup")
  assert.equal((await store.write(snapshot.revision!, { debug: true })).kind, "failed")
  assert.equal(await readFile(f.file, "utf8"), original)
  assert.equal((await readdir(f.global)).some(name => name.includes(".tmp-") || name.endsWith(".lock")), false)
})

test("replacement failure preserves original bytes and never restores automatically", async () => {
  const f = await fixture()
  let denied = false
  const store = createCandidate(f.host, { replace: async (from, to) => {
    await chmod(f.global, 0o500)
    try { await rename(from, to) } catch (error) {
      denied = (error as NodeJS.ErrnoException).code === "EACCES"
      throw error
    } finally { await chmod(f.global, 0o755) }
  } })
  const snapshot = await store.read()
  assert.equal(snapshot.writable, true, snapshot.reason ?? "Source must be writable")
  assert.equal((await store.write(snapshot.revision!, { debug: true })).kind, "failed")
  assert.equal(denied, true, "exercise a real kernel permission failure, not an injected error")
  assert.equal(await readFile(f.file, "utf8"), original)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), original)
  assert.equal((await readdir(f.global)).some(name => name.includes(".tmp-") || name.endsWith(".lock")), false)
})

test("unsupported provenance is read-only", async () => {
  const cases: [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>][] = [
    ["inline override", async f => { f.host.env.OPENCODE_CONFIG_CONTENT = "{}" }],
    ["explicit config", async f => { f.host.env.OPENCODE_CONFIG = join(f.home, "elsewhere.json") }],
    ["custom config directory", async f => { f.host.env.OPENCODE_CONFIG_DIR = join(f.home, "elsewhere") }],
    ["second global file", f => writeFile(join(f.global, "opencode.json"), "{}")],
    ["project override", async f => { delete f.host.env.OPENCODE_DISABLE_PROJECT_CONFIG; await writeFile(join(f.directory, "opencode.json"), "{}") }],
    ["managed configuration", f => mkdir(f.host.systemPaths[0])],
    ["wrong package", async f => { f.host.source.path = f.home }],
    ["different effective options", async f => { f.host.options = { models: "not/the-same" } }],
    ["duplicate entries", f => writeFile(f.file, original.replace('    {"package": "other-plugin"', `    {"package": ${JSON.stringify(sourcePackage)}, "options": {}},\n    {"package": "other-plugin"`))],
    ["duplicate keys", f => writeFile(f.file, original.replace('"username": "untouched"', '"username": "before", "username": "after"'))],
    ["malformed JSONC", f => writeFile(f.file, "{ invalid")],
    ["unwritable file", f => chmod(f.file, 0o400)],
    ["hardlinked file", f => link(f.file, join(f.home, "linked"))],
    ["symlinked backup", f => symlink(f.file, f.file + ".predictions-backup")],
    ["symlinked active file", async f => { await rename(f.file, join(f.home, "indirect")); await symlink(join(f.home, "indirect"), f.file) }],
    ["npm source", async f => { f.host.source = { type: "package", target: "opencode-predictions@0.1.0" } }],
    ["Git source", async f => { f.host.source = { type: "package", target: "github:example/opencode-predictions" } }],
    ["string entry", f => writeFile(f.file, JSON.stringify({ plugins: [sourcePackage] }))],
    ["local alias duplicate", f => writeFile(f.file, original.replace('    {"package": "other-plugin"', `    {"package": ${JSON.stringify(sourcePackage + "/.")}, "options": {}},\n    {"package": "other-plugin"`))],
    ["ACL grants", f => promisify(execFile)("/bin/chmod", ["+a", "everyone allow read", f.file])],
    ["directory ACL grants", f => promisify(execFile)("/bin/chmod", ["+a", "everyone allow read", f.global])],
    ["world-writable global directory", f => chmod(f.global, 0o777)],
    ["automatic global plugin discovery", f => mkdir(join(f.global, "plugins"))],
  ]
  for (const [name, arrange] of cases) {
    const f = await fixture()
    assert.equal((await createCandidate(f.host).read()).writable, true, name + ": control")
    await arrange(f)
    const bytes = await readFile(f.file)
    const store = createCandidate(f.host)
    assert.equal((await store.read()).writable, false, name)
    assert.notEqual((await store.write("untrusted", { debug: true })).kind, "written", name)
    assert.deepEqual(await readFile(f.file), bytes, name)
  }
})

test("separate processes serialize the complete transaction and reject the stale writer", { timeout: 15000 }, async t => {
  const f = await fixture()
  const snapshot = await createCandidate(f.host).read()
  assert.equal(snapshot.writable, true)
  function worker(patch: Record<string, unknown>, hold: boolean) {
    const child = fork(new URL("./persistence-worker.ts", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
    t.after(() => child.kill())
    const messages: any[] = []
    child.on("message", message => messages.push(message))
    function wait(kind: string) {
      return new Promise<any>((resolve, reject) => {
        const previous = messages.find(message => message.kind === kind)
        if (previous) return resolve(previous)
        const onMessage = (message: any) => { if (message.kind === kind) { child.off("message", onMessage); resolve(message) } }
        child.on("message", onMessage)
        child.once("error", reject)
        child.once("exit", code => { if (!messages.some(message => message.kind === kind)) reject(new Error("Worker exited before " + kind + ": " + code)) })
      })
    }
    child.send({ host: f.host, revision: snapshot.revision, patch, hold })
    return { child, wait, messages }
  }
  const first = worker({ debug: true }, true)
  await first.wait("locked")
  const second = worker({ contextTurns: 5 }, false)
  await second.wait("started")
  first.child.send({ kind: "release" })
  assert.equal((await first.wait("result")).result.kind, "written")
  assert.equal((await second.wait("result")).result.kind, "conflict")
  assert.match(await readFile(f.file, "utf8"), /"debug": true/)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), original)
  assert.deepEqual((await readdir(f.global)).sort(), ["opencode.jsonc", "opencode.jsonc.predictions-backup"])
})

test("recovery copy rotates once and preserves original JSON and CRLF bytes", async () => {
  const f = await fixture()
  const initial = JSON.stringify({ plugins: [{ package: sourcePackage, options: f.host.options }], username: "keep" }, null, "\t").replaceAll("\n", "\r\n") + "\r\n"
  await rename(f.file, join(f.global, "opencode.json"))
  const file = join(f.global, "opencode.json")
  await writeFile(file, initial)
  const store = createCandidate(f.host)
  const before = await store.read()
  assert.equal(before.writable, true)
  assert.equal((await store.write(before.revision!, { debug: true })).kind, "written")
  const once = await readFile(file, "utf8")
  assert.equal(await readFile(file + ".predictions-backup", "utf8"), initial)
  assert.equal(once.replaceAll("\r\n", "").includes("\n"), false)
  assert.ok(once.includes('\t"username": "keep"'))
  f.host.options.debug = true
  const next = await store.read()
  assert.equal((await store.write(next.revision!, { contextTurns: 4 })).kind, "written")
  assert.equal(await readFile(file + ".predictions-backup", "utf8"), once)
  assert.equal((await stat(file + ".predictions-backup")).mode & 0o777, 0o600)
  assert.deepEqual((await readdir(f.global)).sort(), ["opencode.json", "opencode.json.predictions-backup"])
})

test("changed permissions and untrusted patch keys never commit", async () => {
  const f = await fixture()
  const store = createCandidate(f.host)
  const before = await store.read()
  assert.equal((await store.write(before.revision!, { token: "must-not-write" })).kind, "invalid")
  assert.equal((await store.write(before.revision!, { contextTurns: 8 })).kind, "invalid")
  assert.equal((await store.write(before.revision!, { enabled: undefined })).kind, "invalid")
  await chmod(f.file, 0o600)
  assert.equal((await store.write(before.revision!, { debug: true })).kind, "conflict")
  assert.equal(await readFile(f.file, "utf8"), original)
})

test("late external-editor race remains possible and its bytes are not in the recovery copy", async () => {
  const f = await fixture()
  const external = original.replace('"username": "untouched"', '"username": "lost"')
  const store = createCandidate(f.host, { beforeReplace: () => writeFile(f.file, external) })
  const snapshot = await store.read()
  assert.equal((await store.write(snapshot.revision!, { debug: true })).kind, "written")
  assert.match(await readFile(f.file, "utf8"), /"username": "untouched"/)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), original)
})

test("all seven edited settings persist while unknown options and omitted defaults remain untouched", async () => {
  const f = await fixture()
  const store = createCandidate(f.host)
  const before = await store.read()
  const patch = { enabled: false, automatic: true, escalation: "off", models: ["fixture/model"], timeoutMs: 2000, contextTurns: 4, debug: true }
  const saved = await store.write(before.revision!, patch)
  assert.equal(saved.kind, "written")
  Object.assign(f.host.options, patch)
  const after = await store.read()
  assert.equal(saved.revision, after.revision, "written revision must identify the persisted document")
  assert.deepEqual(after.fields, patch)
  assert.ok((await readFile(f.file, "utf8")).includes('"unknown": "keep"'))
  assert.equal((await store.write(after.revision!, { models: undefined })).kind, "written")
  assert.equal((await readFile(f.file, "utf8")).includes('"models"'), false)
})

test("pre-commit interruption removes temporary files and preserves active bytes", async () => {
  const f = await fixture()
  const store = createCandidate(f.host, { beforeBackup: async () => { throw new Error("Interrupted") } })
  const snapshot = await store.read()
  assert.equal((await store.write(snapshot.revision!, { debug: true })).kind, "failed")
  assert.equal(await readFile(f.file, "utf8"), original)
  assert.deepEqual(await readdir(f.global), ["opencode.jsonc"])
})

test("abandoned lock times out without age-based ownership stealing", { timeout: 10000 }, async () => {
  const f = await fixture()
  const store = createCandidate(f.host)
  const snapshot = await store.read()
  const lock = join(f.global, ".predictions-setup.lock")
  await mkdir(lock, { mode: 0o700 })
  await utimes(lock, new Date(0), new Date(0))
  assert.equal((await store.write(snapshot.revision!, { debug: true })).kind, "busy")
  assert.equal(await readFile(f.file, "utf8"), original)
  assert.deepEqual((await readdir(f.global)).sort(), [".predictions-setup.lock", "opencode.jsonc"])
})

test("unverified post-commit bytes never report a verified successful write or trigger rollback", async () => {
  const f = await fixture()
  const external = original.replace('"username": "untouched"', '"username": "external-after-commit"')
  const store = createCandidate(f.host, { replace: async (from, to) => { await rename(from, to); await writeFile(to, external) } })
  const snapshot = await store.read()
  assert.equal((await store.write(snapshot.revision!, { debug: true })).kind, "written_unverified")
  assert.equal(await readFile(f.file, "utf8"), external)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), original)
})
})

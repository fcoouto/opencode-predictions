import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import fs, { chmod, chown, link, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { join, resolve } from "node:path"
import { fork, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { administrativePaths, createPreferencesStore, decodePreferences, expandContextPath, managedContextPath, preferencesPath, sameContextPath, contextFileProblem, type PreferencesHost } from "../src/preferences-store.ts"

const signal = () => new AbortController().signal
async function fixture() {
  await mkdir(".test-artifacts", { recursive: true })
  const home = await mkdtemp(resolve(".test-artifacts/preferences-"))
  const host: PreferencesHost = { home, platform: process.platform, env: { XDG_CONFIG_HOME: join(home, "config") }, systemPaths: [join(home, "managed")] }
  const store = createPreferencesStore(host), file = preferencesPath(host)
  async function put(settings: object, extra = {}) {
    await mkdir(join(home, "config", "opencode"), { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify({ version: 1, settings, ...extra }) + "\n", { mode: 0o600 })
  }
  return { home, host, store, file, put }
}
function interceptRename(t: TestContext, run: (from: string, to: string, original: () => Promise<void>) => Promise<void>) {
  const original = fs.rename
  const mock = t.mock.method(fs, "rename", (from: string, to: string) => run(String(from), String(to), () => original(from, to)))
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
}

test("preferences paths use server config roots, not the project", () => {
  assert.equal(preferencesPath({ home: "/u", platform: "darwin", env: {}, systemPaths: [] }), "/u/.config/opencode/predictions.json")
  assert.equal(preferencesPath({ home: "/u", platform: "linux", env: { XDG_CONFIG_HOME: "/config" }, systemPaths: [] }), "/config/opencode/predictions.json")
  for (const value of ["", "."]) assert.throws(() => preferencesPath({ home: "/u", platform: "linux", env: { XDG_CONFIG_HOME: value }, systemPaths: [] }))
  assert.equal(preferencesPath({ home: "C:\\Users\\u", platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, systemPaths: [] }), "C:\\Users\\u\\AppData\\Roaming\\opencode\\predictions.json")
  assert.throws(() => preferencesPath({ home: "C:\\Users\\u", platform: "win32", env: {}, systemPaths: [] }))
})

test("administrative discovery uses ProgramData on Windows and fails closed when its root is unknown", async () => {
  assert.deepEqual(administrativePaths("win32", { ProgramData: "D:\\Managed" }), ["D:\\Managed\\opencode"])
  assert.deepEqual(administrativePaths("linux", {}), ["/etc/opencode"])
  for (const ProgramData of [undefined, "", "relative"]) {
    const f = await fixture()
    await f.put({ debug: true })
    f.host.systemPaths = administrativePaths("win32", { ProgramData })
    const state = await f.store.read(signal())
    assert.equal(state.policy, "managed")
    assert.equal(state.writable, false)
    assert.deepEqual(state.overrides, {})
  }
})

test("missing preferences preserve legacy activation when ownership verification is unsupported", async () => {
  const f = await fixture()
  const getuid = process.getuid
  try {
    process.getuid = undefined as any
    const state = await f.store.read(signal())
    assert.equal(state.documentValid, true, "verified absence is not an unreadable preference document")
    assert.equal(state.writable, false)
    assert.deepEqual(state.overrides, {})
    assert.equal((await f.store.write(state.revision, { fields: { debug: true } }, signal())).kind, "read_only")
    assert.deepEqual(await readdir(f.home), [])
  } finally { process.getuid = getuid }
})

test("strict byte decoding rejects malformed UTF-8 and oversize documents", () => {
  assert.throws(() => decodePreferences(Buffer.concat([Buffer.from('{"version":1,"settings":{"future":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}}')])), /valid UTF-8/)
  assert.throws(() => decodePreferences(Buffer.alloc(65537, 32)), /65536/)
})

test("read does not create preferences; first save writes only changed fields without locks", async () => {
  const f = await fixture()
  const before = await f.store.read(signal())
  assert.equal(before.writable, true)
  assert.equal(before.documentValid, true)
  assert.deepEqual(await readdir(f.home), [])
  assert.equal((await f.store.write(before.revision, { fields: { automatic: false } }, signal())).kind, "written")
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { version: 1, settings: { automatic: false } })
  assert.equal((await stat(f.file)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(join(f.home, "config", "opencode")), ["predictions.json"])
})

test("already committed revisions reject stale drafts and preserve unrelated OpenCode bytes", async () => {
  const f = await fixture()
  await f.put({ debug: false })
  const unrelated = join(f.home, "config", "opencode", "opencode.jsonc"), text = '// PRIVATE\n{"plugins":["package-name"]}\n'
  await writeFile(unrelated, text)
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  assert.equal((await f.store.write(before.revision, { fields: { debug: true } }, signal())).kind, "written")
  assert.equal((await f.store.write(before.revision, { fields: { contextTurns: 5 } }, signal())).kind, "conflict")
  assert.deepEqual(await readFile(f.file + ".backup"), bytes)
  assert.equal((await stat(f.file + ".backup")).mode & 0o777, 0o600)
  assert.equal(await readFile(unrelated, "utf8"), text)
})

test("unknown members survive reset and no-model suppression is distinct from reset", async () => {
  const f = await fixture()
  await f.put({ automatic: false, future: "PRIVATE", models: "local/a" }, { future: { keep: true } })
  let before = await f.store.read(signal())
  assert.doesNotMatch(JSON.stringify(before), /PRIVATE/)
  assert.equal((await f.store.write(before.revision, { fields: {}, removeModels: true }, signal())).kind, "written")
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).settings.models, null)
  before = await f.store.read(signal())
  assert.equal((await f.store.write(before.revision, { fields: {}, reset: ["models", "automatic"] }, signal())).kind, "written")
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { version: 1, future: { keep: true }, settings: { future: "PRIVATE" } })
})

test("invalid prospective changes never write and numeric-null files can be repaired", async () => {
  const f = await fixture()
  await f.put({ timeoutMs: null })
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  assert.equal(before.writable, true)
  for (const input of [
    { fields: { debug: true } }, { fields: { timeoutMs: null } }, { fields: { models: null } },
    { fields: {}, reset: ["debug", "debug"] }, { fields: { debug: false }, reset: ["debug"] },
    { fields: {}, reset: ["other"] }, { fields: { models: "local/a" }, removeModels: true },
    { fields: {}, source: "/client/other" },
  ]) {
    assert.equal((await f.store.write(before.revision, input as any, signal())).kind, "failed")
    assert.deepEqual(await readFile(f.file), bytes)
  }
  assert.equal((await f.store.write(before.revision, { fields: { timeoutMs: 8000 } }, signal())).kind, "written")
})

test("managed sources suppress preferences", async () => {
  const f = await fixture()
  await f.put({ debug: true })
  await mkdir(f.host.systemPaths[0])
  const value = await f.store.read(signal())
  assert.equal(value.policy, "managed")
  assert.equal(value.writable, false)
  assert.deepEqual(value.overrides, {})
  assert.equal((await f.store.write(value.revision, { fields: { debug: false } }, signal())).kind, "read_only")
})

test("uncheckable administrative policy uses managed fallback without reading preferences", async () => {
  const f = await fixture()
  await f.put({ debug: true })
  await writeFile(join(f.home, "not-a-directory"), "synthetic")
  f.host.systemPaths = [join(f.home, "not-a-directory", "managed")]
  const value = await f.store.read(signal())
  assert.equal(value.policy, "managed")
  assert.equal(value.documentValid, true)
  assert.deepEqual(value.overrides, {})
  assert.equal(value.writable, false)
})

test("config-root aliases are supported while symlinked files and hard links are refused", async () => {
  const f = await fixture()
  await f.put({ debug: false })
  const alias = join(f.home, "alias")
  await symlink(join(f.home, "config"), alias)
  f.host.env.XDG_CONFIG_HOME = alias
  const aliased = await f.store.read(signal())
  assert.equal(aliased.writable, true)
  assert.equal(aliased.source, f.file)
  await link(f.file, join(f.home, "hardlink"))
  assert.equal((await f.store.read(signal())).writable, false)
  const g = await fixture()
  await g.put({})
  await rename(g.file, join(g.home, "elsewhere"))
  await symlink(join(g.home, "elsewhere"), g.file)
  assert.equal((await g.store.read(signal())).writable, false)
})

test("readable unwritable preferences remain inspectable but unsafe metadata is refused", async () => {
  const f = await fixture()
  await f.put({ debug: true })
  await chmod(f.file, 0o400)
  let value = await f.store.read(signal())
  assert.equal(value.documentValid, true)
  assert.equal(value.writable, false)
  assert.deepEqual(value.overrides, { debug: true })
  await chmod(f.file, 0o666)
  value = await f.store.read(signal())
  assert.equal(value.documentValid, false)
  assert.equal(value.writable, false)
})

test("malformed, duplicate, future and oversized files are never overwritten", async () => {
  for (const text of ['{bad', '{"version":2,"settings":{}}', '{"version":1,"settings":{"debug":true,"debug":false}}', " ".repeat(65537)]) {
    const f = await fixture()
    await f.put({})
    const before = await f.store.read(signal())
    await writeFile(f.file, text)
    assert.equal((await f.store.read(signal())).documentValid, false)
    assert.equal((await f.store.write(before.revision, { fields: { debug: true } }, signal())).kind, "read_only")
    assert.equal(await readFile(f.file, "utf8"), text)
  }
})

test("backup and precommit failures preserve active bytes and clean only owned temporary files", async t => {
  const f = await fixture()
  await f.put({})
  await writeFile(join(f.home, "config", "opencode", ".predictions.tmp-OTHER"), "other writer")
  await mkdir(join(f.home, "config", "opencode", ".predictions.lock"))
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  interceptRename(t, async (_from, to, original) => { if (to.endsWith(".backup")) throw new Error("PRIVATE"); await original() })
  const result = await f.store.write(before.revision, { fields: { debug: true } }, signal())
  assert.equal(result.kind, "failed")
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
  assert.deepEqual(await readFile(f.file), bytes)
  assert.deepEqual((await readdir(join(f.home, "config", "opencode"))).sort(), [".predictions.lock", ".predictions.tmp-OTHER", "predictions.json"])
})

for (const phase of ["write", "sync", "commit", "unsafe-backup", "unsafe-directory"]) test(`store refuses ${phase} failure without changing active bytes`, async t => {
  const f = await fixture()
  await f.put({ debug: false })
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  if (phase === "write" || phase === "sync") {
    const original = fs.open
    const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      if (String(args[0]).includes(".predictions.tmp-")) t.mock.method(handle, phase === "write" ? "writeFile" : "sync", async () => { throw new Error("PRIVATE failure") })
      return handle
    })
    syncBuiltinESMExports()
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  }
  if (phase === "commit") interceptRename(t, async (_from, to, original) => { if (to === f.file) throw new Error("PRIVATE failure"); await original() })
  if (phase === "unsafe-backup") await symlink(f.file, f.file + ".backup")
  if (phase === "unsafe-directory") await chmod(join(f.home, "config", "opencode"), 0o777)
  const result = await f.store.write(before.revision, { fields: { debug: true } }, signal())
  assert.notEqual(result.kind, "written")
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
  assert.deepEqual(await readFile(f.file), bytes)
  assert.equal((await readdir(join(f.home, "config", "opencode"))).some(file => file.startsWith(".predictions.tmp-")), false)
})

test("unsupported ACLs refuse preference writes", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture()
  await f.put({})
  await promisify(execFile)("/bin/chmod", ["+a", "everyone allow read", f.file])
  assert.equal((await f.store.read(signal())).writable, false)
})

test("cancellation before commit preserves bytes and a postcommit race is uncertain without rollback", async t => {
  const f = await fixture()
  await f.put({})
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(f.store.write(before.revision, { fields: { debug: true } }, cancelled.signal))
  assert.deepEqual(await readFile(f.file), bytes)
  interceptRename(t, async (_from, to, original) => {
    await original()
    if (to === f.file) await writeFile(f.file, '{"version":1,"settings":{"debug":false}}\n')
  })
  const result = await f.store.write(before.revision, { fields: { debug: true } }, signal())
  assert.equal(result.kind, "failed")
  assert.match("message" in result ? result.message : "", /may have been saved/)
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).settings, { debug: false })
})

function worker(t: TestContext, home: string, phase: string, fields: object) {
  const child = fork(resolve("tests/host/preferences-worker.ts"), [home, phase, JSON.stringify(fields)], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") })
  return child
}
function message(child: ChildProcess, key: string): Promise<any> {
  return new Promise((resolveMessage, reject) => {
    const onMessage = (value: any) => { if (Object.hasOwn(value, key)) { cleanup(); resolveMessage(value[key]) } }
    const onExit = () => { cleanup(); reject(new Error("Worker exited before " + key)) }
    const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit) }
    child.on("message", onMessage); child.once("exit", onExit)
  })
}
for (const existing of [false, true]) test(`concurrent ${existing ? "replacements can lose an earlier edit" : "first creation remains whole-document atomic"}`, { timeout: 15000 }, async t => {
  const f = await fixture()
  if (existing) await f.put({})
  const a = worker(t, f.home, "prepared", { debug: true }), b = worker(t, f.home, "prepared", { contextTurns: 5 })
  await Promise.all([message(a, "phase"), message(b, "phase")])
  const doneA = message(a, "result"); a.send("continue")
  assert.equal((await doneA).kind, "written")
  const doneB = message(b, "result"); b.send("continue")
  assert.equal((await doneB).kind, "written")
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).settings, { contextTurns: 5 })
})

for (const phase of ["prepared", "committed"]) test(`killed writer ${phase} permits fresh Save without cleanup`, { timeout: 15000 }, async t => {
  const f = await fixture()
  await f.put({ automatic: false })
  const child = worker(t, f.home, phase, { debug: true })
  await message(child, "phase")
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).settings, phase === "prepared" ? { automatic: false } : { automatic: false, debug: true })
  const priorFiles = await readdir(join(f.home, "config", "opencode"))
  assert.equal(priorFiles.some(file => file.includes("lock")), false)
  const fresh = worker(t, f.home, "none", { contextTurns: 4 })
  assert.equal((await message(fresh, "result")).kind, "written")
  const after = JSON.parse(await readFile(f.file, "utf8")).settings
  assert.equal(after.contextTurns, 4)
  assert.equal(after.automatic, false)
  for (const file of priorFiles.filter(file => file.startsWith(".predictions.tmp-"))) assert.ok((await readdir(join(f.home, "config", "opencode"))).includes(file))
})

const contextName = "predictions-context.md"
const contextOf = (f: { home: string }) => join(f.home, "config", "opencode", contextName)
const refusedContext = (reason: string) => `predictions-context.md exists but is not safe to use: ${reason}. Fix or remove it, then save again.`

test("managed context path is home-relative under home and absolute elsewhere", () => {
  const under = managedContextPath({ home: "/u", platform: "darwin", env: {}, systemPaths: [] })
  assert.deepEqual(under, { stored: "~/.config/opencode/predictions-context.md", absolute: "/u/.config/opencode/predictions-context.md" })
  assert.equal(expandContextPath(under.stored, "/u"), under.absolute)
  assert.deepEqual(managedContextPath({ home: "/u", platform: "linux", env: { XDG_CONFIG_HOME: "/config" }, systemPaths: [] }),
    { stored: "/config/opencode/predictions-context.md", absolute: "/config/opencode/predictions-context.md" })
  const windows = managedContextPath({ home: "C:\\Users\\u", platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, systemPaths: [] })
  assert.deepEqual(windows, { stored: "~/AppData/Roaming/opencode/predictions-context.md", absolute: "C:\\Users\\u\\AppData\\Roaming\\opencode\\predictions-context.md" })
  assert.equal(expandContextPath(windows.stored, "C:\\Users\\u"), windows.absolute)
  assert.equal(expandContextPath("/abs/predictions-context.md", "/u"), "/abs/predictions-context.md")
})

test("context path equality folds case only on darwin and win32", () => {
  const cases: [string, string, NodeJS.Platform, boolean][] = [
    ["~/A/predictions-context.md", "~/a/predictions-context.md", "linux", false],
    ["~/A/predictions-context.md", "~/a/predictions-context.md", "darwin", true],
    ["~/A/predictions-context.md", "~/a/predictions-context.md", "win32", true],
    ["~/x/predictions-context.md", "~/x/predictions-context.md", "linux", true],
    ["/x/predictions-context.md", "/y/predictions-context.md", "darwin", false],
  ]
  for (const [a, b, platform, same] of cases) assert.equal(sameContextPath(a, b, platform), same, `${platform}: ${a} vs ${b}`)
})

test("first managed save creates an empty private context file and records a home-relative path", async () => {
  const f = await fixture()
  const before = await f.store.read(signal())
  assert.equal((await f.store.write(before.revision, { fields: {}, contextFile: "managed" }, signal())).kind, "written")
  assert.equal(await readFile(contextOf(f), "utf8"), "")
  assert.equal((await stat(contextOf(f))).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).settings.contextFile, "~/config/opencode/predictions-context.md")
})

test("context file mode is 0600 even under a restrictive umask", async () => {
  const f = await fixture()
  await f.put({ debug: false })
  const before = await f.store.read(signal())
  const previous = process.umask(0o277)
  try { assert.equal((await f.store.write(before.revision, { fields: {}, contextFile: "managed" }, signal())).kind, "written") }
  finally { process.umask(previous) }
  assert.equal((await stat(contextOf(f))).mode & 0o777, 0o600)
})

test("managed context path is absolute when the config root is outside home", async () => {
  const f = await fixture()
  const outside = await mkdtemp(resolve(".test-artifacts/outside-"))
  f.host.env.XDG_CONFIG_HOME = outside
  const before = await f.store.read(signal())
  assert.equal((await f.store.write(before.revision, { fields: {}, contextFile: "managed" }, signal())).kind, "written")
  assert.equal(await readFile(join(outside, "opencode", contextName), "utf8"), "")
  assert.equal(JSON.parse(await readFile(join(outside, "opencode", "predictions.json"), "utf8")).settings.contextFile, join(outside, "opencode", contextName))
})

test("an existing context file is adopted without changing its text or mode", async () => {
  const f = await fixture()
  await f.put({ debug: false })
  const context = contextOf(f)
  await writeFile(context, "Standing notes\n", { mode: 0o600 })
  await chmod(context, 0o664)
  const before = await f.store.read(signal())
  assert.equal((await f.store.write(before.revision, { fields: {}, contextFile: "managed" }, signal())).kind, "written")
  assert.equal(await readFile(context, "utf8"), "Standing notes\n")
  assert.equal((await stat(context)).mode & 0o777, 0o664)
})

const refusals: [string, string, (f: Awaited<ReturnType<typeof fixture>>, context: string) => Promise<void>][] = [
  ["a symbolic link", "it is a link", async (f, context) => {
    await writeFile(join(f.home, "elsewhere.md"), "notes", { mode: 0o600 })
    await symlink(join(f.home, "elsewhere.md"), context)
  }],
  ["a hard link", "it has more than one link", async (f, context) => {
    await writeFile(context, "", { mode: 0o600 })
    await link(context, join(f.home, "other.md"))
  }],
  ["a FIFO", "it is not a regular file", async (_f, context) => { await promisify(execFile)("mkfifo", [context]) }],
  ["a directory", "it is not a regular file", async (_f, context) => { await mkdir(context) }],
  ["world-writable", "other users can write to it", async (_f, context) => {
    await writeFile(context, "", { mode: 0o600 })
    await chmod(context, 0o666)
  }],
]
for (const [name, reason, arrange] of refusals) test(`an existing context file that is ${name} is refused and predictions.json is unchanged`, async () => {
  const f = await fixture()
  await f.put({ debug: false })
  await arrange(f, contextOf(f))
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  assert.deepEqual(await f.store.write(before.revision, { fields: { debug: true }, contextFile: "managed" }, signal()), { kind: "refused_context", message: refusedContext(reason) })
  assert.deepEqual(await readFile(f.file), bytes)
})

test("a context file with extra access rules is refused", { skip: process.platform !== "darwin" && "macOS access control entries only" }, async () => {
  const f = await fixture()
  await f.put({ debug: false })
  await writeFile(contextOf(f), "", { mode: 0o600 })
  await promisify(execFile)("/bin/chmod", ["+a", "everyone allow read", contextOf(f)])
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  assert.deepEqual(await f.store.write(before.revision, { fields: { debug: true }, contextFile: "managed" }, signal()), { kind: "refused_context", message: refusedContext("it has extra access rules") })
  assert.deepEqual(await readFile(f.file), bytes)
})

test("a context file owned by another user is refused", { skip: process.getuid?.() === 0 ? false : "needs root to give a file to another user; run the suite as root to exercise it" }, async () => {
  const f = await fixture()
  await f.put({ debug: false })
  await writeFile(contextOf(f), "", { mode: 0o600 })
  await chown(contextOf(f), 1, (await stat(contextOf(f))).gid)
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  assert.deepEqual(await f.store.write(before.revision, { fields: { debug: true }, contextFile: "managed" }, signal()), { kind: "refused_context", message: refusedContext("it is owned by another user") })
  assert.deepEqual(await readFile(f.file), bytes)
})

test("saving managed again recreates a missing context file", async () => {
  const f = await fixture()
  await f.put({ contextFile: "~/config/opencode/predictions-context.md" })
  const before = await f.store.read(signal())
  assert.equal((await f.store.write(before.revision, { fields: {}, contextFile: "managed" }, signal())).kind, "written")
  assert.equal(await readFile(contextOf(f), "utf8"), "")
})

test("an empty context file left by a failed save is adopted by the next save", async t => {
  const f = await fixture()
  await f.put({ debug: false })
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  let failCommit = true
  interceptRename(t, async (_from, to, original) => { if (failCommit && to === f.file) throw new Error("PRIVATE failure"); await original() })
  assert.equal((await f.store.write(before.revision, { fields: { debug: true }, contextFile: "managed" }, signal())).kind, "failed")
  assert.deepEqual(await readFile(f.file), bytes)
  assert.equal(await readFile(contextOf(f), "utf8"), "")
  failCommit = false
  const after = await f.store.read(signal())
  assert.equal((await f.store.write(after.revision, { fields: { debug: true }, contextFile: "managed" }, signal())).kind, "written")
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).settings.contextFile, "~/config/opencode/predictions-context.md")
})

test("saving none removes the setting and leaves the context file on disk", async () => {
  const f = await fixture()
  await f.put({ debug: false })
  let before = await f.store.read(signal())
  assert.equal((await f.store.write(before.revision, { fields: {}, contextFile: "managed" }, signal())).kind, "written")
  before = await f.store.read(signal())
  assert.equal((await f.store.write(before.revision, { fields: {}, contextFile: "none" }, signal())).kind, "written")
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).settings, { debug: false })
  assert.equal(await readFile(contextOf(f), "utf8"), "")
})

test("context file input accepts only managed and none", async () => {
  const f = await fixture()
  const before = await f.store.read(signal())
  await assert.rejects(f.store.write(before.revision, { fields: {}, contextFile: "/etc/passwd" as any }, signal()), /Invalid save input\./)
  assert.equal((await readdir(f.home)).includes("config"), false)
})

const changedContext = "it changed while it was checked"

for (const mode of [0o200, 0o000]) test(`an owned context file with mode ${mode.toString(8)} that cannot be read is adopted`, async () => {
  const f = await fixture()
  await f.put({ debug: false })
  const context = contextOf(f)
  await writeFile(context, "", { mode: 0o600 })
  await chmod(context, mode)
  const before = await f.store.read(signal())
  assert.equal((await f.store.write(before.revision, { fields: { debug: true }, contextFile: "managed" }, signal())).kind, "written")
  assert.equal((await stat(context)).mode & 0o777, mode)
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).settings.contextFile, "~/config/opencode/predictions-context.md")
})

async function refusedBeforeCommit(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, change: (context: string) => Promise<void>, reason: string, mode = 0o600) {
  await f.put({ debug: false })
  const context = contextOf(f)
  await writeFile(context, "", { mode: 0o600 })
  if (mode !== 0o600) await chmod(context, mode)
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  let changed = false, committed = false
  interceptRename(t, async (_from, to, original) => {
    // The backup rename runs after adoption and before the commit-time check.
    if (to.endsWith(".backup") && !changed) { changed = true; await change(context) }
    if (to === f.file) committed = true
    await original()
  })
  assert.deepEqual(await f.store.write(before.revision, { fields: { debug: true }, contextFile: "managed" }, signal()), { kind: "refused_context", message: refusedContext(reason) })
  assert.equal(changed, true)
  assert.equal(committed, false)
  assert.deepEqual(await readFile(f.file), bytes)
}

test("a context file replaced by a symbolic link before commit is refused and never renamed over predictions.json", async t => {
  const f = await fixture()
  await refusedBeforeCommit(t, f, async context => {
    await writeFile(join(f.home, "elsewhere.md"), "unchecked", { mode: 0o600 })
    await unlink(context)
    await symlink(join(f.home, "elsewhere.md"), context)
  }, "it is a link")
})

test("a context file replaced by another inode before commit is refused and never renamed over predictions.json", async t => {
  const f = await fixture()
  await refusedBeforeCommit(t, f, async context => {
    // Holding a second link keeps the old inode allocated, so the replacement cannot reuse its number.
    await link(context, join(f.home, "held.md"))
    await unlink(context)
    await writeFile(context, "", { mode: 0o600 })
  }, changedContext)
})

// The same inode, changed in place: identity matches, so the commit-time rules must judge it.
test("a context file that keeps its identity but gains a second link before commit is refused", async t => {
  const f = await fixture()
  await refusedBeforeCommit(t, f, async context => { await link(context, join(f.home, "copy.md")) }, "it has more than one link")
})

test("a context file that keeps its identity but becomes world-writable before commit is refused", async t => {
  const f = await fixture()
  await refusedBeforeCommit(t, f, async context => { await chmod(context, 0o666) }, "other users can write to it")
})

test("a context file that keeps its identity but gains an access rule before commit is refused", { skip: process.platform !== "darwin" && "macOS access control entries only" }, async t => {
  const f = await fixture()
  await refusedBeforeCommit(t, f, async context => { await promisify(execFile)("/bin/chmod", ["+a", "everyone allow read", context]) }, "it has extra access rules")
})

// Records every read-only handle the store opens on the fixed path, so a test can see whether it is still open.
function recordContextHandles(t: TestContext, context: string): Awaited<ReturnType<typeof fs.open>>[] {
  const original = fs.open, handles: Awaited<ReturnType<typeof fs.open>>[] = []
  const mock = t.mock.method(fs, "open", (async (...args: any[]) => {
    const handle = await (original as any)(...args)
    if (String(args[0]) === context && typeof args[1] === "number" && (args[1] & constants.O_WRONLY) === 0) handles.push(handle)
    return handle
  }) as any)
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  return handles
}

test("the adopted context file stays open until the commit ends, and a replacement there cannot reuse its number", async t => {
  const f = await fixture()
  await f.put({ debug: false })
  const context = contextOf(f)
  await writeFile(context, "", { mode: 0o600 })
  const handles = recordContextHandles(t, context)
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  let checked = false, committed = false, reused = true
  interceptRename(t, async (_from, to, original) => {
    if (to.endsWith(".backup") && !checked) {
      checked = true
      const [held] = handles
      assert.ok(held, "the store opened the context file")
      // Still open at the hook: stat() on a closed handle rejects.
      const pinned = (await held.stat()).ino
      await unlink(context)
      await writeFile(context, "", { mode: 0o600 })
      reused = (await stat(context)).ino === pinned
    }
    if (to === f.file) committed = true
    await original()
  })
  assert.deepEqual(await f.store.write(before.revision, { fields: { debug: true }, contextFile: "managed" }, signal()), { kind: "refused_context", message: refusedContext(changedContext) })
  assert.equal(checked, true)
  assert.equal(reused, false, "a held handle keeps the old inode number from being reused")
  assert.equal(committed, false)
  assert.deepEqual(await readFile(f.file), bytes)
  await assert.rejects(handles[0].stat(), "the store releases its handle when the save ends")
})

test("an unreadable context file gaining a second link before commit is refused by its rules", async t => {
  const f = await fixture()
  await refusedBeforeCommit(t, f, async context => { await link(context, join(f.home, "copy.md")) }, "it has more than one link", 0o200)
})

test("a reused inode is judged by its own rules, not by the identity match alone", () => {
  const uid = process.getuid?.() ?? 0
  const clean = { dev: 1, ino: 7, isFile: () => true, isSymbolicLink: () => false, nlink: 1, uid, mode: 0o100600 }
  const identity = { dev: 1, ino: 7 }
  assert.equal(contextFileProblem(clean, identity), undefined)
  assert.equal(contextFileProblem({ ...clean, nlink: 2 }, identity), "it has more than one link")
  assert.equal(contextFileProblem({ ...clean, mode: 0o100666 }, identity), "other users can write to it")
  assert.equal(contextFileProblem({ ...clean, uid: uid + 1 }, identity), "it is owned by another user")
  assert.equal(contextFileProblem({ ...clean, isFile: () => false, isSymbolicLink: () => true }, identity), "it is a link")
  assert.equal(contextFileProblem({ ...clean, isFile: () => false }, identity), "it is not a regular file")
  assert.equal(contextFileProblem({ ...clean, ino: 8 }, identity), changedContext)
  assert.equal(contextFileProblem({ ...clean, ino: 8, nlink: 2 }, identity), "it has more than one link", "the rules are reported before the identity mismatch")
})

test("an access-rule check cannot be fooled by swapping the file out and back during the inspection", { skip: process.platform !== "darwin" && "macOS access control entries only" }, async t => {
  const f = await fixture()
  await f.put({ debug: false })
  const context = contextOf(f), aside = join(f.home, "aside.md")
  await writeFile(context, "", { mode: 0o600 })
  await promisify(execFile)("/bin/chmod", ["+a", "everyone allow read", context])
  const before = await f.store.read(signal()), bytes = await readFile(f.file)
  // Between the open and the access-rule inspection a clean file takes the path; the original returns before the final lstat.
  const realOpen = fs.open, realLstat = fs.lstat
  let opened = false, swapped = false, lstats = 0
  const openMock = t.mock.method(fs, "open", (async (...args: any[]) => {
    const handle = await (realOpen as any)(...args)
    if (String(args[0]) === context && typeof args[1] === "number" && (args[1] & constants.O_WRONLY) === 0) opened = true
    return handle
  }) as any)
  // The first check after the open passes; the file is then swapped for a clean one while the access-rule
  // inspection runs; the original is restored before the second check. Only the directory stamp can see that.
  const lstatMock = t.mock.method(fs, "lstat", (async (...args: any[]) => {
    if (!opened || String(args[0]) !== context) return (realLstat as any)(...args)
    if (++lstats === 1) {
      const stat = await (realLstat as any)(...args)
      swapped = true
      await rename(context, aside)
      await writeFile(context, "", { mode: 0o600 })
      return stat
    }
    if (lstats === 2) await rename(aside, context)
    return (realLstat as any)(...args)
  }) as any)
  syncBuiltinESMExports()
  t.after(() => { openMock.mock.restore(); lstatMock.mock.restore(); syncBuiltinESMExports() })
  assert.deepEqual(await f.store.write(before.revision, { fields: { debug: true }, contextFile: "managed" }, signal()), { kind: "refused_context", message: refusedContext(changedContext) })
  assert.equal(swapped, true)
  assert.equal(lstats >= 2, true)
  assert.deepEqual(await readFile(f.file), bytes)
})

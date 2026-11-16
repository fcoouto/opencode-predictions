import { describe, test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import fs, { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import type { PathLike } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join, resolve } from "node:path"
import { createConfigStore, type ConfigHost } from "../src/config.ts"

const signal = () => new AbortController().signal

function atRename(t: TestContext, intercept: (from: PathLike, to: PathLike, commit: () => Promise<void>) => Promise<void>) {
  const original = fs.rename
  const replacement = t.mock.method(fs, "rename", (from: PathLike, to: PathLike) => intercept(from, to, () => original(from, to)))
  syncBuiltinESMExports()
  t.after(() => { replacement.mock.restore(); syncBuiltinESMExports() })
}

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
    version: process.env.PREDICTIONS_CONFIG_TEST_VERSION ?? "2.2.6", home, directory: home,
    env: { XDG_CONFIG_HOME: join(home, "config"), OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    systemPaths: [join(home, "managed")],
    source: async () => ({ type: "local", path: resolve(".") }),
    options: () => options,
  }
  return { home, file, global, host, options, original, store: createConfigStore(host) }
}

describe("verified macOS global config store", { skip: process.platform !== "darwin" }, () => {
test("qualified 2.3.0 source preserves JSONC and rejects stale saves", async () => {
  const f = await fixture()
  f.host.version = "2.3.0"
  const snapshot = await f.store.read(signal())
  assert.equal(snapshot.writable, true)
  assert.equal((await f.store.write(snapshot.revision, { debug: true }, signal())).kind, "written")
  f.options.debug = true
  assert.equal((await readFile(f.file, "utf8")).replace(',"debug": true', ""), f.original)
  assert.equal((await f.store.write(snapshot.revision, { debug: false }, signal())).kind, "conflict")
})
test("setup preserves omitted GitHub PR context during unrelated edits", async () => {
  const f = await fixture()
  const before = await f.store.read(signal())
  assert.equal(Object.hasOwn(before.fields, "includeGithubPRContext"), false)
  assert.equal((await f.store.write(before.revision, { debug: true }, signal())).kind, "written")
  assert.doesNotMatch(await readFile(f.file, "utf8"), /includeGithubPRContext/)
})

test("setup round-trips explicit GitHub PR context false and rejects nonboolean values before writing", async () => {
  const f = await fixture()
  const before = await f.store.read(signal())
  for (const value of [null, 1, "true"]) {
    assert.equal((await f.store.write(before.revision, { includeGithubPRContext: value }, signal())).kind, "failed", String(value))
    assert.equal(await readFile(f.file, "utf8"), f.original)
  }
  assert.equal((await f.store.write(before.revision, { includeGithubPRContext: false }, signal())).kind, "written")
  f.options.includeGithubPRContext = false
  const after = await f.store.read(signal())
  assert.equal(after.fields.includeGithubPRContext, false, "an explicit false is a persisted boolean, not an omission")
  assert.match(await readFile(f.file, "utf8"), /"includeGithubPRContext": false/)
  assert.equal((await f.store.write(after.revision, { includeGithubPRContext: true }, signal())).kind, "written")
  f.options.includeGithubPRContext = true
  assert.equal((await f.store.read(signal())).fields.includeGithubPRContext, true)
  assert.match(await readFile(f.file, "utf8"), /synthetic-private-option/)
})

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
    ["version", f => { f.host.version = "2.4.0" }],
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

test("model removal preserves every surrounding comment and handles trailing commas", async t => {
  const cases = [
    { name: "first", input: '{"models":"fixture/model",/* keep next */"automatic":false}', want: '{/* keep next */"automatic":false}', options: { models: "fixture/model", automatic: false } },
    { name: "middle", input: '{"automatic":false,/* before */"models":"fixture/model"/* after */,/* next */"debug":false}', want: '{"automatic":false,/* before *//* after *//* next */"debug":false}', options: { automatic: false, models: "fixture/model", debug: false } },
    { name: "last", input: '{"automatic":false,/* before */"models":"fixture/model"/* tail */}', want: '{"automatic":false/* before *//* tail */}', options: { automatic: false, models: "fixture/model" } },
    { name: "last with trailing comma", input: '{"automatic":false,/* before */"models":"fixture/model",/* tail */}', want: '{"automatic":false,/* before *//* tail */}', options: { automatic: false, models: "fixture/model" } },
    { name: "sole", input: '{"models":"fixture/model"}', want: '{}', options: { models: "fixture/model" } },
    { name: "sole with trailing comma", input: '{"models":"fixture/model",/* tail */}', want: '{/* tail */}', options: { models: "fixture/model" } },
    { name: "comments inside removed value", input: '{"models":[/* choose group */"fixture/model"/* group tail */],/* next */"automatic":false}', want: '{/* choose group *//* group tail *//* next */"automatic":false}', options: { models: ["fixture/model"], automatic: false } },
    { name: "CRLF line comments", input: '{\r\n\t"models":"fixture/model", // tail\r\n\t// automatic note\r\n\t"automatic":false\r\n}', want: '{\r\n\t // tail\r\n\t// automatic note\r\n\t"automatic":false\r\n}', options: { models: "fixture/model", automatic: false } },
  ]
  for (const item of cases) await t.test(item.name, async () => {
    const f = await fixture()
    const document = (options: string) => `{"plugins":[{"package":${JSON.stringify(resolve("."))},"options":${options}}],"username":"keep"}\n`
    const original = document(item.input)
    await writeFile(f.file, original)
    f.host.options = () => item.options
    const snapshot = await f.store.read(signal())
    assert.equal(snapshot.writable, true)
    assert.equal((await f.store.write(snapshot.revision, { models: undefined }, signal())).kind, "written")
    assert.equal(await readFile(f.file, "utf8"), document(item.want))
    assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), original)
    const after = await f.store.read(signal())
    assert.equal(Object.hasOwn(after.fields, "models"), false)
  })
})

test("replacing model groups preserves comments inside the edited value", async () => {
  const f = await fixture()
  const original = `{"plugins":[{"package":${JSON.stringify(resolve("."))},"options":{"models":[/* group note */"fixture/model"/* tail note */],"automatic":false}}]}\n`
  await writeFile(f.file, original)
  f.host.options = () => ({ models: ["fixture/model"], automatic: false })
  const snapshot = await f.store.read(signal())
  assert.equal(snapshot.writable, true)
  assert.equal((await f.store.write(snapshot.revision, { models: [["fixture/new"]] }, signal())).kind, "written")
  const expected = `{"plugins":[{"package":${JSON.stringify(resolve("."))},"options":{"models":[["fixture/new"]]/* group note *//* tail note */,"automatic":false}}]}\n`
  assert.equal(await readFile(f.file, "utf8"), expected)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), original)
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

test("production final comparison rejects an edit after replacement and recovery files are staged", async t => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  const external = f.original.replace("synthetic-private-config", "external-kept")
  let staged = 0
  atRename(t, async (_from, to, commit) => {
    if (to === f.file + ".predictions-backup") {
      staged = (await readdir(f.global)).filter(name => name.includes(".tmp-")).length
      await commit()
      await writeFile(f.file, external)
    } else await commit()
  })
  const result = await f.store.write(snapshot.revision, { debug: true }, signal())
  assert.equal(staged, 2, "the edit must occur after both files are staged, not during preflight")
  assert.equal(result.kind, "conflict")
  assert.equal(await readFile(f.file, "utf8"), external)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), f.original)
  assert.deepEqual((await readdir(f.global)).sort(), ["opencode.jsonc", "opencode.jsonc.predictions-backup"])
})

test("production cancellation after staging and backup commit leaves active bytes unchanged", async t => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  const controller = new AbortController()
  let staged = 0, reached = false
  atRename(t, async (_from, to, commit) => {
    if (to === f.file + ".predictions-backup") {
      staged = (await readdir(f.global)).filter(name => name.includes(".tmp-")).length
      await commit()
      reached = true
      controller.abort()
    } else await commit()
  })
  const result = await f.store.write(snapshot.revision, { debug: true }, controller.signal)
  assert.equal(reached, true)
  assert.equal(staged, 2)
  assert.equal(result.kind, "failed")
  assert.equal(await readFile(f.file, "utf8"), f.original)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), f.original)
  assert.deepEqual((await readdir(f.global)).sort(), ["opencode.jsonc", "opencode.jsonc.predictions-backup"])
})

test("production recovery-copy rename failure cleans staged files without changing active bytes", async t => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  let staged = 0, kernelError: string | undefined
  atRename(t, async (_from, to, commit) => {
    if (to !== f.file + ".predictions-backup") return commit()
    staged = (await readdir(f.global)).filter(name => name.includes(".tmp-")).length
    await mkdir(f.file + ".predictions-backup")
    try { await commit() } catch (error) {
      kernelError = (error as NodeJS.ErrnoException).code
      throw error
    } finally { await rmdir(f.file + ".predictions-backup") }
  })
  const result = await f.store.write(snapshot.revision, { debug: true }, signal())
  assert.equal(staged, 2)
  assert.match(kernelError ?? "", /^(EISDIR|ENOTEMPTY)$/)
  assert.equal(result.kind, "failed")
  assert.equal(await readFile(f.file, "utf8"), f.original)
  assert.doesNotMatch(JSON.stringify(result), /EISDIR|ENOTEMPTY|synthetic-private/)
  assert.deepEqual(await readdir(f.global), ["opencode.jsonc"])
})

test("production active replacement gets real EACCES without changing bytes or restoring backup", async t => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  let denied = false
  atRename(t, async (_from, to, commit) => {
    if (to !== f.file) return commit()
    await chmod(f.global, 0o500)
    try { await commit() } catch (error) {
      denied = (error as NodeJS.ErrnoException).code === "EACCES"
      throw error
    } finally { await chmod(f.global, 0o755) }
  })
  const result = await f.store.write(snapshot.revision, { debug: true }, signal())
  assert.equal(denied, true, "exercise a kernel failure after successful preflight and staging")
  assert.equal(result.kind, "failed")
  assert.equal(await readFile(f.file, "utf8"), f.original)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), f.original)
  assert.doesNotMatch(JSON.stringify(result), /EACCES|synthetic-private/)
  assert.deepEqual((await readdir(f.global)).sort(), ["opencode.jsonc", "opencode.jsonc.predictions-backup"])
})

test("production post-commit mismatch reports uncertainty without rollback or repeat replacement", async t => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  const external = f.original.replace("synthetic-private-config", "external-after-commit")
  let replacements = 0
  atRename(t, async (_from, to, commit) => {
    await commit()
    if (to === f.file) { replacements++; await writeFile(f.file, external) }
  })
  const result = await f.store.write(snapshot.revision, { debug: true }, signal())
  assert.deepEqual(result, { kind: "failed", message: "Changes may have been saved. Reopen settings before trying again." })
  assert.equal(replacements, 1)
  assert.equal(await readFile(f.file, "utf8"), external)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), f.original)
  assert.deepEqual((await readdir(f.global)).sort(), ["opencode.jsonc", "opencode.jsonc.predictions-backup"])
})

test("production post-commit verification error reports uncertainty and never rolls back saved bytes", async t => {
  const f = await fixture()
  const snapshot = await f.store.read(signal())
  let replacements = 0
  atRename(t, async (_from, to, commit) => {
    await commit()
    if (to === f.file) {
      replacements++
      f.host.source = async () => { throw new Error("synthetic-private-source-failure") }
    }
  })
  const result = await f.store.write(snapshot.revision, { debug: true }, signal())
  assert.deepEqual(result, { kind: "failed", message: "Changes may have been saved. Reopen settings before trying again." })
  assert.equal(replacements, 1)
  assert.equal((await readFile(f.file, "utf8")).replace(',"debug": true', ""), f.original)
  assert.equal(await readFile(f.file + ".predictions-backup", "utf8"), f.original)
  assert.deepEqual((await readdir(f.global)).sort(), ["opencode.jsonc", "opencode.jsonc.predictions-backup"])
})
})

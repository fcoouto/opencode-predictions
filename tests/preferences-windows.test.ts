import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test, type TestContext } from "node:test"
import { promisify } from "node:util"
import { createPreferencesStore, preferencesPath, type PreferencesHost } from "../src/preferences-store.ts"

const native = { skip: process.platform !== "win32", timeout: 25000 }
const signal = () => new AbortController().signal
const run = promisify(execFile)
const initial = '{"version":1,"future":"keep","settings":{"automatic":false}}\n'
const edit = { fields: { debug: true } }

test("Windows roots must identify a local drive", () => {
  const base = { home: "C:\\Users\\Example", platform: "win32", systemPaths: [] } as const
  const root = "C:\\Users\\Example\\AppData\\Roaming"
  assert.equal(preferencesPath({ ...base, env: { APPDATA: root } }), root + "\\opencode\\predictions.json")
  for (const bad of ["\\rooted", "C:relative", "\\\\server\\share", "\\\\?\\C:\\device", "C:\\root:stream", "C:\\NUL.txt", "C:\\dir.\\next", "C:\\dir \\next"]) {
    for (const key of ["APPDATA", "XDG_CONFIG_HOME"]) {
      assert.throws(() => preferencesPath({ ...base, env: { [key]: bad } }), `accepted ${key}=${bad}`)
    }
  }
})

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "predictions-win-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const host: PreferencesHost = { home: root, platform: "win32", env: { XDG_CONFIG_HOME: join(root, "config") }, systemPaths: [join(root, "managed")] }
  const source = preferencesPath(host), directory = dirname(source)
  await mkdir(directory, { recursive: true })
  const config = join(directory, "opencode.jsonc"), configBytes = "// unchanged\n{}\n"
  await writeFile(config, configBytes)
  return { host, source, directory, root, config, configBytes, store: createPreferencesStore(host) }
}

function utility(name: string, args: string[], env = process.env) {
  return run(join(process.env.SystemRoot!, "System32", name), args, { env, windowsHide: true, timeout: 6000 })
}

const icacls = (path: string, ...args: string[]) => utility("icacls.exe", [path, ...args])
const getAcl = async (path: string) => (await utility("WindowsPowerShell\\v1.0\\powershell.exe", [
  "-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:PREDICTIONS_TEST_ACL_PATH).Sddl",
], { ...process.env, PREDICTIONS_TEST_ACL_PATH: path })).stdout.trim()

test("Windows reads create nothing and a second Save creates a private backup", native, async t => {
  const f = await fixture(t), beforeAcl = await getAcl(f.directory)
  const before = await f.store.read(signal())
  assert.equal(before.writable, true, before.reason ?? "First Save must be available.")
  assert.deepEqual(await readdir(f.directory), ["opencode.jsonc"])
  assert.equal((await f.store.write(before.revision, { fields: { automatic: false } }, signal())).kind, "written")
  await writeFile(f.source, initial)
  const edited = await f.store.read(signal()), oldAcl = await getAcl(f.source)
  assert.equal((await f.store.write(edited.revision, edit, signal())).kind, "written")
  assert.deepEqual(JSON.parse(await readFile(f.source, "utf8")), { version: 1, future: "keep", settings: { automatic: false, debug: true } })
  assert.equal(await readFile(f.source + ".backup", "utf8"), initial)
  const backupAcl = await getAcl(f.source + ".backup")
  assert.match(backupAcl, /D:P/)
  assert.doesNotMatch(backupAcl, /;;;(?:WD|AU|BU)\)/)
  assert.equal(await getAcl(f.source), oldAcl)
  assert.equal(await getAcl(f.directory), beforeAcl)
  assert.equal(await readFile(f.config, "utf8"), f.configBytes)
})

test("Windows refuses an empty replacement directory with a stale revision", native, async t => {
  const f = await fixture(t)
  const before = await f.store.read(signal())
  assert.equal(before.writable, true, before.reason ?? "The empty directory must be writable.")
  await rename(f.directory, f.directory + "-original")
  await mkdir(f.directory)
  assert.equal((await f.store.write(before.revision, edit, signal())).kind, "conflict")
  assert.deepEqual(await readdir(f.directory), [])
  assert.equal(await readFile(join(f.directory + "-original", "opencode.jsonc"), "utf8"), f.configBytes)
})

for (const kind of ["denied write", "read-only attribute"]) test(`Windows reads a valid file with ${kind} but refuses Save`, native, async t => {
  const f = await fixture(t)
  await writeFile(f.source, initial)
  if (kind === "denied write") {
    const { stdout } = await utility("whoami.exe", ["/user", "/fo", "csv", "/nh"])
    const sid = stdout.match(/S-1-[\d-]+/)?.[0]
    assert.ok(sid, "The runner must identify its standard account.")
    await icacls(f.source, "/deny", `*${sid}:(WD)`)
  } else {
    await utility("attrib.exe", ["+R", f.source])
    t.after(() => utility("attrib.exe", ["-R", f.source]).catch(() => {}))
  }
  const before = await f.store.read(signal())
  assert.equal(before.documentValid, true, before.reason ?? "The file must remain readable.")
  assert.equal(before.writable, false)
  assert.deepEqual(before.overrides, { automatic: false })
  assert.equal((await f.store.write(before.revision, edit, signal())).kind, "read_only")
  assert.equal(await readFile(f.source, "utf8"), initial)
  assert.equal(await readFile(f.config, "utf8"), f.configBytes)
})

for (const kind of ["inherited mutation rights", "hard link", "junction"]) test(`Windows refuses active preferences with ${kind}`, native, async t => {
  const f = await fixture(t)
  await writeFile(f.source, initial)
  assert.equal((await f.store.read(signal())).documentValid, true, "The file must be valid before adding the unsafe metadata.")
  if (kind === "inherited mutation rights") await icacls(f.directory, "/grant", "*S-1-5-11:(OI)(CI)(WD,DC)")
  if (kind === "hard link") await link(f.source, join(f.root, "active-copy"))
  if (kind === "junction") {
    await rename(f.directory, f.directory + "-target")
    await symlink(f.directory + "-target", f.directory, "junction")
  }
  const state = await f.store.read(signal())
  assert.equal(state.documentValid, false)
  assert.equal((await f.store.write(state.revision, edit, signal())).kind, "read_only")
  assert.equal(await readFile(f.source, "utf8"), initial)
  assert.equal(await readFile(f.config, "utf8"), f.configBytes)
})

for (const kind of ["untrusted reader", "hard link", "junction"]) test(`Windows refuses to overwrite a backup with ${kind}`, native, async t => {
  const f = await fixture(t), backup = f.source + ".backup"
  await writeFile(f.source, initial)
  if (kind === "junction") {
    const target = join(f.root, "backup-target")
    await mkdir(target)
    await symlink(target, backup, "junction")
  }
  else {
    await writeFile(backup, "existing backup")
    if (kind === "hard link") await link(backup, join(f.root, "backup-copy"))
    else await icacls(backup, "/grant", "*S-1-5-11:(R)")
  }
  const before = await f.store.read(signal())
  assert.equal(before.writable, true, before.reason ?? "The active document must be writable before checking the backup.")
  assert.equal((await f.store.write(before.revision, edit, signal())).kind, "failed")
  assert.equal(await readFile(f.source, "utf8"), initial)
  if (kind !== "junction") assert.equal(await readFile(backup, "utf8"), "existing backup")
  assert.equal(await readFile(f.config, "utf8"), f.configBytes)
})

test("Windows treats present or uncheckable administrative configuration as managed", native, async t => {
  const f = await fixture(t)
  await writeFile(f.source, initial)
  assert.deepEqual((await f.store.read(signal())).overrides, { automatic: false })
  await mkdir(f.host.systemPaths[0])
  for (const paths of [f.host.systemPaths, [join(f.source, "not-a-directory")], [""]]) {
    f.host.systemPaths = paths
    const state = await f.store.read(signal())
    assert.equal(state.policy, "managed")
    assert.deepEqual(state.overrides, {})
    assert.equal((await f.store.write(state.revision, edit, signal())).kind, "read_only")
    assert.equal(await readFile(f.source, "utf8"), initial)
  }
})

test("Windows refuses stale drafts and oversized preferences", native, async t => {
  const f = await fixture(t)
  await writeFile(f.source, initial)
  const before = await f.store.read(signal())
  assert.equal(before.writable, true, before.reason ?? "The original document must be writable.")
  const newer = JSON.stringify({ version: 1, settings: { contextTurns: 5 } })
  await writeFile(f.source, newer)
  assert.equal((await f.store.write(before.revision, edit, signal())).kind, "conflict")
  assert.equal(await readFile(f.source, "utf8"), newer)
  const oversized = " ".repeat(65537)
  await writeFile(f.source, oversized)
  const state = await f.store.read(signal())
  assert.equal(state.documentValid, false)
  assert.equal((await f.store.write(state.revision, edit, signal())).kind, "read_only")
  assert.equal(await readFile(f.source, "utf8"), oversized)
  assert.equal(await readFile(f.config, "utf8"), f.configBytes)
})

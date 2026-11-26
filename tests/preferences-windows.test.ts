import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test, type TestContext } from "node:test"
import { promisify } from "node:util"
import { administrativePaths, createPreferencesStore, preferencesPath, type PreferencesHost } from "../src/preferences-store.ts"

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
    assert.deepEqual(administrativePaths("win32", { ProgramData: bad }), [""])
  }
})

const loadWindowsIO = () => import(new URL("../src/preferences-windows.ts", import.meta.url).href)
const candidate = { source: "C:\\fixture\\opencode\\predictions.json", state: "user", writable: true, expected: "a".repeat(64), bytes: null }
const administration = ["C:\\fixture\\managed"]

test("Windows refuses malformed, unknown, or oversized helper replies", async () => {
  const { createWindowsIO } = await loadWindowsIO()
  for (const reply of [
    "{bad",
    JSON.stringify({ kind: "snapshot", snapshot: { ...candidate, state: "unknown" } }),
    JSON.stringify({ kind: "snapshot", snapshot: { ...candidate, bytes: Buffer.alloc(65537).toString("base64") } }),
    JSON.stringify({ kind: "snapshot", snapshot: { ...candidate, expected: "" } }),
  ]) {
    const io = createWindowsIO(async () => reply)
    const read = await io.readWindowsPreferences(candidate.source, administration, signal())
    assert.equal(read.state, "unavailable")
    assert.equal(read.writable, false)
  }
})

test("Windows refuses timed-out reads and propagates cancellation", async () => {
  const { createWindowsIO } = await loadWindowsIO()
  const read = createWindowsIO(async () => { throw Object.assign(new Error("private helper output"), { code: "ETIMEDOUT" }) }).readWindowsPreferences
  const result = await read(candidate.source, administration, signal())
  assert.equal(result.writable, false)
  assert.doesNotMatch(JSON.stringify(result), /private helper output/)
  await assert.rejects(read(candidate.source, administration, AbortSignal.abort()), { name: "AbortError" })
})

test("Windows does not replay a commit after losing the helper reply", async () => {
  const { createWindowsIO } = await loadWindowsIO()
  let commits = 0
  const io = createWindowsIO(async (request: { op: string }) => {
    if (request.op === "commit") {
      commits++
      throw new Error("private helper output")
    }
    return JSON.stringify({ kind: "snapshot", snapshot: candidate })
  })
  const before = await io.readWindowsPreferences(candidate.source, administration, signal())
  const result = await io.commitWindowsPreferences(before, administration, Buffer.from(initial), signal())
  assert.deepEqual(result, { kind: "failed", message: "Changes may have been saved. Reopen settings before trying again." })
  assert.equal(commits, 1)
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

test("the preference helper compiles in Windows PowerShell", native, async t => {
  const f = await fixture(t)
  const { windowsScript } = await import(new URL("../src/preferences-windows-script.ts", import.meta.url).href)
  const path = join(f.root, "compile-helper.ps1")
  const compileOnly = windowsScript.slice(0, windowsScript.indexOf("$reply = ")).replace(/^\$request = .*$/m, "")
  await writeFile(path, compileOnly)
  await utility("WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path])
})

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
  // The kernel can record automatic inheritance even when the DACL remains protected.
  assert.equal((await getAcl(f.source)).replace("D:PAI(", "D:P("), oldAcl.replace("D:PAI(", "D:P("))
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

test("Windows refuses a file with an explicit integrity policy it cannot preserve", native, async t => {
  const f = await fixture(t)
  await writeFile(f.source, initial)
  assert.equal((await f.store.read(signal())).documentValid, true)
  await icacls(f.source, "/setintegritylevel", "L")
  const state = await f.store.read(signal())
  assert.equal(state.documentValid, false)
  assert.equal((await f.store.write(state.revision, edit, signal())).kind, "read_only")
  assert.equal(await readFile(f.source, "utf8"), initial)
})

test("Windows refuses a foreign-owned file in an otherwise verified directory", native, async () => {
  const root = process.env.PREDICTIONS_TEST_FOREIGN_ROOT
  assert.ok(root, "Run native tests with the isolated ownership fixture.")
  const host: PreferencesHost = { home: root, platform: "win32", env: { XDG_CONFIG_HOME: root }, systemPaths: [join(root, "managed")] }
  const source = preferencesPath(host), parked = source + ".foreign"
  const bytes = await readFile(source)
  const store = createPreferencesStore(host)
  await rename(source, parked)
  try {
    const empty = await store.read(signal())
    assert.equal(empty.writable, true, empty.reason ?? "The parent must be eligible for Save.")
  } finally { await rename(parked, source) }
  const state = await store.read(signal())
  assert.equal(state.documentValid, false)
  assert.equal((await store.write(state.revision, edit, signal())).kind, "read_only")
  assert.deepEqual(await readFile(source), bytes)
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
  for (const bad of [" ".repeat(65537), ""]) {
    await writeFile(f.source, bad)
    const state = await f.store.read(signal())
    assert.equal(state.documentValid, false)
    assert.equal((await f.store.write(state.revision, edit, signal())).kind, "read_only")
    assert.equal(await readFile(f.source, "utf8"), bad)
  }
  assert.equal(await readFile(f.config, "utf8"), f.configBytes)
})

async function checkpoint(name: string, code: string) {
  const { createWindowsIO, invokeWindows } = await loadWindowsIO()
  const { windowsScript } = await import(new URL("../src/preferences-windows-script.ts", import.meta.url).href)
  const marker = `/* ${name} */`
  assert.equal(windowsScript.split(marker).length, 2, `Missing test boundary: ${name}`)
  const script = windowsScript.replace(marker, () => code)
  return createWindowsIO((request: unknown, abort: AbortSignal) => invokeWindows(request, abort, script))
}

test("Windows staging is private before it receives preference bytes", native, async t => {
  const f = await fixture(t), observation = join(f.root, "staging-before-write")
  const io = await checkpoint("BEFORE_STAGE_WRITE", `
    var stagedPath = new System.IO.FileInfo(path);
    var stagedAcl = stagedPath.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access);
    File.AppendAllText(${JSON.stringify(observation)}, stagedPath.Length + ":" + stagedAcl + Environment.NewLine);
  `)
  await writeFile(f.source, initial)
  const before = await io.readWindowsPreferences(f.source, f.host.systemPaths, signal())
  const result = await io.commitWindowsPreferences(before, f.host.systemPaths, Buffer.from('{"version":1,"settings":{}}\n'), signal())
  assert.equal(result.kind, "written")
  const samples = (await readFile(observation, "utf8")).trim().split(/\r?\n/)
  assert.equal(samples.length, 2, "Both active and backup staging were observed.")
  for (const sample of samples) {
    assert.match(sample, /^0:D:P/)
    assert.doesNotMatch(sample, /;;;(?:WD|AU|BU)\)/)
  }
})

test("Windows pins the verified directory until replacement finishes", native, async t => {
  const f = await fixture(t), observation = join(f.root, "rename-observed")
  const spare = join(f.root, "spare")
  await mkdir(spare)
  await writeFile(join(spare, "sentinel"), "not a preferences directory")
  const io = await checkpoint("BEFORE_ACTIVE_REPLACE", `
    try { Directory.Move(${JSON.stringify(f.directory)}, ${JSON.stringify(f.directory + "-moved")}); }
    catch (IOException) { File.WriteAllText(${JSON.stringify(observation)}, "pinned"); }
  `)
  await writeFile(f.source, initial)
  const before = await io.readWindowsPreferences(f.source, f.host.systemPaths, signal())
  const complete = '{"version":1,"settings":{"debug":true}}\n'
  assert.equal((await io.commitWindowsPreferences(before, f.host.systemPaths, Buffer.from(complete), signal())).kind, "written")
  assert.equal(await readFile(observation, "utf8"), "pinned")
  assert.equal(await readFile(f.source, "utf8"), complete)
  assert.equal(await readFile(f.config, "utf8"), f.configBytes)
  assert.deepEqual(await readdir(spare), ["sentinel"])
  assert.equal(await readFile(join(spare, "sentinel"), "utf8"), "not a preferences directory")
})

for (const phase of ["before replacement", "lost readback", "different readback"]) test(`Windows reports a safe outcome for ${phase}`, native, async t => {
  const f = await fixture(t)
  const differing = '{"version":1,"settings":{"debug":false}}\n'
  const io = await checkpoint(phase === "before replacement" ? "BEFORE_ACTIVE_REPLACE" : "AFTER_ACTIVE_REPLACE",
    phase === "different readback"
      ? `File.WriteAllText(${JSON.stringify(f.source)}, ${JSON.stringify(differing)});`
      : 'if (path.Length > 0) throw new IOException("private fixture failure");')
  await writeFile(f.source, initial)
  const before = await io.readWindowsPreferences(f.source, f.host.systemPaths, signal())
  const next = '{"version":1,"settings":{"debug":true}}\n'
  const result = await io.commitWindowsPreferences(before, f.host.systemPaths, Buffer.from(next), signal())
  assert.equal(result.kind, "failed")
  assert.doesNotMatch(JSON.stringify(result), /private fixture failure/)
  if (phase === "before replacement") {
    assert.equal(await readFile(f.source, "utf8"), initial)
    assert.doesNotMatch(JSON.stringify(result), /may have been saved/)
  } else {
    assert.equal(await readFile(f.source, "utf8"), phase === "lost readback" ? next : differing)
    assert.match(result.message, /Changes may have been saved/)
    assert.equal((await io.commitWindowsPreferences(before, f.host.systemPaths, Buffer.from(next), signal())).kind, "conflict")
  }
  assert.equal(await readFile(f.config, "utf8"), f.configBytes)
})

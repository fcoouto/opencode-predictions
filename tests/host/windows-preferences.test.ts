import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { link, lstat, mkdir, readFile, readdir, rmdir, symlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { setTimeout as pause } from "node:timers/promises"
import { after, before, test, type TestContext } from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { OpenCode } from "@opencode/client"
import { Predictions } from "../../src/rpc.ts"
import type { Status } from "../../src/service.ts"
import type { ContextFileStatus, SaveInput, SaveResult, SetupSnapshot } from "../../src/setup.ts"
import { createFixture } from "./fixture.mjs"

assert.equal(process.platform, "win32", "This qualification test requires native Windows.")
const { APPDATA, ProgramData, OPENCODE_BIN, PREDICTIONS_PACKAGE } = process.env
for (const [name, value] of Object.entries({ APPDATA, ProgramData, OPENCODE_BIN, PREDICTIONS_PACKAGE })) {
  assert.ok(value && isAbsolute(value), `${name} must be an absolute Windows path.`)
}
const helperName = "predictions-verifier.exe"
assert.ok(existsSync(join(PREDICTIONS_PACKAGE!, "dist", helperName)), "The installed npm tarball must contain the Windows verifier.")

const assertNoAdminConfig = () => assert.rejects(lstat(join(ProgramData!, "opencode")), { code: "ENOENT" })
before(assertNoAdminConfig)
after(assertNoAdminConfig)

async function entries(path: string): Promise<string[] | undefined> {
  try { return (await readdir(path)).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
}

async function afterRestart(read: () => Promise<SetupSnapshot>, t: TestContext) {
  try { return await read() }
  catch (error) {
    const failure = error as { cause?: { cause?: { code?: string } } }
    if (failure.cause?.cause?.code !== "ECONNRESET") throw error
    t.diagnostic("The server reset the read connection during startup. Reopening settings once.")
  }
  return read()
}

const firstRoot = process.env.PREDICTIONS_WINDOWS_FIRST_ROOT ?? "appdata"
assert.ok(firstRoot === "appdata" || firstRoot === "override", "The Windows smoke test order must be explicit.")
const rootCases = [
  ["appdata", "default Windows profile saves and survives server restart"],
  ["override", "literal Windows config paths round-trip"],
] as const
for (const [windowsConfig, name] of firstRoot === "appdata" ? rootCases : [...rootCases].reverse()) {
  test(name, { timeout: 120000 }, async t => {
    t.diagnostic(`${windowsConfig} runs ${windowsConfig === firstRoot ? "first" : "second"} in this profile; helper: ${helperName}.`)
    await using f = await createFixture(pathToFileURL(PREDICTIONS_PACKAGE!).href, {}, {}, {
      windowsConfig, projectConfig: true, seedPreferences: false,
    })
    const root = windowsConfig === "appdata" ? APPDATA! : join(f.root, "O'Brien [测试]")
    const source = join(root, "opencode", "predictions.json")
    const config = join(f.directory, "opencode.jsonc")
    const configBytes = await readFile(config)
    const beforeRoot = await entries(root), beforeDir = await entries(dirname(source))
    await assert.rejects(readFile(source), { code: "ENOENT" })
    assert.equal(f.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined)
    assert.equal(f.env.XDG_CONFIG_HOME, windowsConfig === "appdata" ? undefined : root)
    const version = (await f.api.server.info()).version
    t.diagnostic(`Native Windows OpenCode ${version}`)
    assert.equal(version, "2.2.6")

    const location = { directory: f.directory }
    const read = async () => await f.api.rpc(Predictions).settingsV2({}, { location, signal: AbortSignal.timeout(2000) }) as SetupSnapshot
    const saveFields = async (revision: string, fields: { automatic?: boolean; debug?: boolean }) =>
      await f.api.rpc(Predictions).saveSettings({ revision, fields }, { location, signal: AbortSignal.timeout(12000) }) as SaveResult
    const began = performance.now()
    const before = await read()
    t.diagnostic(`First settings read: ${Math.round(performance.now() - began)} ms; writable: ${before.writable}.`)
    assert.deepEqual(await entries(root), beforeRoot)
    assert.deepEqual(await entries(dirname(source)), beforeDir)
    assert.equal(before.source, source)
    assert.equal(before.writable, true, before.reason ?? "The Windows server must permit first Save.")

    const save = await saveFields(before.revision, { automatic: false })
    assert.equal(save.kind, "saved", JSON.stringify(save))
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), { version: 1, settings: { automatic: false } })
    const saved = await read()
    assert.equal(saved.activeRevision, saved.revision)
    assert.equal(saved.revision, save.revision)
    assert.deepEqual(await readFile(config), configBytes)

    const future = windowsConfig === "override" ? "é".repeat(24000) : "keep"
    const prior = JSON.stringify({ version: 1, future, settings: { automatic: false } }) + "\n"
    await writeFile(source, prior)
    const edited = await read()
    const second = await saveFields(edited.revision, { debug: true })
    assert.equal(second.kind, "saved", JSON.stringify(second))
    assert.equal(await readFile(source + ".backup", "utf8"), prior)
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), { version: 1, future, settings: { automatic: false, debug: true } })
    assert.deepEqual(await readFile(config), configBytes)

    const secondBytes = await readFile(source)
    const third = await saveFields(second.revision, { debug: false })
    assert.equal(third.kind, "saved", JSON.stringify(third))
    assert.deepEqual(await readFile(source + ".backup"), secondBytes)
    assert.deepEqual(await readFile(config), configBytes)

    await f.restart()
    const restarted = await afterRestart(read, t)
    assert.equal(restarted.activeRevision, restarted.revision)
    assert.equal(restarted.effective?.automatic, false)
    assert.equal(restarted.effective?.debug, false)
    assert.deepEqual(f.calls, [])
  })
}

test("two Windows clients sustain status polling without accumulating helpers", { timeout: 90000 }, async t => {
  await using f = await createFixture(pathToFileURL(PREDICTIONS_PACKAGE!).href, {}, {}, {
    windowsConfig: "override", projectConfig: true, seedPreferences: false,
  })
  const location = { directory: f.directory }
  const clients = [f.api, OpenCode.make({ baseUrl: f.address, headers: f.headers })]
  const before = await clients[0].rpc(Predictions).settingsV2({}, { location, signal: AbortSignal.timeout(2000) }) as SetupSnapshot
  assert.equal(before.writable, true, before.reason ?? "Stock CommonApplicationData must not suppress user preferences.")
  const save = await clients[0].rpc(Predictions).saveSettings({ revision: before.revision, fields: { models: "fixture/model", automatic: false } },
    { location, signal: AbortSignal.timeout(12000) }) as SaveResult
  assert.equal(save.kind, "saved", JSON.stringify(save))

  const script = `
    $ErrorActionPreference = 'Stop'
    $filter = "ParentProcessId = $([int]$env:PREDICTIONS_TEST_SERVER_PID) AND Name = '${helperName}'"
    function sample { @(Get-CimInstance -ClassName Win32_Process -Filter $filter).Count }
    $peak = sample
    [Console]::WriteLine('ready')
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
      $peak = [Math]::Max($peak, (sample))
      Start-Sleep -Milliseconds 35
    } while ($clock.ElapsedMilliseconds -lt 34000)
    [Console]::WriteLine("$peak,$(sample)")
  `
  const monitor = spawn(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, PREDICTIONS_TEST_SERVER_PID: String(f.pid) }, stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  t.after(() => { if (monitor.exitCode === null && monitor.signalCode === null) monitor.kill() })
  let output = "", errors = ""
  monitor.stdout.on("data", chunk => { output += chunk })
  monitor.stderr.on("data", chunk => { errors += chunk })
  const closed = once(monitor, "close")
  // A 34 s monitor leaves a quiet tail after the last 2 s poll.
  await Promise.race([once(monitor.stdout, "data"), closed])
  assert.match(output, /^ready\r?\n/, errors || "Helper sampling did not start.")

  let slowest = 0
  const start = performance.now()
  for (let i = 0; i <= 15; i++) {
    const gap = start + i * 2000 - performance.now()
    if (gap > 0) await pause(gap)
    const began = performance.now()
    const status = await Promise.all(clients.map(api => api.rpc(Predictions).status({}, { location, signal: AbortSignal.timeout(2000) }))) as Status[]
    assert.ok(status.every(result => result.enabled), JSON.stringify(status))
    slowest = Math.max(slowest, performance.now() - began)
  }
  assert.ok(slowest < 2000, `Slowest poll pair: ${slowest.toFixed(0)} ms`)
  assert.equal((await closed)[0], 0, errors)
  const counts = output.match(/^ready\r?\n(\d+),(\d+)\s*$/)
  assert.ok(counts, `Unexpected sample output: ${output}`)
  assert.ok(Number(counts[1]) > 0 && Number(counts[1]) <= 2, `Peak helper count: ${counts[1]}`)
  assert.equal(Number(counts[2]), 0, "No helpers may remain after polling.")
  assert.deepEqual(f.calls, [])
  t.diagnostic(`Peak helpers: ${counts[1]}; slowest poll pair: ${slowest.toFixed(0)} ms`)
})

const contextName = "predictions-context.md"
const notes = "Standing notes for Windows.\r\nSecond line: é\n"
const refusal = (reason: string) => `predictions-context.md exists but is not safe to use: ${reason}. Fix or remove it, then save again.`
const run = promisify(execFile)

function utility(name: string, args: string[], env = process.env) {
  return run(join(process.env.SystemRoot!, "System32", name), args, { env, windowsHide: true, timeout: 10000 })
}
const icacls = (path: string, ...args: string[]) => utility("icacls.exe", [path, ...args])
const getAcl = async (path: string) => (await utility("WindowsPowerShell\\v1.0\\powershell.exe", [
  "-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:PREDICTIONS_TEST_ACL_PATH).Sddl",
], { ...process.env, PREDICTIONS_TEST_ACL_PATH: path })).stdout.trim()

// The verifier's private ACL: owned by the server's account, inheritance blocked, and full control for only
// that account, SYSTEM and Administrators. A directory passes the same three grants on to what it contains.
async function assertPrivateAcl(path: string, directory = false) {
  const { stdout } = await utility("whoami.exe", ["/user", "/fo", "csv", "/nh"])
  const sid = stdout.match(/S-1-[\d-]+/)?.[0]
  assert.ok(sid, "The runner must identify its standard account.")
  const sddl = await getAcl(path)
  assert.match(sddl, new RegExp(`^O:${sid}(?=G:|D:)`), sddl)
  // The kernel can record automatic inheritance even when the DACL remains protected.
  assert.match(sddl, /D:P(?:AI)?\(/, sddl)
  const aces = [...sddl.matchAll(/\(([^)]*)\)/g)].map(match => match[1]).sort()
  assert.deepEqual(aces, [sid, "SY", "BA"].map(trustee => `A;${directory ? "OICI" : ""};FA;;;${trustee}`).sort(), sddl)
}

// Every case gets its own configuration root, so a context file left by one case cannot reach another.
const contextFixture = () => createFixture(pathToFileURL(PREDICTIONS_PACKAGE!).href, {}, {}, {
  windowsConfig: "override", projectConfig: true, seedPreferences: false,
})
// RPC results are compared as plain JSON, whatever objects the client decodes them into.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function contextClient(f: Awaited<ReturnType<typeof contextFixture>>) {
  const source = join(f.root, "O'Brien [测试]", "opencode", "predictions.json")
  const directory = dirname(source), context = join(directory, contextName)
  const { USERPROFILE } = process.env
  assert.ok(USERPROFILE && isAbsolute(USERPROFILE), "USERPROFILE must be an absolute Windows path.")
  const under = relative(USERPROFILE, context)
  assert.ok(!under.startsWith("..") && !isAbsolute(under), "The fixture root must be inside the account's profile.")
  const location = { directory: f.directory }
  return {
    source, directory, context,
    // The server stores a path under the home directory as "~/" plus forward slashes.
    stored: "~/" + under.split(sep).join("/"),
    read: async () => plain(await f.api.rpc(Predictions).settingsV2({}, { location, signal: AbortSignal.timeout(2000) }) as SetupSnapshot),
    save: async (input: SaveInput) => plain(await f.api.rpc(Predictions).saveSettings(input, { location, signal: AbortSignal.timeout(12000) }) as SaveResult),
    status: async () => plain(await f.api.rpc(Predictions).contextFileStatus({}, { location, signal: AbortSignal.timeout(2000) }) as ContextFileStatus),
  }
}
type ContextClient = ReturnType<typeof contextClient>

// Saves preferences without a context file, so a later refusal has bytes to leave unchanged.
async function seedPreferences(c: ContextClient) {
  const empty = await c.read()
  assert.equal(empty.source, c.source)
  assert.equal(empty.writable, true, empty.reason ?? "The Windows server must permit first Save.")
  const first = await c.save({ revision: empty.revision, fields: { automatic: false } })
  assert.equal(first.kind, "saved", JSON.stringify(first))
  assert.deepEqual(JSON.parse(await readFile(c.source, "utf8")), { version: 1, settings: { automatic: false } })
  assert.deepEqual(await c.status(), { set: false })
}

test("Windows first Save creates the missing directory and an empty private context file", { timeout: 120000 }, async t => {
  await using f = await contextFixture()
  const c = contextClient(f)
  // The server can create its configuration directory when it starts. Remove it while it is empty,
  // so that this Save must create the directory and the context file together.
  const startup = await entries(c.directory)
  if (startup) {
    assert.deepEqual(startup, [], "Only an empty configuration directory may be removed.")
    await rmdir(c.directory)
  }
  t.diagnostic(`The opencode directory was ${startup ? "made by the server and removed" : "missing"} before the first read.`)
  const before = await c.read()
  assert.equal(before.source, c.source)
  assert.equal(before.writable, true, before.reason ?? "The Windows server must permit first Save.")
  assert.deepEqual(await c.status(), { set: false })
  assert.equal(await entries(c.directory), undefined, "The opencode directory must be missing before the first Save.")

  const save = await c.save({ revision: before.revision, fields: { automatic: false }, contextFile: "managed" })
  assert.equal(save.kind, "saved", JSON.stringify(save))
  assert.deepEqual(await entries(c.directory), [contextName, "predictions.json"])
  assert.equal((await readFile(c.context)).length, 0)
  assert.equal((await lstat(c.context)).nlink, 1)
  await assertPrivateAcl(c.context)
  await assertPrivateAcl(c.directory, true)
  assert.deepEqual(JSON.parse(await readFile(c.source, "utf8")), { version: 1, settings: { automatic: false, contextFile: c.stored } })
  assert.deepEqual(await c.status(), { set: true, path: c.stored, absolute: c.context, managed: true, state: "empty", bytes: 0 })
  const saved = await c.read()
  assert.equal(saved.activeRevision, saved.revision)
  assert.equal(saved.revision, save.revision)
  assert.equal(saved.effective?.contextFile, c.stored)
  assert.deepEqual(f.calls, [])
})

test("Windows adopts an existing safe context file without changing it", { timeout: 120000 }, async () => {
  await using f = await contextFixture()
  const c = contextClient(f)
  await seedPreferences(c)
  await writeFile(c.context, notes)
  const acl = await getAcl(c.context), prior = await readFile(c.source), listing = await entries(c.directory) ?? []
  assert.ok(listing.includes(contextName) && !listing.includes("predictions.json.backup"), JSON.stringify(listing))
  const before = await c.read()
  const save = await c.save({ revision: before.revision, fields: { debug: true }, contextFile: "managed" })
  assert.equal(save.kind, "saved", JSON.stringify(save))
  assert.equal(await readFile(c.context, "utf8"), notes)
  assert.equal(await getAcl(c.context), acl)
  assert.equal((await lstat(c.context)).nlink, 1)
  assert.deepEqual(await readFile(c.source + ".backup"), prior)
  assert.deepEqual(JSON.parse(await readFile(c.source, "utf8")), { version: 1, settings: { automatic: false, debug: true, contextFile: c.stored } })
  // Save adds only the backup of the earlier preferences.
  assert.deepEqual(await entries(c.directory), [...listing, "predictions.json.backup"].sort())
  assert.deepEqual(await c.status(), { set: true, path: c.stored, absolute: c.context, managed: true, state: "ok", bytes: Buffer.byteLength(notes) })
  assert.deepEqual(f.calls, [])
})

const unsafeEntries = [
  ["a symbolic link", "it is a link"],
  ["a junction", "it is a link"],
  ["a directory", "it is not a regular file"],
  ["a file with a second hard link", "it has more than one link"],
  ["a file that other users can write", "other users can write to it"],
] as const

// Puts an unsafe entry at the fixed context path. Returns a check that the entry is still as it was made,
// or nothing when this account cannot make the entry.
async function occupy(kind: typeof unsafeEntries[number][0], path: string, outside: string): Promise<(() => Promise<void>) | undefined> {
  if (kind === "a symbolic link") {
    await writeFile(outside, notes)
    try { await symlink(outside, path, "file") }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error
      return
    }
    return async () => {
      assert.ok((await lstat(path)).isSymbolicLink())
      assert.equal(await readFile(outside, "utf8"), notes)
    }
  }
  if (kind === "a junction") {
    await mkdir(outside)
    await symlink(outside, path, "junction")
    return async () => {
      assert.ok((await lstat(path)).isSymbolicLink())
      assert.deepEqual(await entries(outside), [])
    }
  }
  if (kind === "a directory") {
    await mkdir(path)
    return async () => {
      assert.ok((await lstat(path)).isDirectory())
      assert.deepEqual(await entries(path), [])
    }
  }
  await writeFile(path, notes)
  if (kind === "a file with a second hard link") {
    await link(path, outside)
    return async () => {
      assert.equal((await lstat(path)).nlink, 2)
      assert.equal(await readFile(path, "utf8"), notes)
      assert.equal(await readFile(outside, "utf8"), notes)
    }
  }
  await icacls(path, "/grant", "*S-1-5-11:(WD)")
  const acl = await getAcl(path)
  return async () => {
    assert.equal(await readFile(path, "utf8"), notes)
    assert.equal(await getAcl(path), acl)
  }
}

for (const [kind, reason] of unsafeEntries) {
  test(`Windows refuses a context file path that holds ${kind}`, { timeout: 120000 }, async t => {
    await using f = await contextFixture()
    const c = contextClient(f)
    await seedPreferences(c)
    const unchanged = await occupy(kind, c.context, join(f.root, "context-outside"))
    if (!unchanged) {
      // A junction covers the reparse point rule on every runner. A file symbolic link needs a privilege.
      t.skip("This account cannot create a symbolic link. Windows needs Developer Mode or the symbolic link privilege.")
      return
    }
    const bytes = await readFile(c.source), listing = await entries(c.directory)
    const before = await c.read()
    assert.equal(before.writable, true, before.reason ?? "Only the context file is unsafe.")
    const save = await c.save({ revision: before.revision, fields: { debug: true }, contextFile: "managed" })
    assert.deepEqual(save, { kind: "invalid", issues: [{ field: "contextFile", severity: "error", code: "unsafe_context_file", message: refusal(reason) }] })
    assert.deepEqual(await readFile(c.source), bytes)
    // A refusal leaves no backup and no staging file behind.
    assert.deepEqual(await entries(c.directory), listing)
    await unchanged()
    assert.deepEqual(await c.status(), { set: false })
    assert.deepEqual((await c.read()).overrides, { automatic: false })
    assert.deepEqual(f.calls, [])
  })
}

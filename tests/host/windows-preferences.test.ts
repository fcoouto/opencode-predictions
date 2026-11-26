import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { setTimeout as pause } from "node:timers/promises"
import { test, type TestContext } from "node:test"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { Predictions } from "../../src/rpc.ts"
import type { Status } from "../../src/service.ts"
import type { SaveResult, SetupSnapshot } from "../../src/setup.ts"
import { createFixture } from "./fixture.mjs"

assert.equal(process.platform, "win32", "This qualification test requires native Windows.")
const { APPDATA, OPENCODE_BIN, PREDICTIONS_PACKAGE } = process.env
for (const [name, value] of Object.entries({ APPDATA, OPENCODE_BIN, PREDICTIONS_PACKAGE })) {
  assert.ok(value && isAbsolute(value), `${name} must be an absolute Windows path.`)
}

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
    t.diagnostic(`${windowsConfig} runs ${windowsConfig === firstRoot ? "first" : "second"} in this profile.`)
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

    await f.restart()
    const restarted = await afterRestart(read, t)
    assert.equal(restarted.activeRevision, restarted.revision)
    assert.equal(restarted.effective?.automatic, false)
    assert.equal(restarted.effective?.debug, true)
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
  const save = await clients[0].rpc(Predictions).saveSettings({ revision: before.revision, fields: { models: "fixture/model", automatic: false } },
    { location, signal: AbortSignal.timeout(12000) }) as SaveResult
  assert.equal(save.kind, "saved", JSON.stringify(save))

  const script = `
    $ErrorActionPreference = 'Stop'
    $filter = "ParentProcessId = $([int]$env:PREDICTIONS_TEST_SERVER_PID) AND Name = 'powershell.exe'"
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

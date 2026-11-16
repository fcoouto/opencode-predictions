import { test } from "node:test"
import assert from "node:assert/strict"
import { createDesktopSetupOrigin, createStandaloneSetupOrigin, type OriginProcess, type StandaloneRuntime } from "../src/setup-origin.ts"

const signal = () => new AbortController().signal
const denied = /not verified for local setup/
function desktop() {
  const lifetime = new AbortController()
  const original = { id: "sidecar", url: "http://127.0.0.1:1234", sameMachine: true, headers: { authorization: "PRIVATE" } }
  let endpoint: typeof original | undefined = original
  const host = {
    app: { name: "opencode", version: "2.3.0", platform: "desktop" as const, packaged: true, channel: "prod" as const },
    signal: lifetime.signal, serverEndpoints: { get: (_id: string) => endpoint },
  }
  return { host, original, lifetime, change(value: typeof endpoint) { endpoint = value } }
}
function standalone() {
  let infoCalls = 0, inspections = 0
  const record: OriginProcess = { parent: 100, uid: 501, command: "/native/opencode serve --stdio --port 0", started: "Sun Nov 15 12:00:00 2026" }
  const runtime: StandaloneRuntime = {
    platform: "darwin", pid: 100, uid: 501, executable: "/native/opencode",
    argv: ["/native/opencode", "/native/opencode", "--standalone"], env: {},
    inspect: async pid => { inspections++; assert.equal(pid, 200); return record },
  }
  const info = { pid: 200, version: "2.2.6" }
  const client = { server: { info: async () => { infoCalls++; return info } } }
  const host = { app: { version: "2.2.6" }, client }
  return { host, client, runtime, record, info, counts: () => ({ infoCalls, inspections }) }
}

test("Desktop main denies non-sameMachine setup before local dispatch", async () => {
  for (const mode of ["remote", "relay", "unknown", "unqualified-version", "forged-flag", "wrong-id"]) {
    const f = desktop()
    if (mode === "unknown") f.change(undefined)
    else if (mode === "unqualified-version") f.host.app.version = "2.4.0"
    else if (mode === "forged-flag") f.original.sameMachine = "true" as any
    else if (mode === "wrong-id") f.original.id = "different-server"
    else f.original.sameMachine = false
    const origin = createDesktopSetupOrigin(f.host, "sidecar")
    let localCalls = 0
    await assert.rejects(origin.dispatch(signal(), async () => { localCalls++; return "written" }), denied, mode)
    assert.equal(localCalls, 0, mode)
  }
})

test("Desktop dispatch pins native endpoint and credentials and never silently retargets", async () => {
  for (const field of ["url", "authorization", "sameMachine", "removed"]) {
    const f = desktop()
    const origin = createDesktopSetupOrigin(f.host, "sidecar")
    assert.equal(await origin.dispatch(signal(), async identity => identity.serverID), "sidecar")
    f.change({ ...f.original, headers: { ...f.original.headers } })
    if (field === "url") f.change({ ...f.original, url: "http://127.0.0.1:9999" })
    if (field === "authorization") f.change({ ...f.original, headers: { authorization: "ROTATED_PRIVATE" } })
    if (field === "sameMachine") f.change({ ...f.original, sameMachine: false })
    if (field === "removed") f.change(undefined)
    let localCalls = 0
    await assert.rejects(origin.dispatch(signal(), async () => { localCalls++ }), denied, field)
    f.change(f.original)
    await assert.rejects(origin.dispatch(signal(), async () => { localCalls++ }), denied, "revoked origins must not revive")
    assert.equal(localCalls, 0)
  }
})

test("Desktop host teardown and caller cancellation prevent local dispatch", async () => {
  for (const mode of ["host", "caller", "dispose"]) {
    const f = desktop(), caller = new AbortController()
    const origin = createDesktopSetupOrigin(f.host, "sidecar")
    if (mode === "host") f.lifetime.abort()
    if (mode === "caller") caller.abort()
    if (mode === "dispose") origin.dispose()
    let calls = 0
    await assert.rejects(origin.dispatch(caller.signal, async () => { calls++ }))
    assert.equal(calls, 0)
  }
})

test("CLI denies unqualified launch origins before metadata or local dispatch", async () => {
  const argumentsToDeny = [
    [], ["--server", "http://remote"], ["--standalone", "--server=http://remote"],
    ["--", "--standalone"], ["--prompt", "--standalone"], ["mini", "--standalone"],
    ["--standalone=false"], ["--standalone", "--standalone"], ["--standalone", "--session"],
    ["--standalone", "--unknown"], ["--standalone", "/one", "/two"],
  ]
  for (const args of argumentsToDeny) {
    const f = standalone()
    f.runtime.argv = ["/native/opencode", "/native/opencode", ...args]
    const origin = createStandaloneSetupOrigin(f.host, f.runtime)
    let localCalls = 0
    await assert.rejects(origin.dispatch(signal(), async () => { localCalls++ }), denied, JSON.stringify(args))
    assert.equal(localCalls, 0)
    assert.deepEqual(f.counts(), { infoCalls: 0, inspections: 0 })
  }
})

test("CLI accepts canonical standalone arguments and verifies the OS-owned private child", async () => {
  const f = standalone()
  f.runtime.argv = ["/native/opencode", "/native/opencode", "--standalone", "--session", "ses_fixture", "--continue", "--log-level", "debug", "/project"]
  const origin = createStandaloneSetupOrigin(f.host, f.runtime)
  assert.equal(await origin.dispatch(signal(), async identity => identity.serverPid), 200)
  assert.deepEqual(f.counts(), { infoCalls: 1, inspections: 1 })
})

test("CLI denies routing overrides, unknown versions, platforms and custom executables before metadata", async () => {
  for (const mode of ["platform", "version", "executable", "OPENCODE_SERVER", "OPENCODE_SERVER_URL", "HTTP_PROXY", "https_proxy", "ALL_PROXY", "NODE_OPTIONS", "BUN_OPTIONS", "OPENCODE_DRIVE"]) {
    const f = standalone()
    if (mode === "platform") f.runtime.platform = "linux"
    else if (mode === "version") f.host.app.version = "2.3.0"
    else if (mode === "executable") f.runtime.executable = "/native/node"
    else f.runtime.env[mode] = "PRIVATE_REMOTE_HINT"
    let calls = 0
    await assert.rejects(createStandaloneSetupOrigin(f.host, f.runtime).dispatch(signal(), async () => { calls++ }), denied, mode)
    assert.equal(calls, 0)
    assert.equal(f.counts().infoCalls, 0)
  }
})

test("relayed PID or private-looking metadata cannot replace OS child ownership", async () => {
  for (const mode of ["parent", "uid", "command", "missing", "bad-pid", "server-version"]) {
    const f = standalone()
    if (mode === "parent") f.record.parent = 999
    if (mode === "uid") f.record.uid = 502
    if (mode === "command") f.record.command = "/native/opencode serve --hostname 127.0.0.1"
    if (mode === "missing") f.runtime.inspect = async () => undefined
    if (mode === "bad-pid") f.info.pid = NaN
    if (mode === "server-version") f.info.version = "2.3.0"
    let calls = 0
    await assert.rejects(createStandaloneSetupOrigin(f.host, f.runtime).dispatch(signal(), async () => { calls++ }), denied, mode)
    assert.equal(calls, 0)
  }
})

test("CLI pins process birth identity and revokes replacements rather than following them", async () => {
  const f = standalone()
  const origin = createStandaloneSetupOrigin(f.host, f.runtime)
  await origin.dispatch(signal(), async () => {})
  f.record.started = "Sun Nov 15 12:00:01 2026"
  let calls = 0
  await assert.rejects(origin.dispatch(signal(), async () => { calls++ }), denied)
  f.record.started = "Sun Nov 15 12:00:00 2026"
  await assert.rejects(origin.dispatch(signal(), async () => { calls++ }), denied)
  assert.equal(calls, 0)
})

test("CLI rechecks selected client after asynchronous inspection before dispatch", async () => {
  const f = standalone()
  f.runtime.inspect = async () => {
    f.host.client = { server: { info: f.client.server.info } }
    return f.record
  }
  let calls = 0
  await assert.rejects(createStandaloneSetupOrigin(f.host, f.runtime).dispatch(signal(), async () => { calls++ }), denied)
  assert.equal(calls, 0)
})

test("origin inspection failures expose fixed copy, not credential or native command errors", async () => {
  const f = standalone()
  f.runtime.inspect = async () => { throw new Error("PRIVATE command or credential") }
  await assert.rejects(createStandaloneSetupOrigin(f.host, f.runtime).dispatch(signal(), async () => {}), error => {
    assert.doesNotMatch(String(error), /PRIVATE/)
    return denied.test(String(error))
  })
})

test("CLI rejects a changed server PID before inspecting a replacement process", async () => {
  const f = standalone()
  const origin = createStandaloneSetupOrigin(f.host, f.runtime)
  await origin.dispatch(signal(), async () => {})
  f.info.pid = 201
  let calls = 0
  await assert.rejects(origin.dispatch(signal(), async () => { calls++ }), denied)
  assert.equal(f.counts().inspections, 1, "a pinned origin must not inspect a replacement target")
  assert.equal(calls, 0)
})

test("CLI cancellation or disposal during ignored metadata prevents late local dispatch", async () => {
  for (const mode of ["caller", "dispose"]) {
    const f = standalone(), caller = new AbortController()
    let finish!: (info: { pid: number; version: string }) => void
    f.client.server.info = () => new Promise(resolve => { finish = resolve })
    const origin = createStandaloneSetupOrigin(f.host, f.runtime)
    let calls = 0
    const pending = origin.dispatch(caller.signal, async () => { calls++ })
    if (mode === "caller") caller.abort()
    else origin.dispose()
    await assert.rejects(pending)
    finish(f.info)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 0)
    assert.equal(f.counts().inspections, 0)
  }
})

test("CLI rechecks routing and invocation after async inspection", async () => {
  for (const mode of ["environment", "arguments", "version"]) {
    const f = standalone()
    f.runtime.inspect = async () => {
      if (mode === "environment") f.runtime.env.HTTPS_PROXY = "PRIVATE_PROXY"
      if (mode === "arguments") f.runtime.argv = [...f.runtime.argv, "--server", "http://remote"]
      if (mode === "version") f.host.app.version = "2.3.0"
      return f.record
    }
    let calls = 0
    await assert.rejects(createStandaloneSetupOrigin(f.host, f.runtime).dispatch(signal(), async () => { calls++ }), denied)
    assert.equal(calls, 0)
  }
})

test("origin disposal cancels already dispatched work without retrying or claiming rollback", async () => {
  const f = standalone()
  const origin = createStandaloneSetupOrigin(f.host, f.runtime)
  let finish!: () => void, start!: () => void, workSignal: AbortSignal | undefined, calls = 0
  const started = new Promise<void>(resolve => { start = resolve })
  const pending = origin.dispatch(signal(), async (_identity, value) => {
    calls++; workSignal = value; start()
    return new Promise<void>(resolve => { finish = resolve })
  })
  await started
  origin.dispose()
  await assert.rejects(pending)
  assert.equal(workSignal?.aborted, true)
  finish()
  await assert.rejects(origin.dispatch(signal(), async () => { calls++ }))
  assert.equal(calls, 1)
})

test("CLI bounds metadata verification even when its signal is ignored", async () => {
  const f = standalone()
  f.client.server.info = async () => new Promise(() => {})
  let calls = 0
  const pending = assert.rejects(createStandaloneSetupOrigin(f.host, f.runtime).dispatch(signal(), async () => { calls++ }), denied)
  await Promise.all([pending, new Promise(resolve => setTimeout(resolve, 2100))])
  assert.equal(calls, 0)
})

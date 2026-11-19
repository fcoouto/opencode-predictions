import { test } from "node:test"
import assert from "node:assert/strict"
import { createPreferencesRuntime } from "../src/preferences-runtime.ts"
import { createService, type ServiceAPI } from "../src/service.ts"
import type { PreferenceRead, PreferencesStore } from "../src/preferences-store.ts"

const signal = () => new AbortController().signal
function fixture(legacy: unknown = { models: "local/a", debug: false }) {
  let stored: PreferenceRead = { source: "/server/predictions.json", revision: "one", writable: true, documentValid: true, policy: "user", overrides: {} }
  const calls = { construct: 0, dispose: 0, generate: 0, pr: 0 }
  const api: ServiceAPI = {
    session: async id => ({ id, time: { idle: 2 }, location: { directory: "/project" } }),
    context: async () => [{ type: "user", text: "Fix it" }, { type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: "Fixed" }] }, { type: "idle", outcome: "succeeded" }],
    models: async () => [{ providerID: "local", id: "a", enabled: true, variants: [] }],
    includeGithubPRContext: async () => { calls.pr++; return [] },
    generate: async () => { calls.generate++; return '{"prompt":"Run tests."}' },
  }
  const store: PreferencesStore = { read: async () => structuredClone(stored), write: async () => { throw new Error("Unexpected write") } }
  const runtime = createPreferencesRuntime(store, legacy, options => {
    calls.construct++
    const engine = createService(api, options, "/project"), dispose = engine.dispose
    engine.dispose = () => { calls.dispose++; dispose() }
    return engine
  })
  const set = (patch: Partial<PreferenceRead>) => { stored = { ...stored, ...patch, revision: crypto.randomUUID() } }
  return { runtime, store, calls, api, set }
}

test("origin-only reset advances active revision without replacing the engine or generating", async () => {
  const f = fixture()
  try {
    f.set({ overrides: { debug: false } }); await f.runtime.refresh(signal())
    const before = f.runtime.state()
    assert.equal(before.resolved.origins.debug, "preferences")
    assert.equal(before.activeRevision, before.revision)
    f.set({ overrides: {} }); await f.runtime.refresh(signal())
    assert.notEqual(f.runtime.state().revision, before.revision)
    assert.equal(f.runtime.state().activeRevision, f.runtime.state().revision)
    assert.equal(f.runtime.state().resolved.origins.debug, "configuration")
    assert.equal(f.calls.construct, 1)
    assert.equal(f.calls.generate, 0)
  } finally { f.runtime.dispose() }
})

for (const field of ["timeoutMs", "contextTurns"] as const) test(`numeric-null ${field} never activates on startup or manual replacement`, async () => {
  const f = fixture()
  try {
    f.set({ overrides: { [field]: null } }); await f.runtime.refresh(signal())
    assert.equal(f.runtime.state().activeRevision, null)
    assert.equal(f.runtime.state().resolved.issues[0]?.field, field)
    assert.equal(f.runtime.state().service.status().enabled, false)
    const failed = await f.runtime.predict({ sessionID: "ses_test", completion: 2 }, signal())
    assert.equal(failed.text, undefined)
    assert.equal(f.calls.generate, 0)
    f.set({ overrides: { [field]: field === "timeoutMs" ? 8000 : 3 } }); await f.runtime.refresh(signal())
    assert.equal(f.runtime.state().activeRevision, f.runtime.state().revision)
    const healthy = f.runtime.state().service
    f.set({ overrides: { [field]: null } }); await f.runtime.refresh(signal())
    assert.notEqual(f.runtime.state().service, healthy)
    assert.equal(f.runtime.state().activeRevision, null)
    assert.ok(f.calls.dispose >= 2)
    assert.equal(f.calls.pr, 0)
  } finally { f.runtime.dispose() }
})

test("missing preferences retain legacy null defaults and readable unwritable values remain active", async () => {
  const f = fixture({ models: "local/a", timeoutMs: null, contextTurns: null })
  try {
    await f.runtime.refresh(signal())
    assert.equal(f.runtime.state().service.status().timeoutMs, 8000)
    assert.equal(f.runtime.state().service.status().contextTurns, 3)
    f.set({ overrides: { debug: true }, writable: false }); await f.runtime.refresh(signal())
    assert.equal(f.runtime.state().service.status().debug, true)
    assert.equal(f.runtime.state().activeRevision, f.runtime.state().revision)
    f.set({ overrides: {} }); await f.runtime.refresh(signal())
    assert.equal(f.runtime.state().service.status().debug, false)
  } finally { f.runtime.dispose() }
})

test("corrupt or unreadable replacement disables predictions instead of restoring defaults", async () => {
  const f = fixture({ models: "local/a", includeGithubPRContext: true })
  try {
    await f.runtime.refresh(signal())
    const healthy = f.runtime.state().service
    f.set({ documentValid: false, writable: false, reason: "Invalid preferences" })
    await f.runtime.refresh(signal())
    assert.notEqual(f.runtime.state().service, healthy)
    assert.equal(f.runtime.state().activeRevision, null)
    assert.equal(f.runtime.state().service.status().enabled, false)
    await f.runtime.predict({ sessionID: "ses_test", completion: 2 }, signal())
    assert.equal(f.calls.generate, 0)
    assert.equal(f.calls.pr, 0)
  } finally { f.runtime.dispose() }
})

test("administrative configuration ignores preferences and uses legacy options", async () => {
  const f = fixture()
  try {
    f.set({ policy: "managed", writable: false, overrides: { debug: true } })
    await f.runtime.refresh(signal())
    assert.equal(f.runtime.state().service.status().debug, false)
    assert.equal(f.runtime.state().resolved.origins.debug, "configuration")
  } finally { f.runtime.dispose() }
})

test("effective changes abort old generation and late replies never escape", async () => {
  const f = fixture()
  let started!: () => void, finish!: (text: string) => void, generationSignal: AbortSignal | undefined
  const ready = new Promise<void>(resolve => { started = resolve })
  f.api.generate = async (_model, _prompt, signal) => { generationSignal = signal; started(); return new Promise(resolve => { finish = resolve }) }
  try {
    const pending = f.runtime.predict({ sessionID: "ses_test", completion: 2 }, signal())
    await ready
    f.set({ overrides: { debug: true } }); await f.runtime.refresh(signal())
    assert.equal(generationSignal?.aborted, true)
    finish('{"prompt":"STALE"}')
    assert.equal((await pending).text, undefined)
    assert.equal(f.runtime.state().service.status().debug, true)
  } finally { f.runtime.dispose() }
})

test("older refresh completion cannot overwrite newer state and disposal cannot resurrect an engine", async () => {
  const f = fixture()
  try {
    await f.runtime.refresh(signal())
    const before = f.runtime.state().stored
    let finish!: (value: PreferenceRead) => void
    f.store.read = async () => new Promise(resolve => { finish = resolve })
    const older = f.runtime.refresh(signal())
    f.store.read = async () => ({ ...before, revision: "newer", overrides: { debug: true } })
    await f.runtime.refresh(signal())
    finish({ ...before, revision: "older", overrides: { debug: false } }); await older
    assert.equal(f.runtime.state().service.status().debug, true)
    let complete!: (value: PreferenceRead) => void
    f.store.read = async () => new Promise(resolve => { complete = resolve })
    const pending = f.runtime.refresh(signal()).catch(() => {})
    const count = f.calls.construct
    f.runtime.dispose(); complete(before); await pending
    assert.equal(f.calls.construct, count)
  } finally { f.runtime.dispose() }
})

for (const stage of ["before dispatch", "after completion"] as const) test(`a canceled newer refresh cannot discard invalid preferences ${stage}`, { timeout: 2000 }, async () => {
  const f = fixture({ models: "local/a", includeGithubPRContext: true })
  try {
    await f.runtime.refresh(signal())
    const before = f.runtime.state().stored
    const invalid = { ...before, revision: "corrupt", documentValid: false, writable: false, reason: "Invalid preferences" }
    const criticalRead = stage === "before dispatch" ? 1 : 2
    let reads = 0, ready!: () => void, finish!: (value: PreferenceRead) => void
    const reached = new Promise<void>(resolve => { ready = resolve })
    f.store.read = async () => {
      const read = ++reads
      if (read === criticalRead) { ready(); return new Promise(resolve => { finish = resolve }) }
      if (read === criticalRead + 1) return new Promise(() => {})
      return read < criticalRead ? before : invalid
    }
    const prediction = f.runtime.predict({ sessionID: "ses_test", completion: 2 }, signal())
    await reached
    const cancelled = new AbortController()
    const newer = assert.rejects(f.runtime.refresh(cancelled.signal))
    cancelled.abort()
    await newer
    finish(invalid)
    assert.equal((await prediction).text, undefined, "a discarded corrupt-file read must not publish an old suggestion")
    assert.equal(f.runtime.state().activeRevision, null)
    assert.equal(f.calls.generate, stage === "before dispatch" ? 0 : 1)
    assert.equal(f.calls.pr, stage === "before dispatch" ? 0 : 1)
  } finally { f.runtime.dispose() }
})

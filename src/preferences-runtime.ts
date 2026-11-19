import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { parseOptions } from "./options.ts"
import { resolvePreferences, type ResolvedPreferences } from "./preferences.ts"
import { abortable, type createService, type Request, type Reply } from "./service.ts"
import type { PreferenceRead, PreferencesStore } from "./preferences-store.ts"

type Engine = ReturnType<typeof createService>
export type PreferenceRuntimeState = { stored: PreferenceRead; resolved: ResolvedPreferences; revision: string; activeRevision: string | null; service: Engine }

export function createPreferencesRuntime(store: PreferencesStore, legacy: unknown, make: (rawOptions: unknown) => Engine) {
  const lifetime = new AbortController()
  let current: PreferenceRuntimeState | undefined, effective: unknown, generation = 0
  const state = () => {
    if (!current) throw new Error("Prediction preferences are not loaded.")
    return current
  }
  async function refresh(parent: AbortSignal) {
    const signal = AbortSignal.any([parent, lifetime.signal]), ticket = ++generation
    signal.throwIfAborted()
    const stored = await abortable(() => store.read(signal), signal)
    signal.throwIfAborted()
    if (ticket !== generation) return
    const resolved = resolvePreferences(legacy, stored.policy === "managed" ? {} : stored.overrides)
    const parsed = parseOptions(resolved.rawOptions)
    const valid = stored.documentValid && !resolved.issues.length && parsed.ok
    const next = valid && parsed.ok ? parsed.value : null
    const revision = createHash("sha256").update(JSON.stringify([stored.revision, legacy, stored.policy])).digest("hex")
    let service = current?.service
    if (!service || !isDeepStrictEqual(effective, next)) {
      service?.dispose()
      service = make(valid ? resolved.rawOptions : null)
    }
    effective = next
    current = { stored, resolved, revision, activeRevision: valid ? revision : null, service }
  }
  return {
    state,
    refresh,
    async predict(input: Request, signal: AbortSignal): Promise<Reply> {
      await refresh(signal)
      const engine = state().service
      const reply = await engine.predict(input, signal)
      await refresh(signal)
      return engine === state().service ? reply : { reason: "stale" }
    },
    dispose() { if (!lifetime.signal.aborted) { lifetime.abort(); current?.service.dispose() } },
  }
}
export type PreferencesRuntime = ReturnType<typeof createPreferencesRuntime>

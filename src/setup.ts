import { parseOptions, type Options } from "./options.ts"
import type { Candidate, CatalogModel } from "./models.ts"
import { abortable } from "./service.ts"
import { applyPreferenceChange, resolvePreferences } from "./preferences.ts"

// Setup RPC must not let clients select files for the server to read and send to providers.
export const settingKeys = ["models", "enabled", "automatic", "escalation", "timeoutMs", "contextTurns", "debug", "includeGithubPRContext"] as const
export type SettingKey = typeof settingKeys[number]
export type SettingOrigin = "preferences" | "default"
export type SettingsInput = Partial<Record<SettingKey, unknown>>
export type ConfigSnapshot = { revision: string; source?: string; scope: "global"; writable: boolean; reason?: string; fields: SettingsInput }
export type SetupLocation = { directory: string; workspaceID?: string }
export type SetupIssue = { field: SettingKey | "contextFile"; group?: number; entry?: number; severity: "error" | "warning"; code: string; message: string }
export type SetupSnapshot = ConfigSnapshot & { overrides: SettingsInput; origins: Record<SettingKey, SettingOrigin>; activeRevision: string | null; effective: Options | null; catalog: CatalogModel[]; issues: SetupIssue[]; serviceVersion: string }
export type SetupPreview = { groups: { selectors: string[]; candidates: Candidate[] }[]; issues: SetupIssue[] }
export type SaveInput = { revision: string; fields: SettingsInput; removeModels?: true; reset?: SettingKey[]; contextFile?: "managed" | "none" }
// Defined here because this module also runs in the window, which must not reach context-file.ts and its node:fs imports.
export type ContextFileState = "ok" | "empty" | "missing" | "too_large" | "invalid" | "unreadable"
// path is the stored value for display; absolute is the server-resolved path for Open and Show.
export type ContextFileStatus = { set: false } | { set: true; path: string; absolute: string; managed: boolean; state: ContextFileState; bytes?: number }
export type SaveResult = { kind: "saved"; revision: string; serviceVersion: string } | { kind: "saved_not_active"; revision: string; message: string } | { kind: "invalid"; issues: SetupIssue[] } | { kind: "conflict" | "read_only" | "failed"; message: string }
// "unsupported" means the server predates contextFileStatus; "unavailable" means the status could not be read right now.
export type ContextStatusResult = ContextFileStatus | "unsupported" | "unavailable"
export type SetupAPI = {
  read(signal: AbortSignal): Promise<SetupSnapshot>
  preview(fields: SettingsInput, signal: AbortSignal): Promise<SetupPreview>
  save(input: SaveInput, signal: AbortSignal): Promise<SaveResult>
  contextStatus?(signal: AbortSignal): Promise<ContextStatusResult>
  dispose?(): void
}
export type SetupState = { snapshot?: SetupSnapshot; fields: SettingsInput; reset: SettingKey[]; origins: Record<SettingKey, SettingOrigin>; groups?: string[][]; issues: SetupIssue[]; preview?: SetupPreview; dirty: boolean; loading: boolean; previewing: boolean; saving: boolean; lastSave?: SaveResult; error?: string; previewError?: string; blocked: boolean; context?: ContextStatusResult; contextLoading: boolean; contextChange?: "managed" | "none" }
export type SetupEditor = ReturnType<typeof createSetupEditor>

export async function waitForSetupSnapshot(read: SetupAPI["read"], signal: AbortSignal): Promise<SetupSnapshot> {
  const waiting = AbortSignal.any([signal, AbortSignal.timeout(2000)])
  for (;;) {
    try { return await abortable(() => read(waiting), waiting) }
    catch (error) {
      waiting.throwIfAborted()
      if (!error || typeof error !== "object" || !("type" in error) || error.type !== "rpc.unavailable") throw error
      await abortable(() => new Promise<void>(resolve => setTimeout(resolve, 100)), waiting)
    }
  }
}

// Old servers answer method_not_found, so that is "unsupported", not a retry; rpc.unavailable retries until the deadline like the snapshot read.
export async function readContextStatus(read: (signal: AbortSignal) => Promise<ContextFileStatus>, signal: AbortSignal): Promise<ContextStatusResult> {
  const waiting = AbortSignal.any([signal, AbortSignal.timeout(2000)])
  for (;;) {
    try { return await abortable(() => read(waiting), waiting) }
    catch (error) {
      signal.throwIfAborted()
      if (waiting.aborted) return "unavailable"
      const type = error && typeof error === "object" && "type" in error ? error.type : undefined
      if (type === "rpc.method_not_found") return "unsupported"
      if (type !== "rpc.unavailable") return "unavailable"
      await abortable(() => new Promise<void>(resolve => setTimeout(resolve, 100)), waiting).catch(() => {})
    }
  }
}

export function validateSettings(fields: SettingsInput, contextFile?: unknown): SetupIssue[] {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Settings must be an object.")
  if (Object.keys(fields).some(key => !(settingKeys as readonly string[]).includes(key))) throw new Error("Unknown setting.")
  for (const field of ["timeoutMs", "contextTurns"] as const) {
    if (fields[field] === null) return [{ field, severity: "error", code: "invalid_value", message: "Enter a whole number." }]
  }
  const parsed = parseOptions({ ...fields, contextFile })
  if (parsed.ok) return []
  const contextIssue = parsed.reason.startsWith("contextFile")
  return [{ field: contextIssue ? "contextFile" : settingKeys.find(key => parsed.reason.startsWith(key)) ?? "models", severity: "error", code: "invalid_value", message: parsed.reason + (contextIssue ? ". Correct it in predictions.json on the server." : "") }]
}

export function createSetupEditor(api: SetupAPI, changed: () => void) {
  const state: SetupState = { fields: {}, reset: [], origins: resolvePreferences({}).origins, issues: [], dirty: false, loading: false, previewing: false, saving: false, blocked: false, contextLoading: false }
  const lifetime = new AbortController()
  let generation = 0, contextRequest = 0, previewAbort: AbortController | undefined
  const notify = () => { if (!lifetime.signal.aborted) changed() }
  // A new draft state invites a fresh preview, so a failure from an earlier one must not stay on screen.
  const resetPreview = () => { generation++; previewAbort?.abort(); state.preview = undefined; state.previewing = false; state.previewError = undefined }
  const groups = () => { try { state.groups = readGroups(state.fields) } catch { state.groups = undefined } }
  const update = () => {
    state.issues = validateSettings(state.fields)
    const snapshot = state.snapshot
    const edits = snapshot ? changedFields(snapshot.fields, state.fields) : {}
    state.dirty = !!snapshot && (state.reset.length > 0 || Object.keys(edits).length > 0 || state.contextChange !== undefined)
    if (snapshot) state.origins = Object.fromEntries(settingKeys.map(key => [key, state.reset.includes(key)
      ? "default"
      : Object.hasOwn(edits, key) ? "preferences" : snapshot.origins[key]])) as Record<SettingKey, SettingOrigin>
    groups(); notify()
  }
  // Show the active settings when the file is readable but cannot be saved here.
  const displayed = (snapshot: SetupSnapshot): SetupSnapshot => {
    const effective = snapshot.effective
    if (snapshot.writable || !effective) return snapshot
    const { models, contextFile: _contextFile, ...rest } = effective
    return { ...snapshot, fields: { ...rest, ...(models ? { models: models.map(group => group.split(",").map(selector => selector.trim())) } : {}) } as SettingsInput }
  }
  const adopt = (incoming: SetupSnapshot) => {
    const snapshot = displayed(incoming)
    state.snapshot = structuredClone(snapshot); state.fields = structuredClone(snapshot.fields)
    state.reset = []; state.origins = { ...snapshot.origins }
    state.issues = [...snapshot.issues]; state.dirty = false; groups()
  }
  const readback = async () => {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)])
    for (;;) {
      try { return await abortable(() => api.read(signal), signal) }
      catch {
        signal.throwIfAborted()
        await abortable(() => new Promise<void>(resolve => setTimeout(resolve, 100)), signal)
      }
    }
  }
  // One status read decides whether the stored path shows the requested action. A failed or unclear read does not confirm it.
  const contextConfirmed = async (change: "managed" | "none" | undefined): Promise<boolean> => {
    if (change === undefined) return true
    const read = api.contextStatus?.bind(api)
    if (!read) return false
    try {
      const status = await read(lifetime.signal)
      if (typeof status !== "object") return false
      return change === "managed" ? status.set && status.managed : !status.set
    } catch { return false }
  }
  // Only the newest request may write its reply, so a slow older status cannot replace a newer one.
  const refreshContext = async (): Promise<void> => {
    const request = ++contextRequest
    const read = api.contextStatus?.bind(api)
    // A missing method is not an old server: "unsupported" is reserved for the explicit method_not_found reply.
    if (!read) { state.context = "unavailable"; state.contextLoading = false; notify(); return }
    state.contextLoading = true; notify()
    try {
      const status = await abortable(() => read(lifetime.signal), lifetime.signal)
      if (request === contextRequest && !lifetime.signal.aborted) {
        state.context = status
        // An old server cannot apply a staged file action, so the staged change is dropped instead of sent.
        if (status === "unsupported" && state.contextChange !== undefined) { state.contextChange = undefined; update() }
      }
    } catch { if (request === contextRequest && !lifetime.signal.aborted) state.context = "unavailable" }
    finally { if (request === contextRequest) { state.contextLoading = false; notify() } }
  }
  return {
    state: (): Readonly<SetupState> => state,
    refreshContext,
    setContextFile(change: "managed" | "none" | undefined) {
      if (lifetime.signal.aborted || state.loading || state.saving) return
      // Clearing needs no status, so Undo keeps working when the status later turns unknown.
      if (change !== undefined && (!state.snapshot?.writable || typeof state.context !== "object")) return
      state.contextChange = change; state.lastSave = undefined; update()
    },
    async load() {
      if (lifetime.signal.aborted || state.saving) return
      resetPreview()
      const revision = generation
      state.loading = true; state.error = undefined; state.contextChange = undefined; update()
      const context = refreshContext()
      try {
        const snapshot = await abortable(() => api.read(lifetime.signal), lifetime.signal)
        if (revision !== generation || lifetime.signal.aborted) return
        adopt(snapshot); state.blocked = false; state.lastSave = undefined
      } catch { if (revision === generation && !lifetime.signal.aborted) state.error = "Settings are unavailable. Reopen settings to try again." }
      finally { if (revision === generation) { state.loading = false; notify() } }
      await context
    },
    change(fields: SettingsInput) {
      if (lifetime.signal.aborted || state.loading || state.saving || !state.snapshot) return
      validateSettings(fields)
      state.reset = state.reset.filter(key => !Object.hasOwn(fields, key))
      resetPreview(); state.fields = { ...state.fields, ...structuredClone(fields) }; state.lastSave = undefined; update()
    },
    resetPreferences() {
      if (lifetime.signal.aborted || state.loading || state.saving || !state.snapshot?.writable) return
      resetPreview()
      state.fields = {}
      state.reset = settingKeys.filter(key => Object.hasOwn(state.snapshot!.overrides, key))
      state.lastSave = undefined
      update()
    },
    setGroups(value: string[][] | undefined) { this.change(patchGroups(value)) },
    async preview() {
      if (lifetime.signal.aborted || state.saving || !state.snapshot) return
      resetPreview()
      const revision = generation
      const abort = new AbortController()
      previewAbort = abort
      const signal = AbortSignal.any([abort.signal, lifetime.signal])
      state.previewing = true; state.previewError = undefined; notify()
      try {
        const result = await abortable(() => api.preview(structuredClone(state.fields), signal), signal)
        if (revision !== generation || signal.aborted) return
        state.preview = result; state.issues = result.issues
      } catch { if (revision === generation && !signal.aborted) state.previewError = "Model preview is unavailable." }
      finally { if (revision === generation) { state.previewing = false; notify() } }
    },
    async save(): Promise<SaveResult> {
      const failed = (message: string): SaveResult => ({ kind: "failed", message })
      if (lifetime.signal.aborted || state.loading || state.saving || !state.snapshot) return failed("Settings are unavailable.")
      if (state.blocked) {
        // change() clears the last result, so say why Save does nothing instead of returning silently.
        state.lastSave = failed("Reload settings before trying again. Reloading discards your unsaved changes."); notify()
        return state.lastSave
      }
      const issues = validateSettings(state.fields)
      if (issues.length) { state.issues = issues; notify(); return { kind: "invalid", issues } }
      if (!state.dirty) return failed("No changes to save.")
      if (!state.snapshot.writable) return { kind: "read_only", message: state.snapshot.reason ?? "This configuration is read-only." }
      // Without a known status the server cannot be trusted to apply a file action: refuse locally and keep the change for Undo.
      if (state.contextChange !== undefined && typeof state.context !== "object") {
        const refused: SaveResult = { kind: "invalid", issues: [{ field: "contextFile", severity: "error", code: "context_status_unavailable", message: "Context file status is unavailable right now." }] }
        state.lastSave = refused; notify()
        return refused
      }
      resetPreview()
      const before = state.snapshot
      const expected = structuredClone(state.fields)
      const patch = changedFields(before.fields, expected)
      for (const key of state.reset) delete patch[key]
      const removeModels = Object.hasOwn(patch, "models") && patch.models === undefined
      if (removeModels) delete patch.models
      const contextFile = state.contextChange
      const input: SaveInput = { revision: before.revision, fields: patch, ...(removeModels ? { removeModels: true } : {}), ...(state.reset.length ? { reset: [...state.reset] } : {}), ...(contextFile ? { contextFile } : {}) }
      // contextFile is a file action, not a preference: only the stores apply it.
      const { revision: _revision, contextFile: _contextFile, ...change } = input
      const overrides = applyPreferenceChange(before.overrides, change)
      state.saving = true; state.error = undefined; notify()
      let result: SaveResult | undefined
      try {
        try {
          result = await abortable(() => api.save(input, lifetime.signal), lifetime.signal)
        } catch { /* A lost reply is not proof that the write failed. Read back; never repeat it. */ }
        if (result?.kind === "saved") result = { kind: "saved_not_active", revision: result.revision, message: "Saved on disk. Effective activation is not verified." }
        // The server's own durable acknowledgment: a later unconfirmed context status must not erase it.
        const acknowledged = result?.kind === "saved_not_active"
        if (lifetime.signal.aborted) return failed("Settings editor closed.")
        if (!result || result.kind === "saved_not_active" || result.kind === "failed") {
          try {
            const fresh = await readback()
            lifetime.signal.throwIfAborted()
            const fieldsMatch = settingKeys.every(key => JSON.stringify(fresh.fields[key]) === JSON.stringify(expected[key]))
            const overridesMatch = settingKeys.every(key => Object.hasOwn(fresh.overrides, key) === Object.hasOwn(overrides, key) && JSON.stringify(fresh.overrides[key]) === JSON.stringify(overrides[key]))
            // Administrative read-only snapshots can mask preferences, so they cannot prove a lost reset committed.
            if (fresh.writable && fresh.source === before.source && fresh.revision !== before.revision && fieldsMatch && overridesMatch) {
              // An unrelated writer can change the revision while the fields still match, so a staged context action needs its own proof.
              // Without that proof, only a lost or failed reply becomes uncertain; a durable acknowledgment is kept and the draft stays blocked.
              if (!await contextConfirmed(contextFile)) { if (!acknowledged) result = undefined }
              else {
                const parsed = parseOptions(expected)
                const active = parsed.ok && !!fresh.effective && fresh.activeRevision === fresh.revision && settingKeys.every(key => JSON.stringify(fresh.effective![key]) === JSON.stringify(parsed.value[key]))
                result = active ? { kind: "saved", revision: fresh.revision, serviceVersion: fresh.serviceVersion }
                  : { kind: "saved_not_active", revision: fresh.revision, message: "Saved on disk. Effective activation is not verified." }
                adopt(fresh)
                state.contextChange = undefined; void refreshContext()
              }
            }
          } catch { /* Retain the draft and any durable acknowledgement when readback is unavailable. */ }
        }
        if (lifetime.signal.aborted) return failed("Settings editor closed.")
        result ??= failed("Changes may have been saved. Reopen settings before trying again.")
        if (state.dirty && result.kind !== "invalid") state.blocked = true
        state.lastSave = result
        if (result.kind === "invalid") state.issues = result.issues
        return result
      } finally { if (!lifetime.signal.aborted) { state.saving = false; notify() } }
    },
    discard() { if (!lifetime.signal.aborted && !state.saving && state.snapshot) { resetPreview(); state.contextChange = undefined; adopt(state.snapshot); notify() } },
    dispose() { lifetime.abort(); previewAbort?.abort(); generation++; api.dispose?.() },
  }
}

// A selector names a catalog model only when its base is exactly that model's provider/id; anything else is edited as a pattern.
export function parseSelector(selector: string, catalog: readonly CatalogModel[]): { kind: "model"; model: CatalogModel; variant?: string } | { kind: "pattern" } {
  const hash = selector.indexOf("#")
  const base = hash < 0 ? selector : selector.slice(0, hash)
  const model = catalog.find(item => item.providerID + "/" + item.id === base)
  return model ? { kind: "model", model, variant: hash < 0 ? undefined : selector.slice(hash + 1) } : { kind: "pattern" }
}

export function readGroups(fields: SettingsInput): string[][] | undefined {
  if (fields.models === undefined) return undefined
  const parsed = parseOptions({ models: fields.models })
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.value.models!.map(group => group.split(",").map(entry => entry.trim()))
}
export function patchGroups(groups: string[][] | undefined): SettingsInput {
  return { models: groups?.length ? groups.map(group => [...group]) : undefined }
}
export function changedFields(original: SettingsInput, draft: SettingsInput): SettingsInput {
  return Object.fromEntries(settingKeys.filter(key => Object.hasOwn(draft, key) && JSON.stringify(original[key]) !== JSON.stringify(draft[key])).map(key => [key, draft[key]]))
}

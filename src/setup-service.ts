import { expandContextPath, sameContextPath, type PreferencesStore } from "./preferences-store.ts"
import type { PreferencesRuntime } from "./preferences-runtime.ts"
import { applyPreferenceChange, resolvePreferences } from "./preferences.ts"
import { isDeepStrictEqual } from "node:util"
import { resolveModels, resolveModelGroups, type CatalogModel, type Candidate } from "./models.ts"
import { parseOptions } from "./options.ts"
import { inspectContextFile } from "./context-file.ts"
import { abortable } from "./service.ts"
import { readGroups, validateSettings as validation, type ContextFileStatus, type SaveInput, type SaveResult, type SettingsInput, type SetupSnapshot, type SetupPreview } from "./setup.ts"

// Server-fixed managed path and the host facts needed to resolve a stored context path. Clients never supply these.
export type ContextPaths = { managed: () => { stored: string; absolute: string }; home: string; platform: NodeJS.Platform }

function resolve(fields: SettingsInput, catalog: readonly CatalogModel[]): SetupPreview {
  const issues = validation(fields)
  if (issues.length) return { groups: [], issues }
  const selectors = readGroups(fields) ?? []
  const candidates = resolveModelGroups(selectors.map(group => group.join(", ")), catalog)
  const allModels = catalog.map(model => ({ ...model, enabled: true }))
  const owners = new Map<string, number>()
  const key = (model: Candidate) => JSON.stringify([model.providerID, model.id, model.variant ?? null])
  for (const [group, entries] of selectors.entries()) {
    for (const [entry, text] of entries.entries()) {
      const add = (code: string, message: string) => issues.push({ field: "models", group, entry, severity: "warning", code, message })
      const [selector, variant] = text.split("#")
      const base = resolveModels(selector, allModels)
      const possible = resolveModels(text, allModels)
      const available = resolveModels(text, catalog)
      if (!base.length) add("no_match", "No current models match this selector.")
      else {
        if (variant !== undefined && possible.length < base.length) add("unsupported_variant", "Some matching models do not support this reasoning variant.")
        if (available.length < possible.length) add("disabled_model", "Some matching models are currently disabled.")
      }
      const previous = [...new Set(available.flatMap(model => owners.has(key(model)) ? [owners.get(key(model))!] : []))].sort((a, b) => a - b)
      if (previous.length) add("overlap", `Models matched here are already tried in ${previous.length === 1 ? "Group" : "Groups"} ${previous.map(index => index + 1).join(", ")}, so they are not repeated.`)
    }
    for (const model of candidates[group]) owners.set(key(model), group)
  }
  return { groups: selectors.map((entries, index) => ({ selectors: entries, candidates: candidates[index] })), issues }
}

export function createSetupService(store: PreferencesStore, models: (signal: AbortSignal) => Promise<readonly CatalogModel[]>, runtime: PreferencesRuntime, paths: ContextPaths) {
  async function catalog(signal: AbortSignal): Promise<CatalogModel[]> {
    try {
      return (await abortable(() => models(signal), signal)).map(model => ({
        providerID: model.providerID, id: model.id, ...(model.name === undefined ? {} : { name: model.name }),
        enabled: model.enabled, variants: model.variants.map(variant => ({ id: variant.id })),
      }))
    } catch {
      signal.throwIfAborted()
      throw new Error("Model metadata is unavailable.")
    }
  }
  return {
    async read(signal: AbortSignal): Promise<SetupSnapshot> {
      await runtime.refresh(signal)
      const metadata = await catalog(signal)
      const state = runtime.state(), { stored, resolved } = state, parsed = parseOptions(resolved.rawOptions)
      return {
        revision: state.revision, source: stored.source, scope: "global", writable: stored.writable,
        ...(stored.reason ? { reason: stored.reason } : {}), fields: resolved.fields,
        overrides: stored.overrides, origins: resolved.origins, activeRevision: state.activeRevision,
        effective: state.activeRevision && parsed.ok ? parsed.value : null, catalog: metadata,
        issues: [...resolved.issues, ...resolve(resolved.fields, metadata).issues.filter(issue => !resolved.issues.some(existing => existing.field === issue.field))],
        serviceVersion: state.service.status().version,
      }
    },
    async preview(fields: SettingsInput, signal: AbortSignal): Promise<SetupPreview> {
      signal.throwIfAborted()
      const issues = validation(fields)
      if (issues.length) return { groups: [], issues }
      return resolve(fields, await catalog(signal))
    },
    async contextStatus(signal: AbortSignal): Promise<ContextFileStatus> {
      await runtime.refresh(signal)
      const stored = runtime.state().stored
      // An unverified document carries no context path, so absence here is unknown, not "not set". The clients show the failure as unavailable.
      if (!stored.documentValid) throw new Error("Context file status is unavailable.")
      const value = stored.contextFile
      if (value === undefined) return { set: false }
      if (typeof value !== "string" || !parseOptions({ contextFile: value }).ok) return { set: true, path: String(value), absolute: "", managed: false, state: "unreadable" }
      const absolute = expandContextPath(value, paths.home)
      const info = await inspectContextFile(absolute, signal)
      const managed = sameContextPath(absolute, paths.managed().absolute, paths.platform)
      return { set: true, path: value, absolute, managed, state: info.state, ...(info.bytes === undefined ? {} : { bytes: info.bytes }) }
    },
    async save(input: SaveInput, signal: AbortSignal): Promise<SaveResult> {
      signal.throwIfAborted()
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["revision", "fields", "removeModels", "reset", "contextFile"].includes(key))) throw new Error("Unknown save field.")
      if (typeof input.revision !== "string" || !input.revision || Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error("Invalid save input.")
      // Presence, not value, decides: a present undefined is still a choice, and only managed or none may appear.
      if (Object.hasOwn(input, "contextFile") && input.contextFile !== "managed" && input.contextFile !== "none") throw new Error("Invalid save input.")
      const invalid = validation(input.fields)
      if (invalid.length) return { kind: "invalid", issues: invalid }
      const { revision: _revision, contextFile, ...change } = input
      const edits = applyPreferenceChange({}, change)
      await runtime.refresh(signal)
      const fresh = runtime.state()
      if (!fresh.stored.writable) return { kind: "read_only", message: fresh.stored.reason ?? "Prediction preferences are read-only." }
      if (fresh.revision !== input.revision) return { kind: "conflict", message: "Configuration changed. Reload settings before trying again." }
      const prospective = { ...fresh.stored.overrides, ...edits }
      for (const key of input.reset ?? []) delete prospective[key]
      // The context path this save will leave stored: "none" clears it, "managed" sets the fixed path, otherwise it is unchanged.
      const context = contextFile === "managed" ? paths.managed().stored : contextFile === "none" ? undefined : fresh.stored.contextFile
      const issues = resolvePreferences(prospective, context).issues
      if (issues.length) return { kind: "invalid", issues }
      let written = fresh.stored.revision
      if (contextFile !== undefined || !isDeepStrictEqual(prospective, fresh.stored.overrides)) {
        const fields = Object.fromEntries(Object.entries(input.fields).filter(([key, value]) => !Object.hasOwn(fresh.stored.overrides, key) || !isDeepStrictEqual(value, fresh.stored.overrides[key as keyof SettingsInput])))
        const result = await store.write(fresh.stored.revision, { fields, ...(input.reset ? { reset: input.reset } : {}), ...(input.removeModels ? { removeModels: true } : {}), ...(contextFile === undefined ? {} : { contextFile }) }, signal)
        if (result.kind === "refused_context") return { kind: "invalid", issues: [{ field: "contextFile", severity: "error", code: "unsafe_context_file", message: result.message }] }
        if (result.kind !== "written") return result
        written = result.revision
      }
      try { await runtime.refresh(signal) } catch {
        signal.throwIfAborted()
        return { kind: "saved_not_active", revision: fresh.revision, message: "Saved on disk. Effective activation is not verified." }
      }
      const state = runtime.state()
      if (state.stored.revision === written && state.activeRevision === state.revision && isDeepStrictEqual(state.stored.overrides, prospective) && isDeepStrictEqual(state.stored.contextFile, context)) {
        return { kind: "saved", revision: state.revision, serviceVersion: state.service.status().version }
      }
      return { kind: "saved_not_active", revision: state.revision, message: "Saved on disk. Effective activation is not verified." }
    },
  }
}

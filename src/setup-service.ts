import type { ConfigStore } from "./config.ts"
import { resolveModels, resolveModelGroups, type CatalogModel, type Candidate } from "./models.ts"
import { parseOptions } from "./options.ts"
import { abortable } from "./service.ts"
import { readGroups, changedFields, settingKeys, validateSettings as validation, type SaveInput, type SaveResult, type SettingsInput, type SetupIssue, type SetupSnapshot, type SetupPreview } from "./setup.ts"

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
      if (previous.length) add("overlap", `Matches already belong to ${previous.length === 1 ? "Group" : "Groups"} ${previous.map(index => index + 1).join(", ")}.`)
    }
    for (const model of candidates[group]) owners.set(key(model), group)
  }
  return { groups: selectors.map((entries, index) => ({ selectors: entries, candidates: candidates[index] })), issues }
}

export function createSetupService(store: ConfigStore, models: (signal: AbortSignal) => Promise<readonly CatalogModel[]>, current: () => { options: unknown; version: string }) {
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
      const snapshot = await store.read(signal)
      const metadata = await catalog(signal)
      const state = current(), parsed = parseOptions(state.options)
      return { ...snapshot, effective: parsed.ok ? parsed.value : null, catalog: metadata, issues: resolve(snapshot.fields, metadata).issues, serviceVersion: state.version }
    },
    async preview(fields: SettingsInput, signal: AbortSignal): Promise<SetupPreview> {
      signal.throwIfAborted()
      const issues = validation(fields)
      if (issues.length) return { groups: [], issues }
      return resolve(fields, await catalog(signal))
    },
    async save(input: SaveInput, signal: AbortSignal): Promise<SaveResult> {
      signal.throwIfAborted()
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["revision", "fields", "removeModels"].includes(key))) throw new Error("Unknown save field.")
      if (typeof input.revision !== "string" || !input.revision || (input.removeModels !== undefined && input.removeModels !== true)) throw new Error("Invalid save input.")
      const invalid = validation(input.fields)
      if (invalid.length) return { kind: "invalid", issues: invalid }
      if (input.removeModels && Object.hasOwn(input.fields, "models")) throw new Error("Conflicting model edits.")
      const fresh = await store.read(signal)
      if (!fresh.writable) return { kind: "read_only", message: fresh.reason ?? "This configuration is read-only." }
      if (fresh.revision !== input.revision) return { kind: "conflict", message: "Configuration changed. Reload settings before trying again." }
      const prospective = { ...fresh.fields, ...input.fields, ...(input.removeModels ? { models: undefined } : {}) }
      const issues = validation(prospective)
      if (issues.length) return { kind: "invalid", issues }
      const patch = changedFields(fresh.fields, prospective)
      if (!Object.keys(patch).length) return { kind: "saved", revision: fresh.revision, serviceVersion: current().version }
      const before = current().version
      const result = await store.write(input.revision, patch, signal)
      if (result.kind !== "written") return result
      const state = current(), parsed = parseOptions(state.options), expected = parseOptions(prospective)
      if (state.version !== before && parsed.ok && expected.ok && settingKeys.every(key => JSON.stringify(parsed.value[key]) === JSON.stringify(expected.value[key]))) {
        return { kind: "saved", revision: result.revision, serviceVersion: state.version }
      }
      return { kind: "saved_not_active", revision: result.revision, message: "Saved on disk. Effective activation is not verified." }
    },
  }
}

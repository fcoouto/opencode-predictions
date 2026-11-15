import type { ConfigStore } from "./config.ts"
import { resolveModels, resolveModelGroups, type CatalogModel, type Candidate } from "./models.ts"
import { parseOptions } from "./options.ts"
import { abortable } from "./service.ts"
import { readGroups, settingKeys, type SettingsInput, type SetupIssue, type SetupSnapshot, type SetupPreview } from "./setup.ts"

function validation(fields: SettingsInput): SetupIssue[] {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Settings must be an object.")
  if (Object.keys(fields).some(key => !(settingKeys as readonly string[]).includes(key))) throw new Error("Unknown setting.")
  for (const field of ["timeoutMs", "contextTurns"] as const) {
    if (fields[field] === null) return [{ field, severity: "error", code: "invalid_value", message: "Enter a whole number." }]
  }
  const parsed = parseOptions(fields)
  return parsed.ok ? [] : [{ field: settingKeys.find(key => parsed.reason.startsWith(key)) ?? "models", severity: "error", code: "invalid_value", message: parsed.reason }]
}

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
  }
}

import { parseTree, type Node, type ParseError } from "jsonc-parser"
import { settingKeys, validateSettings, type SaveInput, type SettingsInput, type SettingKey, type SettingOrigin, type SetupIssue } from "./setup.ts"

export type PreferenceDocument = { version: 1; settings: Record<string, unknown>; [key: string]: unknown }
export type ResolvedPreferences = { rawOptions: SettingsInput & { contextFile?: unknown }; fields: SettingsInput; origins: Record<SettingKey, SettingOrigin>; issues: SetupIssue[] }

export function parsePreferences(text: string): PreferenceDocument {
  const invalid = () => new Error("Prediction preferences must be a version 1 JSON document with a settings object.")
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false })
  if (!root || root.type !== "object" || errors.length) throw invalid()
  function unique(node: Node) {
    if (node.type === "object") {
      const names = node.children!.map(property => property.children![0].value)
      if (new Set(names).size !== names.length) throw invalid()
    }
    node.children?.forEach(unique)
  }
  unique(root)
  const value = JSON.parse(text)
  if (value.version !== 1 || !value.settings || typeof value.settings !== "object" || Array.isArray(value.settings)) throw invalid()
  return value
}

export function preferenceFields(value: Record<string, unknown>): SettingsInput {
  return Object.fromEntries(settingKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
}

export function validatePreferenceFields(overrides: SettingsInput): SetupIssue[] {
  const fields = preferenceFields(overrides)
  if (fields.models === null) delete fields.models
  return validateSettings(fields)
}

export function applyPreferenceChange(overrides: Record<string, unknown>, input: Omit<SaveInput, "revision">): Record<string, unknown> {
  const invalid = () => new Error("Prediction preference changes are invalid.")
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["fields", "reset", "removeModels"].includes(key))
    || !input.fields || typeof input.fields !== "object" || Array.isArray(input.fields)
    || Object.entries(input.fields).some(([key, value]) => !settingKeys.includes(key as SettingKey) || value === undefined)
    || input.removeModels !== undefined && input.removeModels !== true
    || input.removeModels && Object.hasOwn(input.fields, "models")
    || input.reset !== undefined && (!Array.isArray(input.reset) || new Set(input.reset).size !== input.reset.length
      || input.reset.some(key => !settingKeys.includes(key) || Object.hasOwn(input.fields, key) || key === "models" && input.removeModels))
    || validateSettings(input.fields).length) throw invalid()
  const next = { ...overrides, ...input.fields }
  for (const key of input.reset ?? []) delete next[key]
  if (input.removeModels) next.models = null
  if (validatePreferenceFields(next).length) throw invalid()
  return next
}

export function resolvePreferences(overrides: SettingsInput, contextFile?: unknown): ResolvedPreferences {
  const fields = preferenceFields(overrides)
  if (fields.models === null) delete fields.models
  const rawOptions = { ...fields, ...(contextFile === undefined ? {} : { contextFile }) }
  const origins = Object.fromEntries(settingKeys.map(key => [key, Object.hasOwn(overrides, key) ? "preferences" : "default"])) as Record<SettingKey, SettingOrigin>
  return { rawOptions, fields, origins, issues: validateSettings(fields, contextFile) }
}

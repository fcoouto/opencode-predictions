import { parseTree, type Node, type ParseError } from "jsonc-parser"
import { settingKeys, validateSettings, type SettingsInput, type SettingKey, type SettingOrigin, type SetupIssue } from "./setup.ts"

export type PreferenceDocument = { version: 1; settings: Record<string, unknown>; [key: string]: unknown }
export type ResolvedPreferences = { rawOptions: unknown; fields: SettingsInput; fallbackFields: SettingsInput; origins: Record<SettingKey, SettingOrigin>; issues: SetupIssue[] }

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

export function resolvePreferences(legacy: unknown, overrides: SettingsInput): ResolvedPreferences {
  const valid = !!legacy && typeof legacy === "object" && !Array.isArray(legacy)
  const base = valid ? legacy as Record<string, unknown> : {}
  const fallbackFields = preferenceFields(base)
  // Legacy numeric nulls already mean defaults; only explicit preference nulls are invalid.
  for (const key of ["timeoutMs", "contextTurns"] as const) if (fallbackFields[key] === null) delete fallbackFields[key]
  const known = preferenceFields(overrides)
  const fields = { ...fallbackFields, ...known }
  const rawOptions = valid ? { ...base, ...known } : legacy
  if (known.models === null) { delete fields.models; if (rawOptions && typeof rawOptions === "object") delete (rawOptions as Record<string, unknown>).models }
  const origins = Object.fromEntries(settingKeys.map(key => [key, Object.hasOwn(known, key) ? "preferences" : Object.hasOwn(fallbackFields, key) ? "configuration" : "default"])) as Record<SettingKey, SettingOrigin>
  return { rawOptions, fields, fallbackFields, origins, issues: validatePreferenceFields(known) }
}

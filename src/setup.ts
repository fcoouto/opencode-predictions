import { parseOptions, type Options } from "./options.ts"
import type { Candidate, CatalogModel } from "./models.ts"

export const settingKeys = ["models", "enabled", "automatic", "escalation", "timeoutMs", "contextTurns", "debug"] as const
export type SettingKey = typeof settingKeys[number]
export type SettingsInput = Partial<Record<SettingKey, unknown>>
export type ConfigSnapshot = { revision: string; source?: string; scope: "global"; writable: boolean; reason?: string; fields: SettingsInput }
export type SetupIssue = { field: SettingKey; group?: number; entry?: number; severity: "error" | "warning"; code: string; message: string }
export type SetupSnapshot = ConfigSnapshot & { effective: Options | null; catalog: CatalogModel[]; issues: SetupIssue[]; serviceVersion: string }
export type SetupPreview = { groups: { selectors: string[]; candidates: Candidate[] }[]; issues: SetupIssue[] }

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

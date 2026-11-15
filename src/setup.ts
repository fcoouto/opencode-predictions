export type SettingKey = "models" | "enabled" | "automatic" | "escalation" | "timeoutMs" | "contextTurns" | "debug"
export type SettingsInput = Partial<Record<SettingKey, unknown>>
export type ConfigSnapshot = { revision: string; source?: string; scope: "global"; writable: boolean; reason?: string; fields: SettingsInput }

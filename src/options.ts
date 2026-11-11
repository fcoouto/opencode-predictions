export type ModelRef = { providerID: string; id: string; variant?: string }
export type Options = { enabled: boolean; models?: string; timeoutMs: number; contextTurns: number; automatic: boolean }
export type OptionsResult = { ok: true; value: Options; warnings: string[] } | { ok: false; reason: string; warnings: string[] }

export function parseOptions(input: unknown = {}): OptionsResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "Plugin options must be an object", warnings: [] }
  const raw = input as Record<string, unknown>
  const fields = ["enabled", "models", "timeoutMs", "contextTurns", "automatic"]
  const warnings = Object.keys(raw).filter(key => !fields.includes(key)).map(key => `Unknown option ignored: ${key}`)
  const invalid = (reason: string): OptionsResult => ({ ok: false, reason, warnings })
  for (const name of ["enabled", "automatic"]) {
    if (raw[name] !== undefined && typeof raw[name] !== "boolean") return invalid(`${name} must be a boolean`)
  }
  const timeoutMs = raw.timeoutMs ?? 8000
  const contextTurns = raw.contextTurns ?? 3
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) return invalid("timeoutMs must be a positive integer within the timer limit")
  if (typeof contextTurns !== "number" || !Number.isInteger(contextTurns) || contextTurns < 1 || contextTurns > 5) return invalid("contextTurns must be an integer from 1 to 5")
  if (raw.models !== undefined) {
    if (typeof raw.models !== "string") return invalid("models must be a provider/model-pattern#variant text field")
    for (const entry of raw.models.split(",")) {
      const [selector, variant, extra] = entry.trim().split("#")
      const slash = selector.indexOf("/")
      if (slash <= 0 || !selector.slice(slash + 1).trim() || /\s/.test(selector.slice(0, slash)) || variant === "" || (variant !== undefined && /\s/.test(variant)) || extra !== undefined) return invalid("models must contain provider/model-pattern selectors with optional #variant")
    }
  }
  return { ok: true, value: { enabled: raw.enabled as boolean ?? true, ...(typeof raw.models === "string" ? { models: raw.models.trim() } : {}), timeoutMs, contextTurns, automatic: raw.automatic as boolean ?? true }, warnings }
}

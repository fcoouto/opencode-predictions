export type ModelRef = { providerID: string; id: string; variant?: string }
export type Options = { enabled: boolean; models?: readonly string[]; timeoutMs: number; contextTurns: number; automatic: boolean; debug: boolean }
export type OptionsResult = { ok: true; value: Options; warnings: string[] } | { ok: false; reason: string; warnings: string[] }

export function parseOptions(input: unknown = {}): OptionsResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "Plugin options must be an object", warnings: [] }
  const raw = input as Record<string, unknown>
  const fields = ["enabled", "models", "timeoutMs", "contextTurns", "automatic", "debug"]
  const warnings = Object.keys(raw).filter(key => !fields.includes(key)).map(key => `Unknown option ignored: ${key}`)
  const invalid = (reason: string): OptionsResult => ({ ok: false, reason, warnings })
  for (const name of ["enabled", "automatic", "debug"]) {
    if (raw[name] !== undefined && typeof raw[name] !== "boolean") return invalid(`${name} must be a boolean`)
  }
  const timeoutMs = raw.timeoutMs ?? 8000
  const contextTurns = raw.contextTurns ?? 3
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) return invalid("timeoutMs must be a positive integer within the timer limit")
  if (typeof contextTurns !== "number" || !Number.isInteger(contextTurns) || contextTurns < 1 || contextTurns > 5) return invalid("contextTurns must be an integer from 1 to 5")
  const models: string[] = []
  if (raw.models !== undefined) {
    const groups = typeof raw.models === "string" ? [raw.models] : raw.models
    if (!Array.isArray(groups) || !groups.length) return invalid("models must be selector text or a nonempty array of selector groups")
    for (const group of groups) {
      const selectors = typeof group === "string" ? [group] : group
      if (!Array.isArray(selectors) || !selectors.length || selectors.some(selector => typeof selector !== "string")) return invalid("each models group must be selector text or a nonempty array of selector text")
      const text = selectors.join(", ")
      for (const entry of text.split(",")) {
        const [selector, variant, extra] = entry.trim().split("#")
        const slash = selector.indexOf("/")
        if (slash <= 0 || !selector.slice(slash + 1).trim() || /\s/.test(selector.slice(0, slash)) || variant === "" || (variant !== undefined && /\s/.test(variant)) || extra !== undefined) return invalid("models must contain provider/model-pattern selectors with optional #variant")
      }
      models.push(text.trim())
    }
  }
  return { ok: true, value: { enabled: raw.enabled as boolean ?? true, ...(raw.models === undefined ? {} : { models }), timeoutMs, contextTurns, automatic: raw.automatic as boolean ?? true, debug: raw.debug as boolean ?? false }, warnings }
}

import { parseOptions, type ModelRef } from "./options.ts"
import { buildPrompt, collectTurns, parseSuggestion } from "./predict.ts"
import { resolveModels, type Candidate, type CatalogModel } from "./models.ts"
export type Request = { sessionID: string; completion: number; requestID?: string }
export type Reply = { text?: string; reason?: string }
export type Session = { id: string; parentID?: string; outcome?: string; time: { idle?: number; busy?: number }; location: { directory: string } }
export type ServiceAPI = {
  session(id: string, signal: AbortSignal): Promise<Session>
  context(id: string, signal: AbortSignal): Promise<readonly unknown[]>
  models(signal: AbortSignal): Promise<readonly CatalogModel[]>
  generate(model: ModelRef, prompt: string, signal: AbortSignal): Promise<string>
  notice?(message: string, request: Request): void | Promise<void>
}
export type Status = { enabled: boolean; models?: string; candidates?: Candidate[]; automatic: boolean; timeoutMs: number; contextTurns: number; version: string; warnings: string[]; reason?: string; lastOutcome?: string; lastLatencyMs?: number }

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  try {
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }) })
    return await Promise.race([work(), aborted])
  } finally { signal.removeEventListener("abort", onAbort) }
}

export function createService(api: ServiceAPI, rawOptions: unknown, directory: string) {
  const parsed = parseOptions(rawOptions)
  const options = parsed.ok ? parsed.value : undefined
  const version = crypto.randomUUID()
  let lastOutcome: string | undefined
  let lastLatencyMs: number | undefined
  let candidates: Candidate[] | undefined
  const status = (): Status => ({
    enabled: !!options?.enabled && !!options.models && (candidates === undefined || candidates.length > 0),
    ...(options?.models ? { models: options.models } : {}),
    ...(candidates ? { candidates } : {}),
    automatic: options?.automatic ?? true, timeoutMs: options?.timeoutMs ?? 8000, contextTurns: options?.contextTurns ?? 3,
    version, warnings: parsed.warnings,
    ...(!parsed.ok ? { reason: parsed.reason } : !options?.enabled ? { reason: "disabled" } : !options.models ? { reason: "models_required" } : candidates?.length === 0 ? { reason: "model_unavailable" } : {}),
    ...(lastOutcome ? { lastOutcome, lastLatencyMs } : {}),
  })
  const predict = async (request: Request, parent: AbortSignal): Promise<Reply> => {
    const started = performance.now()
    if (!options || !options.enabled || !options.models) return { reason: status().reason }
    const check = (session: Session): string | undefined => {
      if (session.id !== request.sessionID || session.time.idle !== request.completion || (session.time.busy ?? 0) > request.completion) return "stale"
      if (session.location.directory !== directory) return "wrong_location"
      if (session.parentID || session.outcome === "interrupted") return "context_unavailable"
    }
    try {
      parent.throwIfAborted()
      const work = async (): Promise<Reply> => {
        const session = await api.session(request.sessionID, parent)
        const reason = check(session)
        if (reason) return { reason }
        candidates = resolveModels(options.models!, await api.models(parent))
        if (!candidates.length) return { reason: "model_unavailable" }
        const messages = await api.context(request.sessionID, parent)
        const records = messages.map(value => value && typeof value === "object" ? value as { type?: string; status?: string; outcome?: string; time?: { completed?: unknown } } : {})
        const idle = records.findLastIndex(value => value.type === "idle")
        const start = records.slice(0, idle).findLastIndex(value => value.type === "idle" || (value.type === "compaction" && value.status !== "failed"))
        const response = records.slice(start + 1, idle).findLast(value => value.type === "assistant")
        if (idle < 0 || records[idle].outcome === "interrupted" || response?.time?.completed === undefined || records.slice(idle + 1).some(value => value.type === "user" || value.type === "assistant")) return { reason: "context_unavailable" }
        if (!collectTurns(messages.slice(start + 1, idle + 1)).length) return { reason: "context_unavailable" }
        const prompt = buildPrompt(collectTurns(messages), options.contextTurns)
        if (!prompt) return { reason: "context_unavailable" }
        const chain = candidates
        let failure = "generation_failed"
        for (let index = 0; index < chain.length; index++) {
          parent.throwIfAborted()
          const changed = check(await api.session(request.sessionID, parent))
          if (changed) return { reason: changed }
          const { name, ...model } = chain[index]
          const signal = AbortSignal.any([parent, AbortSignal.timeout(options.timeoutMs)])
          try {
            const output = await abortable(() => api.generate(model, prompt, signal), signal)
            parent.throwIfAborted()
            const changed = check(await api.session(request.sessionID, parent))
            if (changed) return { reason: changed }
            const text = parseSuggestion(output)
            if (text) return { text }
            if ((JSON.parse(output) as { prompt?: unknown } | null)?.prompt === null) return { reason: "no_suggestion" }
            throw new Error("Invalid prediction response")
          } catch {
            parent.throwIfAborted()
            failure = signal.aborted ? "timeout" : "generation_failed"
            const next = chain[index + 1]
            const message = next ? `Predictions failed with ${name}, moving on with ${next.name}...` : `Predictions failed with ${name}; no configured models remain.`
            await api.notice?.(message, request)
          }
        }
        return { reason: failure }
      }
      const reply = await abortable(work, parent)
      lastOutcome = reply.text ? "suggestion" : reply.reason
      return reply
    } catch {
      lastOutcome = parent.aborted ? "cancelled" : "generation_failed"
      return { reason: lastOutcome }
    } finally {
      lastLatencyMs = Math.round(performance.now() - started)
    }
  }
  const inspect = async (signal: AbortSignal): Promise<Status> => {
    if (options?.enabled && options.models) candidates = resolveModels(options.models, await api.models(signal))
    return status()
  }
  return { predict, status, inspect }
}

import { parseOptions, type ModelRef } from "./options.ts"
import { buildPrompt, collectTurns, parseSuggestion } from "./predict.ts"
import { resolveModels, type Candidate, type CatalogModel } from "./models.ts"
import { statusNotice, reasonNotice, pluginVersion, feedbackRevision, type Notice } from "./feedback.ts"
export type Request = { sessionID: string; completion: number; requestID?: string; manual?: boolean; escalation?: string }
export type EscalationOffer = { token: string; group: number; model: ModelRef; name: string }
export type Reply = { text?: string; reason?: string; notice?: Notice; escalation?: EscalationOffer }
export type Session = { id: string; parentID?: string; outcome?: string; time: { idle?: number; busy?: number; updated?: number }; location: { directory: string } }
export type ServiceAPI = {
  session(id: string, signal: AbortSignal): Promise<Session>
  context(id: string, signal: AbortSignal): Promise<readonly unknown[]>
  models(signal: AbortSignal): Promise<readonly CatalogModel[]>
  generate(model: ModelRef, prompt: string, signal: AbortSignal): Promise<string>
  notice?(message: string, request: Request, notice?: Notice): void | Promise<void>
}
export type QueueEntry = Candidate & { state: "ready" | "cooling" | "blocked"; reason?: string; retryAt?: number }
export type Status = { enabled: boolean; models?: string; candidates?: QueueEntry[]; groups?: { selectors: string; candidates: QueueEntry[] }[]; automatic: boolean; escalation?: "off" | "manual" | "automatic"; debug: boolean; timeoutMs: number; contextTurns: number; version: string; warnings: string[]; reason?: string; lastOutcome?: string; lastLatencyMs?: number; pluginVersion?: string; feedbackRevision?: number }

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  try {
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }) })
    return await Promise.race([work(), aborted])
  } finally { signal.removeEventListener("abort", onAbort) }
}

function failurePolicy(error: unknown): { detail: string; delayMs: number; modelWide: boolean } {
  const value = error && typeof error === "object" ? error as { status?: unknown; reason?: unknown; message?: unknown; _tag?: unknown; retryAfterMs?: unknown } : {}
  const message = typeof value.message === "string" ? value.message.slice(0, 1000) : ""
  const status = typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? value.status : undefined
  // Provider errors can echo credentials or conversation text; show only recognized, fixed summaries.
  const reasons: Record<string, string> = {
    authentication: "Provider authentication failed.",
    rate_limit: "Provider rate limit or usage quota reached.",
    content_filter: "Provider rejected the content.",
    invalid_request: "Provider rejected the request.",
    overloaded: "Provider is overloaded.",
    provider: "Provider request failed.",
  }
  const fallback = typeof value.reason === "string" && Object.hasOwn(reasons, value.reason) ? reasons[value.reason] : "Model request failed."
  const detail = status === 403 && /not available in your country/i.test(message) ? "This model is not available in your country."
    : status === 429 && /free usage limit reached/i.test(message) ? "Free usage limit reached."
    : message === "Invalid prediction response" ? "Model returned an invalid prediction response."
    : fallback
  const blocked = [401, 402, 403, 404].includes(status ?? 0) || value.reason === "authentication" || value._tag === "ModelNotFoundError" || value._tag === "ProviderNotFoundError" || value._tag === "UnsupportedModelError"
  const budget = value.reason !== "invalid_request" && value.reason !== "content_filter" && /\b(?:exhausted|exceeded|reached|depleted|insufficient)\b/i.test(message) && /\b(?:daily|monthly|budget|credits?)\b|\bfree usage\b|\binsufficient quota\b/i.test(message)
  const delay = typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs) && value.retryAfterMs > 0 ? Math.max(60000, value.retryAfterMs) : budget ? 3600000 : 60000
  return { detail: status === undefined ? detail : `HTTP ${status}: ${detail}`, delayMs: blocked ? Infinity : delay, modelWide: blocked || budget || status === 429 || value.reason === "rate_limit" }
}

export function createService(api: ServiceAPI, rawOptions: unknown, directory: string) {
  const parsed = parseOptions(rawOptions)
  const options = parsed.ok ? parsed.value : undefined
  const version = crypto.randomUUID()
  let lastOutcome: string | undefined
  let lastLatencyMs: number | undefined
  let groups: Candidate[][] | undefined
  const skipped = new Map<string, { until: number; reason: string }>()
  const outcomes = new Map<string, "working" | "failed">()
  const owners = new Map<string, { group: number }>()
  type Offer = { sessionID: string; completion: number; afterGroup: number; offer: EscalationOffer }
  const offers = new Map<string, Offer>()
  const modelKey = (model: ModelRef) => JSON.stringify([model.providerID, model.id])
  const candidateKey = (model: ModelRef) => JSON.stringify([model.providerID, model.id, model.variant ?? null])
  const outcomeKey = (model: ModelRef, group: number) => JSON.stringify([group, candidateKey(model)])
  const skip = (model: ModelRef) => {
    let active: { until: number; reason: string } | undefined
    for (const key of [modelKey(model), candidateKey(model)]) {
      const entry = skipped.get(key)
      if (entry && entry.until <= Date.now()) skipped.delete(key)
      else if (entry && (!active || entry.until > active.until)) active = entry
    }
    return active
  }
  const refresh = (catalog: readonly CatalogModel[]) => {
    const seen = new Set<string>()
    const currentOutcomes = new Set<string>()
    groups = options!.models!.map((selectors, index) => {
      const resolved = resolveModels(selectors, catalog).filter(model => {
        const key = candidateKey(model)
        if (seen.has(key)) return false
        seen.add(key)
        if (owners.get(key)?.group !== index) owners.set(key, { group: index })
        currentOutcomes.add(outcomeKey(model, index))
        return true
      })
      const available = new Map(resolved.map(model => [candidateKey(model), model]))
      const ordered: Candidate[] = []
      for (const previous of groups?.[index] ?? []) {
        const current = available.get(candidateKey(previous))
        if (current) ordered.push(current)
      }
      return [
        ...ordered.filter(model => outcomes.get(outcomeKey(model, index)) === "working"),
        ...resolved.filter(model => !outcomes.has(outcomeKey(model, index))),
        ...ordered.filter(model => outcomes.get(outcomeKey(model, index)) === "failed"),
      ]
    })
    const resolved = groups.flat()
    const keys = new Set(resolved.flatMap(model => [modelKey(model), candidateKey(model)]))
    for (const key of skipped.keys()) if (!keys.has(key)) skipped.delete(key)
    for (const key of outcomes.keys()) if (!currentOutcomes.has(key)) outcomes.delete(key)
    for (const key of owners.keys()) if (!seen.has(key)) owners.delete(key)
  }
  const move = (model: ModelRef, first: boolean, group: number, ownership: ReadonlyMap<string, { group: number }>, modelWide = false) => {
    // Owner records are replaced on transfer, including leave-and-return changes.
    if (owners.get(candidateKey(model)) !== ownership.get(candidateKey(model))) return
    const key = modelWide ? modelKey : candidateKey
    const matches = (candidate: Candidate) => key(candidate) === key(model) && owners.get(candidateKey(candidate)) === ownership.get(candidateKey(candidate))
    groups = groups?.map((queue, index) => {
      if (!modelWide && index !== group) return queue
      const selected = queue.filter(matches)
      const others = queue.filter(candidate => !matches(candidate))
      for (const candidate of selected) outcomes.set(outcomeKey(candidate, index), first ? "working" : "failed")
      return first ? [...selected, ...others] : [...others, ...selected]
    })
  }
  const queueEntry = (model: Candidate): QueueEntry => {
    const entry = skip(model)
    return entry ? { ...model, state: entry.until === Infinity ? "blocked" : "cooling", reason: entry.reason, ...(Number.isFinite(entry.until) ? { retryAt: entry.until } : {}) } : { ...model, state: "ready" }
  }
  const noSuggestion = (request: Request, afterGroup: number): Reply => {
    if (options?.escalation === "off") return { reason: "no_suggestion" }
    for (const [token, previous] of offers) if (previous.sessionID === request.sessionID) offers.delete(token)
    for (let group = afterGroup + 1; group < (groups?.length ?? 0); group++) {
      const candidate = groups![group].find(model => !skip(model))
      if (!candidate) continue
      const { name, ...model } = candidate
      const offer = { token: crypto.randomUUID(), group: group + 1, model, name }
      offers.set(offer.token, { sessionID: request.sessionID, completion: request.completion, afterGroup, offer })
      if (offers.size > 128) offers.delete(offers.keys().next().value!)
      return { reason: "no_suggestion", escalation: offer }
    }
    return { reason: "no_suggestion" }
  }
  const status = (): Status => {
    const candidates = groups?.flat()
    return {
      enabled: !!options?.enabled && !!options.models,
      ...(options?.models ? { models: options.models.join(", ") } : {}),
      ...(groups ? { groups: groups.map((queue, index) => ({ selectors: options!.models![index], candidates: queue.map(queueEntry) })), candidates: candidates!.map(queueEntry) } : {}),
      automatic: options?.automatic ?? true, debug: options?.debug ?? false, timeoutMs: options?.timeoutMs ?? 8000, contextTurns: options?.contextTurns ?? 3,
      escalation: options?.escalation ?? "off",
      version, warnings: parsed.warnings, pluginVersion, feedbackRevision,
      ...(!parsed.ok ? { reason: parsed.reason } : !options?.enabled ? { reason: "disabled" } : !options.models ? { reason: "models_required" } : candidates?.length === 0 ? { reason: "model_unavailable" } : candidates?.every(model => !!skip(model)) ? { reason: "no_models_eligible" } : {}),
      ...(lastOutcome ? { lastOutcome, lastLatencyMs } : {}),
    }
  }
  const predict = async (request: Request, parent: AbortSignal): Promise<Reply> => {
    const started = performance.now()
    if (!options || !options.enabled || !options.models) return { reason: status().reason, notice: statusNotice(status()) ?? reasonNotice(status().reason) }
    const caller = parent
    let deadline: AbortSignal | undefined
    const limitEscalation = () => { deadline = AbortSignal.timeout(options.timeoutMs); parent = AbortSignal.any([caller, deadline]) }
    let offered: Offer | undefined
    let extraCall = false
    if (request.escalation !== undefined) {
      offered = offers.get(request.escalation)
      if (!request.manual || options.escalation === "off" || !offered || offered.sessionID !== request.sessionID || offered.completion !== request.completion) return { reason: "escalation_unavailable" }
      offers.delete(request.escalation)
      extraCall = true
      limitEscalation()
    } else {
      for (const [token, previous] of offers) if (previous.sessionID === request.sessionID) offers.delete(token)
    }
    let configured: Candidate[] = []
    const check = (session: Session): string | undefined => {
      const completion = session.time.idle || (request.manual === true && !session.time.busy ? session.time.updated : undefined)
      if (session.id !== request.sessionID || completion !== request.completion || (session.time.busy ?? 0) > request.completion) return "stale"
      if (session.location.directory !== directory) return "wrong_location"
      if (session.parentID || session.outcome === "interrupted") return "context_unavailable"
    }
    try {
      parent.throwIfAborted()
      const work = async (): Promise<Reply> => {
        const session = await api.session(request.sessionID, parent)
        const reason = check(session)
        if (reason) return { reason }
        refresh(await api.models(parent))
        configured = groups!.flat()
        if (!configured.length) return { reason: "model_unavailable" }
        parent.throwIfAborted()
        if (configured.every(model => !!skip(model))) return { reason: "no_models_eligible" }
        const messages = [...await api.context(request.sessionID, parent)]
        const records = messages.map(value => value && typeof value === "object" ? value as { type?: string; status?: string; outcome?: string; finish?: string; content?: unknown; time?: { completed?: unknown } } : {})
        const last = records.findLast(value => value.type === "user" || value.type === "assistant" || value.type === "idle" || (value.type === "compaction" && value.status !== "failed"))
        if (request.manual === true && last?.type === "assistant" && last.time?.completed !== undefined) {
          const content = Array.isArray(last.content) ? last.content : []
          const start = records.findLastIndex(value => value.type === "user" || value.type === "idle" || (value.type === "compaction" && value.status !== "failed"))
          const pending = records.slice(start + 1).some(value => Array.isArray(value.content) && value.content.some(part => part?.type === "tool" && !["completed", "error"].includes(part.state?.status)))
          if (last.finish === "tool-calls" || pending || !content.some(part => part?.type === "text" && typeof part.text === "string" && part.text.trim())) return { reason: "context_unavailable" }
          // Historical completed turns may lack an idle record; close only this local copy.
          const boundary = { type: "idle", outcome: session.outcome }
          messages.push(boundary); records.push(boundary)
        }
        const idle = records.findLastIndex(value => value.type === "idle")
        const start = records.slice(0, idle).findLastIndex(value => value.type === "idle" || (value.type === "compaction" && value.status !== "failed"))
        const response = records.slice(start + 1, idle).findLast(value => value.type === "assistant")
        if (idle < 0 || records[idle].outcome === "interrupted" || response?.time?.completed === undefined || records.slice(idle + 1).some(value => value.type === "user" || value.type === "assistant")) return { reason: "context_unavailable" }
        if (!collectTurns(messages.slice(start + 1, idle + 1)).length) return { reason: "context_unavailable" }
        const prompt = buildPrompt(collectTurns(messages), options.contextTurns)
        if (!prompt) return { reason: "context_unavailable" }
        let chain = groups!.flatMap((queue, group) => queue.map(model => ({ ...model, group })))
        if (offered) {
          const target = chain.find(model => model.group + 1 === offered.offer.group && candidateKey(model) === candidateKey(offered.offer.model) && !skip(model))
          if (!target) return noSuggestion(request, offered.afterGroup)
          chain = [target]
        }
        const ownership = new Map(owners)
        let failure = "no_models_eligible"
        for (let index = 0; index < chain.length; index++) {
          parent.throwIfAborted()
          const changed = check(await abortable(() => api.session(request.sessionID, parent), parent))
          if (changed) return { reason: changed }
          parent.throwIfAborted()
          const candidate = chain[index]
          if (skip(candidate)) continue
          const { name, group, ...model } = candidate
          const signal = AbortSignal.any([parent, AbortSignal.timeout(options.timeoutMs)])
          let generating = true
          try {
            const output = await abortable(() => api.generate(model, prompt, signal), signal)
            generating = false
            parent.throwIfAborted()
            const changed = check(await abortable(() => api.session(request.sessionID, parent), parent))
            if (changed) return { reason: changed }
            parent.throwIfAborted()
            const text = parseSuggestion(output)
            if (text) { if (!skip(model)) move(model, true, group, ownership); return { text } }
            let abstained = false
            try { abstained = (JSON.parse(output) as { prompt?: unknown } | null)?.prompt === null } catch {}
            if (abstained) {
              if (!skip(model)) move(model, true, group, ownership)
              const next = options.escalation === "automatic" && !extraCall ? chain.findIndex(candidate => candidate.group > group && !skip(candidate)) : -1
              if (next !== -1) { extraCall = true; limitEscalation(); index = next - 1; continue }
              return noSuggestion(request, group)
            }
            throw new Error("Invalid prediction response")
          } catch (error) {
            const timedOut = signal.aborted
            if (!caller.aborted && deadline?.aborted && generating) {
              const key = candidateKey(model)
              const until = Date.now() + 60000
              if ((skipped.get(key)?.until ?? 0) < until) skipped.set(key, { until, reason: `Timed out after ${options.timeoutMs} ms.` })
              move(model, false, group, ownership)
            }
            parent.throwIfAborted()
            const changed = check(await abortable(() => api.session(request.sessionID, parent), parent))
            if (changed) return { reason: changed }
            parent.throwIfAborted()
            failure = timedOut ? "timeout" : "generation_failed"
            const policy = timedOut ? { detail: `Timed out after ${options.timeoutMs} ms.`, delayMs: 60000, modelWide: false } : failurePolicy(error)
            const key = policy.modelWide ? modelKey(model) : candidateKey(model)
            const until = Date.now() + policy.delayMs
            if ((skipped.get(key)?.until ?? 0) < until) skipped.set(key, { until, reason: policy.detail })
            move(model, false, group, ownership, policy.modelWide)
            if (extraCall) break
            if (options.debug) {
              const next = chain.slice(index + 1).find(candidate => !skip(candidate))
              const message = next ? `Predictions failed with [${name}], moving on with [${next.name}]...` : `Predictions failed with [${name}]; no eligible configured models remain.`
              const entry = skip(model)!
              const minutes = Math.ceil((entry.until - Date.now()) / 60000)
              const queue = entry.until === Infinity ? "Blocked until the server plugin reloads." : `Paused for ${minutes} minute${minutes === 1 ? "" : "s"}.`
              await api.notice?.(`${message}\nReason: ${policy.detail}\nQueue: ${queue}`, request)
            }
          }
        }
        return { reason: failure }
      }
      const reply = await abortable(async (): Promise<Reply> => {
        const reply = await work()
        if (reply.reason && ["model_unavailable", "no_models_eligible", "generation_failed", "timeout"].includes(reply.reason)) {
          parent.throwIfAborted()
          const changed = check(await abortable(() => api.session(request.sessionID, parent), parent))
          if (changed) return { reason: changed }
          parent.throwIfAborted()
          const selectors = new Set(options.models!.flatMap(group => group.split(",").map(value => value.trim())))
          const single = configured[0]
          const message = Math.max(configured.length, selectors.size) > 1
            ? "No model worked at this time." + (options.debug ? "" : " Activate `debug` mode for details.")
            : `Model [${single?.name ?? [...selectors][0]}] failed with message: ${single && skip(single)?.reason || "No configured model is available."}`
          reply.notice = statusNotice(status()) ?? reasonNotice(reply.reason)
          await abortable(() => Promise.resolve(api.notice?.(message, request, reply.notice)), parent)
        }
        return reply
      }, parent)
      lastOutcome = reply.text ? "suggestion" : reply.reason
      return reply
    } catch {
      lastOutcome = caller.aborted ? "cancelled" : deadline?.aborted ? "timeout" : "generation_failed"
      return { reason: lastOutcome, ...(lastOutcome !== "cancelled" ? { notice: reasonNotice(lastOutcome === "timeout" ? "timeout" : "service_unavailable") } : {}) }
    } finally {
      lastLatencyMs = Math.round(performance.now() - started)
    }
  }
  const inspect = async (signal: AbortSignal): Promise<Status> => {
    if (options?.enabled && options.models) refresh(await api.models(signal))
    return status()
  }
  return { predict, status, inspect }
}

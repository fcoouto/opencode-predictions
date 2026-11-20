import { abortable, type Reply, type Status } from "./service.ts"
import { createController, type Activity, type Communication } from "./controller.ts"
import { log } from "./log.ts"
import { statusNotice, reasonNotice, formatStatus, feedbackRevision, type Notice, type StatusView } from "./feedback.ts"
import { defaultTimeoutMs } from "./options.ts"
export type ClientState = { key: string; sessionID: string; completion: number; eligible: boolean; draft: string; automaticEligible?: boolean }
export type ClientMemory = { mounted: boolean; suppressed: string[]; current?: string }
export type ClientHost = {
  memory?: readonly [ClientMemory, (mutation: (draft: ClientMemory) => void) => void]
  scope(): string | undefined
  state(): ClientState | undefined
  status(signal: AbortSignal): Promise<Status>
  predict(state: ClientState, requestID: string, signal: AbortSignal, notice: (message: string, final?: Notice, modelName?: string) => void, manual?: boolean, escalation?: string): Promise<Reply>
  paint(text: string | undefined): boolean
  hint?(available: boolean): void
  insert(text: string): boolean
  focus(): void
  show(notice: Notice): void
  clearNotice?(): void
  communicate?(value: Communication | undefined, activate: () => void): void
  openStatus(view: StatusView): void | Promise<void>
  diagnostics?(): Record<string, unknown>
}
type Health = { health?: Notice; requestFailure?: Notice; lastNotice?: Notice; announced?: string }
export function startClient(host: ClientHost) {
  const suppressed = new Set(host.memory?.[0].suppressed)
  const versions = new Map<string, string>()
  let lastCompletion: string | undefined
  if (host.memory?.[0].mounted && host.memory[0].current) suppressed.add(host.memory[0].current)
  host.memory?.[1](draft => { draft.mounted = true; draft.suppressed = [...suppressed] })
  const completionKey = () => {
    const location = host.scope(), state = host.state()
    return location && state ? JSON.stringify([location, state.key]) : undefined
  }
  const suppress = () => {
    const key = completionKey() ?? lastCompletion
    if (!key) return
    suppressed.add(key)
    if (suppressed.size > 128) suppressed.delete(suppressed.values().next().value!)
    host.memory?.[1](draft => { draft.suppressed = [...suppressed] })
  }
  const locations = new Map<string, Health>()
  let scope: string | undefined
  let current: ClientState | undefined
  let cache: Status | undefined
  let checked = -Infinity
  let epoch = 0
  let loading: { abort: AbortController; done: Promise<void> } | undefined
  let disposed = false
  let manual: { scope: string; key?: string; fromShortcut: boolean; draft: string; epoch: number; version?: string; escalation?: string; activity: Activity } | undefined
  let requestingManual = false
  let communication: Communication | undefined
  let predicting: { signal: AbortSignal; scope: string | undefined; epoch: number; explicit: boolean } | undefined
  const activePrediction = () => predicting && !predicting.signal.aborted && predicting.scope === scope && predicting.epoch === epoch ? predicting : undefined
  const fingerprint = (notice: Notice) => JSON.stringify([notice.code, notice.severity, notice.title, notice.message, !!notice.persistent])
  const record = () => locations.get(scope!)!
  const activeNotice = () => {
    const value = scope && locations.get(scope)
    return value ? value.health?.severity === "error" ? value.health : value.requestFailure ?? value.health : undefined
  }
  const announce = (notice: Notice, explicit = false) => {
    if (disposed) return
    const value = scope ? record() : undefined
    if (value && notice.severity === "error") value.lastNotice = notice
    if (!explicit && value?.announced === fingerprint(notice)) return
    if (notice.severity !== "info" && value) { host.clearNotice?.(); value.announced = fingerprint(notice) }
    host.show(notice)
  }
  const health = (notice: Notice | undefined, recoveredModels = false) => {
    const value = record()
    const previous = value.health
    value.health = notice
    if ((previous && notice?.code !== previous.code && value.requestFailure?.code === previous.code) || (recoveredModels && value.requestFailure?.code === "models_unavailable")) {
      value.requestFailure = undefined
      value.announced = undefined
      host.clearNotice?.()
    }
    if (!activeNotice()) { value.announced = undefined; host.clearNotice?.() }
    else if (!manual && !activePrediction()?.explicit) announce(activeNotice()!)
  }
  const sync = () => {
    const next = host.scope()
    if (next !== scope) {
      lastCompletion = undefined
      loading?.abort.abort(); loading = undefined; cache = undefined; checked = -Infinity; epoch++; manual = undefined
      host.clearNotice?.(); controller.update({ eligible: false, draft: "" })
      scope = next
      if (scope && !locations.has(scope)) {
        locations.set(scope, {})
        if (locations.size > 32) locations.delete(locations.keys().next().value!)
      }
    }
    current = host.state()
    if (current) {
      lastCompletion = completionKey()
      if (host.memory && host.memory[0].current !== lastCompletion) host.memory[1](draft => { draft.current = lastCompletion })
    }
    if (manual && ((manual.key && manual.key !== current?.key) || manual.draft !== (current?.draft ?? "") || manual.epoch !== epoch)) manual = undefined
  }
  const controller = createController({
    paint: host.paint,
    insert: host.insert,
    communicate: value => {
      communication = value
      const key = current?.key
      const location = scope
      const generation = epoch
      host.communicate?.(value, () => {
        if (disposed || generation !== epoch || host.scope() !== location || host.state()?.key !== key || host.state()?.draft || !value?.offer || communication?.offer?.token !== value.offer.token || communication.pending) return
        request()
      })
    },
    predict: async (signal, escalation) => {
      const state = current!
      const location = scope
      const generation = epoch
      const version = cache?.version
      const explicit = requestingManual
      let final: Notice | undefined
      const modern = cache?.feedbackRevision === feedbackRevision
      const debug = !!cache?.debug
      const legacyProgress: string[] = []
      const progress = (message: string) => log(text => host.show({ code: "progress", severity: "info", title: "Prompt predictions", message: text }), message)
      const live = () => !disposed && !signal.aborted && epoch === generation && host.scope() === location && host.state()?.key === state.key && !host.state()?.draft
      const flight = { signal, scope: location, epoch: generation, explicit }
      const deadline = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      // Allow a model attempt plus bounded validation; renew only on actual model progress.
      const renew = () => { clearTimeout(timer); timer = setTimeout(() => deadline.abort(), (cache?.timeoutMs ?? defaultTimeoutMs) * 2) }
      renew()
      const requestSignal = AbortSignal.any([signal, deadline.signal])
      predicting = flight
      try {
        let reply: Reply
        try {
          reply = await abortable(() => host.predict(state, crypto.randomUUID(), requestSignal, (message, notice, modelName) => {
            if (predicting !== flight || !live() || requestSignal.aborted) return
            if (modelName) { renew(); controller.progress(modelName); return }
            if (notice) { final = notice; return }
            if (modern) progress(message)
            else if (debug) { legacyProgress.push(message); if (legacyProgress.length > 32) legacyProgress.shift() }
          }, explicit, escalation), requestSignal)
        } catch {
          const reason = deadline.signal.aborted && !signal.aborted ? "timeout" : "service_unavailable"
          reply = { reason, notice: reasonNotice(reason) }
        }
        if (!live()) {
          if (!signal.aborted) {
            const latest = host.state()
            if (host.scope() === location && latest?.key === state.key && latest.draft) controller.update({ key: JSON.stringify([location, state.key, version]), eligible: false, draft: latest.draft })
            else { sync(); controller.update({ eligible: false, draft: "" }) }
          }
          return { reason: "stale" }
        }
        if (reply.text || reply.reason === "no_suggestion") {
          record().requestFailure = undefined
          record().announced = record().health ? fingerprint(record().health!) : undefined
          if (!record().health) host.clearNotice?.()
        }
        const notice = reply.notice ?? final ?? reasonNotice(reply.reason)
        // Legacy services emit the final error as their last unstructured event.
        for (const message of notice?.severity === "error" ? legacyProgress.slice(0, -1) : legacyProgress) progress(message)
        if (notice && notice.severity !== "info") {
          record().requestFailure = notice
          announce(notice, explicit)
        } else if (notice && explicit && !(["no_suggestion", "escalation_refreshed"].includes(reply.reason ?? "") && cache?.escalation && cache.escalation !== "off" && host.communicate)) announce(notice, true)
        if (cache?.escalation && cache.escalation !== "off") {
          const refreshed = reply.reason === "escalation_refreshed" || escalation === "refresh"
          const abstained = reply.reason === "no_suggestion" && !refreshed
          const message = reply.text || controller.preview() || refreshed || ["stale", "cancelled"].includes(reply.reason ?? "") ? ""
            : abstained ? reply.modelName ? `[${reply.modelName}] provided no prediction.` : "No prediction."
              : notice ? `${notice.title}\n${["generation_failed", "context_unavailable"].includes(reply.reason ?? "") ? notice.message : "Open Prediction status and preview for recovery."}` : ""
          return { ...reply, communication: { message, offer: reply.text || abstained || refreshed ? reply.escalation : undefined } }
        }
        return reply
      } finally { clearTimeout(timer!); if (predicting === flight) predicting = undefined }
    },
  })
  const load = () => {
    if (!scope || disposed) return Promise.resolve()
    if (loading) return loading.done
    const location = scope
    const generation = epoch
    const inspectedFailure = record().requestFailure
    const abort = new AbortController()
    const deadline = AbortSignal.timeout(cache?.timeoutMs ?? defaultTimeoutMs)
    const signal = AbortSignal.any([abort.signal, deadline])
    const live = () => !disposed && !abort.signal.aborted && epoch === generation && host.scope() === location
    const request = { abort, done: Promise.resolve() }
    loading = request
    const done = (async () => {
      try {
        const value = await abortable(() => host.status(signal), signal)
        if (live()) {
          if (versions.has(location) && versions.get(location) !== value.version) {
            suppress(); manual = undefined; controller.invalidate()
          }
          versions.set(location, value.version)
          cache = value; checked = Date.now()
          const recoveredModels = record().requestFailure === inspectedFailure && !!value.candidates?.some(model => model.state === "ready")
          health(statusNotice(value), recoveredModels)
        }
      } catch {
        if (live()) {
          checked = Date.now()
          if (deadline.aborted) { manual = undefined; controller.stage(undefined); health(reasonNotice("timeout")) }
          else { cache = undefined; health(reasonNotice("service_unavailable")) }
        }
      } finally {
        if (loading?.abort === abort) loading = undefined
        if (live()) tick()
      }
    })()
    request.done = done
    return done
  }
  const tick = () => {
    if (disposed) return
    sync()
    if (scope && !loading && Date.now() - checked >= 2000) void load()
    if (manual?.fromShortcut && (current?.draft || cache?.enabled === false)) manual = undefined
    const available = !!cache?.enabled && !cache.reason
    controller.update({ key: current && cache ? JSON.stringify([scope, current.key, cache.version]) : undefined, eligible: !!current?.eligible && !!cache?.enabled, draft: current?.draft ?? "" })
    controller.stage(manual?.activity)
    if (manual && !loading) {
      const action = manual
      manual = undefined
      if (action.version && action.version !== cache?.version) { controller.stage(undefined); return }
      const issue = record().health?.severity === "error" ? record().health : !cache ? reasonNotice("service_unavailable") : !cache.enabled ? reasonNotice("disabled") : !current ? reasonNotice("context_unavailable") : current.draft || !current.eligible ? reasonNotice("composer_unavailable") : undefined
      if (issue) { controller.stage(undefined); announce(issue, true); return }
      if (activePrediction()) { controller.stage(undefined); return }
      requestingManual = true
      void controller.request(true, action.escalation ?? null, !!cache?.escalation && cache.escalation !== "off")
      requestingManual = false
    } else if (!manual && available && current?.eligible && current.automaticEligible !== false && !current.draft && cache?.automatic && !suppressed.has(completionKey()!)) void controller.request()
    host.hint?.(available && cache?.automatic === false && !!current?.eligible && !current.draft && !manual && !activePrediction())
  }
  const request = (fromShortcut = false) => {
    if (disposed) return
    sync()
    if (manual || activePrediction()) return
    if (!scope) { announce(reasonNotice("location_unavailable")!, true); return }
    const offer = communication?.offer
    manual = { scope, key: host.state()?.key, fromShortcut, draft: host.state()?.draft ?? "", epoch, version: cache?.version, escalation: offer?.token, activity: offer ? { kind: "alternative", name: offer.name } : { kind: "initial" } }
    controller.stage(manual.activity)
    host.focus()
    tick()
  }
  const interval = setInterval(tick, 100)
  tick()
  return {
    accept() { tick(); return controller.accept() },
    request,
    requestFromShortcut() {
      tick()
      if (!current?.eligible || current.draft || cache?.enabled === false) return false
      request(true)
    },
    async status() {
      if (disposed) return
      sync()
      const location = scope
      const generation = epoch
      if (scope) await load()
      if (disposed || epoch !== generation || host.scope() !== location) return
      const value = scope ? record() : undefined
      await host.openStatus(formatStatus(cache, { currentNotice: activeNotice() ?? (!scope ? reasonNotice("location_unavailable") : undefined), lastNotice: value?.lastNotice, suggestion: controller.preview(), diagnostics: host.diagnostics?.() }))
    },
    invalidate(options?: { suppressAutomatic?: boolean }) {
      if (disposed) return
      if (options?.suppressAutomatic) suppress()
      epoch++; manual = undefined; loading?.abort.abort(); loading = undefined; cache = undefined; checked = -Infinity
      if (options?.suppressAutomatic) controller.invalidate()
      else controller.update({ eligible: false, draft: "" })
      tick()
    },
    dispose() { suppress(); disposed = true; clearInterval(interval); loading?.abort.abort(); controller.dispose(); host.hint?.(false); host.clearNotice?.() },
  }
}

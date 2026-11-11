import type { Reply, Status } from "./service.ts"
import { createController } from "./controller.ts"
import { log } from "./log.ts"
import { statusNotice, reasonNotice, formatStatus, feedbackRevision, type Notice, type StatusView } from "./feedback.ts"
export type ClientState = { key: string; sessionID: string; completion: number; eligible: boolean; draft: string }
export type ClientHost = {
  scope(): string | undefined
  state(): ClientState | undefined
  status(signal: AbortSignal): Promise<Status>
  predict(state: ClientState, requestID: string, signal: AbortSignal, notice: (message: string, final?: Notice) => void): Promise<Reply>
  paint(text: string | undefined): boolean
  insert(text: string): boolean
  focus(): void
  show(notice: Notice): void
  clearNotice?(): void
  openStatus(view: StatusView): void | Promise<void>
  diagnostics?(): Record<string, unknown>
}
type Health = { health?: Notice; requestFailure?: Notice; lastNotice?: Notice; announced?: string }
export function startClient(host: ClientHost) {
  const locations = new Map<string, Health>()
  let scope: string | undefined
  let current: ClientState | undefined
  let cache: Status | undefined
  let checked = -Infinity
  let epoch = 0
  let loading: { abort: AbortController; done: Promise<void> } | undefined
  let disposed = false
  let manual: { scope: string; key?: string; fromShortcut: boolean } | undefined
  let requestingManual = false
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
      loading?.abort.abort(); loading = undefined; cache = undefined; checked = -Infinity; epoch++; manual = undefined
      host.clearNotice?.(); controller.update({ eligible: false, draft: "" })
      scope = next
      if (scope && !locations.has(scope)) {
        locations.set(scope, {})
        if (locations.size > 32) locations.delete(locations.keys().next().value!)
      }
    }
    current = host.state()
    if (manual?.key && manual.key !== current?.key) manual = undefined
  }
  const controller = createController({
    paint: host.paint,
    insert: host.insert,
    predict: async signal => {
      const state = current!
      const location = scope
      const generation = epoch
      const explicit = requestingManual
      let final: Notice | undefined
      const modern = cache?.feedbackRevision === feedbackRevision
      const debug = !!cache?.debug
      const legacyProgress: string[] = []
      const progress = (message: string) => log(text => host.show({ code: "progress", severity: "info", title: "Prompt predictions", message: text }), message)
      const live = () => !disposed && !signal.aborted && epoch === generation && host.scope() === location && host.state()?.key === state.key
      const flight = { signal, scope: location, epoch: generation, explicit }
      predicting = flight
      try {
        let reply: Reply
        try {
          reply = await host.predict(state, crypto.randomUUID(), signal, (message, notice) => {
            if (!live()) return
            if (notice) { final = notice; return }
            if (modern) progress(message)
            else if (debug) { legacyProgress.push(message); if (legacyProgress.length > 32) legacyProgress.shift() }
          })
        } catch { reply = { reason: "service_unavailable", notice: reasonNotice("service_unavailable") } }
        if (!live()) return { reason: "stale" }
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
        } else if (notice && explicit) announce(notice, true)
        return reply
      } finally { if (predicting === flight) predicting = undefined }
    },
  })
  const load = () => {
    if (!scope || disposed) return Promise.resolve()
    if (loading) return loading.done
    const location = scope
    const generation = epoch
    const inspectedFailure = record().requestFailure
    const abort = new AbortController()
    const live = () => !disposed && !abort.signal.aborted && epoch === generation && host.scope() === location
    const request = { abort, done: Promise.resolve() }
    loading = request
    const done = (async () => {
      try {
        const value = await host.status(abort.signal)
        if (live()) {
          cache = value; checked = Date.now()
          const recoveredModels = record().requestFailure === inspectedFailure && !!value.candidates?.some(model => model.state === "ready")
          health(statusNotice(value), recoveredModels)
        }
      } catch {
        if (live()) { cache = undefined; checked = Date.now(); health(reasonNotice("service_unavailable")) }
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
    controller.update({ key: current && cache ? JSON.stringify([scope, current.key, cache.version]) : undefined, contextKey: current ? JSON.stringify([scope, current.key]) : undefined, eligible: !!current?.eligible && available, draft: current?.draft ?? "" })
    if (manual && !loading) {
      const issue = record().health?.severity === "error" ? record().health : !cache ? reasonNotice("service_unavailable") : !cache.enabled ? reasonNotice("disabled") : !current ? reasonNotice("context_unavailable") : current.draft || !current.eligible ? reasonNotice("composer_unavailable") : undefined
      manual = undefined
      if (issue) { announce(issue, true); return }
      if (activePrediction()) { announce({ code: "prediction_pending", severity: "info", title: "A prediction is already running", message: "Wait for the current prediction to finish." }, true); return }
      requestingManual = true
      void controller.request(true)
      requestingManual = false
    } else if (!manual && available && current?.eligible && !current.draft && cache?.automatic) void controller.request()
  }
  const request = (fromShortcut = false) => {
    if (disposed) return
    sync()
    if (!scope) { announce(reasonNotice("location_unavailable")!, true); return }
    manual = { scope, key: host.state()?.key, fromShortcut }
    host.focus()
    tick()
  }
  const interval = setInterval(tick, 100)
  tick()
  return {
    accept() { tick(); return controller.accept() },
    dismiss() { tick(); return controller.dismiss() },
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
    invalidate() { if (disposed) return; epoch++; loading?.abort.abort(); loading = undefined; cache = undefined; checked = -Infinity; controller.update({ eligible: false, draft: "" }); tick() },
    dispose() { disposed = true; clearInterval(interval); loading?.abort.abort(); controller.dispose(); host.clearNotice?.() },
  }
}

import type { Reply, Status } from "./service.ts"
import { createController } from "./controller.ts"
import { log } from "./log.ts"
export type ClientState = { key: string; sessionID: string; completion: number; eligible: boolean; draft: string }
export type ClientHost = {
  state(): ClientState | undefined
  status(state: ClientState, signal: AbortSignal): Promise<Status>
  predict(state: ClientState, requestID: string, signal: AbortSignal, notice: (message: string) => void): Promise<Reply>
  paint(text: string | undefined): boolean
  insert(text: string): boolean
  focus(): void
  show(message: string): void
  diagnostics?(): Record<string, unknown>
}
export function startClient(host: ClientHost) {
  const show = (message: string) => log(message => host.show(message), message)
  let current: ClientState | undefined
  let cache: Status | undefined
  let scope: string | undefined
  let checked = 0
  let loading: AbortController | undefined
  let disposed = false
  let manual: { key: string; fromShortcut: boolean } | undefined
  let error = ""
  const controller = createController({
    paint: host.paint,
    insert: host.insert,
    predict: async signal => {
      const state = current!
      const id = crypto.randomUUID()
      let reply: Reply
      try {
        reply = await host.predict(state, id, signal, message => { if (!signal.aborted && host.state()?.key === state.key) show(message) })
      } catch {
        if (!signal.aborted && host.state()?.key === state.key) { error = "Prediction service unavailable"; show(error) }
        return { reason: "service_unavailable" }
      } finally { tick() }
      if (reply.reason && !["no_suggestion", "cancelled", "stale"].includes(reply.reason)) error = reply.reason
      return reply
    },
  })
  const load = async (state: ClientState) => {
    const request = new AbortController()
    loading = request
    try {
      const value = await host.status(state, request.signal)
      if (!disposed && !request.signal.aborted && host.state()?.key === state.key) { cache = value; error = value.reason ?? ""; checked = Date.now() }
    } catch {
      if (!request.signal.aborted) { cache = undefined; error = "Prediction service unavailable"; checked = Date.now() }
    } finally {
      if (loading === request) loading = undefined
      if (!disposed && !request.signal.aborted) tick()
    }
  }
  const tick = () => {
    if (disposed) return
    current = host.state()
    if (current?.key !== scope) {
      if (manual?.key !== current?.key) manual = undefined
      loading?.abort(); loading = undefined; cache = undefined; checked = 0; scope = current?.key
    }
    if (current && !loading && Date.now() - checked >= 2000) void load(current)
    if (manual?.fromShortcut && (current?.draft || cache?.enabled === false)) manual = undefined
    controller.update({ key: current && cache ? current.key + "/" + cache.version : undefined, eligible: !!current?.eligible && !!cache?.enabled, draft: current?.draft ?? "" })
    if (cache?.enabled && current?.eligible && !current.draft && (cache.automatic || manual?.key === current.key)) {
      const requested = manual?.key === current.key; manual = undefined
      void controller.request(requested).catch(() => { error = "Prediction service unavailable" })
    }
  }
  const interval = setInterval(tick, 100)
  const request = (fromShortcut = false) => { const state = host.state(); manual = state ? { key: state.key, fromShortcut } : undefined; host.focus(); tick() }
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
      const preview = controller.preview()
      const state = host.state()
      if (state) { loading?.abort(); await load(state) }
      show(JSON.stringify({ ...host.diagnostics?.(), ...cache, ...(!cache ? { reason: error || "No completed session" } : {}), ...(preview ? { suggestion: preview } : {}), ...(error ? { lastNotice: error } : {}) }, null, 2))
    },
    invalidate() { loading?.abort(); loading = undefined; cache = undefined; checked = 0; controller.update({ eligible: false, draft: "" }); tick() },
    dispose() { disposed = true; clearInterval(interval); loading?.abort(); controller.dispose() },
  }
}

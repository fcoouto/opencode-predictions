import type { Reply } from "./service.ts"
export type Snapshot = { key?: string; contextKey?: string; eligible: boolean; draft: string }
export type ControllerIO = { predict(signal: AbortSignal): Promise<Reply>; paint(text: string | undefined): boolean; insert(text: string): boolean }
export function createController(io: ControllerIO) {
  let current: Snapshot = { eligible: false, draft: "" }
  let pending: AbortController | undefined
  const results = new Map<string, { text: string; contextKey: string; accepted?: boolean }>()
  let visible = false
  let disposed = false
  const attempted = new Set<string>()
  const remember = (key: string) => {
    attempted.add(key)
    if (attempted.size > 128) {
      const oldest = attempted.values().next().value!
      attempted.delete(oldest)
      results.delete(oldest)
    }
  }
  const paint = () => {
    visible = io.paint(!disposed && current.eligible && !current.draft && current.key ? results.get(current.key)?.text : undefined)
  }
  const clear = () => { pending?.abort(); pending = undefined; visible = false; io.paint(undefined) }
  return {
    update(snapshot: Snapshot) {
      if (disposed) return
      if (snapshot.key !== current.key || snapshot.draft) clear()
      current = snapshot
      if (snapshot.draft) {
        const contextKey = snapshot.contextKey ?? snapshot.key
        for (const [key, result] of results) if (result.contextKey === contextKey && !result.accepted) results.delete(key)
        if (snapshot.key) remember(snapshot.key)
      }
      paint()
    },
    async request(manual = false) {
      const key = current.key
      if (disposed || !key || !current.eligible || current.draft || pending || (!manual && attempted.has(key))) return
      const contextKey = current.contextKey ?? key
      remember(key)
      const request = new AbortController()
      pending = request
      try {
        const reply = await io.predict(request.signal)
        if (!disposed && !request.signal.aborted && current.key === key && !current.draft && reply.text) results.set(key, { text: reply.text, contextKey })
      } catch {
        // The host status command reports service availability; failed calls never auto-retry.
      } finally {
        if (pending === request) pending = undefined
        paint()
      }
    },
    dismiss(): boolean { const shown = visible; if (current.key) { results.delete(current.key); remember(current.key) }; clear(); return shown },
    accept(): boolean {
      const result = current.key ? results.get(current.key) : undefined
      if (disposed || !visible || !current.eligible || current.draft || !result) return false
      clear()
      if (!io.insert(result.text)) return false
      result.accepted = true
      return true
    },
    preview(): string | undefined { return current.key ? results.get(current.key)?.text : undefined },
    dispose() { disposed = true; clear(); results.clear(); attempted.clear() },
  }
}

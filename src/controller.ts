import type { Reply } from "./service.ts"
export type Snapshot = { key?: string; eligible: boolean; draft: string }
export type ControllerIO = { predict(signal: AbortSignal): Promise<Reply>; paint(text: string | undefined): boolean; insert(text: string): boolean }
export function createController(io: ControllerIO) {
  let current: Snapshot = { eligible: false, draft: "" }
  let pending: AbortController | undefined
  let result: { key: string; text: string } | undefined
  let visible = false
  let disposed = false
  const attempted = new Set<string>()
  const remember = (key: string) => {
    attempted.add(key)
    if (attempted.size > 128) attempted.delete(attempted.values().next().value!)
  }
  const paint = () => {
    visible = io.paint(!disposed && current.eligible && !current.draft && result?.key === current.key ? result?.text : undefined)
  }
  const clear = () => { pending?.abort(); pending = undefined; result = undefined; visible = false; io.paint(undefined) }
  return {
    update(snapshot: Snapshot) {
      if (disposed) return
      if (snapshot.key !== current.key || snapshot.draft) clear()
      current = snapshot
      if (snapshot.key && snapshot.draft) remember(snapshot.key)
      paint()
    },
    async request(manual = false) {
      const key = current.key
      if (disposed || !key || !current.eligible || current.draft || pending || (!manual && attempted.has(key))) return
      remember(key)
      const request = new AbortController()
      pending = request
      try {
        const reply = await io.predict(request.signal)
        if (!disposed && !request.signal.aborted && current.key === key && !current.draft && reply.text) result = { key, text: reply.text }
      } catch {
        // The host status command reports service availability; failed calls never auto-retry.
      } finally {
        if (pending === request) pending = undefined
        paint()
      }
    },
    dismiss(): boolean { const shown = visible; if (current.key) remember(current.key); clear(); return shown },
    accept(): boolean {
      if (disposed || !visible || !current.eligible || current.draft || !result || result.key !== current.key) return false
      const text = result.text
      clear()
      return io.insert(text)
    },
    preview(): string | undefined { return result?.key === current.key ? result?.text : undefined },
    dispose() { disposed = true; clear(); attempted.clear() },
  }
}

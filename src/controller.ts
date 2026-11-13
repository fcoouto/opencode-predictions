import type { Reply, EscalationOffer } from "./service.ts"
export type Snapshot = { key?: string; eligible: boolean; draft: string }
export type Communication = { message: string; offer?: EscalationOffer; pending?: boolean }
export function communicationText(value: Communication): string {
  const offer = value.offer
  return [value.pending ? "Asking another model…" : value.message, offer && `Next: ${offer.name} (${offer.model.providerID}/${offer.model.id}${offer.model.variant ? "#" + offer.model.variant : ""}), group ${offer.group}.`, offer && "Uses this provider's quota.", offer && !value.pending && "Ask another model · Alt+Shift+P"].filter(Boolean).join("\n")
}
export type ControllerIO = { predict(signal: AbortSignal, escalation?: string): Promise<Reply & { communication?: Communication }>; paint(text: string | undefined): boolean; insert(text: string): boolean; communicate?(value: Communication | undefined): void }
export function createController(io: ControllerIO) {
  let current: Snapshot = { eligible: false, draft: "" }
  let pending: AbortController | undefined
  const results = new Map<string, { text?: string; communication?: Communication }>()
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
    const result = !disposed && !current.draft && current.key ? results.get(current.key) : undefined
    visible = io.paint(current.eligible ? result?.text : undefined)
    io.communicate?.(result?.communication ? { ...result.communication, pending: !!pending } : undefined)
  }
  const clear = () => { pending?.abort(); pending = undefined; visible = false; io.paint(undefined); io.communicate?.(undefined) }
  return {
    update(snapshot: Snapshot) {
      if (disposed) return
      if (snapshot.key !== current.key || snapshot.draft) clear()
      current = snapshot
      if (snapshot.key && snapshot.draft) {
        remember(snapshot.key)
        if (results.get(snapshot.key)?.communication) results.delete(snapshot.key)
      }
      paint()
    },
    async request(manual = false, expectedOffer?: string | null) {
      const key = current.key
      if (disposed || !key || !current.eligible || current.draft || pending || (!manual && attempted.has(key))) return
      const communication = results.get(key)?.communication
      if (manual && expectedOffer !== undefined && (communication?.offer?.token ?? null) !== expectedOffer) return
      if (manual && communication && !communication.offer) return
      const escalation = manual ? communication?.offer?.token : undefined
      remember(key)
      const request = new AbortController()
      pending = request
      paint()
      try {
        const reply = await io.predict(request.signal, escalation)
        if (!disposed && !request.signal.aborted && current.key === key && !current.draft) {
          if (reply.text) results.set(key, { text: reply.text })
          else if (reply.communication) results.set(key, { communication: reply.communication })
          else if (communication) results.delete(key)
        }
      } catch {
        // The host status command reports service availability; failed calls never auto-retry.
      } finally {
        if (pending === request) { pending = undefined; paint() }
      }
    },
    accept(): boolean {
      const result = current.key ? results.get(current.key) : undefined
      if (disposed || !visible || !current.eligible || current.draft || !result?.text) return false
      clear()
      return io.insert(result.text)
    },
    preview(): string | undefined { return current.key ? results.get(current.key)?.text : undefined },
    dispose() { disposed = true; clear(); results.clear(); attempted.clear() },
  }
}

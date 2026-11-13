import type { Reply, EscalationOffer } from "./service.ts"
export type Snapshot = { key?: string; eligible: boolean; draft: string }
export type Activity = { kind: "initial" } | { kind: "alternative"; name: string }
export type Communication = { message: string; offer?: EscalationOffer; pending?: boolean; activity?: Activity }
export function communicationText(value: Communication, reducedMotion = false, shortcut = "Alt+Shift+P"): string {
  if (!value.activity) return value.message && value.offer ? `${value.message}\nUse ${shortcut} to escalate it to [${value.offer.name}].` : value.message
  const indicator = reducedMotion ? "…" : ["▰▱▱", "▱▰▱", "▱▱▰"][Math.floor(Date.now() / 200) % 3]
  return "\uFFFB" + indicator + (value.activity.kind === "alternative" ? " " + value.activity.name : "")
}
export type ControllerIO = { predict(signal: AbortSignal, escalation?: string): Promise<Reply & { communication?: Communication }>; paint(text: string | undefined): boolean; insert(text: string): boolean; communicate?(value: Communication | undefined): void }
export function createController(io: ControllerIO) {
  let current: Snapshot = { eligible: false, draft: "" }
  let pending: AbortController | undefined
  let staged: Activity | undefined
  let transient: { key: string; message: string } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
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
    const activity = staged ?? (pending ? result?.communication?.offer ? { kind: "alternative" as const, name: result.communication.offer.name } : { kind: "initial" as const } : undefined)
    const message = transient && transient.key === current.key ? transient.message : undefined
    visible = io.paint(current.eligible && !activity && !message ? result?.text : undefined)
    io.communicate?.(!current.draft && !disposed ? activity ? { ...result?.communication, message: "", activity, pending: true } : message ? { message } : result?.communication : undefined)
  }
  const clearTransient = () => { clearTimeout(timer); timer = undefined; transient = undefined }
  const clear = () => { pending?.abort(); pending = undefined; staged = undefined; clearTransient(); visible = false; io.paint(undefined); io.communicate?.(undefined) }
  const exhausted = () => {
    if (!current.key) return
    clearTransient()
    transient = { key: current.key, message: "No alternatives available." }
    timer = setTimeout(() => { transient = undefined; timer = undefined; paint() }, 1500)
    paint()
  }
  return {
    update(snapshot: Snapshot) {
      if (disposed) return
      if (snapshot.key !== current.key || snapshot.draft) clear()
      current = snapshot
      if (snapshot.key && snapshot.draft) {
        remember(snapshot.key)
        const result = results.get(snapshot.key)
        if (result?.text) result.communication = undefined
        else results.delete(snapshot.key)
      }
      paint()
    },
    async request(manual = false, expectedOffer?: string | null, continuation = false) {
      const key = current.key
      if (disposed || !key || !current.eligible || current.draft || pending || (!manual && attempted.has(key))) return
      const communication = results.get(key)?.communication
      if (manual && expectedOffer !== undefined && (communication?.offer?.token ?? null) !== expectedOffer) return
      if (manual && communication && !communication.offer && expectedOffer !== null) { staged = undefined; exhausted(); return }
      const escalation = manual ? communication?.offer?.token ?? (continuation && attempted.has(key) ? "refresh" : undefined) : undefined
      const refreshing = manual && !!communication && !communication.offer
      let noAlternatives = false
      remember(key)
      const request = new AbortController()
      pending = request
      clearTransient()
      paint()
      try {
        const reply = await io.predict(request.signal, escalation)
        if (!disposed && !request.signal.aborted && current.key === key && !current.draft) {
          const text = reply.text || results.get(key)?.text
          const next = reply.communication ?? (reply.escalation ? { message: "", offer: reply.escalation } : !reply.text && communication ? { message: text ? "" : "No suggestion." } : undefined)
          results.set(key, { text, communication: next })
          noAlternatives = refreshing && reply.reason === "no_suggestion" && !next?.offer
        }
      } catch {
        // The host status command reports service availability; failed calls never auto-retry.
        if (!request.signal.aborted && current.key === key) {
          const result = results.get(key)
          if (result?.communication) result.communication = { message: result.text ? "" : "Prediction failed." }
        }
      } finally {
        if (pending === request) { pending = undefined; staged = undefined; if (noAlternatives) exhausted(); else paint() }
      }
    },
    accept(): boolean {
      const result = current.key ? results.get(current.key) : undefined
      if (disposed || pending || staged || !visible || !current.eligible || current.draft || !result?.text) return false
      clear()
      result.communication = undefined
      const inserted = io.insert(result.text)
      if (!inserted) paint()
      return inserted
    },
    stage(activity: Activity | undefined) { staged = activity; paint() },
    preview(): string | undefined { return current.key ? results.get(current.key)?.text : undefined },
    dispose() { disposed = true; clear(); results.clear(); attempted.clear() },
  }
}

import { Plugin } from "@opencode/plugin/gui"
import { Predictions } from "../../../src/rpc.ts"
import { createDesktopAdapter } from "../../../src/adapters/desktop.ts"
export default Plugin.define({
  setup(ctx) {
    const adapter = createDesktopAdapter(document, () => ctx.screen.current()?.composer)
    let lastKey: unknown
    const onKey = (event: KeyboardEvent) => { if (event.code === "KeyP") lastKey = { key: event.key, code: event.code, eligible: adapter.eligible(), matches: ctx.keybinds.matches("opencode-predictions.request-shortcut", event) } }
    document.addEventListener("keydown", onKey, true)
    const fixture = {
      ready: () => ctx.layout.ready() && !!ctx.servers.get("sidecar")?.connected,
      launch: () => ctx.layout.draft({ server: "sidecar", directory: String(ctx.options.directory), prompt: "Fix the assertion." }),
      status: () => ctx.commands.run("opencode-predictions.status"),
      predictionReady: (submittedAt: number) => {
        const session = ctx.sessions.current()
        if (!session || !session.server.connected || !session.location || session.pending) return false
        const data = session.server.data
        const info = data.session.get(session.id)
        return !!info && !info.parentID && (info.time.idle ?? 0) >= submittedAt && info.outcome !== "interrupted" && data.session.status(session.id) === "idle" && adapter.eligible() && !data.session.pending.list(session.id).length && !data.session.permission.list(session.id)?.length && !data.session.form.list(session.id, session.location)?.length
      },
      users: () => { const session = ctx.sessions.current(); return session?.server.data.session.message.list(session.id).filter((message: { type: string }) => message.type === "user").length },
      snapshot: async () => {
        const session = ctx.sessions.current()
        if (!session) return { session: false }
        const composer = ctx.screen.current()?.composer
        const data = session.server.data
        const ready = !session.pending && data.session.status(session.id) === "idle" && !data.session.pending.list(session.id).length && !data.session.permission.list(session.id)?.length && !data.session.form.list(session.id, session.location)?.length
        return { session: data.session.get(session.id), ready, eligible: adapter.eligible(), focused: composer?.focused(), text: composer?.text(), shortcut: ctx.keybinds.keybind("opencode-predictions.request-shortcut"), lastKey, status: await session.server.client.rpc(Predictions).status({}, { location: session.location }) }
      },
    }
    Object.defineProperty(window, "__predictionFixture", { value: fixture, configurable: true })
    return () => { adapter.dispose(); document.removeEventListener("keydown", onKey, true); Reflect.deleteProperty(window, "__predictionFixture") }
  },
})

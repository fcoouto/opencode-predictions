import { Command, Plugin, createKeyed } from "@opencode/plugin/gui"
import { onCleanup } from "solid-js"
import type { Data } from "@opencode/client/solid"
import { createDesktopAdapter } from "./adapters/desktop.ts"
import { startClient } from "./client.ts"
import { Predictions } from "./rpc.ts"
import type { Reply, Status } from "./service.ts"

export default Plugin.define({
  setup(ctx) {
    const adapter = createDesktopAdapter(document, () => ctx.screen.current()?.composer)
    const session = () => ctx.sessions.current()
    const client = startClient({
      state: () => {
        const value = session()
        if (!value || !value.server.connected || !value.location || value.pending) return
        const data = value.server.data
        const info = data.session.get(value.id)
        if (!info || info.parentID || !info.time.idle || info.outcome === "interrupted" || data.session.status(value.id) !== "idle") return
        const eligible = adapter.eligible() && !data.session.pending.list(value.id).length && !data.session.permission.list(value.id)?.length && !data.session.form.list(value.id, value.location)?.length
        return { key: value.key + "/" + value.directory + "/" + info.time.idle, sessionID: value.id, completion: info.time.idle, eligible, draft: adapter.read() }
      },
      status: async (state, signal) => {
        const value = session()
        if (!value || value.id !== state.sessionID || !value.location) throw new Error("Session changed")
        return await value.server.client.rpc(Predictions).status({}, { location: value.location, signal }) as Status
      },
      predict: async (state, requestID, signal, notice) => {
        const value = session()
        if (!value || value.id !== state.sessionID || !value.location) return { reason: "stale" }
        const rpc = value.server.client.rpc(Predictions)
        const stop = rpc.events.on("progress", event => { if (event.data.requestID === requestID && event.data.sessionID === state.sessionID) notice(String(event.data.message)) })
        try { return await rpc.predict({ sessionID: state.sessionID, completion: state.completion, requestID }, { location: value.location, signal }) as Reply } finally { stop() }
      },
      paint: adapter.paint,
      insert: adapter.insert,
      focus: () => ctx.screen.current()?.composer.focus(),
      show: message => { ctx.toast.show({ title: "Prompt predictions", description: message, duration: 8000 }) },
      diagnostics: () => ({ host: "Desktop", hostVersion: ctx.app.version, composerEligible: adapter.eligible() }),
    })
    const serverData = (): Data | undefined => session()?.server.data
    createKeyed(serverData, data => {
      client.invalidate()
      onCleanup(data.on("config.updated", () => client.invalidate()))
      onCleanup(data.on("plugin.updated", () => client.invalidate()))
    })
    createKeyed(() => session()?.key, () => client.invalidate(), { otherwise: () => client.invalidate() })
    ctx.add(Command, { id: "accept", title: "Accept prompt prediction", bind: "tab", editable: true, hidden: true, run: () => client.accept() ? undefined : false })
    ctx.add(Command, { id: "dismiss", title: "Dismiss prompt prediction", bind: "escape", editable: true, hidden: true, run: () => client.dismiss() ? undefined : false })
    ctx.add(Command, { id: "request", title: "Predict next prompt", group: "Predictions", run: () => client.request() })
    ctx.add(Command, { id: "request-shortcut", title: "Predict next prompt", bind: "alt+shift+p", editable: true, hidden: true, run: () => client.requestFromShortcut() })
    ctx.add(Command, { id: "status", title: "Prediction status and preview", group: "Predictions", run: () => client.status() })
    return () => { client.dispose(); adapter.dispose() }
  },
})

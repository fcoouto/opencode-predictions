import { Plugin } from "@opencode/plugin/tui"
import { createTerminalAdapter } from "./adapters/terminal.ts"
import { startClient } from "./client.ts"
import { Predictions } from "./rpc.ts"
import type { Reply, Status } from "./service.ts"

export default Plugin.define({
  id: "fcoouto.predictions.tui",
  setup(ctx) {
    const adapter = createTerminalAdapter(ctx.renderer)
    const session = () => { const route = ctx.ui.router.current(); return route.type === "session" ? ctx.data.session.get(route.sessionID) : undefined }
    const client = startClient({
      state: () => {
        const value = session()
        if (!value || value.parentID || !value.time.idle || ctx.data.session.status(value.id) !== "idle" || value.outcome === "interrupted") return
        const eligible = adapter.eligible() && !ctx.data.session.pending.list(value.id).length && !ctx.data.session.permission.list(value.id)?.length && !ctx.data.session.form.list(value.id, value.location)?.length
        return { key: value.id + "/" + value.location.directory + "/" + value.time.idle, sessionID: value.id, completion: value.time.idle, eligible, draft: adapter.read() }
      },
      status: async (state, signal) => {
        const value = session()
        if (!value || value.id !== state.sessionID) throw new Error("Session changed")
        return await ctx.client.rpc(Predictions).status({}, { location: value.location, signal }) as Status
      },
      predict: async (state, requestID, signal, notice) => {
        const value = session()
        if (!value || value.id !== state.sessionID) return { reason: "stale" }
        const rpc = ctx.client.rpc(Predictions)
        const stop = rpc.events.on("progress", event => { if (event.data.requestID === requestID && event.data.sessionID === state.sessionID) notice(String(event.data.message)) })
        try { return await rpc.predict({ sessionID: state.sessionID, completion: state.completion, requestID }, { location: value.location, signal }) as Reply } finally { stop() }
      },
      paint: adapter.paint,
      insert: adapter.insert,
      focus: () => ctx.renderer.currentFocusedEditor?.focus(),
      show: message => { ctx.ui.toast.show({ title: "Prompt predictions", message, duration: 8000 }) },
      diagnostics: () => ({ host: "CLI", hostVersion: ctx.app.version, composerEligible: adapter.eligible() }),
    })
    ctx.keymap.layer(() => ({ priority: 20, commands: [
      { id: "predictions.accept", bind: "tab", run: () => client.accept() ? undefined : false },
      { id: "predictions.dismiss", bind: "escape", run: () => client.dismiss() ? undefined : false },
      { id: "predictions.request", title: "Predict next prompt", group: "Predictions", palette: true, run: () => client.request() },
      { id: "predictions.status", title: "Prediction status and preview", group: "Predictions", palette: true, run: () => client.status() },
    ] }))
    const stopConfig = ctx.data.on("config.updated", () => client.invalidate())
    const stopPlugin = ctx.data.on("plugin.updated", () => client.invalidate())
    return () => { stopConfig(); stopPlugin(); client.dispose(); adapter.dispose() }
  },
})

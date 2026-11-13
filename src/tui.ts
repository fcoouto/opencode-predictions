import { Plugin } from "@opencode/plugin/tui"
import { createTerminalAdapter } from "./adapters/terminal.ts"
import { startClient } from "./client.ts"
import { Predictions } from "./rpc.ts"
import type { Reply, Status } from "./service.ts"
import { pluginVersion, feedbackRevision, type Notice } from "./feedback.ts"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export default Plugin.define({
  id: "opencode-predictions.tui",
  setup(ctx) {
    let checkedMotion = -Infinity
    let reducedMotion = true
    const adapter = createTerminalAdapter(ctx.renderer, () => {
      if (Date.now() - checkedMotion < 2000) return reducedMotion
      checkedMotion = Date.now()
      try {
        let settings: { animations?: boolean } = {}
        try { settings = JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "cli.json"), "utf8")) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
        const inline = JSON.parse(process.env.OPENCODE_CLI_CONFIG_CONTENT ?? "{}")
        const animations = inline.animations ?? settings.animations
        reducedMotion = animations !== undefined && animations !== true
      } catch { reducedMotion = true }
      return reducedMotion
    })
    const session = () => { const route = ctx.ui.router.current(); return route.type === "session" ? ctx.data.session.get(route.sessionID) : undefined }
    const location = () => session()?.location ?? ctx.location ?? ctx.data.location.default()
    const client = startClient({
      scope: () => { const value = location(); return value ? JSON.stringify(value) : undefined },
      state: () => {
        const value = session()
        if (!value || value.parentID || ctx.data.session.status(value.id) !== "idle" || value.outcome === "interrupted") return
        const completion = value.time.idle || value.time.updated
        if (!completion) return
        const eligible = adapter.eligible() && !ctx.data.session.pending.list(value.id).length && !ctx.data.session.permission.list(value.id)?.length && !ctx.data.session.form.list(value.id, value.location)?.length
        return { key: value.id + "/" + value.location.directory + "/" + completion, sessionID: value.id, completion, eligible, draft: adapter.read(), automaticEligible: !!value.time.idle }
      },
      status: async signal => await ctx.client.rpc(Predictions).status({}, { location: location(), signal }) as Status,
      predict: async (state, requestID, signal, notice, manual, escalation) => {
        const value = session()
        if (!value || value.id !== state.sessionID) return { reason: "stale" }
        const rpc = ctx.client.rpc(Predictions)
        const stop = rpc.events.on("progress", event => { if (event.data.requestID === requestID && event.data.sessionID === state.sessionID) notice(String(event.data.message), event.data.notice as Notice | undefined) })
        try { return await rpc.predict({ sessionID: state.sessionID, completion: state.completion, requestID, ...(manual ? { manual: true } : {}), ...(escalation ? { escalation } : {}) }, { location: value.location, signal }) as Reply } finally { stop() }
      },
      paint: adapter.paint,
      insert: adapter.insert,
      communicate: adapter.communicate,
      focus: () => ctx.renderer.currentFocusedEditor?.focus(),
      show: notice => { ctx.ui.toast.show({ title: notice.title, message: notice.message + (notice.severity !== "info" ? "\nOpen Prediction status and preview from the command palette for details." : ""), variant: notice.severity, duration: 8000 }) },
      openStatus: async view => {
        if (await ctx.ui.dialog.confirm({ title: "Prediction status and preview", message: view.summary, label: { confirm: "Technical details", cancel: "Close" } })) await ctx.ui.dialog.alert({ title: "Prediction technical details", message: view.details })
      },
      diagnostics: () => ({ host: "CLI", hostVersion: ctx.app.version, clientVersion: pluginVersion, feedbackRevision, composerEligible: adapter.eligible() }),
    })
    ctx.keymap.layer(() => ({ priority: 20, commands: [
      { id: "predictions.accept", bind: "tab", run: () => client.accept() ? undefined : false },
      { id: "predictions.request", title: "Predict next prompt", group: "Predictions", palette: true, run: () => client.request() },
      { id: "predictions.request-shortcut", title: "Predict next prompt", bind: "alt+shift+p", run: () => client.requestFromShortcut() },
      { id: "predictions.status", title: "Prediction status and preview", group: "Predictions", palette: true, run: () => client.status() },
    ] }))
    const stopConfig = ctx.data.on("config.updated", () => client.invalidate())
    const stopPlugin = ctx.data.on("plugin.updated", () => client.invalidate())
    return () => { stopConfig(); stopPlugin(); client.dispose(); adapter.dispose() }
  },
})

import { Command, ComposerPill, Plugin, createKeyed } from "@opencode/plugin/gui"
import { onCleanup, createComponent, createSignal } from "solid-js"
import type { Data } from "@opencode/client/solid"
import { createDesktopAdapter } from "./adapters/desktop.ts"
import { startClient } from "./client.ts"
import { Predictions } from "./rpc.ts"
import type { Reply, Status } from "./service.ts"
import { pluginVersion, feedbackRevision, type Notice } from "./feedback.ts"
import { communicationText, type Communication } from "./controller.ts"

export default Plugin.define({
  setup(ctx) {
    const adapter = createDesktopAdapter(document, () => ctx.screen.current()?.composer)
    const session = () => ctx.sessions.current()
    const connection = () => {
      const value = session()
      if (value?.location) return { server: value.server, location: value.location }
      const server = ctx.servers.get("sidecar")
      const location = server?.data.location.default()
      return server && location ? { server, location } : undefined
    }
    let errorToast: { dismiss(): void } | undefined
    const [communication, setCommunication] = createSignal<{ value: Communication; activate: () => void; key: string }>()
    const client = startClient({
      scope: () => { const value = connection(); return value ? JSON.stringify([value.server.id, value.location]) : undefined },
      state: () => {
        const value = session()
        if (!value || !value.server.connected || !value.location || value.pending) return
        const data = value.server.data
        const info = data.session.get(value.id)
        if (!info || info.parentID || info.outcome === "interrupted" || data.session.status(value.id) !== "idle") return
        const completion = info.time.idle || info.time.updated
        if (!completion) return
        const eligible = adapter.eligible() && !data.session.pending.list(value.id).length && !data.session.permission.list(value.id)?.length && !data.session.form.list(value.id, value.location)?.length
        return { key: value.key + "/" + value.directory + "/" + completion, sessionID: value.id, completion, eligible, draft: adapter.read(), automaticEligible: !!info.time.idle }
      },
      status: async signal => {
        const value = connection()
        if (!value?.location) throw new Error("No location selected")
        return await value.server.client.rpc(Predictions).status({}, { location: value.location, signal }) as Status
      },
      predict: async (state, requestID, signal, notice, manual, escalation) => {
        const value = session()
        if (!value || value.id !== state.sessionID || !value.location) return { reason: "stale" }
        const rpc = value.server.client.rpc(Predictions)
        const stop = rpc.events.on("progress", event => { if (event.data.requestID === requestID && event.data.sessionID === state.sessionID) notice(String(event.data.message), event.data.notice as Notice | undefined) })
        try { return await rpc.predict({ sessionID: state.sessionID, completion: state.completion, requestID, ...(manual ? { manual: true } : {}), ...(escalation ? { escalation } : {}) }, { location: value.location, signal }) as Reply } finally { stop() }
      },
      paint: adapter.paint,
      insert: adapter.insert,
      communicate: (value, activate) => {
        adapter.communicate(value)
        const key = session()?.key
        setCommunication(value && key ? { value, activate, key } : undefined)
      },
      focus: () => ctx.screen.current()?.composer.focus(),
      show: notice => {
        const toast = ctx.toast.show({ title: notice.title, description: notice.message, variant: notice.severity === "error" ? "error" : "default", persistent: !!notice.persistent, duration: 8000, ...(notice.severity !== "info" ? { actions: [{ label: "Open prediction status", run: () => client.status() }] } : {}) })
        if (notice.severity !== "info") errorToast = toast
      },
      clearNotice: () => { errorToast?.dismiss(); errorToast = undefined },
      openStatus: view => {
        ctx.dialogs.open(dialog => {
          const [technical, setTechnical] = createSignal(false)
          const content = document.createElement("div")
          content.setAttribute("data-prediction-status", "")
          content.style.whiteSpace = "pre-wrap"
          content.style.overflowWrap = "anywhere"
          content.textContent = view.summary
          return createComponent(ctx.ui.Dialog, {
            title: "Prediction status and preview", size: "large", children: content,
            footer: [
              createComponent(ctx.ui.Button, { children: "Close", onClick: () => dialog.close() }),
              createComponent(ctx.ui.Button, { get children() { return technical() ? "Status summary" : "Technical details" }, variant: "contrast", onClick: () => { setTechnical(!technical()); content.textContent = technical() ? view.details : view.summary } }),
            ],
          })
        })
      },
      diagnostics: () => ({ host: "Desktop", hostVersion: ctx.app.version, clientVersion: pluginVersion, feedbackRevision, composerEligible: adapter.eligible() }),
    })
    const serverData = (): Data | undefined => connection()?.server.data
    createKeyed(serverData, data => {
      client.invalidate()
      onCleanup(data.on("config.updated", () => client.invalidate()))
      onCleanup(data.on("plugin.updated", () => client.invalidate()))
    })
    createKeyed(() => session()?.key, () => client.invalidate(), { otherwise: () => client.invalidate() })
    ctx.add(Command, { id: "accept", title: "Accept prompt prediction", bind: "tab", editable: true, hidden: true, run: () => client.accept() ? undefined : false })
    ctx.add(Command, { id: "request", title: "Predict next prompt", group: "Predictions", run: () => client.request() })
    ctx.add(Command, { id: "request-shortcut", title: "Predict next prompt", bind: "alt+shift+p", editable: true, hidden: true, run: () => client.requestFromShortcut() })
    ctx.add(Command, { id: "status", title: "Prediction status and preview", group: "Predictions", run: () => client.status() })
    ctx.add(ComposerPill, { id: "escalate", show: input => {
      const current = communication()
      if (!current?.value.offer || current.key !== input.session.key) return
      return { label: current.value.pending ? "Asking another model…" : "Ask another model", title: communicationText(current.value), ...(!current.value.pending ? { run: current.activate } : {}) }
    } })
    return () => { client.dispose(); adapter.dispose() }
  },
})

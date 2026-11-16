import { Plugin } from "@opencode/plugin/tui"
import { writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createStandaloneSetupOrigin } from "../../../src/setup-origin.ts"
import { createTUISetupAPI } from "../../../src/setup-tui-api.ts"
import { createSetupEditor } from "../../../src/setup.ts"
export default Plugin.define({
  id: "prediction-test-observer.tui",
  setup(ctx) {
    let originTimer: ReturnType<typeof setInterval> | undefined
    let origin: ReturnType<typeof createStandaloneSetupOrigin> | undefined
    if (process.env.PREDICTIONS_ORIGIN_OBSERVER) {
      origin = createStandaloneSetupOrigin(ctx)
      const selectedClient = ctx.client
      const observe = async () => {
        let localDispatches = 0, guardAllowed = false
        try { await origin!.dispatch(AbortSignal.timeout(2500), async () => { localDispatches++ }); guardAllowed = true }
        catch { /* Keep native metadata observation independent of guard authorization. */ }
        const base = { clientPid: process.pid, clientIdentityStable: ctx.client === selectedClient, guardAllowed, localDispatches }
        try {
          const info = await ctx.client.server.info({ signal: AbortSignal.timeout(5000) })
          if (!Number.isSafeInteger(info.pid) || info.pid <= 0) throw new Error("Invalid fixture server PID")
          const run = promisify(execFile)
          const parent = await run("/bin/ps", ["-p", String(info.pid), "-o", "ppid="])
          const command = await run("/bin/ps", ["-p", String(info.pid), "-o", "args="])
          const owner = await run("/bin/ps", ["-p", String(info.pid), "-o", "uid="])
          return {
            ...base, serverPid: info.pid, serverParentPid: Number(parent.stdout.trim()),
            privateServerCommand: /(?:^|\s)serve\s+--stdio\s+--port\s+0(?:\s|$)/.test(command.stdout),
            serverExecutableMatches: command.stdout.trimStart().startsWith(process.execPath + " serve --stdio --port 0"),
            serverSameUser: Number(owner.stdout.trim()) === process.getuid!(),
            hostVersion: ctx.app.version, serverVersion: info.version, contextKeys: Object.keys(ctx).sort(),
            serverAvailable: true,
          }
        } catch {
          return { ...base, serverAvailable: false }
        }
      }
      void observe().then(value => writeFile(process.env.PREDICTIONS_ORIGIN_OBSERVER!, JSON.stringify(value)))
      if (process.env.PREDICTIONS_ORIGIN_WATCH) {
        let busy = false
        originTimer = setInterval(() => {
          if (busy) return
          busy = true
          void observe().then(value => writeFile(process.env.PREDICTIONS_ORIGIN_OBSERVER! + ".after", JSON.stringify(value))).finally(() => { busy = false })
        }, 250)
      }
    }
    const handoff = ctx.storage?.memory?.("lifecycle-proof", { initial: { generations: 0, token: "" } })
    handoff?.[1](state => { state.generations++; state.token ||= crypto.randomUUID() })
    let lastKey: unknown
    const onKey = (event: { name: string; shift: boolean; meta: boolean; option: boolean }) => { if (event.name.toLowerCase() === "p") lastKey = { name: event.name, shift: event.shift, meta: event.meta, option: event.option } }
    ctx.renderer.keyInput.on("keypress", onKey)
    ctx.keymap.layer(() => ({ mode: "global", priority: 100, commands: [{ bind: "f8", run: async () => {
      if (process.env.PREDICTIONS_OBSERVER) await writeFile(process.env.PREDICTIONS_OBSERVER, JSON.stringify({ draft: ctx.renderer.currentFocusedEditor?.plainText, placeholder: (ctx.renderer.currentFocusedEditor as { placeholder?: unknown } | undefined)?.placeholder, shortcuts: ctx.keymap.shortcuts("predictions.request-shortcut"), mode: ctx.keymap.mode.current(), lastKey }))
    } }, { bind: "f9", run: () => ctx.keymap.dispatch("predictions.status") }, { bind: "f10", run: () => ctx.ui.dialog.clear() }, { bind: "f11", run: async () => {
      if (!process.env.PREDICTIONS_SAVE_TEST || !process.env.PREDICTIONS_OBSERVER) return
      const route = ctx.ui.router.current()
      const location = route.type === "session" ? ctx.data.session.get(route.sessionID)?.location : ctx.location
      if (!location) throw new Error("Fixture location is unavailable.")
      const editor = createSetupEditor(createTUISetupAPI(ctx, { directory: location.directory }), () => {})
      try {
        await editor.load()
        editor.change({ debug: true })
        const result = await editor.save()
        // Wait for the watcher-driven reload so later checks do not race the server's activation.
        const until = Date.now() + 10000
        while (Date.now() < until && editor.state().snapshot?.effective?.debug !== true) {
          await new Promise(resolve => setTimeout(resolve, 100))
          await editor.load()
        }
        await writeFile(process.env.PREDICTIONS_OBSERVER + ".save", JSON.stringify({ ...result, active: editor.state().snapshot?.effective?.debug === true }))
      } finally { editor.dispose() }
    } }, { bind: "f6", run: () => ctx.keymap.dispatch("predictions.setup") }, { bind: "f12", run: () => ctx.keymap.dispatch("predictions.request") }] }))
    if (process.env.PREDICTIONS_OBSERVER) {
      const observation = process.env.PREDICTIONS_OBSERVER
      void writeFile(observation + ".memory", JSON.stringify(handoff ? { available: true, generations: handoff[0].generations, token: handoff[0].token } : { available: false }))
        .then(() => writeFile(observation + ".ready", "ready"))
    }
    return () => { origin?.dispose(); clearInterval(originTimer); ctx.renderer.keyInput.off("keypress", onKey) }
  },
})

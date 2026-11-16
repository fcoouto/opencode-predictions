import { Plugin } from "@opencode/plugin/tui"
import { writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createStandaloneSetupOrigin } from "../../../src/setup-origin.ts"
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
    let lastKey: unknown
    const onKey = (event: { name: string; shift: boolean; meta: boolean; option: boolean }) => { if (event.name.toLowerCase() === "p") lastKey = { name: event.name, shift: event.shift, meta: event.meta, option: event.option } }
    ctx.renderer.keyInput.on("keypress", onKey)
    ctx.keymap.layer(() => ({ mode: "global", priority: 100, commands: [{ bind: "f8", run: async () => {
      if (process.env.PREDICTIONS_OBSERVER) await writeFile(process.env.PREDICTIONS_OBSERVER, JSON.stringify({ draft: ctx.renderer.currentFocusedEditor?.plainText, placeholder: (ctx.renderer.currentFocusedEditor as { placeholder?: unknown } | undefined)?.placeholder, shortcuts: ctx.keymap.shortcuts("predictions.request-shortcut"), mode: ctx.keymap.mode.current(), lastKey }))
    } }, { bind: "f9", run: () => ctx.keymap.dispatch("predictions.status") }, { bind: "f10", run: () => ctx.ui.dialog.clear() }] }))
    if (process.env.PREDICTIONS_OBSERVER) void writeFile(process.env.PREDICTIONS_OBSERVER + ".ready", "ready")
    return () => { origin?.dispose(); clearInterval(originTimer); ctx.renderer.keyInput.off("keypress", onKey) }
  },
})

import { Plugin } from "@opencode/plugin/tui"
import { writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createTUISetupAPI } from "../../../src/setup-tui-api.ts"
import { createSetupEditor } from "../../../src/setup.ts"
export default Plugin.define({
  id: "prediction-test-observer.tui",
  setup(ctx) {
    if (process.env.PREDICTIONS_OBSERVER) {
      const file = process.env.PREDICTIONS_OBSERVER + ".host"
      void ctx.client.server.info().then(async info => {
        const parent = await promisify(execFile)("/bin/ps", ["-p", String(info.pid), "-o", "ppid="])
        const command = await promisify(execFile)("/bin/ps", ["-p", String(info.pid), "-o", "args="])
        await writeFile(file, JSON.stringify({ hostVersion: ctx.app.version, serverVersion: info.version, serverPid: info.pid, clientPid: process.pid, serverParentPid: Number(parent.stdout.trim()), sharedService: /serve\s+--service(?:\s|$)/.test(command.stdout), standalone: /serve\s+--stdio(?:\s|$)/.test(command.stdout) }))
      })
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
    return () => { ctx.renderer.keyInput.off("keypress", onKey) }
  },
})

import { Plugin } from "@opencode/plugin/tui"
import { writeFile } from "node:fs/promises"
export default Plugin.define({
  id: "prediction-test-observer.tui",
  setup(ctx) {
    let lastKey: unknown
    const onKey = (event: { name: string; shift: boolean; meta: boolean; option: boolean }) => { if (event.name.toLowerCase() === "p") lastKey = { name: event.name, shift: event.shift, meta: event.meta, option: event.option } }
    ctx.renderer.keyInput.on("keypress", onKey)
    ctx.keymap.layer(() => ({ mode: "global", priority: 100, commands: [{ bind: "f8", run: async () => {
      if (process.env.PREDICTIONS_OBSERVER) await writeFile(process.env.PREDICTIONS_OBSERVER, JSON.stringify({ draft: ctx.renderer.currentFocusedEditor?.plainText, placeholder: (ctx.renderer.currentFocusedEditor as { placeholder?: unknown } | undefined)?.placeholder, shortcuts: ctx.keymap.shortcuts("predictions.request-shortcut"), mode: ctx.keymap.mode.current(), lastKey }))
    } }, { bind: "f9", run: () => ctx.keymap.dispatch("predictions.status") }, { bind: "f10", run: () => ctx.ui.dialog.clear() }] }))
    if (process.env.PREDICTIONS_OBSERVER) void writeFile(process.env.PREDICTIONS_OBSERVER + ".ready", "ready")
    return () => { ctx.renderer.keyInput.off("keypress", onKey) }
  },
})

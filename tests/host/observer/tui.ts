import { Plugin } from "@opencode/plugin/tui"
import { writeFile } from "node:fs/promises"
export default Plugin.define({
  id: "prediction-test-observer.tui",
  setup(ctx) {
    ctx.keymap.layer(() => ({ mode: "global", priority: 100, commands: [{ bind: "f8", run: async () => {
      if (process.env.PREDICTIONS_OBSERVER) await writeFile(process.env.PREDICTIONS_OBSERVER, JSON.stringify({ draft: ctx.renderer.currentFocusedEditor?.plainText }))
    } }, { bind: "f9", run: () => ctx.keymap.dispatch("predictions.status") }, { bind: "f10", run: () => ctx.ui.dialog.clear() }] }))
    if (process.env.PREDICTIONS_OBSERVER) void writeFile(process.env.PREDICTIONS_OBSERVER + ".ready", "ready")
  },
})

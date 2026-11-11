import { Plugin } from "@opencode/plugin/tui"
import { writeFile } from "node:fs/promises"
export default Plugin.define({
  id: "prediction-test-observer.tui",
  setup(ctx) {
    ctx.keymap.layer(() => ({ priority: 100, commands: [{ bind: "f8", run: async () => {
      if (process.env.PREDICTIONS_OBSERVER) await writeFile(process.env.PREDICTIONS_OBSERVER, JSON.stringify({ draft: ctx.renderer.currentFocusedEditor?.plainText }))
    } }] }))
  },
})

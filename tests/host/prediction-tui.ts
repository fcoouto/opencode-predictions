import { Plugin } from "@opencode/plugin/tui"
import { writeFile } from "node:fs/promises"
import predictions from "../../src/tui.ts"

const moduleRevision = 1
export default Plugin.define({
  ...predictions,
  setup(ctx) {
    const memory = ctx.storage.memory("save-mount-proof", { initial: { mounts: 0 } })
    memory[1](state => { state.mounts++ })
    if (process.env.PREDICTIONS_OBSERVER) void writeFile(process.env.PREDICTIONS_OBSERVER + ".prediction-memory", JSON.stringify({ mounts: memory[0].mounts, moduleRevision }))
    return predictions.setup(ctx)
  },
})

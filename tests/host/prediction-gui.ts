import { Plugin } from "@opencode/plugin/gui"
import predictions from "../../src/gui.ts"

export default Plugin.define({
  ...predictions,
  setup(ctx) {
    const memory = ctx.storage.memory("save-mount-proof", { initial: { mounts: 0 } })
    memory[1](state => { state.mounts++ })
    Object.defineProperty(window, "__predictionMounts", { configurable: true, get: () => memory[0].mounts })
    return predictions.setup?.(ctx)
  },
})

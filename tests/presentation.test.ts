import { test } from "node:test"
import assert from "node:assert/strict"
import tui from "../src/tui.ts"

test("CLI shows actionable error variants and reopens native status before a completed session", async () => {
  const toasts: any[] = []
  const dialogs: any[] = []
  const commands = new Map<string, any>()
  let technical = false
  const stop = tui.setup!({
    renderer: {}, location: { directory: "/fixture" }, app: { version: "test" },
    data: { location: { default: () => ({ directory: "/fixture" }) }, on: () => () => {} },
    client: { rpc: () => ({ status: async () => ({ enabled: false, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [], reason: "models_required" }) }) },
    ui: { router: { current: () => ({ type: "home" }) }, toast: { show: (options: unknown) => toasts.push(options) }, dialog: { confirm: async (options: unknown) => { dialogs.push(options); return technical }, alert: async (options: unknown) => { dialogs.push(options) } } },
    keymap: { layer: (factory: () => any) => { for (const command of factory().commands) commands.set(command.id, command) } },
  } as any)
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(toasts.length, 1)
    assert.equal(toasts[0].variant, "error")
    assert.match(toasts[0].message, /Prediction status and preview/)
    await commands.get("predictions.status").run()
    assert.match(dialogs[0].message, /snapshot.*Predictions need a model/s)
    assert.equal(dialogs[0].label.confirm, "Technical details")
    technical = true
    await commands.get("predictions.status").run()
    assert.match(dialogs[2].message, /Service plugin:/)
    assert.equal(toasts.length, 1)
  } finally { if (typeof stop === "function") stop() }
})

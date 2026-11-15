import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { mock } from "node:test"
import { createConfigStore } from "../../src/config.ts"
import type { ProbeHost } from "./persistence-candidate.ts"

process.once("message", async (input: { host: ProbeHost; revision: string; patch: Record<string, unknown>; hold: boolean }) => {
  const mkdir = fs.mkdir
  const replacement = mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await mkdir(...args)
    if (String(args[0]).endsWith(".predictions-setup.lock")) {
      process.send!({ kind: "locked" })
      if (input.hold) await new Promise(resolve => process.once("message", resolve))
    }
    return result
  })
  syncBuiltinESMExports()
  try {
    const store = createConfigStore({
      ...input.host, version: "2.2.6",
      source: async () => input.host.source.type === "local" && input.host.source.path ? { type: "local", path: input.host.source.path } : undefined,
      options: () => input.host.options,
    })
    process.send!({ kind: "started" })
    process.send!({ kind: "result", result: await store.write(input.revision, input.patch, new AbortController().signal) })
    process.disconnect!()
  } catch (error) { console.error(error); process.exitCode = 1; process.disconnect!() } finally {
    replacement.mock.restore()
    syncBuiltinESMExports()
  }
})

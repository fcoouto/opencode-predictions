import { Plugin } from "@opencode/plugin"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import predictions from "../../../src/index.ts"
import { PersistenceProbe } from "./rpc.ts"
import { createCandidate } from "../persistence-candidate.ts"

export default Plugin.define({
  id: predictions.id,
  async setup(ctx) {
    const cleanup = await predictions.setup(ctx)
    const mount = randomUUID()
    async function candidate() {
      const plugin = (await ctx.plugin.list()).data.find(entry => entry.id === predictions.id)
      if (plugin?.source.type !== "local") return
      return createCandidate({
        home: homedir(), directory: ctx.location.directory,
        env: Object.fromEntries(["XDG_CONFIG_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_DISABLE_PROJECT_CONFIG"].map(key => [key, process.env[key]])),
        source: plugin.source, options: ctx.options,
        systemPaths: process.platform === "darwin" ? [
          "/Library/Application Support/opencode",
          "/Library/Managed Preferences/ai.opencode.managed.plist",
          join("/Library/Managed Preferences", userInfo().username, "ai.opencode.managed.plist"),
        ] : ["/etc/opencode"],
      })
    }
    const registration = await ctx.rpc.register(PersistenceProbe, {
      read: async () => ({ ...await (await candidate())?.read(), mount, version: ctx.app.version }),
      save: async input => {
        const request = input as { revision: string; patch: Record<string, unknown>; loseAck?: boolean; markStarted?: boolean }
        const store = await candidate()
        if (request.markStarted) await writeFile(join(homedir(), ".persistence-probe-write-started"), "started", { mode: 0o600 })
        const result = await store?.write(request.revision, request.patch) ?? { kind: "read_only" }
        if (request.loseAck) await delay(2000)
        return result
      },
    })
    return async () => { await registration.dispose(); await cleanup?.() }
  },
})

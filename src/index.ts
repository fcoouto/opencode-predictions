import { Plugin } from "@opencode/plugin"
import { Predictions } from "./rpc.ts"
import { createService, type Request } from "./service.ts"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { createConfigStore } from "./config.ts"
import { createSetupService } from "./setup-service.ts"
import type { SettingsInput } from "./setup.ts"
import { startLocalSetup } from "./setup-local.ts"

export default Plugin.define({
  id: "opencode-predictions",
  async setup(ctx) {
    const service = createService({
      session: (sessionID, signal) => ctx.session.get({ sessionID }, { signal }),
      context: (sessionID, signal) => ctx.session.context({ sessionID }, { signal }),
      models: async signal => (await ctx.model.list(undefined, { signal })).data,
      generate: async (model, prompt, signal) => (await ctx.experimental.generate.text({ model, prompt }, { signal })).text,
      notice: async (message, request, notice) => { if (request.requestID) await registration.events.emit("progress", { message, requestID: request.requestID, sessionID: request.sessionID, ...(notice ? { notice } : {}) }) },
      progress: async (modelName, request) => { if (request.requestID) await registration.events.emit("progress", { message: "", modelName, requestID: request.requestID, sessionID: request.sessionID }) },
    }, ctx.options, ctx.location.directory)
    let username: string | undefined
    try { username = userInfo().username } catch {}
    const store = createConfigStore({
      version: ctx.app.version, home: homedir(), directory: ctx.location.directory,
      env: Object.fromEntries(["XDG_CONFIG_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_DISABLE_PROJECT_CONFIG"].map(key => [key, process.env[key]])),
      systemPaths: process.platform === "darwin" ? [
        "/Library/Application Support/opencode", "/Library/Managed Preferences/ai.opencode.managed.plist",
        username ? join("/Library/Managed Preferences", username, "ai.opencode.managed.plist") : "/Library/Managed Preferences",
      ] : ["/etc/opencode"],
      source: async signal => {
        if (!username) return
        const plugin = (await ctx.plugin.list(undefined, { signal })).data.find(entry => entry.id === "opencode-predictions")
        return plugin?.source.type === "local" && plugin.state.status === "active" ? plugin.source : undefined
      },
      options: () => ctx.options,
    })
    const setup = createSetupService(store, async signal => (await ctx.model.list(undefined, { signal })).data, () => ({ options: ctx.options, version: service.status().version }))
    let local: ReturnType<typeof startLocalSetup> | undefined, closing = false
    const registration = await ctx.rpc.register(Predictions, {
      predict: (input, context) => service.predict(input as Request, context.signal),
      status: (_input, context) => service.inspect(context.signal),
      settings: async (_input, context) => {
        const snapshot = await setup.read(context.signal)
        const location = { directory: ctx.location.directory, ...("workspaceID" in ctx.location && typeof ctx.location.workspaceID === "string" ? { workspaceID: ctx.location.workspaceID } : {}) }
        const authority = snapshot.writable && !closing ? await (local ??= startLocalSetup(location, setup)) : undefined
        if (closing) await authority?.dispose()
        return { ...snapshot, ...(authority && !closing ? { localAuthority: { id: authority.id } } : {}), writable: false, reason: snapshot.reason ?? "Saving requires a verified local setup connection." }
      },
      previewSettings: (input, context) => setup.preview((input as { fields: SettingsInput }).fields, context.signal),
    })
    return async () => {
      closing = true
      service.dispose()
      await (await local)?.dispose()
      await registration.dispose()
    }
  },
})

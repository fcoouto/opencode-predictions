import { Plugin } from "@opencode/plugin"
import { Predictions } from "./rpc.ts"
import { createService, type Request } from "./service.ts"
import { homedir, userInfo } from "node:os"
import { administrativePaths, createPreferencesStore } from "./preferences-store.ts"
import { createPreferencesRuntime } from "./preferences-runtime.ts"
import { createSetupService } from "./setup-service.ts"
import type { SaveInput, SettingsInput } from "./setup.ts"
import { readContextFile } from "./context-file.ts"
import { createGitHubContext } from "./github.ts"

export default Plugin.define({
  id: "opencode-predictions",
  async setup(ctx) {
    const lifetime = new AbortController()
    let username: string | undefined
    try { username = userInfo().username } catch {}
    const store = createPreferencesStore({
      home: homedir(), platform: process.platform, env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA },
      systemPaths: administrativePaths(process.platform, process.env, username),
    })
    const runtime = createPreferencesRuntime(store, options => createService({
      session: (sessionID, signal) => ctx.session.get({ sessionID }, { signal }),
      context: (sessionID, signal) => ctx.session.context({ sessionID }, { signal }),
      contextFile: readContextFile,
      includeGithubPRContext: createGitHubContext(),
      models: async signal => (await ctx.model.list(undefined, { signal })).data,
      generate: async (model, prompt, signal) => (await ctx.experimental.generate.text({ model, prompt }, { signal })).text,
      notice: async (message, request, notice) => { if (request.requestID) await registration.events.emit("progress", { message, requestID: request.requestID, sessionID: request.sessionID, ...(notice ? { notice } : {}) }) },
      progress: async (modelName, request) => { if (request.requestID) await registration.events.emit("progress", { message: "", modelName, requestID: request.requestID, sessionID: request.sessionID }) },
    }, options, ctx.location.directory))
    await runtime.refresh(lifetime.signal)
    const setup = createSetupService(store, async signal => (await ctx.model.list(undefined, { signal })).data, runtime)
    const signal = (parent: AbortSignal) => AbortSignal.any([parent, lifetime.signal])
    const registration = await ctx.rpc.register(Predictions, {
      predict: (input, context) => runtime.predict(input as Request, signal(context.signal)),
      status: async (_input, context) => { await runtime.refresh(signal(context.signal)); return runtime.state().service.inspect(signal(context.signal)) },
      settingsV2: (_input, context) => setup.read(signal(context.signal)),
      saveSettings: (input, context) => setup.save(input as SaveInput, signal(context.signal)),
      previewSettings: (input, context) => setup.preview((input as { fields: SettingsInput }).fields, signal(context.signal)),
    })
    return async () => {
      lifetime.abort()
      runtime.dispose()
      await registration.dispose()
    }
  },
})

import { OpenCode } from "@opencode/client"
import type { Plugin as GUIPlugin } from "@opencode/plugin/gui"
import type { SetupLocation, SetupSnapshot, SetupPreview } from "./setup.ts"
import { Predictions } from "./rpc.ts"
import { createDesktopSetupOrigin } from "./setup-origin.ts"
import { createNativeSetupAPI } from "./setup-native-api.ts"
import { validSetupLocation } from "./setup-local.ts"
import { SetupLocal } from "./setup-ipc.ts"
export function createMainSetupAPI(host: Pick<Parameters<GUIPlugin.MainSetup>[0], "app" | "signal" | "serverEndpoints">, serverID: string, location: SetupLocation) {
  if (!validSetupLocation(location)) throw new Error("Local setup is unavailable.")
  const endpoint = host.serverEndpoints.get(serverID)
  if (!endpoint) throw new Error("Local setup is unavailable.")
  const origin = createDesktopSetupOrigin(host, serverID)
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: endpoint.headers })
  const pinned = { ...location }
  return createNativeSetupAPI({
    read: async signal => await client.rpc(Predictions).settings({}, { location: pinned, signal }) as SetupSnapshot,
    preview: async (fields, signal) => await client.rpc(Predictions).previewSettings({ fields }, { location: pinned, signal }) as SetupPreview,
  }, pinned, (signal, local) => origin.dispatch(signal, async (_, signal) => {
    const info = await client.server.info({ signal })
    return origin.dispatch(signal, (_, signal) => local(info.pid, signal))
  }), () => origin.dispose())
}

export function registerSetupMain(ctx: Parameters<GUIPlugin.MainSetup>[0]): () => void {
  const apis = new Map<string, ReturnType<typeof createMainSetupAPI>>()
  const get = (window: number, input: { serverID: string; location: SetupLocation }) => {
    if (Object.keys(input).some(key => !["serverID", "location", "input"].includes(key)) || !validSetupLocation(input.location)) throw new Error("Local setup is unavailable.")
    const key = JSON.stringify([window, input.serverID, input.location.directory, input.location.workspaceID])
    let api = apis.get(key)
    if (!api) {
      if (apis.size >= 64) throw new Error("Reopen the window before opening more setup targets.")
      api = createMainSetupAPI(ctx, input.serverID, input.location)
      apis.set(key, api)
    }
    return api
  }
  const provider = ctx.provide(SetupLocal, {
    read: async (input, caller) => {
      if (Object.keys(input).some(key => !["serverID", "location"].includes(key))) throw new Error("Local setup is unavailable.")
      try { return await get(caller.window, input).read(caller.signal) }
      catch { throw new Error("Local setup is unavailable.") }
    },
    save: (input, caller) => get(caller.window, input).save(input.input, caller.signal),
  })
  const stop = ctx.windows.on("close", window => {
    for (const [key, api] of apis) if (JSON.parse(key)[0] === window.id) { api.dispose(); apis.delete(key) }
  })
  return () => { stop(); provider.dispose(); for (const api of apis.values()) api.dispose(); apis.clear() }
}

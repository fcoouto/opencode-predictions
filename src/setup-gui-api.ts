import type { Plugin as GUIPlugin } from "@opencode/plugin/gui"
import { Predictions } from "./rpc.ts"
import type { SetupAPI, SetupLocation, SetupSnapshot, SetupPreview, SaveResult } from "./setup.ts"
import { abortable } from "./service.ts"
import { waitForSetupSnapshot } from "./setup.ts"

export function createGUISetupAPI(ctx: Pick<Parameters<GUIPlugin.Setup>[0], "servers">, target: { serverID: string; location: SetupLocation }): SetupAPI {
  const pinned = { serverID: target.serverID, location: { ...target.location } }
  const server = ctx.servers.get(pinned.serverID)
  const client = server?.client
  const selected = () => {
    if (!client || ctx.servers.get(pinned.serverID)?.client !== client) throw new Error("This setup target changed. Reopen settings.")
    return client.rpc(Predictions)
  }
  return {
    async read(signal) {
      const snapshot = await waitForSetupSnapshot(async signal => await selected().settingsV2({}, { location: pinned.location, signal }) as SetupSnapshot, signal)
      selected()
      return snapshot
    },
    preview: async (fields, signal) => await selected().previewSettings({ fields }, { location: pinned.location, signal }) as SetupPreview,
    async save(input, signal) {
      const waiting = AbortSignal.any([signal, AbortSignal.timeout(12000)])
      const result = await abortable(() => selected().saveSettings(input, { location: pinned.location, signal: waiting }), waiting) as SaveResult
      selected()
      return result
    },
  }
}

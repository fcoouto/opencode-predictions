import type { Plugin as GUIPlugin } from "@opencode/plugin/gui"
import { SetupLocal } from "./setup-ipc.ts"
import { Predictions } from "./rpc.ts"
import type { SetupAPI, SetupLocation, SetupSnapshot, SetupPreview, SaveResult } from "./setup.ts"
import { abortable } from "./service.ts"
import { waitForSetupSnapshot } from "./setup.ts"

export function createGUISetupAPI(ctx: Pick<Parameters<GUIPlugin.Setup>[0], "servers" | "main">, target: { serverID: string; location: SetupLocation }): SetupAPI {
  const pinned = { serverID: target.serverID, location: { ...target.location } }
  const server = ctx.servers.get(pinned.serverID)
  const client = server?.client
  const selected = () => {
    if (!client || ctx.servers.get(pinned.serverID)?.client !== client) throw new Error("This setup target changed. Reopen settings.")
    return client.rpc(Predictions)
  }
  let local = false
  return {
    async read(signal) {
      selected()
      try {
        const waiting = AbortSignal.any([signal, AbortSignal.timeout(2000)])
        const snapshot = await abortable(() => ctx.main(SetupLocal).read(pinned, { signal: waiting }), waiting) as SetupSnapshot
        local = snapshot.writable
        return snapshot
      } catch {
        signal.throwIfAborted()
        local = false
        const snapshot = await waitForSetupSnapshot(async signal => await selected().settings({}, { location: pinned.location, signal }) as SetupSnapshot, signal)
        return { ...snapshot, writable: false, reason: snapshot.reason ?? "Local setup is unavailable." }
      }
    },
    preview: async (fields, signal) => await selected().previewSettings({ fields }, { location: pinned.location, signal }) as SetupPreview,
    async save(input, signal) {
      selected()
      if (!local) return { kind: "read_only", message: "Local setup is unavailable." }
      const waiting = AbortSignal.any([signal, AbortSignal.timeout(12000)])
      return await abortable(() => ctx.main(SetupLocal).save({ ...pinned, input }, { signal: waiting }), waiting) as SaveResult
    },
  }
}

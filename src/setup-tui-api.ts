import type { Plugin as TUIPlugin } from "@opencode/plugin/tui"
import { Predictions } from "./rpc.ts"
import { readContextStatus, waitForSetupSnapshot, type ContextFileStatus, type SetupAPI, type SetupLocation, type SetupSnapshot, type SetupPreview, type SaveResult } from "./setup.ts"
import { abortable } from "./service.ts"
export function createTUISetupAPI(ctx: Pick<TUIPlugin.Context, "client">, location: SetupLocation): SetupAPI {
  const client = ctx.client, pinned = { ...location }
  const selected = () => {
    if (ctx.client !== client) throw new Error("This setup target changed. Reopen settings.")
    return client.rpc(Predictions)
  }
  return {
    async read(signal) {
      const snapshot = await waitForSetupSnapshot(async signal => await selected().settingsV2({}, { location: pinned, signal }) as SetupSnapshot, signal)
      selected()
      return snapshot
    },
    preview: async (fields, signal) => await selected().previewSettings({ fields }, { location: pinned, signal }) as SetupPreview,
    // A reply, or an old server's refusal, counts only while the pinned client is still the selected one.
    contextStatus: async signal => await readContextStatus(async signal => {
      try { return await selected().contextFileStatus({}, { location: pinned, signal }) as ContextFileStatus }
      finally { selected() }
    }, signal),
    async save(input, signal) {
      const waiting = AbortSignal.any([signal, AbortSignal.timeout(12000)])
      const result = await abortable(() => selected().saveSettings(input, { location: pinned, signal: waiting }), waiting) as SaveResult
      selected()
      return result
    },
  }
}

import type { Plugin as TUIPlugin } from "@opencode/plugin/tui"
import { createStandaloneSetupOrigin, type StandaloneRuntime } from "./setup-origin.ts"
import { Predictions } from "./rpc.ts"
import type { SetupLocation, SetupSnapshot, SetupPreview } from "./setup.ts"
import { createNativeSetupAPI } from "./setup-native-api.ts"
export function createTUISetupAPI(ctx: Pick<TUIPlugin.Context, "app" | "client">, location: SetupLocation, runtime?: StandaloneRuntime) {
  const client = ctx.client, pinned = { ...location }
  const origin = createStandaloneSetupOrigin(ctx, runtime)
  return createNativeSetupAPI({
    read: async signal => await client.rpc(Predictions).settings({}, { location: pinned, signal }) as SetupSnapshot,
    preview: async (fields, signal) => await client.rpc(Predictions).previewSettings({ fields }, { location: pinned, signal }) as SetupPreview,
  }, pinned, (signal, local) => origin.dispatch(signal, (identity, signal) => local(identity.serverPid, signal)), () => origin.dispose(), () => origin.revoked())
}

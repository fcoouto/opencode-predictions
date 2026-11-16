import { readLocalSetup, saveLocalSetup, type LocalSetupTarget, validSetupLocation } from "./setup-local.ts"
import { validateSettings, waitForSetupSnapshot, type SetupAPI, type SetupLocation, type SetupSnapshot } from "./setup.ts"

export type NativeDispatch = <Value>(signal: AbortSignal, local: (serverPid: number, signal: AbortSignal) => Promise<Value>) => Promise<Value>
export function createNativeSetupAPI(network: Pick<SetupAPI, "read" | "preview">, location: SetupLocation, dispatch: NativeDispatch, dispose: () => void): SetupAPI & { dispose(): void } {
  const pinned = { ...location }
  let target: LocalSetupTarget | undefined, source: string | undefined
  const readonly = () => ({ kind: "read_only" as const, message: "This target is not verified for local setup." })
  return {
    async read(signal) {
      target = undefined
      const remote = await waitForSetupSnapshot(network.read, signal)
      try {
        if (!validSetupLocation(pinned) || !remote.localAuthority || source !== undefined && remote.source !== source) throw new Error()
        const local = await dispatch(signal, async (serverPid, signal) => {
          const candidate = { id: remote.localAuthority!.id, serviceVersion: remote.serviceVersion, location: pinned, serverPid }
          const value = await readLocalSetup(candidate, signal)
          if (value.source !== remote.source || value.revision !== remote.revision || JSON.stringify(value.fields) !== JSON.stringify(remote.fields)) throw new Error()
          target = candidate
          return value
        })
        if (local.writable) source ??= local.source
        else target = undefined
        return local
      } catch {
        target = undefined
        signal.throwIfAborted()
        return { ...remote, writable: false, reason: remote.reason ?? readonly().message }
      }
    },
    preview: (fields, signal) => network.preview(fields, signal),
    async save(input, signal) {
      if (!target) return readonly()
      const issues = validateSettings(input.fields)
      if (issues.length) return { kind: "invalid", issues }
      const selected = target
      const remote: SetupSnapshot = await waitForSetupSnapshot(network.read, signal)
      if (remote.localAuthority?.id !== selected.id || remote.serviceVersion !== selected.serviceVersion || remote.source !== source) { target = undefined; return readonly() }
      try {
        return await dispatch(signal, (serverPid, signal) => {
          if (serverPid !== selected.serverPid || target !== selected) throw new Error("This target is not verified for local setup.")
          return saveLocalSetup(selected, input, signal)
        })
      } catch (error) {
        target = undefined
        if (String(error).includes("not verified for local setup")) return readonly()
        // The write may have committed; only the editor's readback can establish its outcome.
        throw new Error("Local setup is unavailable.")
      }
    },
    dispose() { target = undefined; dispose() },
  }
}

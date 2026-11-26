import { spawn } from "node:child_process"
import { win32 } from "node:path"
import { fileURLToPath } from "node:url"
import type { PreferencesWriteResult } from "./preferences-store.ts"

const limit = 65536, wireLimit = 192 * 1024
const unavailable = "Windows prediction preferences cannot be read or verified. Check the server's configuration directory."
const helperUnavailable = "Windows prediction preferences verifier could not run. Check that the npm release is installed on the server."
const helperTimeout = "Windows prediction preferences verifier timed out."
const uncertain = "Changes may have been saved. Reopen settings before trying again."
const readOnly = "Windows prediction preferences are not writable."
const refused = "Windows prediction preferences were not saved. Check file and backup permissions, then reopen settings."
const conflict = "Prediction preferences changed. Reload settings before saving."
// The reasons the verifier may give for refusing the fixed context file. Anything else is not trusted.
const contextReasons = new Set(["it is a link", "it is not a regular file", "it has more than one link", "it is owned by another user", "other users can write to it", "it changed while it was checked", "its access rules cannot be read"])
export const contextRefusal = (reason: string) => `predictions-context.md exists but is not safe to use: ${reason}. Fix or remove it, then save again.`
const inputPrefix = "OPENCODE_PREDICTIONS_IO_"
const inputChunk = 16 * 1024
const verifier = fileURLToPath(new URL("../dist/predictions-verifier.exe", import.meta.url))

export type WindowsSnapshot = {
  source: string; state: "user" | "managed" | "unavailable"; writable: boolean
  expected: string; present: boolean; bytes: Buffer; reason?: string
}
type WindowsCommit = { kind: "written"; snapshot: WindowsSnapshot } | Exclude<PreferencesWriteResult, { kind: "written" }>
type Request = { op: "read"; source: string; systemPaths: readonly string[] }
  | { op: "commit"; source: string; systemPaths: readonly string[]; expected: string; bytes: string; context?: "create" }
type Invoke = (request: Request, signal: AbortSignal) => Promise<string>
class HelperRefusal extends Error {}

export function windowsLocalRoot(value: string): boolean {
  if (!/^[A-Za-z]:[\\/]/.test(value)) return false
  const components = value.slice(3).replace(/[\\/]$/, "").split(/[\\/]/)
  return components.length === 1 && components[0] === "" || components.every(part =>
    part.length > 0 && !/[\x00-\x1f<>:"|?*]|[. ]$/.test(part)
    && !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³]) *(?:\.|$)/i.test(part))
}

export async function invokeWindows(request: Request, signal: AbortSignal, executable = verifier): Promise<string> {
  signal.throwIfAborted()
  if (process.arch !== "x64") throw new HelperRefusal("Windows prediction preferences are supported on x64 servers only.")
  const root = process.env.SystemRoot
  if (process.platform !== "win32" || !root || !windowsLocalRoot(root)) throw new HelperRefusal(helperUnavailable)
  const system = win32.join(root, "System32")
  const packet = Buffer.from(JSON.stringify(request)).toString("base64")
  if (packet.length > wireLimit) throw new HelperRefusal(helperUnavailable)
  const env: NodeJS.ProcessEnv = { SystemRoot: root, PATH: system, TMP: process.env.TMP, TEMP: process.env.TEMP, USERPROFILE: process.env.USERPROFILE }
  // Windows may stall on Bun's stdin pipe. Keep input out of command arguments
  // and disk. The verifier removes these child-only values before processing.
  for (let i = 0; i * inputChunk < packet.length; i++) env[inputPrefix + i] = packet.slice(i * inputChunk, (i + 1) * inputChunk)
  const deadline = AbortSignal.timeout(1800)
  try {
    const child = spawn(executable, [], {
      cwd: system, env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], signal: AbortSignal.any([signal, deadline]),
    })
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const output: Buffer[] = []
      let length = 0, failed = false
      child.on("error", () => { failed = true })
      child.stdout.on("data", (chunk: Buffer) => {
        length += chunk.length
        if (length > wireLimit) { failed = true; child.kill() }
        else output.push(chunk)
      })
      child.once("close", code => {
        if (failed || code !== 0) reject(new Error(helperUnavailable))
        else resolve(Buffer.concat(output))
      })
    })
    if (deadline.aborted) throw new HelperRefusal(helperTimeout)
    signal.throwIfAborted()
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    signal.throwIfAborted()
    throw new HelperRefusal(deadline.aborted ? helperTimeout : helperUnavailable)
  }
}

const denied = (source: string, reason = unavailable): WindowsSnapshot => ({
  source, state: "unavailable", expected: "", writable: false, present: false, bytes: Buffer.alloc(0), reason,
})
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(unavailable)
  return value as Record<string, unknown>
}
function reply(text: string) {
  if (Buffer.byteLength(text) > wireLimit) throw new Error(unavailable)
  return object(JSON.parse(text))
}
function snapshot(data: unknown, source: string): WindowsSnapshot {
  const { source: path, state, expected, writable, bytes } = object(data)
  if (path !== source || typeof writable !== "boolean" || typeof expected !== "string") throw new Error(unavailable)
  if (state === "unavailable" && !writable && !expected && bytes === null) return denied(source)
  if (state === "managed" && !writable && !expected && bytes === null) return { ...denied(source), state, reason: undefined }
  if (state !== "user" || !/^[a-f0-9]{64}$/.test(expected) || bytes !== null && typeof bytes !== "string") throw new Error(unavailable)
  const decoded = Buffer.from(bytes ?? "", "base64")
  if (decoded.length > limit || bytes !== null && decoded.toString("base64") !== bytes) throw new Error(unavailable)
  return { source, state, expected, writable, present: bytes !== null, bytes: decoded, ...(!writable ? { reason: readOnly } : {}) }
}

export function createWindowsIO(invoke: Invoke = invokeWindows) {
  return {
    async readWindowsPreferences(source: string, systemPaths: readonly string[], signal: AbortSignal): Promise<WindowsSnapshot> {
      signal.throwIfAborted()
      try {
        const result = reply(await invoke({ op: "read", source, systemPaths }, signal))
        signal.throwIfAborted()
        if (result.kind === "snapshot") return snapshot(result.snapshot, source)
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof HelperRefusal) return denied(source, error.message)
      }
      return denied(source)
    },
    // context "create" makes the verifier create or adopt predictions-context.md before it replaces the preferences.
    async commitWindowsPreferences(before: WindowsSnapshot, systemPaths: readonly string[], next: Uint8Array, signal: AbortSignal, context?: "create"): Promise<WindowsCommit> {
      signal.throwIfAborted()
      if (!before.writable || before.state !== "user") return { kind: "read_only", message: readOnly }
      if (next.byteLength > limit) return { kind: "failed", message: refused }
      const bytes = Buffer.from(next)
      try {
        const result = reply(await invoke({ op: "commit", source: before.source, systemPaths, expected: before.expected, bytes: bytes.toString("base64"), ...(context ? { context } : {}) }, signal))
        if (result.kind === "conflict") return { kind: "conflict", message: conflict }
        if (result.kind === "read_only") return { kind: "read_only", message: readOnly }
        if (result.kind === "failed") return { kind: "failed", message: refused }
        // The verifier refuses before predictions.json is replaced; the backup copy may already have changed. A refusal that was not asked for, or carries an unknown reason, proves nothing.
        if (result.kind === "refused_context" && context === "create" && typeof result.reason === "string" && contextReasons.has(result.reason)) return { kind: "refused_context", message: contextRefusal(result.reason) }
        if (result.kind === "written") {
          const persisted = snapshot(result.snapshot, before.source)
          if (persisted.state === "user" && persisted.present && persisted.bytes.equals(bytes)) return { kind: "written", snapshot: persisted }
        }
      } catch {
        // Once sent, a lost response cannot establish that replacement did not occur.
      }
      return { kind: "failed", message: uncertain }
    },
  }
}

export type WindowsIO = ReturnType<typeof createWindowsIO>
export const { readWindowsPreferences, commitWindowsPreferences } = createWindowsIO()

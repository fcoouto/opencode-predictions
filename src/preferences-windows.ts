import { spawn } from "node:child_process"
import { win32 } from "node:path"
import type { PreferencesWriteResult } from "./preferences-store.ts"
import { windowsScript } from "./preferences-windows-script.ts"

const limit = 65536, wireLimit = 192 * 1024
const unavailable = "Windows prediction preferences cannot be read or verified. Check the server's configuration directory."
const helperUnavailable = "Windows PowerShell could not verify prediction preferences."
const helperTimeout = "Windows PowerShell timed out while verifying prediction preferences."
const uncertain = "Changes may have been saved. Reopen settings before trying again."
const readOnly = "Windows prediction preferences are not writable."
const refused = "Windows prediction preferences were not saved. Check file and backup permissions, then reopen settings."
const conflict = "Prediction preferences changed. Reload settings before saving."
const bootstrap = Buffer.from(
  "$ErrorActionPreference='Stop'; $code=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())); & ([ScriptBlock]::Create($code))",
  "utf16le",
).toString("base64")

export type WindowsSnapshot = {
  source: string; state: "user" | "managed" | "unavailable"; writable: boolean
  expected: string; present: boolean; bytes: Buffer; reason?: string
}
type WindowsCommit = { kind: "written"; snapshot: WindowsSnapshot } | Exclude<PreferencesWriteResult, { kind: "written" }>
type Request = { op: "read"; source: string; systemPaths: readonly string[] }
  | { op: "commit"; source: string; systemPaths: readonly string[]; expected: string; bytes: string }
type Invoke = (request: Request, signal: AbortSignal) => Promise<string>
type ChildOptions = { cwd: string; windowsHide: true; signal: AbortSignal; env: NodeJS.ProcessEnv }
type BunRuntime = { spawn: (args: string[], options: ChildOptions & { stdin: Blob; stdout: "pipe"; stderr: "ignore" }) => {
  stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void
} }
class HelperRefusal extends Error {}

export function windowsLocalRoot(value: string): boolean {
  if (!/^[A-Za-z]:[\\/]/.test(value)) return false
  const components = value.slice(3).replace(/[\\/]$/, "").split(/[\\/]/)
  return components.length === 1 && components[0] === "" || components.every(part =>
    part.length > 0 && !/[\x00-\x1f<>:"|?*]|[. ]$/.test(part)
    && !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³]) *(?:\.|$)/i.test(part))
}

export async function invokeWindows(request: Request, signal: AbortSignal, script = windowsScript): Promise<string> {
  signal.throwIfAborted()
  const root = process.env.SystemRoot
  if (process.platform !== "win32" || !root || !windowsLocalRoot(root)) throw new HelperRefusal(helperUnavailable)
  const system = win32.join(root, "System32"), powershell = win32.join(system, "WindowsPowerShell", "v1.0")
  const deadline = AbortSignal.timeout(1800)
  const args = [win32.join(powershell, "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", bootstrap]
  const options: ChildOptions = {
    cwd: system, windowsHide: true,
    signal: AbortSignal.any([signal, deadline]),
    env: { SystemRoot: root, PATH: system, PSModulePath: win32.join(powershell, "Modules"),
      TMP: process.env.TMP, TEMP: process.env.TEMP, USERPROFILE: process.env.USERPROFILE },
  }
  const packet = `${Buffer.from(script).toString("base64")}\n${Buffer.from(JSON.stringify(request)).toString("base64")}\n`
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
  try {
    // Bun's Node-style Windows stdin pipe can stall; pass the complete packet at spawn.
    const bytes = bun ? await runBun(bun, args, options, packet) : await runNode(args, options, packet)
    if (deadline.aborted) throw new HelperRefusal(helperTimeout)
    signal.throwIfAborted()
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    signal.throwIfAborted()
    throw new HelperRefusal(deadline.aborted ? helperTimeout : helperUnavailable)
  }
}

async function runBun(bun: BunRuntime, args: string[], options: ChildOptions, packet: string) {
  const child = bun.spawn(args, { ...options, stdin: new Blob([packet]), stdout: "pipe", stderr: "ignore" })
  const reader = child.stdout.getReader(), output: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.length
      if (length > wireLimit) throw new Error(helperUnavailable)
      output.push(chunk.value)
    }
    if (await child.exited !== 0) throw new Error(helperUnavailable)
    return Buffer.concat(output)
  } catch (error) {
    child.kill()
    await child.exited
    throw error
  } finally { reader.releaseLock() }
}

function runNode([file, ...args]: string[], options: ChildOptions, packet: string): Promise<Buffer> {
  const child = spawn(file, args, { ...options, stdio: ["pipe", "pipe", "ignore"] })
  return new Promise((resolve, reject) => {
    const output: Buffer[] = []
    let length = 0, failed = false
    child.on("error", () => { failed = true })
    child.stdin.on("error", () => { failed = true })
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length
      if (length > wireLimit) {
        failed = true
        child.kill()
      } else output.push(chunk)
    })
    child.once("close", code => {
      if (failed || code !== 0) reject(new Error(helperUnavailable))
      else resolve(Buffer.concat(output))
    })
    child.stdin.end(packet)
  })
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
    async commitWindowsPreferences(before: WindowsSnapshot, systemPaths: readonly string[], next: Uint8Array, signal: AbortSignal): Promise<WindowsCommit> {
      signal.throwIfAborted()
      if (!before.writable || before.state !== "user") return { kind: "read_only", message: readOnly }
      if (next.byteLength > limit) return { kind: "failed", message: refused }
      const bytes = Buffer.from(next)
      try {
        const result = reply(await invoke({ op: "commit", source: before.source, systemPaths, expected: before.expected, bytes: bytes.toString("base64") }, signal))
        if (result.kind === "conflict") return { kind: "conflict", message: conflict }
        if (result.kind === "read_only") return { kind: "read_only", message: readOnly }
        if (result.kind === "failed") return { kind: "failed", message: refused }
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

export const { readWindowsPreferences, commitWindowsPreferences } = createWindowsIO()

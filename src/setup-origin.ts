import type { Plugin as GUIPlugin } from "@opencode/plugin/gui"
import { execFile } from "node:child_process"
import { basename, isAbsolute } from "node:path"
import { promisify } from "node:util"
import { abortable } from "./service.ts"

type DesktopHost = Pick<Parameters<GUIPlugin.MainSetup>[0], "app" | "signal" | "serverEndpoints">
type OriginClient = { server: { info(options: { signal: AbortSignal }): Promise<{ pid: number; version: string }> } }
type StandaloneHost = { app: { version: string }; readonly client: OriginClient }
export type OriginProcess = { parent: number; uid: number; command: string; started: string }
export type StandaloneRuntime = {
  platform: string; pid: number; uid: number; executable: string; argv: readonly string[]; env: Record<string, string | undefined>
  inspect(pid: number, signal: AbortSignal): Promise<OriginProcess | undefined>
}
export type SetupOrigin<Identity> = {
  dispatch<Value>(signal: AbortSignal, local: (identity: Identity, signal: AbortSignal) => Promise<Value>): Promise<Value>
  dispose(): void
}

function refuse(lifetime: AbortController): never {
  const error = new Error("This target is not verified for local setup.")
  lifetime.abort(error)
  throw error
}

export function createDesktopSetupOrigin(host: DesktopHost, serverID: string): SetupOrigin<{ serverID: string }> {
  const lifetime = new AbortController()
  const snapshot = () => {
    try {
      if (host.app.version !== "2.3.0" || host.app.platform !== "desktop") return
      const endpoint = host.serverEndpoints.get(serverID)
      if (!endpoint || endpoint.id !== serverID || endpoint.sameMachine !== true) return
      return JSON.stringify([endpoint.id, endpoint.url, endpoint.password, Object.entries(endpoint.headers).sort(([a], [b]) => a.localeCompare(b))])
    } catch { return }
  }
  const pinned = snapshot()
  return {
    async dispatch(signal, local) {
      signal = AbortSignal.any([signal, host.signal, lifetime.signal])
      signal.throwIfAborted()
      if (!pinned || snapshot() !== pinned) refuse(lifetime)
      const value = await abortable(() => local({ serverID }, signal), signal)
      signal.throwIfAborted()
      if (snapshot() !== pinned) refuse(lifetime)
      return value
    },
    dispose() { lifetime.abort() },
  }
}

function standaloneArguments(argv: readonly string[]): boolean {
  const seen = new Set<string>()
  let directory = false
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index] === "-c" ? "--continue" : argv[index] === "-s" ? "--session" : argv[index]
    if (["--standalone", "--continue", "--auto", "--print-logs", "--session", "--prompt", "--log-level"].includes(arg)) {
      if (seen.has(arg)) return false
      seen.add(arg)
      if (["--session", "--prompt", "--log-level"].includes(arg)) {
        const value = argv[++index]
        if (!value || value.startsWith("-")) return false
      }
    } else {
      if (directory || !(isAbsolute(arg) || arg === "." || arg === ".." || arg.startsWith("./") || arg.startsWith("../"))) return false
      directory = true
    }
  }
  return seen.has("--standalone")
}

const routingEnvironment = [
  "OPENCODE_SERVER", "OPENCODE_SERVER_URL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "NODE_OPTIONS", "BUN_OPTIONS", "BUN_BE_BUN", "OPENCODE_DRIVE",
] as const

function nativeRuntime(): StandaloneRuntime {
  const run = promisify(execFile)
  return {
    platform: process.platform, pid: process.pid, uid: process.getuid?.() ?? -1, executable: process.execPath,
    get argv() { return process.argv },
    get env() { return process.env },
    async inspect(pid, signal) {
      const { stdout } = await run("/bin/ps", ["-p", String(pid), "-o", "ppid=,uid=,lstart=,args="], {
        signal, timeout: 1000, maxBuffer: 8192, env: { LC_ALL: "C" },
      })
      const fields = stdout.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)\s*$/)
      return fields ? { parent: Number(fields[1]), uid: Number(fields[2]), started: fields[3].replace(/\s+/g, " "), command: fields[4].trim() } : undefined
    },
  }
}

export function createStandaloneSetupOrigin(host: StandaloneHost, runtime: StandaloneRuntime = nativeRuntime()): SetupOrigin<{ serverPid: number }> {
  const lifetime = new AbortController()
  const client = host.client
  const argv = JSON.stringify(runtime.argv)
  const executable = runtime.executable, pid = runtime.pid, uid = runtime.uid
  let anchor: { pid: number; started: string } | undefined
  const qualified = () => host.app.version === "2.2.6" && host.client === client && runtime.platform === "darwin"
    && runtime.pid === pid && runtime.uid === uid && uid >= 0 && runtime.executable === executable
    && isAbsolute(executable) && basename(executable) === "opencode" && JSON.stringify(runtime.argv) === argv
    && standaloneArguments(runtime.argv) && !routingEnvironment.some(key => !!runtime.env[key])
  return {
    async dispatch(signal, local) {
      signal = AbortSignal.any([signal, lifetime.signal])
      signal.throwIfAborted()
      let serverPid: number
      try {
        if (!qualified()) refuse(lifetime)
        const verification = AbortSignal.any([signal, AbortSignal.timeout(2000)])
        const info = await abortable(() => client.server.info({ signal: verification }), verification)
        if (info.version !== "2.2.6" || !Number.isSafeInteger(info.pid) || info.pid <= 0 || info.pid === pid) refuse(lifetime)
        if (anchor && anchor.pid !== info.pid) refuse(lifetime)
        const process = await abortable(() => runtime.inspect(info.pid, verification), verification)
        verification.throwIfAborted()
        if (!process || process.parent !== pid || process.uid !== uid || process.command !== executable + " serve --stdio --port 0" || !process.started) refuse(lifetime)
        if (anchor && anchor.started !== process.started) refuse(lifetime)
        if (!qualified()) refuse(lifetime)
        anchor ??= { pid: info.pid, started: process.started }
        serverPid = info.pid
      } catch {
        signal.throwIfAborted()
        refuse(lifetime)
      }
      const value = await abortable(() => local({ serverPid }, signal), signal)
      signal.throwIfAborted()
      if (!qualified()) refuse(lifetime)
      return value
    },
    dispose() { lifetime.abort() },
  }
}

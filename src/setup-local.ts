import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, realpath, rmdir, unlink } from "node:fs/promises"
import { createConnection, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join, isAbsolute } from "node:path"
import { abortable } from "./service.ts"
import { validateSettings, type SetupAPI, type SetupLocation, type SetupSnapshot, type SaveInput, type SaveResult } from "./setup.ts"

export type LocalSetupTarget = { id: string; serviceVersion: string; location: SetupLocation; serverPid: number }
const requestLimit = 65536, responseLimit = 8388608, deadline = 10000
const failure = () => new Error("Local setup is unavailable.")
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
export function validSetupLocation(value: unknown): value is SetupLocation {
  return object(value) && keys(value, ["directory", "workspaceID"]) && typeof value.directory === "string" && isAbsolute(value.directory)
    && !value.directory.includes("\0") && (value.workspaceID === undefined || typeof value.workspaceID === "string" && !!value.workspaceID)
}
function sameLocation(a: SetupLocation, b: SetupLocation) { return a.directory === b.directory && a.workspaceID === b.workspaceID }
function validSave(value: unknown): value is SaveInput {
  if (!object(value) || !keys(value, ["revision", "fields", "removeModels"]) || typeof value.revision !== "string" || !value.revision
    || value.removeModels !== undefined && value.removeModels !== true) return false
  try { validateSettings(value.fields as SaveInput["fields"]); return !(value.removeModels && Object.hasOwn(value.fields as object, "models")) }
  catch { return false }
}
async function socketPath(id: string) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw failure()
  const directory = join(await realpath(tmpdir()), "pp-" + id), path = join(directory, "s")
  if (Buffer.byteLength(path) > 100) throw failure()
  return { directory, path }
}
async function safePath(directory: string, path: string) {
  const parent = await lstat(directory), socket = await lstat(path), uid = process.getuid?.()
  if (uid === undefined || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o7777) !== 0o700
    || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o7777) !== 0o600) throw failure()
}

export async function startLocalSetup(location: SetupLocation, api: Pick<SetupAPI, "read" | "save">): Promise<{ id: string; dispose(): Promise<void> } | undefined> {
  const lifetime = new AbortController(), sockets = new Set<Socket>()
  let owned: { directory: string; path: string; dev: number; ino: number; socketDev?: number; socketIno?: number } | undefined
  const server = createServer({ allowHalfOpen: true }, socket => {
    if (lifetime.signal.aborted || sockets.size >= 16) { socket.destroy(); return }
    sockets.add(socket)
    const cancelled = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, cancelled.signal, AbortSignal.timeout(deadline)])
    const stop = () => socket.destroy()
    signal.addEventListener("abort", stop, { once: true })
    socket.on("error", () => {})
    socket.on("close", () => { sockets.delete(socket); cancelled.abort(); signal.removeEventListener("abort", stop) })
    let chunks: Buffer[] = [], size = 0
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > requestLimit) { socket.destroy(); return }
      chunks.push(chunk)
    })
    socket.on("end", () => { void (async () => {
      try {
        signal.throwIfAborted()
        const text = Buffer.concat(chunks).toString("utf8")
        chunks = []
        if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw failure()
        const input: unknown = JSON.parse(text)
        if (!object(input) || !keys(input, ["id", "serviceVersion", "serverPid", "location", "method", "input"]) || input.id !== id || input.serverPid !== process.pid
          || !validSetupLocation(input.location) || !sameLocation(input.location, pinned)
          || input.method !== "read" && input.method !== "save"
          || input.method === "read" && Object.hasOwn(input, "input") || input.method === "save" && !validSave(input.input)) throw failure()
        await safePath(owned!.directory, owned!.path)
        const current = await lstat(owned!.path), parent = await lstat(owned!.directory)
        if (current.dev !== owned!.socketDev || current.ino !== owned!.socketIno || parent.dev !== owned!.dev || parent.ino !== owned!.ino) throw failure()
        const snapshot = await abortable(() => api.read(signal), signal)
        if (input.serviceVersion !== snapshot.serviceVersion) throw failure()
        let value: SetupSnapshot | SaveResult
        if (input.method === "read") value = { ...snapshot, localAuthority: { id } }
        else if (!snapshot.writable) value = { kind: "read_only", message: "This configuration is read-only." }
        else value = await abortable(() => api.save(input.input as SaveInput, signal), signal)
        signal.throwIfAborted()
        const output = JSON.stringify({ pid: process.pid, value }) + "\n"
        if (Buffer.byteLength(output) > responseLimit) throw failure()
        socket.end(output)
      } catch { if (!socket.destroyed) socket.end('{"error":"Local setup is unavailable."}\n') }
    })() })
  })
  server.on("error", () => {})
  const id = randomBytes(8).toString("hex"), pinned = { ...location }
  const dispose = async () => {
    lifetime.abort()
    for (const socket of sockets) socket.destroy()
    if (owned && server.listening) {
      try {
        const parent = await lstat(owned.directory), socket = await lstat(owned.path)
        if (parent.dev !== owned.dev || parent.ino !== owned.ino || socket.dev !== owned.socketDev || socket.ino !== owned.socketIno) {
          // shortcut: Node close unlinks a replaced bind path; retain the revoked, unreferenced listener until process exit.
          server.unref()
          return
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { server.unref(); return }
      }
    }
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    if (owned) {
      try {
        const current = await lstat(owned.directory)
        if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino) return
        // Never remove another authority or a replacement path.
        try { const socket = await lstat(owned.path); if (socket.isSocket() && socket.dev === owned.socketDev && socket.ino === owned.socketIno) await unlink(owned.path) } catch {}
        await rmdir(owned.directory)
      } catch {}
    }
  }
  try {
    if (!validSetupLocation(location) || !(await abortable(() => api.read(lifetime.signal), AbortSignal.timeout(deadline))).writable) return
    const { directory, path } = await socketPath(id)
    await mkdir(directory, { mode: 0o700 })
    const stat = await lstat(directory)
    owned = { directory, path, dev: stat.dev, ino: stat.ino }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(path, () => { server.off("error", reject); resolve() })
    })
    const socket = await lstat(path)
    owned.socketDev = socket.dev; owned.socketIno = socket.ino
    await chmod(path, 0o600)
    await safePath(directory, path)
    return { id, dispose }
  } catch { await dispose(); return }
}

async function exchange(target: LocalSetupTarget, method: "read" | "save", input: SaveInput | undefined, signal: AbortSignal): Promise<unknown> {
  let socket: Socket | undefined
  try {
    signal = AbortSignal.any([signal, AbortSignal.timeout(deadline)])
    signal.throwIfAborted()
    if (!object(target) || !keys(target, ["id", "serviceVersion", "location", "serverPid"]) || !validSetupLocation(target.location)
      || typeof target.serviceVersion !== "string" || !target.serviceVersion || !Number.isSafeInteger(target.serverPid) || target.serverPid <= 0
      || method === "save" && !validSave(input)) throw failure()
    const request = JSON.stringify({ id: target.id, serviceVersion: target.serviceVersion, serverPid: target.serverPid, location: target.location, method, ...(input ? { input } : {}) }) + "\n"
    if (Buffer.byteLength(request) > requestLimit) throw failure()
    const { directory, path } = await socketPath(target.id)
    await safePath(directory, path)
    signal.throwIfAborted()
    socket = createConnection({ path, signal })
    const connection = socket
    const reply = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      connection.on("connect", () => connection.end(request))
      connection.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > responseLimit) { reject(failure()); connection.destroy(); return }
        chunks.push(chunk)
      })
      connection.on("error", reject)
      connection.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      connection.on("close", () => reject(failure()))
    })
    signal.throwIfAborted()
    if (!reply.endsWith("\n") || reply.indexOf("\n") !== reply.length - 1) throw failure()
    const response = JSON.parse(reply)
    if (!object(response) || !keys(response, ["pid", "value"]) || response.pid !== target.serverPid || !object(response.value)) throw failure()
    return response.value
  } catch { throw failure() }
  finally { socket?.destroy() }
}
export async function readLocalSetup(target: LocalSetupTarget, signal: AbortSignal): Promise<SetupSnapshot> {
  const value = await exchange(target, "read", undefined, signal) as SetupSnapshot
  if (value.serviceVersion !== target.serviceVersion || value.localAuthority?.id !== target.id || typeof value.writable !== "boolean") throw failure()
  return value
}
export async function saveLocalSetup(target: LocalSetupTarget, input: SaveInput, signal: AbortSignal): Promise<SaveResult> {
  const value = await exchange(target, "save", input, signal) as SaveResult
  if (!["saved", "saved_not_active", "invalid", "conflict", "read_only", "failed"].includes(value.kind)) throw failure()
  return value
}

type Authority = { id: string; dispose(): Promise<void> }
// Reuse a started authority, but retry a failed start on the next read instead of caching the failure.
export function lazyLocalSetup(start: () => Promise<Authority | undefined>) {
  let current: Promise<Authority | undefined> | undefined, closed = false
  return {
    get(): Promise<Authority | undefined> {
      if (closed) return Promise.resolve(undefined)
      const pending: Promise<Authority | undefined> = current ??= start().then(authority => {
        if (!authority && current === pending) current = undefined
        return authority
      })
      return pending
    },
    async dispose() { closed = true; const pending = current; current = undefined; await (await pending)?.dispose() },
  }
}

import { createHash, randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises"
import { dirname, basename, isAbsolute, join, posix, win32 } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { applyPreferenceChange, parsePreferences, preferenceFields, type PreferenceDocument } from "./preferences.ts"
import { commitWindowsPreferences, readWindowsPreferences, windowsLocalRoot, type WindowsSnapshot } from "./preferences-windows.ts"
import type { SaveInput, SettingsInput } from "./setup.ts"

export type PreferencesHost = { home: string; platform: NodeJS.Platform; env: Record<string, string | undefined>; systemPaths: readonly string[] }
export type PreferenceRead = { revision: string; source: string; writable: boolean; documentValid: boolean; policy: "user" | "managed"; overrides: SettingsInput; contextFile?: unknown; reason?: string }
export type PreferencesWriteResult = { kind: "written"; revision: string } | { kind: "conflict" | "read_only" | "failed"; message: string } | { kind: "refused_context"; message: string }
const limit = 65536, run = promisify(execFile)
const contextFileName = "predictions-context.md"
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT"
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code
class Refusal extends Error {}
class ContextRefusal extends Refusal {}
const fail = (message: string): never => { throw new Refusal(message) }
const changedContext = "it changed while it was checked"
const refuseContext = (reason: string): never => { throw new ContextRefusal(`predictions-context.md exists but is not safe to use: ${reason}. Fix or remove it, then save again.`) }
const uncertain = "Changes may have been saved. Reopen settings before trying again."
const identity = (value: Stats) => [value.dev, value.ino, value.mode, value.uid, value.gid, ...(value.isDirectory() ? [] : [value.nlink])]
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export function preferencesPath(host: PreferencesHost): string {
  const path = host.platform === "win32" ? win32 : posix
  const absolute = host.platform === "win32" ? windowsLocalRoot : path.isAbsolute
  let root = host.env.XDG_CONFIG_HOME
  if (root !== undefined && (!root || !absolute(root))) fail("XDG_CONFIG_HOME must be an absolute path.")
  if (root === undefined) root = host.platform === "win32" ? host.env.APPDATA : path.join(host.home, ".config")
  if (!root || !absolute(root)) return fail("The server's user configuration directory is unavailable.")
  return path.join(root, "opencode", "predictions.json")
}

export function administrativePaths(platform: NodeJS.Platform, env: PreferencesHost["env"], username?: string): readonly string[] {
  if (platform === "win32") return [env.ProgramData && windowsLocalRoot(env.ProgramData) ? win32.join(env.ProgramData, "opencode") : ""]
  if (platform === "darwin") return [
    "/Library/Application Support/opencode", "/Library/Managed Preferences/ai.opencode.managed.plist",
    username ? posix.join("/Library/Managed Preferences", username, "ai.opencode.managed.plist") : "/Library/Managed Preferences",
  ]
  return ["/etc/opencode"]
}

export function decodePreferences(bytes: Uint8Array): PreferenceDocument {
  if (bytes.byteLength > limit) fail("Prediction preferences exceed 65536 bytes.")
  let text: string
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
  catch { return fail("Prediction preferences must be valid UTF-8.") }
  try { return parsePreferences(text) }
  catch (error) { return fail((error as Error).message) }
}

async function exists(path: string) {
  if (!isAbsolute(path)) fail("The administrative configuration path is unavailable.")
  try { await lstat(path); return true } catch (error) { if (missing(error)) return false; throw error }
}
async function canonical(directory: string): Promise<{ directory: string; ancestor: string }> {
  const suffix: string[] = []
  let ancestor = directory
  for (;;) {
    try { const resolved = await realpath(ancestor); return { directory: join(resolved, ...suffix), ancestor: resolved } }
    catch (error) {
      if (!missing(error) || dirname(ancestor) === ancestor) throw error
      suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor)
    }
  }
}
async function hasAccessRules(path: string) {
  const { stdout } = await run("/bin/ls", ["-lde", path], { timeout: 1000, maxBuffer: 8192 })
  return stdout.split(/\s/, 1)[0].includes("+") || /^\s+\d+:/m.test(stdout)
}
async function safe(info: Stats, path: string, directory = false) {
  if (process.getuid === undefined || info.uid !== process.getuid() || info.mode & 0o7022
    || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) fail("Prediction preferences have unsafe ownership, links or write permissions.")
  if (process.platform === "darwin" && await hasAccessRules(path)) fail("Prediction preferences have unsupported access control entries.")
}

// Stored form: "~/" plus the forward-slash path under home, else the absolute path. Logical, never the realpath.
export function managedContextPath(host: PreferencesHost): { stored: string; absolute: string } {
  const path = host.platform === "win32" ? win32 : posix
  const absolute = path.join(path.dirname(preferencesPath(host)), contextFileName)
  const relative = path.relative(host.home, absolute)
  const under = relative !== "" && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative)
  return { stored: under ? "~/" + relative.split(path.sep).join("/") : absolute, absolute }
}

export function expandContextPath(value: string, home: string): string {
  if (!value.startsWith("~/")) return value
  const path = /^[A-Za-z]:[\\/]|^\\\\/.test(home) ? win32 : posix
  return path.join(home, ...value.slice(2).split("/"))
}

// Case folds only where the platform's file names are case-insensitive. Callers expand "~/" first.
export function sameContextPath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const fold = (value: string) => platform === "win32" || platform === "darwin" ? value.toLowerCase() : value
  return fold(a) === fold(b)
}

function contextShape(info: Stats): string | undefined {
  if (info.isSymbolicLink()) return "it is a link"
  if (!info.isFile()) return "it is not a regular file"
  if (info.nlink !== 1) return "it has more than one link"
  if (process.getuid === undefined || info.uid !== process.getuid()) return "it is owned by another user"
  if (info.mode & 0o002) return "other users can write to it"
  return undefined
}

type ContextIdentity = { dev: number; ino: number }
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino

// A directory's mtime and ctime change on every create, unlink or rename inside it. An unchanged stamp
// across a window proves no entry was swapped in that window.
async function directoryStamp(directory: string): Promise<string> {
  const stat = await lstat(directory, { bigint: true })
  return `${stat.mtimeNs}:${stat.ctimeNs}`
}

// Adopts an existing context file. The access-rule check runs between two identity checks and a directory
// stamp check, so a file swapped out and back during the inspection is refused. An unreadable file
// (no read permission) cannot leak its contents, so its lstat checks stand in for the open.
async function adoptContextFile(directory: string): Promise<ContextIdentity> {
  const path = join(directory, contextFileName)
  const before = await lstat(path)
  const first = contextShape(before)
  if (first) refuseContext(first)
  const stamp = await directoryStamp(directory)
  let handle: FileHandle | undefined
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)) }
  catch (error) {
    if (codeOf(error) === "ELOOP") refuseContext("it is a link")
    if (codeOf(error) !== "EACCES") throw error
  }
  try {
    if (handle) {
      const opened = await handle.stat()
      if (!sameFile(before, opened)) refuseContext(changedContext)
      const shape = contextShape(opened)
      if (shape) refuseContext(shape)
    }
    if (process.platform === "darwin" && await hasAccessRules(path)) refuseContext("it has extra access rules")
    const after = await lstat(path)
    if (!sameFile(before, after)) refuseContext(changedContext)
    const shape = contextShape(after)
    if (shape) refuseContext(shape)
    if (await directoryStamp(directory) !== stamp) refuseContext(changedContext)
    return { dev: after.dev, ino: after.ino }
  } finally { await handle?.close() }
}

// Creates the fixed file empty and private when absent, then adopts whatever is there. Never truncates.
async function ensureContextFile(directory: string): Promise<ContextIdentity> {
  const path = join(directory, contextFileName)
  try {
    const handle = await open(path, "wx", 0o600)
    try { await handle.chmod(0o600) } finally { await handle.close() }
  } catch (error) { if (codeOf(error) !== "EEXIST") throw error }
  return adoptContextFile(directory)
}

// Run immediately before the commit rename: the fixed path must still be the file that was adopted.
async function confirmContextFile(directory: string, identity: ContextIdentity) {
  const current = await lstat(join(directory, contextFileName)).catch(() => undefined)
  if (!current?.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) refuseContext(changedContext)
}

function createWindowsStore(host: PreferencesHost) {
  const revision = (state: WindowsSnapshot) => hash([state.source, state.state, state.expected])
  const systemPaths = () => host.systemPaths.map(path => windowsLocalRoot(path) ? path : "")
  const inspect = (signal: AbortSignal) => readWindowsPreferences(preferencesPath(host), systemPaths(), signal)
  const invalid = (source: string, reason?: string): PreferenceRead => ({
    revision: hash([source, "unavailable"]), source, writable: false, documentValid: false, policy: "user", overrides: {},
    reason: reason ?? "Windows prediction preferences cannot be read or verified. Check the server's configuration directory.",
  })
  return {
    async read(signal: AbortSignal): Promise<PreferenceRead> {
      let source = ""
      try {
        source = preferencesPath(host)
        const state = await inspect(signal)
        if (state.state === "unavailable") return invalid(source, state.reason)
        if (state.state === "managed") return {
          revision: revision(state), source, writable: false, documentValid: true, policy: "managed", overrides: {},
          reason: "Administrative configuration prevents user prediction preferences.",
        }
        const settings = state.present ? decodePreferences(state.bytes).settings : {}
        return { revision: revision(state), source, writable: state.writable, documentValid: true, policy: "user",
          overrides: preferenceFields(settings), contextFile: settings.contextFile, ...(state.reason ? { reason: state.reason } : {}) }
      } catch (error) {
        signal.throwIfAborted()
        return invalid(source, error instanceof Refusal ? error.message : undefined)
      }
    },
    async write(current: string, input: Omit<SaveInput, "revision">, signal: AbortSignal): Promise<PreferencesWriteResult> {
      signal.throwIfAborted()
      let before: WindowsSnapshot, document: PreferenceDocument
      try {
        before = await inspect(signal)
        if (!before.writable) return { kind: "read_only", message: before.reason ?? "Prediction preferences are read-only." }
        document = before.present ? decodePreferences(before.bytes) : { version: 1, settings: {} }
      } catch (error) {
        signal.throwIfAborted()
        return { kind: "read_only", message: error instanceof Refusal ? error.message : "Prediction preferences cannot be read or verified." }
      }
      if (revision(before) !== current) return { kind: "conflict", message: "Prediction preferences changed. Reload settings before saving." }
      let bytes: Buffer
      try {
        const settings = applyPreferenceChange(document.settings, input)
        bytes = Buffer.from(JSON.stringify({ ...document, settings }, null, 2) + "\n")
        decodePreferences(bytes)
      } catch (error) {
        return { kind: "failed", message: error instanceof Refusal ? error.message : "Prediction preference changes are invalid." }
      }
      const result = await commitWindowsPreferences(before, systemPaths(), bytes, signal)
      return result.kind === "written" ? { kind: "written", revision: revision(result.snapshot) } : result
    },
  }
}

export function createPreferencesStore(host: PreferencesHost) {
  if (process.platform === "win32" && host.platform === "win32") return createWindowsStore(host)
  async function inspect(signal: AbortSignal) {
    signal.throwIfAborted()
    const logical = preferencesPath(host)
    const target = await canonical(dirname(logical)), directory = target.directory, source = join(directory, "predictions.json")
    let managed = false
    for (const path of host.systemPaths) { try { managed ||= await exists(path) } catch { managed = true } }
    if (managed) return { source, directory, policy: "managed" as const, bytes: Buffer.alloc(0), document: { version: 1, settings: {} } as PreferenceDocument, info: undefined, parent: undefined, revision: hash([source, "managed"]), writable: false }
    const parent = await lstat(target.ancestor)
    let info: Stats | undefined, bytes = Buffer.alloc(0), document: PreferenceDocument = { version: 1, settings: {} }
    try { info = await lstat(source) } catch (error) { if (!missing(error)) throw error }
    let writable = true, reason: string | undefined
    try { await safe(parent, target.ancestor, true) } catch (error) {
      if (info) throw error
      // An absent document still uses defaults when safe writes are unavailable.
      writable = false
      reason = error instanceof Refusal ? error.message : "Prediction preferences are not writable."
    }
    if (info) {
      await safe(info, source)
      const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const pinned = await handle.stat()
        if (JSON.stringify(identity(pinned)) !== JSON.stringify(identity(info))) fail("Prediction preferences changed while reading. Reload settings.")
        const buffer = Buffer.alloc(limit + 1)
        const read = await handle.read(buffer, 0, buffer.length, 0)
        bytes = buffer.subarray(0, read.bytesRead)
        document = decodePreferences(bytes)
      } finally { await handle.close() }
    }
    const revision = hash([source, info ? identity(info) : null, bytes.toString("hex")])
    writable &&= !info || (info.mode & 0o600) === 0o600
    signal.throwIfAborted()
    return { source, directory, policy: "user" as const, bytes, document, info, parent: target.ancestor === directory ? parent : undefined, revision, writable, reason }
  }
  function snapshot(value: Awaited<ReturnType<typeof inspect>>): PreferenceRead {
    return { revision: value.revision, source: value.source, writable: value.writable, documentValid: true, policy: value.policy, overrides: preferenceFields(value.document.settings), contextFile: value.document.settings.contextFile,
      ...(value.policy === "managed" ? { reason: "Administrative configuration prevents user prediction preferences." } : !value.writable ? { reason: value.reason ?? "Prediction preferences are not writable." } : {}) }
  }
  return {
    async read(signal: AbortSignal): Promise<PreferenceRead> {
      try { return snapshot(await inspect(signal)) }
      catch (error) {
        signal.throwIfAborted()
        let source = ""; try { source = preferencesPath(host) } catch {}
        return { revision: hash([source, "unavailable"]), source, writable: false, documentValid: false, policy: "user", overrides: {},
          reason: error instanceof Refusal ? error.message : "Prediction preferences cannot be read or verified. Check the server's configuration directory." }
      }
    },
    async write(revision: string, input: Omit<SaveInput, "revision">, signal: AbortSignal): Promise<PreferencesWriteResult> {
      signal.throwIfAborted()
      // The context file is applied here, never by applyPreferenceChange, which rejects unknown members.
      const { contextFile, ...change } = input
      if (contextFile !== undefined && contextFile !== "managed" && contextFile !== "none") throw new Error("Invalid save input.")
      const temporary: string[] = []
      let committed = false, cleanupFailed = false, result: PreferencesWriteResult
      async function transaction(): Promise<PreferencesWriteResult> {
        let before: Awaited<ReturnType<typeof inspect>>
        try { before = await inspect(signal) } catch (error) {
          return { kind: "read_only", message: error instanceof Refusal ? error.message : "Prediction preferences cannot be read or verified." }
        }
        if (!before.writable) return { kind: "read_only", message: snapshot(before).reason! }
        if (before.revision !== revision) return { kind: "conflict", message: "Prediction preferences changed. Reload settings before saving." }
        const settings = applyPreferenceChange(before.document.settings, change)
        if (contextFile === "managed") settings.contextFile = managedContextPath(host).stored
        if (contextFile === "none") delete settings.contextFile
        const text = JSON.stringify({ ...before.document, settings }, null, 2) + "\n"
        decodePreferences(Buffer.from(text))
        await mkdir(before.directory, { recursive: true, mode: 0o700 })
        const parent = await lstat(before.directory)
        await safe(parent, before.directory, true)
        let contextIdentity: ContextIdentity | undefined
        if (contextFile === "managed") contextIdentity = await ensureContextFile(before.directory)
        const recheck = async () => {
          const fresh = await inspect(signal), current = await lstat(before.directory)
          if (!fresh.writable || fresh.revision !== revision || fresh.source !== before.source || JSON.stringify(identity(current)) !== JSON.stringify(identity(parent))) fail("Prediction preferences changed. Reload settings before saving.")
        }
        async function stage(bytes: Uint8Array | string, mode: number) {
          signal.throwIfAborted()
          const path = join(before.directory, ".predictions.tmp-" + randomUUID())
          const handle = await open(path, "wx", 0o600)
          temporary.push(path)
          try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync() } finally { await handle.close() }
          return path
        }
        const next = await stage(text, before.info ? before.info.mode & 0o777 : 0o600)
        await recheck()
        if (before.info) {
          const backup = before.source + ".backup"
          if (await exists(backup)) {
            const info = await lstat(backup); await safe(info, backup)
            if (info.mode & 0o177) fail("The prediction preferences backup has unsafe permissions.")
          }
          const copy = await stage(before.bytes, 0o600)
          await rename(copy, backup)
        }
        await recheck()
        signal.throwIfAborted()
        if (contextIdentity) await confirmContextFile(before.directory, contextIdentity)
        // Simultaneous writers may both pass this check; atomic replacement does not prevent lost updates.
        await rename(next, before.source)
        committed = true
        const persisted = await inspect(new AbortController().signal)
        if (!persisted.bytes.equals(Buffer.from(text))) return { kind: "failed", message: uncertain }
        return { kind: "written", revision: persisted.revision }
      }
      try { result = await transaction() }
      catch (error) {
        if (!committed && error instanceof ContextRefusal) result = { kind: "refused_context", message: error.message }
        else result = { kind: "failed", message: committed ? uncertain : error instanceof Refusal || error instanceof Error && error.message === "Prediction preference changes are invalid." ? error.message : "Prediction preferences were not saved. Reopen settings and try again." }
      }
      finally { for (const path of temporary) await unlink(path).catch(error => { if (!missing(error)) cleanupFailed = true }) }
      return cleanupFailed ? { kind: "failed", message: committed ? uncertain : "Save cleanup failed. Reopen settings before trying again." } : result
    },
  }
}
export type PreferencesStore = ReturnType<typeof createPreferencesStore>

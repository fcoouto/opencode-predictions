import { createHash, randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import { dirname, basename, join, posix, win32 } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { applyPreferenceChange, parsePreferences, preferenceFields, type PreferenceDocument } from "./preferences.ts"
import type { SaveInput, SettingsInput } from "./setup.ts"

export type PreferencesHost = { home: string; platform: NodeJS.Platform; env: Record<string, string | undefined>; systemPaths: readonly string[] }
export type PreferenceRead = { revision: string; source: string; writable: boolean; documentValid: boolean; policy: "user" | "managed"; overrides: SettingsInput; reason?: string }
export type PreferencesWriteResult = { kind: "written"; revision: string } | { kind: "conflict" | "read_only" | "failed"; message: string }
const limit = 65536, run = promisify(execFile)
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT"
class Refusal extends Error {}
const fail = (message: string): never => { throw new Refusal(message) }
const uncertain = "Changes may have been saved. Reopen settings before trying again."
const identity = (value: Stats) => [value.dev, value.ino, value.mode, value.uid, value.gid, ...(value.isDirectory() ? [] : [value.nlink])]
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export function preferencesPath(host: PreferencesHost): string {
  const path = host.platform === "win32" ? win32 : posix
  let root = host.env.XDG_CONFIG_HOME
  if (root !== undefined && (!root || !path.isAbsolute(root))) fail("XDG_CONFIG_HOME must be an absolute path.")
  if (root === undefined) root = host.platform === "win32" ? host.env.APPDATA : path.join(host.home, ".config")
  if (!root || !path.isAbsolute(root)) return fail("The server's user configuration directory is unavailable.")
  return path.join(root, "opencode", "predictions.json")
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
async function safe(info: Stats, path: string, directory = false) {
  if (process.getuid === undefined || info.uid !== process.getuid() || info.mode & 0o7022
    || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) fail("Prediction preferences have unsafe ownership, links or write permissions.")
  if (process.platform === "darwin") {
    const { stdout } = await run("/bin/ls", ["-lde", path], { timeout: 1000, maxBuffer: 8192 })
    if (stdout.split(/\s/, 1)[0].includes("+") || /^\s+\d+:/m.test(stdout)) fail("Prediction preferences have unsupported access control entries.")
  }
}

export function createPreferencesStore(host: PreferencesHost) {
  async function inspect(signal: AbortSignal) {
    signal.throwIfAborted()
    const logical = preferencesPath(host)
    const target = await canonical(dirname(logical)), directory = target.directory, source = join(directory, "predictions.json")
    let managed = false
    for (const path of host.systemPaths) { try { managed ||= await exists(path) } catch { managed = true } }
    if (managed) return { source, directory, policy: "managed" as const, bytes: Buffer.alloc(0), document: { version: 1, settings: {} } as PreferenceDocument, info: undefined, parent: undefined, revision: hash([source, "managed"]), writable: false }
    const parent = await lstat(target.ancestor)
    await safe(parent, target.ancestor, true)
    let info: Stats | undefined, bytes = Buffer.alloc(0), document: PreferenceDocument = { version: 1, settings: {} }
    try { info = await lstat(source) } catch (error) { if (!missing(error)) throw error }
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
    const writable = !info || (info.mode & 0o600) === 0o600
    signal.throwIfAborted()
    return { source, directory, policy: "user" as const, bytes, document, info, parent: target.ancestor === directory ? parent : undefined, revision, writable }
  }
  function snapshot(value: Awaited<ReturnType<typeof inspect>>): PreferenceRead {
    return { revision: value.revision, source: value.source, writable: value.writable, documentValid: true, policy: value.policy, overrides: preferenceFields(value.document.settings),
      ...(value.policy === "managed" ? { reason: "Administrative configuration prevents user prediction preferences." } : !value.writable ? { reason: "Prediction preferences are not writable." } : {}) }
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
      const temporary: string[] = []
      let committed = false, cleanupFailed = false, result: PreferencesWriteResult
      async function transaction(): Promise<PreferencesWriteResult> {
        let before: Awaited<ReturnType<typeof inspect>>
        try { before = await inspect(signal) } catch (error) {
          return { kind: "read_only", message: error instanceof Refusal ? error.message : "Prediction preferences cannot be read or verified." }
        }
        if (!before.writable) return { kind: "read_only", message: snapshot(before).reason! }
        if (before.revision !== revision) return { kind: "conflict", message: "Prediction preferences changed. Reload settings before saving." }
        const settings = applyPreferenceChange(before.document.settings, input)
        const text = JSON.stringify({ ...before.document, settings }, null, 2) + "\n"
        decodePreferences(Buffer.from(text))
        await mkdir(before.directory, { recursive: true, mode: 0o700 })
        const parent = await lstat(before.directory)
        await safe(parent, before.directory, true)
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
        // Simultaneous writers may both pass this check; atomic replacement does not prevent lost updates.
        await rename(next, before.source)
        committed = true
        const persisted = await inspect(new AbortController().signal)
        if (!persisted.bytes.equals(Buffer.from(text))) return { kind: "failed", message: uncertain }
        return { kind: "written", revision: persisted.revision }
      }
      try { result = await transaction() }
      catch (error) { result = { kind: "failed", message: committed ? uncertain : error instanceof Refusal || error instanceof Error && error.message === "Prediction preference changes are invalid." ? error.message : "Prediction preferences were not saved. Reopen settings and try again." } }
      finally { for (const path of temporary) await unlink(path).catch(error => { if (!missing(error)) cleanupFailed = true }) }
      return cleanupFailed ? { kind: "failed", message: committed ? uncertain : "Save cleanup failed. Reopen settings before trying again." } : result
    },
  }
}
export type PreferencesStore = ReturnType<typeof createPreferencesStore>

import type { ConfigSnapshot, SettingsInput } from "./setup.ts"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { isDeepStrictEqual, promisify } from "node:util"
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser"
import { parseOptions } from "./options.ts"
import { editSetting } from "./config-edit.ts"

export type ConfigHost = {
  // These values come from the selected server context, never from RPC input.
  version: string
  home: string
  directory: string
  env: Record<string, string | undefined>
  systemPaths: readonly string[]
  source(signal: AbortSignal): Promise<{ type: "local"; path: string } | undefined>
  options(): unknown
}
export type ConfigWriteResult = { kind: "written"; revision: string } | { kind: "conflict" | "read_only" | "failed"; message: string }

const keys = ["models", "enabled", "automatic", "escalation", "timeoutMs", "contextTurns", "debug"] as const
const run = promisify(execFile)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const readOnly = "This configuration source or filesystem is not verified for setup writes."
const uncertain = "Changes may have been saved. Reopen settings before trying again."

async function exists(path: string) {
  try { await lstat(path); return true } catch (error) { if (missing(error)) return false; throw error }
}

async function noACL(path: string) {
  const { stdout } = await run("/bin/ls", ["-lde", path])
  if (stdout.split(/\s/, 1)[0].includes("+") || /^\s+\d+:/m.test(stdout)) throw new Error(readOnly)
}

function parse(text: string) {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true })
  if (!root || root.type !== "object" || errors.length) throw new Error(readOnly)
  function unique(node: Node) {
    if (node.type === "object") {
      const names = node.children!.map(property => property.children![0].value)
      if (new Set(names).size !== names.length) throw new Error(readOnly)
    }
    node.children?.forEach(unique)
  }
  unique(root)
  return getNodeValue(root)
}

export function createConfigStore(host: ConfigHost) {
  const directory = resolve(host.env.XDG_CONFIG_HOME ?? join(host.home, ".config"), "opencode")
  async function inspect(signal: AbortSignal) {
    signal.throwIfAborted()
    if (process.platform !== "darwin" || host.version !== "2.2.6") throw new Error(readOnly)
    if (host.env.XDG_CONFIG_HOME !== undefined && !isAbsolute(host.env.XDG_CONFIG_HOME)) throw new Error(readOnly)
    if (host.env.OPENCODE_CONFIG || host.env.OPENCODE_CONFIG_CONTENT || host.env.OPENCODE_CONFIG_DIR || host.env.OPENCODE_DISABLE_PROJECT_CONFIG !== "1") throw new Error(readOnly)
    if (await exists(join(directory, "plugins"))) throw new Error(readOnly)
    for (const path of host.systemPaths) if (await exists(path)) throw new Error(readOnly)
    const source = await host.source(signal)
    if (!source || source.type !== "local" || !isAbsolute(source.path)) throw new Error(readOnly)
    if (await realpath(directory) !== directory || await realpath(source.path) !== source.path) throw new Error(readOnly)
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.uid !== process.getuid!() || parent.mode & 0o022) throw new Error(readOnly)
    await noACL(directory)
    const paths = (await Promise.all(["opencode.json", "opencode.jsonc"].map(async name => {
      const path = join(directory, name)
      return await exists(path) ? path : undefined
    }))).filter((path): path is string => !!path)
    if (paths.length !== 1) throw new Error(readOnly)
    const file = paths[0], info = await lstat(file)
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o600) !== 0o600 || info.mode & 0o7022) throw new Error(readOnly)
    await noACL(file)
    const backup = file + ".predictions-backup"
    if (await exists(backup)) {
      const prior = await lstat(backup)
      if (!prior.isFile() || prior.nlink !== 1 || prior.uid !== info.uid || prior.mode & 0o177) throw new Error(readOnly)
      await noACL(backup)
    }
    const bytes = await readFile(file)
    const text = bytes.toString("utf8")
    if (!Buffer.from(text).equals(bytes)) throw new Error(readOnly)
    const config = parse(text)
    if (!Array.isArray(config.plugins)) throw new Error(readOnly)
    const matches = []
    for (const [index, entry] of config.plugins.entries()) {
      const spec = typeof entry === "string" ? entry : entry?.package
      if (typeof spec !== "string") throw new Error(readOnly)
      const local = spec.startsWith("file:") ? fileURLToPath(spec) : isAbsolute(spec) ? spec : spec.startsWith(".") ? resolve(directory, spec) : undefined
      if (local && await realpath(local) === source.path) matches.push({ entry, index })
    }
    if (matches.length !== 1) throw new Error(readOnly)
    const { entry, index } = matches[0]
    if (typeof entry === "string" || entry.package !== source.path || !entry.options || typeof entry.options !== "object" || Array.isArray(entry.options)) throw new Error(readOnly)
    const fields: SettingsInput = Object.fromEntries(keys.filter(key => Object.hasOwn(entry.options, key)).map(key => [key, entry.options[key]]))
    const valid = parseOptions(entry.options).ok && isDeepStrictEqual(entry.options, host.options(), { skipPrototype: true })
    const revision = createHash("sha256").update(text).update(JSON.stringify({
      file, inode: info.ino, device: info.dev, mode: info.mode, uid: info.uid, gid: info.gid,
      source, env: host.env, directory: host.directory,
    })).digest("hex")
    signal.throwIfAborted()
    return { file, info, text, index, options: entry.options, fields, valid, revision }
  }
  return {
    async read(signal: AbortSignal): Promise<ConfigSnapshot> {
      try {
        const value = await inspect(signal)
        return { scope: "global", revision: value.revision, source: value.file, writable: value.valid, fields: value.fields, ...(!value.valid ? { reason: readOnly } : {}) }
      } catch {
        signal.throwIfAborted()
        return { scope: "global", revision: "", writable: false, fields: {}, reason: readOnly }
      }
    },
    async write(revision: string, patch: SettingsInput, signal: AbortSignal): Promise<ConfigWriteResult> {
      let locked = false, committed = false, cleanupFailed = false
      const lock = join(directory, ".predictions-setup.lock")
      const temporary: string[] = []
      let result: ConfigWriteResult
      async function transaction(): Promise<ConfigWriteResult> {
        signal.throwIfAborted()
        try { await inspect(signal) } catch { return { kind: "read_only", message: readOnly } }
        const deadline = Date.now() + 3000
        while (!locked) {
          signal.throwIfAborted()
          try { await mkdir(lock, { mode: 0o700 }); locked = true } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
            // Never steal an old lock: its owner may still be in the transaction.
            if (Date.now() >= deadline) return { kind: "failed", message: "Another setup writer owns this configuration. Reopen settings after it finishes." }
            await delay(10, undefined, { signal })
          }
        }
        const before = await inspect(signal)
        if (revision !== before.revision) return { kind: "conflict", message: "Configuration changed. Reopen settings before saving." }
        if (!before.valid) return { kind: "read_only", message: readOnly }
        if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length ||
          Object.entries(patch).some(([key, value]) => !(keys as readonly string[]).includes(key) || (key !== "models" && value === undefined)) ||
          !parseOptions({ ...before.options, ...patch }).ok) return { kind: "failed", message: "Settings are invalid." }
        let text = before.text
        for (const [key, value] of Object.entries(patch)) text = editSetting(text, before.index, key, value)
        parse(text)
        async function stage(bytes: string, mode: number) {
          signal.throwIfAborted()
          const path = join(dirname(before.file), ".predictions.tmp-" + randomUUID())
          const handle = await open(path, "wx", 0o600)
          temporary.push(path)
          try { await handle.writeFile(bytes); await handle.chown(before.info.uid, before.info.gid); await handle.chmod(mode); await handle.sync() } finally { await handle.close() }
          return path
        }
        const next = await stage(text, before.info.mode & 0o777)
        if ((await inspect(signal)).revision !== revision) return { kind: "conflict", message: "Configuration changed. Reopen settings before saving." }
        const recovery = await stage(before.text, before.info.mode & 0o600)
        await rename(recovery, before.file + ".predictions-backup")
        if ((await inspect(signal)).revision !== revision) return { kind: "conflict", message: "Configuration changed. Reopen settings before saving." }
        signal.throwIfAborted()
        // External editors can still race this last comparison and atomic replacement.
        await rename(next, before.file)
        committed = true
        const persisted = await inspect(new AbortController().signal)
        if (persisted.text !== text) return { kind: "failed", message: uncertain }
        return { kind: "written", revision: persisted.revision }
      }
      try { result = await transaction() } catch {
        result = { kind: "failed", message: committed ? uncertain : "Settings were not saved. Reopen settings and try again." }
      } finally {
        for (const path of temporary) await unlink(path).catch(error => { if (!missing(error)) cleanupFailed = true })
        if (locked) await rmdir(lock).catch(() => { cleanupFailed = true })
      }
      return cleanupFailed ? { kind: "failed", message: committed ? uncertain : "Save cleanup failed. Reopen settings before trying again." } : result
    },
  }
}
export type ConfigStore = ReturnType<typeof createConfigStore>

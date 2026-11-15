import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { isDeepStrictEqual, promisify } from "node:util"
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser"
import { parseOptions } from "../../src/options.ts"
import { editSetting } from "../../src/config-edit.ts"

export type ProbeHost = {
  home: string
  directory: string
  env: Record<string, string | undefined>
  source: { type: "local" | "package"; path?: string; target?: string }
  options: Record<string, unknown>
  systemPaths: string[]
}
export type ProbeHooks = { afterLock?(): Promise<void>; beforeBackup?(): Promise<void>; beforeReplace?(): Promise<void>; replace?(from: string, to: string): Promise<void> }
export type ProbeSnapshot = { writable: boolean; revision?: string; source?: string; fields?: Record<string, unknown>; reason?: string }
const fields = ["enabled", "automatic", "escalation", "models", "timeoutMs", "contextTurns", "debug"]
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const run = promisify(execFile)

async function noACL(path: string) {
  const { stdout } = await run("/bin/ls", ["-lde", path])
  if (stdout.split(/\s/, 1)[0].includes("+") || /^\s+\d+:/m.test(stdout)) throw new Error("Unverified ACL")
}

async function exists(file: string) {
  try { await lstat(file); return true } catch (error) { if (missing(error)) return false; throw error }
}

function tree(text: string) {
  const errors: ParseError[] = []
  const node = parseTree(text, errors, { allowTrailingComma: true })
  if (!node || node.type !== "object" || errors.length) throw new Error("Invalid configuration")
  function unique(node: Node) {
    if (node.type === "object") {
      const keys = node.children!.map(property => property.children![0].value)
      if (new Set(keys).size !== keys.length) throw new Error("Duplicate keys")
    }
    node.children?.forEach(unique)
  }
  unique(node)
  return getNodeValue(node)
}

// Research only: supports one absolute local entry and explicitly disabled project discovery.
export function createCandidate(host: ProbeHost, hooks: ProbeHooks = {}) {
  const directory = resolve(host.env.XDG_CONFIG_HOME ?? join(host.home, ".config"), "opencode")
  async function inspect(checkOptions = true) {
    if (process.platform !== "darwin") throw new Error("Unverified platform")
    if (host.env.OPENCODE_CONFIG || host.env.OPENCODE_CONFIG_CONTENT || host.env.OPENCODE_CONFIG_DIR) throw new Error("Override")
    if (host.env.OPENCODE_DISABLE_PROJECT_CONFIG !== "1") throw new Error("Unverified project discovery")
    if (await exists(join(directory, "plugins"))) throw new Error("Unverified automatic discovery")
    for (const path of host.systemPaths) if (await exists(path)) throw new Error("Managed configuration")
    if (host.source.type !== "local" || !host.source.path || !isAbsolute(host.source.path)) throw new Error("Unverified source")
    if (await realpath(directory) !== directory) throw new Error("Indirect configuration directory")
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.uid !== process.getuid!() || parent.mode & 0o022) throw new Error("Unsafe directory")
    await noACL(directory)
    const paths = (await Promise.all(["opencode.json", "opencode.jsonc"].map(async name => {
      const path = join(directory, name)
      return await exists(path) ? path : undefined
    }))).filter((path): path is string => !!path)
    if (paths.length !== 1) throw new Error("Ambiguous global document")
    const file = paths[0], info = await lstat(file)
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o600) !== 0o600 || info.mode & 0o7022) throw new Error("Unsafe file")
    await noACL(file)
    const backup = file + ".predictions-backup"
    if (await exists(backup)) {
      const prior = await lstat(backup)
      if (!prior.isFile() || prior.nlink !== 1 || prior.uid !== info.uid || prior.mode & 0o177) throw new Error("Unsafe recovery copy")
      await noACL(backup)
    }
    const bytes = await readFile(file)
    const text = bytes.toString("utf8")
    if (!Buffer.from(text).equals(bytes)) throw new Error("Invalid encoding")
    const config = tree(text)
    if (!Array.isArray(config.plugins)) throw new Error("Missing plugins")
    if (await realpath(host.source.path) !== host.source.path) throw new Error("Indirect plugin source")
    const matches = []
    for (const [index, entry] of config.plugins.entries()) {
      const spec = typeof entry === "string" ? entry : entry?.package
      if (typeof spec !== "string") throw new Error("Invalid entry")
      const local = spec.startsWith("file:") ? fileURLToPath(spec) : isAbsolute(spec) ? spec : spec.startsWith(".") ? resolve(directory, spec) : undefined
      if (local && await realpath(local) === host.source.path) matches.push({ entry, index })
    }
    if (matches.length !== 1) throw new Error("Ambiguous entry")
    const { entry, index } = matches[0]
    if (typeof entry === "string" || entry.package !== host.source.path || !entry.options || typeof entry.options !== "object" || Array.isArray(entry.options)) throw new Error("Unverified entry shape")
    if (checkOptions && !isDeepStrictEqual(entry.options, host.options, { skipPrototype: true })) throw new Error("Effective options differ")
    if (!parseOptions(entry.options).ok) throw new Error("Invalid options")
    const revision = createHash("sha256").update(text).update(JSON.stringify({
      file, inode: info.ino, device: info.dev, mode: info.mode, uid: info.uid, gid: info.gid,
      source: host.source, env: host.env, directory: host.directory,
    })).digest("hex")
    return { file, text, info, revision, index, options: entry.options }
  }
  return {
    async read(): Promise<ProbeSnapshot> {
      try {
        const value = await inspect()
        return { writable: true, revision: value.revision, source: value.file, fields: Object.fromEntries(fields.filter(key => Object.hasOwn(value.options, key)).map(key => [key, value.options[key]])) }
      } catch { return { writable: false, reason: "Source or filesystem is not verified" } }
    },
    async write(revision: string, patch: Record<string, unknown>) {
      let locked = false
      let committed = false
      const lock = join(directory, ".predictions-setup.lock")
      const temporary: string[] = []
      try {
        // Never reclaim another process's lock by age. A crashed owner requires manual recovery.
        const deadline = Date.now() + 3000
        while (!locked) {
          try { await mkdir(lock, { mode: 0o700 }); locked = true } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
            if (Date.now() >= deadline) return { kind: "busy" }
            await delay(10)
          }
        }
        await hooks.afterLock?.()
        const before = await inspect(false)
        if (revision !== before.revision) return { kind: "conflict" }
        if (!isDeepStrictEqual(before.options, host.options, { skipPrototype: true })) return { kind: "read_only" }
        if (!Object.keys(patch).length || Object.keys(patch).some(key => !fields.includes(key) || (key !== "models" && patch[key] === undefined)) || !parseOptions({ ...before.options, ...patch }).ok) return { kind: "invalid" }
        let text = before.text
        for (const [key, value] of Object.entries(patch)) text = editSetting(text, before.index, key, value)
        tree(text)
        async function stage(bytes: string, mode: number) {
          const path = join(dirname(before.file), ".predictions.tmp-" + randomUUID())
          const handle = await open(path, "wx", 0o600)
          temporary.push(path)
          try { await handle.writeFile(bytes); await handle.chown(before.info.uid, before.info.gid); await handle.chmod(mode); await handle.sync() } finally { await handle.close() }
          return path
        }
        const next = await stage(text, before.info.mode & 0o777)
        await hooks.beforeBackup?.()
        if ((await inspect(false)).revision !== revision) return { kind: "conflict" }
        const recovery = await stage(before.text, before.info.mode & 0o600)
        await rename(recovery, before.file + ".predictions-backup")
        if ((await inspect(false)).revision !== revision) return { kind: "conflict" }
        await hooks.beforeReplace?.()
        await (hooks.replace ?? rename)(next, before.file)
        committed = true
        const persisted = await inspect(false)
        if (persisted.text !== text) return { kind: "written_unverified" }
        return { kind: "written", revision: persisted.revision }
      } catch { return { kind: committed ? "written_unverified" : "failed" } } finally {
        for (const file of temporary) await unlink(file).catch(error => { if (!missing(error)) throw error })
        if (locked) await rmdir(lock)
      }
    },
  }
}

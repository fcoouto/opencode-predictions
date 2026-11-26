import { constants, type BigIntStats } from "node:fs"
import { lstat, open, type FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export type ContextFileState = "ok" | "empty" | "missing" | "too_large" | "invalid" | "unreadable"

type ContextFileStatus = { state: ContextFileState; bytes?: number }

// Reports state and size only; the text itself never leaves this function.
export async function inspectContextFile(absolutePath: string, signal: AbortSignal): Promise<ContextFileStatus> {
  signal.throwIfAborted()
  let before: BigIntStats
  try {
    before = await lstat(absolutePath, { bigint: true })
  } catch (error) {
    signal.throwIfAborted()
    return errorField(error, "code") === "ENOENT" ? { state: "missing" } : { state: "unreadable" }
  }
  signal.throwIfAborted()
  // A symlink or other non-regular file is reported without opening it.
  if (!before.isFile()) return { state: "unreadable" }
  let file: FileHandle
  try {
    // O_NOFOLLOW makes the open refuse a symlink where it is defined. Where it is not (Windows), the
    // identity check in classifyOpenFile catches a swapped-in link or file.
    file = await open(absolutePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    signal.throwIfAborted()
    return errorField(error, "code") === "ENOENT" ? { state: "missing" } : { state: "unreadable" }
  }
  try {
    return await classifyOpenFile(file, before, signal)
  } catch {
    signal.throwIfAborted()
    return { state: "unreadable" }
  } finally {
    await file.close()
  }
}

// Exported for tests. True only when two stat results name the same device and inode.
export function sameFileIdentity(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

async function classifyOpenFile(file: FileHandle, before: BigIntStats, signal: AbortSignal): Promise<ContextFileStatus> {
  const info = await file.stat({ bigint: true })
  signal.throwIfAborted()
  // The handle must be the file lstat reported; a replaced path is unreadable and is never read.
  if (!info.isFile() || !sameFileIdentity(before, info)) return { state: "unreadable" }
  const bytes = Number(info.size)
  try {
    const text = await readValidatedText(file, signal)
    return { state: text ? "ok" : "empty", bytes }
  } catch (error) {
    signal.throwIfAborted()
    const code = errorField(error, "code")
    if (code === "context_file_too_large") return { state: "too_large", bytes }
    if (code === "context_file_invalid") return { state: "invalid", bytes }
    return { state: "unreadable", bytes }
  }
}

function errorField(error: unknown, field: "code" | "name"): unknown {
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>)[field] : undefined
}

export async function readContextFile(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const resolved = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(resolved)) throw new Error("Context file requires an absolute path")
  // Nonblocking open lets us reject named pipes without waiting for a writer.
  const file = await open(resolved, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    signal.throwIfAborted()
    if (!(await file.stat()).isFile()) throw new Error("Context file must be a regular file")
    return await readValidatedText(file, signal)
  } finally { await file.close() }
}

// Reads at most 8192 bytes from an open regular file and validates them. Shared by the prediction
// reader and inspection so both classify the same bytes the same way.
async function readValidatedText(file: FileHandle, signal: AbortSignal): Promise<string> {
  const buffer = Buffer.alloc(8193)
  let bytes = 0
  while (bytes < buffer.length) {
    signal.throwIfAborted()
    const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, null)
    if (!bytesRead) break
    bytes += bytesRead
  }
  signal.throwIfAborted()
  if (bytes > 8192) throw Object.assign(new Error("Context file exceeds 8192 bytes"), { code: "context_file_too_large" })
  let text: string
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)) } catch {
    throw Object.assign(new Error("Context file must be UTF-8 text"), { code: "context_file_invalid" })
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/u.test(text)) throw Object.assign(new Error("Context file contains binary controls"), { code: "context_file_invalid" })
  return text.trim() ? text : ""
}

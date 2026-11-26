import { constants } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export type ContextFileState = "ok" | "empty" | "missing" | "too_large" | "invalid" | "unreadable"

type ContextFileStatus = { state: ContextFileState; bytes?: number }

// Reports state and size only; the text itself never leaves this function.
export async function inspectContextFile(absolutePath: string, signal: AbortSignal): Promise<ContextFileStatus> {
  signal.throwIfAborted()
  let file: FileHandle
  try {
    // O_NOFOLLOW makes the open itself refuse a symlink at the final path component, so the handle
    // that is classified is the handle that is read. There is no check-then-open window to swap in.
    file = await open(absolutePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    signal.throwIfAborted()
    return errorField(error, "code") === "ENOENT" ? { state: "missing" } : { state: "unreadable" }
  }
  try {
    return await classifyOpenFile(file, signal)
  } catch {
    signal.throwIfAborted()
    return { state: "unreadable" }
  } finally {
    await file.close()
  }
}

async function classifyOpenFile(file: FileHandle, signal: AbortSignal): Promise<ContextFileStatus> {
  const info = await file.stat()
  signal.throwIfAborted()
  if (!info.isFile()) return { state: "unreadable" }
  const bytes = info.size
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

import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export async function readContextFile(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const resolved = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(resolved)) throw new Error("Context file requires an absolute path")
  // Nonblocking open lets us reject named pipes without waiting for a writer.
  const file = await open(resolved, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    signal.throwIfAborted()
    if (!(await file.stat()).isFile()) throw new Error("Context file must be a regular file")
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
  } finally { await file.close() }
}

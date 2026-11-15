import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { prURL, links, excerpt, type LinkedPR } from "./github-prompt.ts"

export { appendGitHubContext, type LinkedPR } from "./github-prompt.ts"
type Dependencies = { token?: (signal: AbortSignal) => Promise<string | undefined>; fetch?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number }
const run = promisify(execFile)

async function githubToken(signal: AbortSignal): Promise<string | undefined> {
  try {
    const result = await run("gh", ["auth", "token", "--hostname", "github.com", "--no-refresh"], { encoding: "utf8", signal, maxBuffer: 8192, windowsHide: true })
    return result.stdout.trim() || undefined
  } catch { signal.throwIfAborted(); return }
}

async function readJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing PR response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 262144) throw new Error("PR response too large")
      chunks.push(value)
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function createGitHubContext(deps: Dependencies = {}) {
  const token = deps.token ?? githubToken
  const fetch = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const cache = new Map<string, { expires: number; value: LinkedPR }>()
  return async (sessionID: string, prompt: string, signal: AbortSignal): Promise<readonly LinkedPR[]> => {
    signal.throwIfAborted()
    const urls = links(prompt)
    if (!urls.length) return []
    let credential: string | undefined
    try { credential = await token(signal) } catch { signal.throwIfAborted() }
    signal.throwIfAborted()
    const identity = createHash("sha256").update(credential ?? "").digest("hex")
    const sources: LinkedPR[] = []
    for (const url of urls) {
      signal.throwIfAborted()
      const key = JSON.stringify([sessionID, identity, url])
      const cached = cache.get(key)
      if (cached && cached.expires > now()) { sources.push(cached.value); continue }
      cache.delete(key)
      try {
        const endpoint = "https://api.github.com/repos" + new URL(url).pathname.replace(/\/pull\/(\d+)$/, "/pulls/$1")
        const response = await fetch(endpoint, {
          method: "GET", redirect: "error", signal,
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
        })
        if (response.status !== 200 || response.redirected) { await response.body?.cancel(); continue }
        const data = await readJSON(response) as Record<string, unknown> | null
        signal.throwIfAborted()
        if (!data || typeof data.html_url !== "string" || prURL(data.html_url) !== url || typeof data.title !== "string" || (data.body !== null && typeof data.body !== "string") || (data.state !== "open" && data.state !== "closed") || typeof data.draft !== "boolean" || typeof data.merged !== "boolean" || typeof data.updated_at !== "string" || !Number.isFinite(Date.parse(data.updated_at))) continue
        const body = data.body ?? ""
        const value: LinkedPR = {
          url, title: excerpt(data.title, 256), body: excerpt(body, 4096),
          state: data.merged ? "merged" : data.state as "open" | "closed", draft: data.draft,
          updatedAt: data.updated_at, fetchedAt: new Date(now()).toISOString(), bodyExcerpted: Array.from(body).length > 4096,
        }
        if (cache.size >= 64) cache.delete(cache.keys().next().value!)
        cache.set(key, { expires: now() + 60000, value })
        sources.push(value)
      } catch { signal.throwIfAborted() }
    }
    return sources
  }
}

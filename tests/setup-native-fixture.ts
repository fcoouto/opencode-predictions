import assert from "node:assert/strict"
import type { TestContext } from "node:test"
import { createServer } from "node:http"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { parseOptions } from "../src/options.ts"
import { startLocalSetup } from "../src/setup-local.ts"
import type { SetupSnapshot } from "../src/setup.ts"
import type { StandaloneRuntime } from "../src/setup-origin.ts"

const temporary = process.env.PREDICTIONS_TEST_TMP_ROOT ?? join(tmpdir(), "opencode")
export async function nativeFixture(t: TestContext) {
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, "a-"))
  const previous = process.env.TMPDIR
  process.env.TMPDIR = root
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous })
  const file = join(root, "config.json")
  await writeFile(file, "{}")
  const parsed = parseOptions({})
  assert.ok(parsed.ok)
  const location = { directory: "/fixture/project" }
  const snapshot: SetupSnapshot = { revision: "revision-one", source: file, scope: "global", writable: true, fields: {}, effective: parsed.value, catalog: [], issues: [], serviceVersion: "service-one" }
  let saves = 0, socketReads = 0, metadataReads = 0, unavailable = 0
  const hooks: { afterWrite?: () => void; settingsFails?: boolean } = {}
  const authority = await startLocalSetup(location, {
    async read() { socketReads++; return structuredClone(snapshot) },
    async save(input) {
      saves++
      if (input.revision !== snapshot.revision) return { kind: "conflict", message: "Configuration changed. Reload settings before trying again." }
      await writeFile(file, JSON.stringify(input.fields)); hooks.afterWrite?.()
      snapshot.fields = { ...snapshot.fields, ...input.fields }; if (input.removeModels) delete snapshot.fields.models
      snapshot.revision = "revision-two"
      return { kind: "saved_not_active", revision: "revision-two", message: "Saved on disk." }
    },
  })
  assert.ok(authority)
  t.after(() => authority.dispose())
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Drain the bounded synthetic SDK request. */ }
    response.setHeader("content-type", "application/json")
    if (request.url?.startsWith("/api/info")) response.end(JSON.stringify({ pid: process.pid, version: "2.2.6" }))
    else if (request.url?.includes("/settings")) {
      metadataReads++
      if (hooks.settingsFails) { response.statusCode = 404; response.end(JSON.stringify({ type: "rpc.method_not_found", message: "PRIVATE missing method" })); return }
      if (unavailable-- > 0) { response.statusCode = 500; response.end(JSON.stringify({ type: "rpc.unavailable", message: "RPC is starting." })); return }
      response.end(JSON.stringify({ output: { ...snapshot, writable: false, localAuthority: { id: authority.id } } }))
    }
    else response.end(JSON.stringify({ output: { groups: [], issues: [] } }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const client = OpenCode.make({ baseUrl: url })
  const endpoint = { id: "sidecar", url, headers: {}, sameMachine: true }
  const lifetime = new AbortController()
  const host = {
    app: { name: "opencode", version: "2.3.0", platform: "desktop" as const, packaged: true, channel: "prod" as const },
    signal: lifetime.signal,
    serverEndpoints: { get: (_id: string) => endpoint },
  }
  const runtime: StandaloneRuntime = {
    platform: "darwin", uid: 501, pid: process.pid - 1, executable: "/native/opencode", argv: ["/native/opencode", "/native/opencode", "--standalone"], env: {},
    inspect: async () => ({ parent: process.pid - 1, uid: 501, command: "/native/opencode serve --stdio --port 0", started: "Sun Nov 15 12:00:00 2026" }),
  }
  return { hooks, root, file, snapshot, location, endpoint, host, client, runtime, authority, lifetime, unavailableReads(count: number) { unavailable = count }, counts: () => ({ saves, socketReads, metadataReads }) }
}

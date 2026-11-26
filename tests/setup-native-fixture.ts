import assert from "node:assert/strict"
import type { TestContext } from "node:test"
import { createServer } from "node:http"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { parseOptions } from "../src/options.ts"
import type { ContextFileStatus, SaveInput, SetupIssue, SetupSnapshot } from "../src/setup.ts"
import { applyPreferenceChange, resolvePreferences } from "../src/preferences.ts"

const temporary = process.env.PREDICTIONS_TEST_TMP_ROOT ?? join(tmpdir(), "opencode")
export async function nativeFixture(t: TestContext) {
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, "a-"))
  const file = join(root, "config.json")
  await writeFile(file, "{}")
  const parsed = parseOptions({})
  assert.ok(parsed.ok)
  const location = { directory: "/fixture/project" }
  const snapshot: SetupSnapshot = { revision: "revision-one", activeRevision: "revision-one", overrides: {}, origins: resolvePreferences({}).origins, source: file, scope: "global", writable: true, fields: {}, effective: parsed.value, catalog: [], issues: [], serviceVersion: "service-one" }
  let saves = 0, metadataReads = 0, unavailable = 0, contextReads = 0
  const hooks: { afterWrite?: () => void; settingsFails?: boolean; previewFails?: boolean; saveFails?: boolean; saveIssue?: SetupIssue; context: ContextFileStatus; contextErrors: string[] } = { context: { set: false }, contextErrors: [] }
  const save = async (input: SaveInput) => {
      saves++
      if (hooks.saveIssue) return { kind: "invalid" as const, issues: [hooks.saveIssue] }
      if (input.revision !== snapshot.revision) return { kind: "conflict" as const, message: "Configuration changed. Reload settings before trying again." }
      await writeFile(file, JSON.stringify(input.fields)); hooks.afterWrite?.()
      snapshot.fields = { ...snapshot.fields, ...input.fields }; if (input.removeModels) delete snapshot.fields.models
      const { revision: _, ...change } = input
      snapshot.overrides = applyPreferenceChange(snapshot.overrides, change)
      const resolved = resolvePreferences(snapshot.overrides)
      snapshot.fields = resolved.fields; snapshot.origins = resolved.origins
      snapshot.revision = "revision-two"
      return { kind: "saved_not_active" as const, revision: "revision-two", message: "Saved on disk." }
  }
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    response.setHeader("content-type", "application/json")
    if (request.url?.startsWith("/api/info")) response.end(JSON.stringify({ pid: process.pid, version: "fixture" }))
    else if (request.url?.includes("/settingsV2")) {
      metadataReads++
      if (hooks.settingsFails) { response.statusCode = 404; response.end(JSON.stringify({ type: "rpc.method_not_found", message: "PRIVATE missing method" })); return }
      if (unavailable-- > 0) { response.statusCode = 500; response.end(JSON.stringify({ type: "rpc.unavailable", message: "RPC is starting." })); return }
      response.end(JSON.stringify({ output: snapshot }))
    }
    else if (request.url?.includes("/saveSettings")) {
      if (hooks.saveFails) { response.statusCode = 500; response.end(JSON.stringify({ type: "rpc.unavailable", message: "PRIVATE Save failure" })); return }
      response.end(JSON.stringify({ output: await save(JSON.parse(raw).input) }))
    }
    else if (request.url?.includes("/contextFileStatus")) {
      contextReads++
      const type = hooks.contextErrors.shift()
      if (type) { response.statusCode = type === "rpc.method_not_found" ? 404 : 500; response.end(JSON.stringify({ type, message: "PRIVATE context" })); return }
      response.end(JSON.stringify({ output: hooks.context }))
    }
    else if (hooks.previewFails) { response.statusCode = 500; response.end(JSON.stringify({ type: "rpc.unavailable", message: "PRIVATE preview" })) }
    else response.end(JSON.stringify({ output: { groups: [], issues: [] } }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const client = OpenCode.make({ baseUrl: url })
  return { hooks, root, file, snapshot, location, client, unavailableReads(count: number) { unavailable = count }, counts: () => ({ saves, metadataReads, contextReads }) }
}

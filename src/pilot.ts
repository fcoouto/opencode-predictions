#!/usr/bin/env node
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { resolveModels, type Candidate } from "./models.ts"
import { buildPrompt, parseSuggestion } from "./predict.ts"
export type PilotCandidate = Candidate & { category: string }
export type PilotResult = PilotCandidate & { status: string; latencyMs: number; suggestion?: string; httpStatus?: number; error?: string }
export async function runPilot(candidates: PilotCandidate[], generate: (model: Candidate, prompt: string) => Promise<string>): Promise<PilotResult[]> {
  if (new Set(candidates.map(candidate => candidate.category)).size < 2) throw new Error("Select models from at least two categories")
  const prompt = buildPrompt([{ user: ["Fix the failing assertion in the parser test. Keep the change small."], assistant: ["Fixed the assertion to check the normalized path. I have not run the tests yet."] }], 3)!
  return await Promise.all(candidates.map(async candidate => {
    const started = performance.now()
    try {
      const output = await generate(candidate, prompt)
      const suggestion = parseSuggestion(output)
      if (!suggestion && (JSON.parse(output) as { prompt?: unknown } | null)?.prompt !== null) throw new Error("Invalid prediction response")
      return { ...candidate, status: suggestion ? "suggestion" : "no_suggestion", latencyMs: Math.round(performance.now() - started), ...(suggestion ? { suggestion } : {}) }
    } catch (error) {
      const failure = error as { name?: string; status?: number; statusCode?: number }
      return { ...candidate, status: "failed", latencyMs: Math.round(performance.now() - started), httpStatus: failure.status ?? failure.statusCode, error: failure.name ?? "Model call failed" }
    }
  }))
}

async function main() {
  const { values } = parseArgs({ options: { go: { type: "string" }, free: { type: "string" }, paid: { type: "string" }, timeout: { type: "string", default: "15000" }, output: { type: "string" }, "dry-run": { type: "boolean", default: false } } })
  const selectors = (["go", "free", "paid"] as const).flatMap(category => values[category] ? [{ category, selector: values[category]! }] : [])
  if (selectors.length < 2) throw new Error("Supply at least two of --go, --free, --paid (one selector per category)")
  const timeout = Number(values.timeout)
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new Error("Invalid timeout")
  const endpoint = await Service.discover({ version: version => version.startsWith("2.") })
  if (!endpoint) throw new Error("Cannot authenticate to the existing OpenCode service. Check CLI/Desktop compatibility and `opencode api get /api/info`; the pilot will not restart your service.")
  const api = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const { data: catalog } = await api.model.list()
  const candidates = selectors.map(({ category, selector }) => {
    const match = resolveModels(selector, catalog)[0]
    if (!match) throw new Error("No available model/variant matches " + selector)
    return { ...match, category }
  })
  if (values["dry-run"]) { console.log(JSON.stringify({ candidates, calls: 0 }, null, 2)); return }
  const results = await runPilot(candidates, async (candidate, prompt) => {
    const model = { providerID: candidate.providerID, id: candidate.id, ...(candidate.variant ? { variant: candidate.variant } : {}) }
    return (await api.experimental.generate.text({ model, prompt }, { signal: AbortSignal.timeout(timeout) })).text
  })
  const report = { date: new Date().toISOString(), context: "Synthetic parser-test follow-up; identical across all models", timeoutMs: timeout, usage: "Stateless generation exposes no measured tokens/cost. Go-included usage is not necessarily zero-price or unlimited.", results }
  const output = values.output ?? `.test-artifacts/pilot-${Date.now()}.json`
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify(report, null, 2))
  console.log("Report: " + output)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Pilot failed"); process.exitCode = 1 })
}

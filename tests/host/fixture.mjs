import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

export const isPredictionCall = input => JSON.stringify(input).includes("Conversation:\\n[")

export async function createFixture(packagePath = resolve("."), settings = {}, behavior = {}, { configSource = "inline", projectConfig = false, pluginReference = "object", emptyPassword = false, configHome = "", seedPreferences = true, legacyOptions = {} } = {}) {
  if (!["inline", "global-json", "global-jsonc"].includes(configSource)) throw new Error("Unsupported fixture config source")
  await mkdir(".test-artifacts", { recursive: true })
  const root = await mkdtemp(resolve(".test-artifacts/host-"))
  const temporaryRoot = process.env.PREDICTIONS_TEST_TMP_ROOT ?? join(tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  const temporary = await mkdtemp(join(temporaryRoot, "h-"))
  const directory = join(root, "project")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "README.md"), "Synthetic prediction integration fixture.\n")
  const calls = []
  const provider = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const input = JSON.parse(raw || "{}")
      calls.push(input)
      const prediction = isPredictionCall(input)
      if (prediction) await writeFile(join(root, "prediction-models.json"), JSON.stringify(calls.filter(isPredictionCall).map(call => call.model)))
      if (prediction && behavior.predictionDelayMs?.[input.model]) await new Promise(resolve => setTimeout(resolve, behavior.predictionDelayMs[input.model]))
      const status = behavior.predictionStatuses?.[input.model] ?? behavior.predictionStatus
      if (prediction && status) {
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: "PRIVATE fixture provider failure", type: "server_error" } }))
        return
      }
      const content = prediction ? behavior.predictionOutputs?.[input.model] ?? '{"prompt":"Run the targeted tests."}' : "I fixed the assertion. The tests have not been run yet."
      const base = { id: "chatcmpl-fixture", created: Math.floor(Date.now() / 1000), model: "fixture" }
      if (input.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write("data: " + JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) + "\n\n")
        res.write("data: " + JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + "\n\n")
        res.end("data: [DONE]\n\n")
      } else {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }))
      }
    } catch { res.writeHead(500); res.end("Fixture failed") }
  })
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
  let config = {
    $schema: "https://opencode.ai/config.json",
    model: "fixture/model",
    plugins: [{ package: packagePath, ...(Object.keys(legacyOptions).length ? { options: legacyOptions } : {}) }],
    providers: { fixture: { name: "Fixture", env: ["FIXTURE_API_KEY"], package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1` }, models: Object.fromEntries([...new Set(["model", ...Object.keys(behavior.predictionOutputs ?? {})])].map(id => [id, { name: id === "model" ? "Fixture Flash" : "Fixture " + id, capabilities: { tools: false }, limit: { context: 32768, output: 2048 } }])) } },
  }
  /** @type {NodeJS.ProcessEnv} */
  const env = { PATH: process.env.PATH, HOME: root, USER: process.env.USER ?? "test", LANG: "en_US.UTF-8", TERM: "xterm-256color", TMPDIR: temporary, FIXTURE_API_KEY: "fixture-only", OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DESKTOP_TEST_ROOT: root }
  if (projectConfig) delete env.OPENCODE_DISABLE_PROJECT_CONFIG
  if (emptyPassword) env.OPENCODE_SERVER_PASSWORD = ""
  if (pluginReference === "string") config.plugins = [packagePath]
  for (const name of ["DATA", "CONFIG", "CACHE", "STATE"]) { env[`XDG_${name}_HOME`] = join(root, name.toLowerCase()); await mkdir(env[`XDG_${name}_HOME`], { recursive: true }) }
  if (configHome) env.XDG_CONFIG_HOME = configHome
  const configDirectory = join(env.XDG_CONFIG_HOME, "opencode")
  const preferencesFile = join(configDirectory, "predictions.json")
  await mkdir(configDirectory, { recursive: true })
  if (seedPreferences && !configHome) await writeFile(preferencesFile, JSON.stringify({ version: 1, settings: { models: "fixture/model", ...settings } }), { mode: 0o600 })
  const configFile = configSource === "inline" ? undefined : join(configDirectory, configSource === "global-jsonc" ? "opencode.jsonc" : "opencode.json")
  const writeConfig = async value => {
    if (configFile) {
      await writeFile(configFile, (configSource === "global-jsonc" ? "// Synthetic global fixture configuration.\n" : "") + JSON.stringify(value, null, 2) + "\n")
      delete env.OPENCODE_CONFIG_CONTENT
    } else env.OPENCODE_CONFIG_CONTENT = JSON.stringify(value)
    config = value
  }
  await writeConfig(config)
  // Desktop's managed service needs its own nonzero port, not the user's shared default.
  const probe = createServer()
  probe.listen(0, "127.0.0.1")
  await once(probe, "listening")
  const port = probe.address().port
  // shortcut: releasing the probe can race with another bind; retry allocation if test collisions recur.
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  await writeFile(join(configDirectory, "service.json"), JSON.stringify({ port, hostname: "127.0.0.1" }))
  let child
  let address = ""
  let headers = { authorization: "" }
  /** @type {ReturnType<typeof OpenCode.make>} */
  let api
  let output = ""
  const start = async () => {
    output = ""
    child = spawn(process.env.OPENCODE_BIN ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-64000) })
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-64000) })
    address = await new Promise((resolveAddress, reject) => {
      const timeout = setTimeout(() => { child.kill(); provider.close(); reject(new Error("Fixture server did not start: " + output)) }, 45000)
      const onData = () => { const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match && /server password \S+/.test(output)) { clearTimeout(timeout); resolveAddress(match[0]) } }
      child.stdout.on("data", onData)
      child.once("error", error => { clearTimeout(timeout); reject(error) })
      child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Fixture server exited ${code}: ${output}`)) })
    })
    const password = output.match(/server password (\S+)/)?.[1]
    headers = { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") }
    api = OpenCode.make({ baseUrl: address, headers })
    const ready = AbortSignal.timeout(10000)
    for (;;) {
      ready.throwIfAborted()
      const plugins = await api.plugin.list({ location: { directory } }, { signal: ready })
      if (plugins.data.some(plugin => plugin.id === "opencode-predictions" && plugin.state.status === "active")) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  const stopChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill("SIGTERM")
    await Promise.race([once(child, "exit"), new Promise(resolveWait => setTimeout(() => { child.kill("SIGKILL"); resolveWait() }, 3000).unref())])
  }
  try { await start() } catch (error) { await stopChild(); provider.closeAllConnections(); provider.close(); throw error }
  const stop = async () => {
    await Service.stop({ file: join(root, "state", "opencode", "service.json") })
    await stopChild()
    provider.closeAllConnections(); provider.close()
  }
  const restart = async () => { await stopChild(); await start() }
  return { root, directory, env, get api() { return api }, get address() { return address }, calls, get config() { return config }, configFile, preferencesFile, writeConfig, get headers() { return headers }, output: () => output.replace(/server password \S+/g, "server password [redacted]"), restart, stop, [Symbol.asyncDispose]: stop }
}

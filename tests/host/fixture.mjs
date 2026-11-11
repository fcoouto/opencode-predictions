import { createServer } from "node:http"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { once } from "node:events"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

export async function createFixture(packagePath = resolve("."), options = {}, behavior = {}) {
  await mkdir(".test-artifacts", { recursive: true })
  const root = await mkdtemp(resolve(".test-artifacts/host-"))
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
      const prediction = JSON.stringify(input).includes("Predict the user's next complete prompt")
      if (prediction && behavior.predictionStatus) {
        res.writeHead(behavior.predictionStatus, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: "PRIVATE fixture provider failure", type: "server_error" } }))
        return
      }
      const content = prediction ? '{"prompt":"Run the targeted tests."}' : "I fixed the assertion. The tests have not been run yet."
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
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "fixture/model",
    plugins: [{ package: packagePath, options: { models: "fixture/model", timeoutMs: 8000, obsolete: true, ...options } }],
    providers: { fixture: { name: "Fixture", env: ["FIXTURE_API_KEY"], package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1` }, models: { model: { name: "Fixture Flash", capabilities: { tools: false }, limit: { context: 32768, output: 2048 } } } } },
  }
  const env = { PATH: process.env.PATH, HOME: root, USER: process.env.USER ?? "test", LANG: "en_US.UTF-8", TERM: "xterm-256color", TMPDIR: process.env.TMPDIR ?? root, FIXTURE_API_KEY: "fixture-only", OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DESKTOP_TEST_ROOT: root }
  for (const name of ["DATA", "CONFIG", "CACHE", "STATE"]) { env[`XDG_${name}_HOME`] = join(root, name.toLowerCase()); await mkdir(env[`XDG_${name}_HOME`], { recursive: true }) }
  const probe = createServer()
  probe.listen(0, "127.0.0.1")
  await once(probe, "listening")
  const servicePort = probe.address().port
  await new Promise(resolveClose => probe.close(resolveClose))
  try { await promisify(execFile)(process.env.OPENCODE_BIN ?? "opencode", ["service", "set", "port", String(servicePort)], { env, cwd: directory }) }
  catch (error) { provider.close(); throw error }
  const child = spawn(process.env.OPENCODE_BIN ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-64000) })
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-64000) })
  const address = await new Promise((resolveAddress, reject) => {
    const timeout = setTimeout(() => { child.kill(); provider.close(); reject(new Error("Fixture server did not start: " + output)) }, 45000)
    const onData = () => { const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match && /server password \S+/.test(output)) { clearTimeout(timeout); resolveAddress(match[0]) } }
    child.stdout.on("data", onData)
    child.once("error", error => { clearTimeout(timeout); reject(error) })
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Fixture server exited ${code}: ${output}`)) })
  })
  const password = output.match(/server password (\S+)/)[1]
  const headers = { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") }
  const api = OpenCode.make({ baseUrl: address, headers })
  const stop = async () => {
    await Service.stop({ file: join(root, "state", "opencode", "service.json") })
    child.kill("SIGTERM"); provider.closeAllConnections(); provider.close()
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise(resolveWait => setTimeout(() => { child.kill("SIGKILL"); resolveWait() }, 3000).unref())])
  }
  return { root, directory, env, api, address, calls, config, headers, output: () => output.replace(/server password \S+/g, "server password [redacted]"), stop, [Symbol.asyncDispose]: stop }
}

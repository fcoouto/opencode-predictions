import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"

const checkOnly = process.argv.includes("--check")
assert.ok(checkOnly || process.platform === "win32" && process.env.GITHUB_ACTIONS === "true",
  "Timing instrumentation is only for the disposable Windows CI checkout.")

function replaceOnce(source, anchor, replacement) {
  assert.equal(source.split(anchor).length, 2, `Unexpected timing anchor: ${anchor}`)
  return source.replace(anchor, () => replacement)
}

const phase = name => `Write-PrefTiming '${name}'`
const transport = new URL("../../src/preferences-windows.ts", import.meta.url)
let ts = await readFile(transport, "utf8")
const boot = "  $ErrorActionPreference = 'Stop'"
ts = replaceOnce(ts, boot, `${boot}
  function Write-PrefTiming([string]$phase) {
    [Console]::Error.WriteLine('PREF_PHASE:' + $phase + ':' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    [Console]::Error.Flush()
  }
  ${phase("BOOT")}`)
ts = replaceOnce(ts, "  $parts = ", `  ${phase("COLLECTED")}\n  $parts = `)
ts = replaceOnce(ts, "  & ([ScriptBlock]::Create($code))", `  ${phase("PACKET")}\n  & ([ScriptBlock]::Create($code))`)
ts = replaceOnce(ts, "class HelperRefusal extends Error {}", "class HelperRefusal extends Error {}\nlet timingCall = 0")
ts = replaceOnce(ts, "  const deadline = AbortSignal.timeout(1800)", `  const call = ++timingCall, began = Date.now()
  const trace = (label: string, at = Date.now()) => console.error("PREF_TIMING", process.pid, call, request.op, label, at - began)
  trace("START")
  const deadline = AbortSignal.timeout(1800)
  const timedOut = () => trace("DEADLINE")
  deadline.addEventListener("abort", timedOut, { once: true })`)
ts = replaceOnce(ts, 'stdio: ["ignore", "pipe", "ignore"]', 'stdio: ["ignore", "pipe", "pipe"]')
ts = replaceOnce(ts, "    const bytes = await new Promise<Buffer>", `    child.once("spawn", () => trace("SPAWN"))
    child.once("exit", code => trace(code === 0 ? "EXIT_OK" : "EXIT_OTHER"))
    let tail = ""
    child.stderr.on("data", (chunk: Buffer) => {
      const lines = (tail + chunk.toString("ascii")).split(/\\r?\\n/)
      tail = lines.pop()!.slice(-128)
      for (const line of lines) {
        const match = /^PREF_PHASE:(BOOT|COLLECTED|PACKET|COMPILE|COMPILED|VERIFIED|OUTPUT):([0-9]{13})$/.exec(line)
        if (match) trace(match[1], Number(match[2]))
      }
    })
    const bytes = await new Promise<Buffer>`)
ts = replaceOnce(ts, 'child.on("error", () => { failed = true })', 'child.on("error", () => { failed = true; trace("PROCESS_ERROR") })')
ts = replaceOnce(ts, "        length += chunk.length", `        if (length === 0) trace("STDOUT")
        length += chunk.length`)
ts = replaceOnce(ts, '      child.once("close", code => {', `      child.once("close", code => {
        deadline.removeEventListener("abort", timedOut)
        trace(code === 0 ? "CLOSE_OK" : "CLOSE_OTHER")`)

const verifier = new URL("../../src/preferences-windows-script.ts", import.meta.url)
let ps = await readFile(verifier, "utf8")
ps = replaceOnce(ps, "Add-Type -TypeDefinition", `${phase("COMPILE")}\nAdd-Type -TypeDefinition`)
ps = replaceOnce(ps, "$reply = ", `${phase("COMPILED")}\n$reply = `)
ps = replaceOnce(ps, "[Console]::WriteLine((ConvertTo-Json -InputObject $reply -Depth 4 -Compress))",
  `${phase("VERIFIED")}\n[Console]::WriteLine((ConvertTo-Json -InputObject $reply -Depth 4 -Compress))\n${phase("OUTPUT")}`)

if (!checkOnly) {
  await writeFile(transport, ts)
  await writeFile(verifier, ps)
}
console.log(checkOnly ? "Windows timing anchors verified." : "Instrumented the temporary Windows CI checkout.")

import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve, join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { _electron as electron } from "playwright"
import { build } from "esbuild"
import { copyFile, mkdir, writeFile, readFile, mkdtemp, cp } from "node:fs/promises"
import { createFixture, isPredictionCall } from "./fixture.mjs"
import { build as viteBuild } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

async function predictionPackage() {
  await mkdir(".test-artifacts", { recursive: true })
  const directory = await mkdtemp(resolve(".test-artifacts/save-predictions-"))
  await cp(resolve("dist"), join(directory, "dist"), { recursive: true })
  await copyFile(resolve("package.json"), join(directory, "package.json"))
  await build({ entryPoints: ["tests/host/prediction-tui.ts"], outfile: join(directory, "dist/tui.js"), bundle: true, format: "esm", platform: "node", packages: "external" })
  await viteBuild({ configFile: false, plugins: [gui({ entry: "tests/host/prediction-gui.ts", outFile: join(directory, "dist/gui-experimental.cjs") })] })
  return directory
}

for (const automatic of [true, false]) test(`setup lifecycle: standalone Save preserves composer and suppresses predictions across actual module remount, automatic=${automatic}`, { timeout: 100000 }, async () => {
  const packagePath = await predictionPackage()
  await using fixture = await createFixture(packagePath, { automatic }, {}, { configSource: "global-jsonc" })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  if (automatic) {
    await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion." })
    await fixture.api.session.wait({ sessionID: session.id })
  }
  const observer = { package: resolve("tests/host/observer"), options: {} }
  await fixture.writeConfig({ ...fixture.config, plugins: [...fixture.config.plugins, observer] })
  const observation = join(fixture.root, "save-observation.json")
  const { stdout } = await promisify(execFile)("python3", [resolve("tests/host/terminal.py"), process.env.OPENCODE_BIN ?? "opencode", session.id, fixture.directory, observation], {
    env: { ...fixture.env, PREDICTIONS_OBSERVER: observation, PREDICTIONS_SAVE_TEST: "1", PREDICTIONS_SAVE_AUTOMATIC: String(automatic), PREDICTIONS_SAVE_MODULE: join(packagePath, "dist/tui.js") },
    timeout: 90000, maxBuffer: 1024 * 1024,
  })
  const result = JSON.parse(stdout)
  assert.equal(result.saved, true)
  assert.equal(result.composerPreserved, true)
  assert.equal(result.predictionRemounted, true)
  assert.equal(result.noSurprisePrediction, true)
  assert.equal(fixture.calls.filter(isPredictionCall).length, automatic ? 2 : 1, "only the initial (automatic) prediction and one for the later completed turn")
  assert.match(await readFile(fixture.configFile!, "utf8"), /"debug": true/)
})

for (const automatic of [false, true]) test(`setup lifecycle: Desktop memory handoff preserves composer and suppresses current completion, automatic=${automatic}`, { timeout: 100000, skip: process.platform !== "darwin" }, async () => {
  await build({ entryPoints: ["tests/host/observer/gui.ts"], outfile: "tests/host/observer/gui-experimental.cjs", bundle: true, format: "cjs", platform: "browser", packages: "external" })
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic }, {}, { configSource: "global-jsonc" })
  const observer = { package: resolve("tests/host/observer"), options: { directory: fixture.directory, reloadProbe: 1 } }
  const config = { ...fixture.config, plugins: [...fixture.config.plugins, observer] }
  await fixture.writeConfig(config)
  const app = await electron.launch({
    executablePath: process.env.OPENCODE_DESKTOP_BIN ?? "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
    args: ["--user-data-dir=" + join(fixture.root, "desktop-profile")],
    env: fixture.env as Record<string, string>, timeout: 45000,
  })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), { timeout: 45000 })
    const before = await page.evaluate(() => (window as any).__predictionFixture.memory?.())
    assert.equal(before?.available, true, "native window-local memory API must be available")
    assert.ok(before.generations >= 1)
    await page.evaluate(() => (window as any).__predictionFixture.launch())
    const editor = page.locator('[data-component="composer-editor"][contenteditable="true"]')
    await editor.waitFor({ state: "visible", timeout: 20000 })
    if (automatic) {
      await page.waitForFunction(() => document.querySelector('[data-component="composer-editor"]')?.textContent === "Fix the assertion.")
      await page.getByRole("button", { name: "Fixture / Fixture Flash", exact: true }).waitFor({ state: "visible" })
      await editor.press("Enter")
      await page.locator("[data-opencode-prediction]").waitFor({ state: "visible", timeout: 15000 })
    }
    const callsBefore = fixture.calls.filter(isPredictionCall).length
    await editor.fill("my existing draft")
    await fixture.writeConfig({ ...config, plugins: [...fixture.config.plugins.map(plugin => ({ ...plugin, options: { ...plugin.options, debug: true } })), { ...observer, options: { ...observer.options, reloadProbe: 2 } }] })
    await page.waitForFunction(before => {
      const value = (window as any).__predictionFixture?.memory?.()
      return value?.generations > before.generations && value.token === before.token
    }, before, { timeout: 20000 })
    assert.equal(await editor.innerText(), "my existing draft")
    await editor.fill("")
    await page.waitForTimeout(2300)
    assert.equal(fixture.calls.filter(isPredictionCall).length, callsBefore)
    assert.equal(await page.locator("[data-opencode-prediction]").count(), 0)
  } finally { await app.close() }
})

for (const automatic of [false, true]) test(`setup lifecycle: CLI memory handoff preserves composer and suppresses current completion, automatic=${automatic}`, { timeout: 80000 }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic }, {}, { configSource: "global-jsonc" })
  const session = await fixture.api.session.create({ location: { directory: fixture.directory }, model: { providerID: "fixture", id: "model" } })
  if (automatic) {
    await fixture.api.session.prompt({ sessionID: session.id, text: "Fix the assertion." })
    await fixture.api.session.wait({ sessionID: session.id })
  }
  const directory = join(fixture.root, "memory-observer")
  await mkdir(directory)
  await copyFile(resolve("tests/host/observer/index.ts"), join(directory, "index.ts"))
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "prediction-test-observer", type: "module", exports: { ".": "./index.ts", "./tui": "./tui.js" } }))
  const module = join(directory, "tui.js")
  await build({ entryPoints: ["tests/host/observer/tui.ts"], outfile: module, bundle: true, format: "esm", platform: "node", packages: "external" })
  const observer = { package: directory, options: { reloadProbe: 1 } }
  const config = { ...fixture.config, plugins: [...fixture.config.plugins, observer] }
  await fixture.writeConfig(config)
  const next = { ...config, plugins: [...fixture.config.plugins.map(plugin => ({ ...plugin, options: { ...plugin.options, debug: true } })), { ...observer, options: { reloadProbe: 2 } }] }
  const observation = join(fixture.root, "memory-observation.json")
  const { stdout } = await promisify(execFile)("python3", [resolve("tests/host/terminal.py"), process.env.OPENCODE_BIN ?? "opencode", session.id, fixture.directory, observation], {
    env: { ...fixture.env, PREDICTIONS_OBSERVER: observation, PREDICTIONS_MEMORY_TEST: "1", PREDICTIONS_MEMORY_AUTOMATIC: String(automatic), PREDICTIONS_MEMORY_CONFIG: fixture.configFile, PREDICTIONS_MEMORY_NEXT_CONFIG: JSON.stringify(next), PREDICTIONS_MEMORY_MODULE: module },
    timeout: 65000, maxBuffer: 1024 * 1024,
  })
  assert.equal(JSON.parse(stdout).memoryHandoff, true)
  assert.equal(JSON.parse(stdout).composerPreserved, true)
  assert.equal(fixture.calls.filter(isPredictionCall).length, automatic ? 1 : 0)
})

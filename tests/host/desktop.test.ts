import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { _electron as electron } from "playwright"
import { build } from "esbuild"
import { createFixture } from "./fixture.mjs"

test("real isolated Desktop shows predictions and Tab edits without sending", { timeout: 100000 }, async () => {
  await build({ entryPoints: ["tests/host/observer/gui.ts"], outfile: "tests/host/observer/gui-experimental.cjs", bundle: true, format: "cjs", platform: "browser", packages: "external" })
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE)
  const config = { ...fixture.config, plugins: [...fixture.config.plugins, { package: resolve("tests/host/observer"), options: { directory: fixture.directory } }] }
  const app = await electron.launch({ executablePath: process.env.OPENCODE_DESKTOP_BIN ?? "/Applications/OpenCode.app/Contents/MacOS/OpenCode", env: { ...fixture.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } as Record<string, string>, timeout: 45000 })
  try {
    const page = await app.firstWindow()
    page.on("pageerror", error => console.error("Desktop page:", error.message))
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), { timeout: 45000 })
    await page.evaluate(() => (window as any).__predictionFixture.launch())
    const editor = page.locator('[data-component="composer-editor"][contenteditable="true"]')
    await editor.waitFor({ state: "visible", timeout: 20000 })
    await page.waitForFunction(() => document.querySelector('[data-component="composer-editor"]')?.textContent === "Fix the assertion.")
    await editor.press("Enter")
    try {
      await page.locator("[data-opencode-prediction]").waitFor({ state: "visible", timeout: 15000 })
    } catch (error) {
      console.error("Desktop fixture:", await page.evaluate(() => (window as any).__predictionFixture.snapshot()))
      throw error
    }
    assert.equal(await editor.innerText(), "")
    const usersBefore = await page.evaluate(() => (window as any).__predictionFixture.users())
    await editor.press("Tab")
    assert.equal(await editor.innerText(), "Run the targeted tests.")
    assert.equal(await page.evaluate(() => (window as any).__predictionFixture.users()), usersBefore)
    await editor.fill("my own prompt")
    await editor.press("Tab")
    assert.equal(await editor.innerText(), "my own prompt")
  } finally { await app.close() }
})

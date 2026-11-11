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
    await page.getByRole("button", { name: "Fixture / Fixture Flash", exact: true }).waitFor({ state: "visible" })
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

for (const kind of ["invalid", "temporary"] as const) test(`real isolated Desktop exposes ${kind} prediction failures and reopenable status`, { timeout: 100000 }, async () => {
  await build({ entryPoints: ["tests/host/observer/gui.ts"], outfile: "tests/host/observer/gui-experimental.cjs", bundle: true, format: "cjs", platform: "browser", packages: "external" })
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, kind === "invalid" ? { models: 42 } : {}, kind === "temporary" ? { predictionStatus: 503 } : {})
  const config = { ...fixture.config, plugins: [...fixture.config.plugins, { package: resolve("tests/host/observer"), options: { directory: fixture.directory } }] }
  const app = await electron.launch({ executablePath: process.env.OPENCODE_DESKTOP_BIN ?? "/Applications/OpenCode.app/Contents/MacOS/OpenCode", env: { ...fixture.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } as Record<string, string>, timeout: 45000 })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), { timeout: 45000 })
    await page.evaluate(() => (window as any).__predictionFixture.launch())
    const editor = page.locator('[data-component="composer-editor"][contenteditable="true"]')
    await editor.waitFor({ state: "visible", timeout: 20000 })
    if (kind === "temporary") {
      await page.getByRole("button", { name: "Fixture / Fixture Flash", exact: true }).waitFor({ state: "visible" })
      await editor.press("Enter")
    }
    const title = kind === "invalid" ? "Prediction settings are invalid" : "Prediction models are temporarily paused"
    await page.getByText(title, { exact: true }).waitFor({ state: "visible", timeout: 20000 })
    await page.getByRole("button", { name: "Open prediction status", exact: true }).last().click()
    const dialog = page.getByRole("dialog")
    await dialog.getByText(/Prediction status snapshot/).waitFor({ state: "visible" })
    assert.match(await dialog.innerText(), new RegExp(title))
    assert.doesNotMatch(await dialog.innerText(), /PRIVATE/)
    await page.screenshot({ path: resolve(`.test-artifacts/feedback-desktop-${kind}.png`) })
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click()
    await page.evaluate(() => (window as any).__predictionFixture.status())
    await page.getByRole("dialog").getByText(/Prediction status snapshot/).waitFor({ state: "visible" })
    await page.getByRole("dialog").getByRole("button", { name: "Technical details", exact: true }).click()
    await page.getByRole("dialog").getByText(/Service plugin: 0.1.0/).waitFor({ state: "visible" })
  } finally { await app.close() }
})

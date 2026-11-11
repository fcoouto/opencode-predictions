import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { _electron as electron } from "playwright"
import { build } from "esbuild"
import { createFixture } from "./fixture.mjs"

for (const automatic of [true, false]) test(`real isolated Desktop ${automatic ? "automatically" : "via Alt+Shift+P"} shows predictions and Tab edits without sending`, { timeout: 100000 }, async () => {
  await build({ entryPoints: ["tests/host/observer/gui.ts"], outfile: "tests/host/observer/gui-experimental.cjs", bundle: true, format: "cjs", platform: "browser", packages: "external" })
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic })
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
    const submittedAt = Date.now()
    await editor.press("Enter")
    if (!automatic) {
      // Promise-returning predicates are truthy to Playwright's poller, even when they resolve false.
      try {
        await page.waitForFunction(submittedAt => (window as any).__predictionFixture.predictionReady(submittedAt), submittedAt, { timeout: 15000 })
      } catch (error) { console.error("Desktop readiness:", { submittedAt, snapshot: await page.evaluate(() => (window as any).__predictionFixture.snapshot()) }); throw error }
      assert.equal(await page.locator("[data-opencode-prediction]").count(), 0)
      assert.equal(fixture.calls.filter(call => JSON.stringify(call).includes("Predict the user's next complete prompt")).length, 0)
      await editor.press("Alt+Shift+P")
    }
    try {
      await page.locator("[data-opencode-prediction]").waitFor({ state: "visible", timeout: 15000 })
    } catch (error) {
      console.error("Desktop fixture:", await page.evaluate(() => (window as any).__predictionFixture.snapshot()))
      throw error
    }
    assert.equal(await editor.innerText(), "")
    if (!automatic) {
      assert.equal((await page.evaluate(() => (window as any).__predictionFixture.snapshot())).lastKey.matches, true)
      await editor.press("Escape")
      await page.locator("[data-opencode-prediction]").waitFor({ state: "detached" })
      await editor.dispatchEvent("keydown", { key: "∏", code: "KeyP", altKey: true, shiftKey: true, bubbles: true, cancelable: true })
      await page.locator("[data-opencode-prediction]").waitFor({ state: "visible" })
      assert.equal(await editor.innerText(), "")
      assert.equal((await page.evaluate(() => (window as any).__predictionFixture.snapshot())).lastKey.matches, true)
    }
    const usersBefore = await page.evaluate(() => (window as any).__predictionFixture.users())
    await editor.press("Tab")
    assert.equal(await editor.innerText(), "Run the targeted tests.")
    assert.equal(await page.evaluate(() => (window as any).__predictionFixture.users()), usersBefore)
    await editor.fill("my own prompt")
    if (!automatic) {
      const calls = fixture.calls.length
      await editor.press("Alt+Shift+P")
      assert.equal(fixture.calls.length, calls)
      assert.ok((await editor.innerText()).startsWith("my own prompt"))
      await editor.fill("my own prompt")
    }
    await editor.press("Tab")
    assert.equal(await editor.innerText(), "my own prompt")
  } finally { await app.close() }
})

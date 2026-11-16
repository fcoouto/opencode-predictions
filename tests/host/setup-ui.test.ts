import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { _electron as electron, type Page } from "playwright"
import { build } from "esbuild"
import { parse } from "jsonc-parser"
import { createFixture, isPredictionCall } from "./fixture.mjs"
import { Predictions } from "../../src/rpc.ts"
import type { SetupSnapshot } from "../../src/setup.ts"

const executablePath = process.env.OPENCODE_DESKTOP_BIN ?? "/Applications/OpenCode.app/Contents/MacOS/OpenCode"
const skip = process.platform !== "darwin"

async function open(fixture: Awaited<ReturnType<typeof createFixture>>, profile: string) {
  await build({ entryPoints: ["tests/host/observer/gui.ts"], outfile: "tests/host/observer/gui-experimental.cjs", bundle: true, format: "cjs", platform: "browser", packages: "external" })
  await fixture.writeConfig({ ...fixture.config, plugins: [...fixture.config.plugins, { package: resolve("tests/host/observer"), options: { directory: fixture.directory } }] })
  const app = await electron.launch({ executablePath, args: ["--user-data-dir=" + join(fixture.root, profile)], env: fixture.env as Record<string, string>, timeout: 30000 })
  const page = await app.firstWindow()
  const show = async () => {
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), undefined, { timeout: 20000 })
    await page.evaluate(() => (window as any).__predictionFixture.openSetup())
    await page.getByRole("button", { name: "Save changes" }).waitFor({ state: "visible", timeout: 20000 })
  }
  return { app, page, show }
}
// The host Select is a custom listbox: open its trigger, then choose the option by its visible name.
const choose = async (page: Page, label: string, option: string) => {
  await page.getByRole("button", { name: label }).first().click()
  await page.getByRole("option", { name: option, exact: true }).click()
}
// The native switch input is visually hidden; a forced click lands on the visible track that wraps it.
const flip = (page: Page, name: string) => page.getByRole("switch", { name }).click({ force: true })
const status = async (page: Page) => (await page.locator('[data-footer] [role="status"], [role="status"]').allTextContents()).join(" ")
const stored = async (fixture: Awaited<ReturnType<typeof createFixture>>) => { const text = await readFile(fixture.configFile!, "utf8"); return { text, config: parse(text) as any } }
const settings = (fixture: Awaited<ReturnType<typeof createFixture>>) => fixture.api.rpc(Predictions).settings({}, { location: { directory: fixture.directory } }) as Promise<SetupSnapshot>

test("setup ui: Desktop configures all eight settings through the page, reorders groups, saves, reloads and reopens", { timeout: 150000, skip }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false, models: [["fixture/model"], ["nomatch/*"]] }, {}, { configSource: "global-jsonc" })
  const { app, page, show } = await open(fixture, "ui-profile")
  try {
    await show()
    // A zero-match selector is warned about but kept.
    await page.getByText("0 models match now", { exact: true }).waitFor({ state: "visible", timeout: 15000 })
    await page.getByText("No current models match this selector.").waitFor({ state: "visible" })
    assert.equal(await page.getByRole("button", { name: "Group 2 actions" }).count(), 1)
    await page.getByRole("button", { name: "Group 1 actions" }).click()
    await page.getByRole("menuitem", { name: "Move group down" }).click()
    // The host returns focus to the menu trigger when it closes; the page then moves it to the moved group's own menu.
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Group 2 actions", undefined, { timeout: 5000 })
    assert.equal(await page.getByRole("button", { name: "Add to Group 2" }).count(), 1, "menu labels follow the new order")
    await flip(page, "Enable Predictions")
    await flip(page, "Predict After Replies")
    await choose(page, "Escalation Mode", "Automatically once after no suggestion")
    await page.getByRole("button", { name: "Show advanced settings" }).click()
    await page.getByLabel("Timeout per model").fill("9000")
    await choose(page, "Recent interactions", "5")
    await flip(page, "Include GitHub PR context")
    await flip(page, "Debug notices")
    await page.getByRole("button", { name: "Save changes" }).click()
    await page.getByText(/Saved/).first().waitFor({ state: "visible", timeout: 20000 })
    const { text, config } = await stored(fixture)
    const options = config.plugins.find((plugin: any) => typeof plugin === "object" && plugin.options?.models).options
    assert.deepEqual(options.models, [["nomatch/*"], ["fixture/model"]], "group order is saved")
    assert.deepEqual({ enabled: options.enabled, automatic: options.automatic, escalation: options.escalation, timeoutMs: options.timeoutMs, contextTurns: options.contextTurns, includeGithubPRContext: options.includeGithubPRContext, debug: options.debug }, { enabled: false, automatic: true, escalation: "automatic", timeoutMs: 9000, contextTurns: 5, includeGithubPRContext: true, debug: true })
    assert.match(text, /Synthetic global fixture configuration/, "JSONC comments survive")
    assert.ok(config.plugins.some((plugin: any) => typeof plugin === "object" && plugin.package === resolve("tests/host/observer")), "other plugins survive")
    // A second client against the same server sees the saved values once the watcher activates them.
    let seen!: SetupSnapshot
    const until = Date.now() + 15000
    while (Date.now() < until) { seen = await settings(fixture).catch(() => seen); if (seen?.effective?.debug === true) break; await page.waitForTimeout(150) }
    assert.equal(seen.effective?.debug, true)
    assert.equal(seen.effective?.timeoutMs, 9000)
    assert.equal(fixture.calls.length, 0, "setup, preview and Save never generate")
    // Reload the whole window and reopen: every control shows the saved value.
    await page.reload()
    await show()
    assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isChecked(), false)
    assert.equal(await page.getByRole("switch", { name: "Predict After Replies" }).isChecked(), true)
    await page.getByRole("button", { name: "Show advanced settings" }).click()
    assert.equal(await page.getByLabel("Timeout per model").inputValue(), "9000")
    assert.equal(await page.getByRole("switch", { name: "Include GitHub PR context" }).isChecked(), true)
    assert.equal(await page.getByRole("switch", { name: "Debug notices" }).isChecked(), true)
    assert.equal(await page.getByRole("button", { name: "Save changes" }).isDisabled(), true, "a freshly opened page is clean")
    assert.equal(fixture.calls.length, 0)
  } finally { await app.close() }
})

test("setup ui: an inline configuration override keeps Desktop setup inspectable and read-only", { timeout: 90000, skip }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false, models: [["fixture/model"]] })
  const { app, page } = await open(fixture, "inline-profile")
  try {
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), undefined, { timeout: 20000 })
    await page.evaluate(() => (window as any).__predictionFixture.openSetup())
    await page.getByText("Group 1 — Tried first").waitFor({ state: "visible", timeout: 20000 })
    await page.getByText("Read-only", { exact: true }).waitFor({ state: "visible", timeout: 15000 })
    assert.equal(await page.getByRole("button", { name: "Save changes" }).isDisabled(), true)
    assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isDisabled(), true)
    assert.equal(fixture.calls.length, 0)
  } finally { await app.close() }
})

test("setup ui: an edit made elsewhere while the page is open is never overwritten by the stale page", { timeout: 120000, skip }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false, models: [["fixture/model"]] }, {}, { configSource: "global-jsonc" })
  const { app, page, show } = await open(fixture, "conflict-profile")
  try {
    await show()
    await page.getByRole("button", { name: "Show advanced settings" }).click()
    await flip(page, "Debug notices")
    assert.equal(await page.getByRole("button", { name: "Save changes" }).isEnabled(), true, "the page holds an unsaved draft")
    // Another client edits the same file after this page loaded it; the server then reloads the plugin and this page with it.
    const changed = { ...fixture.config, plugins: fixture.config.plugins.map((plugin: any, index: number) => index === 0 ? { ...plugin, options: { ...plugin.options, timeoutMs: 7000 } } : plugin) }
    await fixture.writeConfig(changed)
    const until = Date.now() + 20000
    let seen: SetupSnapshot | undefined
    while (Date.now() < until && seen?.effective?.timeoutMs !== 7000) { seen = await settings(fixture).catch(() => seen); await page.waitForTimeout(150) }
    assert.equal(seen?.effective?.timeoutMs, 7000, "the server activated the other client's edit")
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), undefined, { timeout: 20000 })
    // Known limit: the reload drops the draft. Whichever state the page is in, a Save from it must not overwrite the edit.
    const save = page.getByRole("button", { name: "Save changes" })
    const visible = await save.isVisible().catch(() => false)
    if (visible && await save.isEnabled()) {
      await save.click()
      await page.getByText(/Configuration changed|Reload settings/).first().waitFor({ state: "visible", timeout: 20000 })
    } else assert.ok(!visible || await save.isDisabled(), "a clean page cannot save")
    const { config } = await stored(fixture)
    const options = config.plugins.find((plugin: any) => typeof plugin === "object" && plugin.options?.models).options
    assert.equal(options.timeoutMs, 7000, "the other client's edit is kept")
    assert.equal(options.debug, undefined, "the stale draft was not written")
    assert.equal(fixture.calls.filter(isPredictionCall).length, 0)
  } finally { await app.close() }
})

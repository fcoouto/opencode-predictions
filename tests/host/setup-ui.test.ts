import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { _electron as electron, type Page } from "playwright"
import { build } from "esbuild"
import { createFixture, isPredictionCall } from "./fixture.mjs"
import { Predictions } from "../../src/rpc.ts"
import type { SetupSnapshot } from "../../src/setup.ts"

const executablePath = process.env.OPENCODE_DESKTOP_BIN ?? "/Applications/OpenCode.app/Contents/MacOS/OpenCode"
const skip = process.platform !== "darwin"

async function open(fixture: Awaited<ReturnType<typeof createFixture>>, profile: string) {
  await build({ entryPoints: ["tests/host/observer/gui.ts"], outfile: "tests/host/observer/gui-experimental.cjs", bundle: true, format: "cjs", platform: "browser", external: ["@opencode/*", "solid-js", "solid-js/*", "effect"] })
  await fixture.writeConfig({ ...fixture.config, plugins: [...fixture.config.plugins, { package: resolve("tests/host/observer"), options: { directory: fixture.directory, setupProbe: true } }] })
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
const stored = async (fixture: Awaited<ReturnType<typeof createFixture>>) => { const text = await readFile(fixture.preferencesFile, "utf8"); return { text, config: JSON.parse(text) as any } }
const settings = (fixture: Awaited<ReturnType<typeof createFixture>>) => fixture.api.rpc(Predictions).settings({}, { location: { directory: fixture.directory } }) as Promise<SetupSnapshot>

test("setup ui: Desktop configures all eight settings through the page, reorders groups, saves, reloads and reopens", { timeout: 150000, skip }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false, models: [["fixture/model"], ["nomatch/*"]] }, {}, { configSource: "global-jsonc", projectConfig: true })
  const { app, page, show } = await open(fixture, "ui-profile")
  try {
    await show()
    const original = await readFile(fixture.configFile!)
    assert.equal(await page.evaluate(() => (window as any).__predictionFixture.setupServerVersion()), "2.3.0")
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
    await page.getByText("Saved. The new settings are active.", { exact: true }).waitFor({ state: "visible", timeout: 20000 })
    const { text, config } = await stored(fixture)
    const options = config.settings
    assert.deepEqual(options.models, [["nomatch/*"], ["fixture/model"]], "group order is saved")
    assert.deepEqual({ enabled: options.enabled, automatic: options.automatic, escalation: options.escalation, timeoutMs: options.timeoutMs, contextTurns: options.contextTurns, includeGithubPRContext: options.includeGithubPRContext, debug: options.debug }, { enabled: false, automatic: true, escalation: "automatic", timeoutMs: 9000, contextTurns: 5, includeGithubPRContext: true, debug: true })
    assert.equal(config.version, 1)
    assert.deepEqual(await readFile(fixture.configFile!), original, "OpenCode bytes, comments and other plugins remain untouched")
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
    await page.getByText("0 models match now", { exact: true }).waitFor()
    await page.locator('[data-action="predictions-preferences"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: ".test-artifacts/preferences-native-desktop.png", fullPage: true })
  } finally { await app.close() }
})

test("setup ui: inline configuration supports first Save and staged reset", { timeout: 90000, skip }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false, models: [["fixture/model"]] }, {}, { projectConfig: true })
  const { app, page, show } = await open(fixture, "inline-profile")
  try {
    await show()
    await flip(page, "Enable Predictions")
    await page.getByRole("button", { name: "Save changes" }).click()
    await page.getByText("Saved. The new settings are active.", { exact: true }).waitFor()
    assert.deepEqual((await stored(fixture)).config.settings, { enabled: false })
    await page.getByRole("button", { name: "Use OpenCode configuration", exact: true }).click()
    assert.deepEqual((await stored(fixture)).config.settings, { enabled: false }, "reset is staged")
    await page.getByRole("button", { name: "Save changes" }).click()
    await page.getByText("Saved. The new settings are active.", { exact: true }).waitFor()
    assert.deepEqual((await stored(fixture)).config.settings, {})
    assert.equal(fixture.calls.length, 0)
  } finally { await app.close() }
})

test("setup ui: an edit made elsewhere while the page is open is never overwritten by the stale page", { timeout: 120000, skip }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false, models: [["fixture/model"]] }, {}, { configSource: "global-jsonc", projectConfig: true })
  const { app, page, show } = await open(fixture, "conflict-profile")
  try {
    await show()
    await page.getByRole("button", { name: "Show advanced settings" }).click()
    await flip(page, "Debug notices")
    assert.equal(await page.getByRole("button", { name: "Save changes" }).isEnabled(), true, "the page holds an unsaved draft")
    // Another client edits preferences without remounting the plugin or dropping this page's dirty draft.
    const before = await settings(fixture)
    assert.equal((await fixture.api.rpc(Predictions).saveSettings({ revision: before.revision, fields: { timeoutMs: 7000 } }, { location: { directory: fixture.directory } }) as any).kind, "saved")
    const until = Date.now() + 20000
    let seen: SetupSnapshot | undefined
    while (Date.now() < until && seen?.effective?.timeoutMs !== 7000) { seen = await settings(fixture).catch(() => seen); await page.waitForTimeout(150) }
    assert.equal(seen?.effective?.timeoutMs, 7000, "the server activated the other client's edit")
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), undefined, { timeout: 20000 })
    const save = page.getByRole("button", { name: "Save changes" })
    assert.equal(await save.isEnabled(), true, "the dirty draft survives external preference activation")
    await save.click()
    await page.getByText(/Configuration changed|Reload settings/).first().waitFor({ state: "visible", timeout: 20000 })
    assert.equal(await page.getByRole("switch", { name: "Debug notices" }).isChecked(), true, "conflict preserves the draft")
    const { config } = await stored(fixture)
    const options = config.settings
    assert.equal(options.timeoutMs, 7000, "the other client's edit is kept")
    assert.equal(options.debug, undefined, "the stale draft was not written")
    assert.equal(fixture.calls.filter(isPredictionCall).length, 0)
  } finally { await app.close() }
})

test("setup ui: after moving an entry the real host's menu names the entry that is now in each position", { timeout: 120000, skip }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: false, models: [["fixture/model", "fixture/second"]] }, {}, { configSource: "global-jsonc", projectConfig: true })
  const { app, page, show } = await open(fixture, "entry-menu-profile")
  try {
    await show()
    const labels = () => page.evaluate(() => [...document.querySelectorAll('[data-action^="predictions-entry-"] button[aria-label^="Actions for "]')].map(node => node.getAttribute("aria-label")!))
    await page.waitForFunction(() => document.querySelectorAll('[data-action^="predictions-entry-"] button[aria-label^="Actions for "]').length === 2, undefined, { timeout: 20000 })
    const before = await labels()
    assert.match(before[0], /, group 1, entry 1$/)
    assert.match(before[1], /, group 1, entry 2$/)
    const name = (label: string) => label.replace(/^Actions for /, "").replace(/, group \d+, entry \d+$/, "")
    assert.notEqual(name(before[0]), name(before[1]), "the two fixture models have different names")
    await page.getByRole("button", { name: before[1], exact: true }).click()
    await page.getByRole("menuitem", { name: "Move up", exact: true }).click()
    await page.waitForFunction(first => document.querySelector('[data-action="predictions-entry-0-0"] button[aria-label^="Actions for "]')?.getAttribute("aria-label")?.startsWith("Actions for " + first), name(before[1]), { timeout: 10000 })
    const after = await labels()
    assert.equal(name(after[0]), name(before[1]), "position 1 now holds the entry that moved up")
    assert.equal(name(after[1]), name(before[0]))
    assert.match(after[0], /, group 1, entry 1$/)
    // The moved entry's own menu now has Move up disabled, which follows its position, not the one the slot was created for.
    await page.getByRole("button", { name: after[0], exact: true }).click()
    assert.equal(await page.getByRole("menuitem", { name: "Move up", exact: true }).getAttribute("aria-disabled"), "true")
    await page.keyboard.press("Escape")
    assert.equal(fixture.calls.length, 0)
  } finally { await app.close() }
})

test("setup ui: preference activation preserves the Desktop composer and suppresses its current suggestion", { timeout: 90000, skip }, async () => {
  await using fixture = await createFixture(process.env.PREDICTIONS_PACKAGE, { automatic: true }, {}, { projectConfig: true })
  const { app, page } = await open(fixture, "composer-profile")
  try {
    await page.waitForFunction(() => (window as any).__predictionFixture?.ready(), undefined, { timeout: 20000 })
    await page.evaluate(() => (window as any).__predictionFixture.launch())
    const editor = page.locator('[data-component="composer-editor"][contenteditable="true"]')
    await editor.waitFor({ state: "visible", timeout: 20000 })
    await page.waitForFunction(() => document.querySelector('[data-component="composer-editor"]')?.textContent === "Fix the assertion.")
    await page.getByRole("button", { name: "Fixture / Fixture Flash", exact: true }).waitFor()
    await editor.press("Enter")
    await page.locator("[data-opencode-prediction]").waitFor({ state: "visible", timeout: 15000 })
    const before = fixture.calls.filter(isPredictionCall).length
    await editor.fill("my existing draft")
    const result = await page.evaluate(async () => {
      await (window as any).__predictionFixture.setupRead()
      return (window as any).__predictionFixture.setupSave()
    })
    assert.equal(result.kind, "saved")
    assert.equal(await editor.innerText(), "my existing draft")
    await editor.fill("")
    await page.waitForTimeout(2300)
    assert.equal(fixture.calls.filter(isPredictionCall).length, before)
    assert.equal(await page.locator("[data-opencode-prediction]").count(), 0)
  } finally { await app.close() }
})

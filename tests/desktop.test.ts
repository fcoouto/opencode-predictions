import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { chromium, type Browser } from "playwright"
import { build } from "esbuild"

let browser: Browser
let source: string
let guiSource: string
before(async () => {
  source = (await build({ entryPoints: ["src/adapters/desktop.ts"], bundle: true, write: false, format: "iife", globalName: "PredictionAdapter", platform: "browser" })).outputFiles[0].text
  guiSource = (await build({ stdin: { contents: 'import gui from "./src/gui.ts"; import { createRoot } from "solid-js"; export { createSignal } from "solid-js"; export const mount = ctx => createRoot(dispose => { const stop = gui.setup(ctx); return () => { stop(); dispose() } })', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "PredictionGUI", platform: "browser", external: ["node:*"] })).outputFiles[0].text
  browser = await chromium.launch()
})
after(async () => { await browser?.close() })

async function fixture() {
  const page = await browser.newPage()
  await page.route("https://fixture.test/", route => route.fulfill({ body: "<!doctype html><html><body></body></html>", contentType: "text/html" }))
  await page.goto("https://fixture.test/")
  await page.setContent(`<form data-component="composer"><div data-component="composer-scroll" style="position:relative"><div data-component="composer-editor" contenteditable="true" role="textbox" style="padding:16px;width:400px;min-height:40px;font:14px sans-serif"></div><div style="pointer-events:none">Original placeholder</div></div></form>`)
  await page.addScriptTag({ content: source })
  await page.evaluate(() => {
    const w = window as any
    w.editor = document.querySelector('[contenteditable="true"]')
    w.normal = true
    w.submissions = 0
    document.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); w.submissions++ })
    w.editor.focus()
    w.adapter = w.PredictionAdapter.createDesktopAdapter(document, () => ({ text: () => w.editor.textContent, focused: () => document.activeElement === w.editor, quotable: () => w.normal, setText: (text: string) => { w.editor.textContent = text }, focus: () => w.editor.focus() }))
  })
  return page
}

async function previewFixture() {
  const page = await fixture()
  await page.setViewportSize({ width: 900, height: 700 })
  await page.evaluate(() => {
    const w = window as any
    document.body.style.cssText = "margin:0;background:#111;color:#aaa"
    document.querySelector("form")!.style.cssText = "position:fixed;bottom:24px;left:24px;width:calc(100% - 48px);background:#242424;border:1px solid #444;border-radius:12px"
    w.editor.style.cssText = "width:100%;box-sizing:border-box;padding:12px 16px;min-height:48px;font:16px/24px sans-serif;white-space:pre-wrap"
    w.editor.nextElementSibling.style.position = "absolute"
    const toolbar = document.createElement("div")
    toolbar.setAttribute("data-preview-toolbar", "")
    toolbar.textContent = "＋  Build  ·  OpenAI / Model  ·  High"
    toolbar.style.cssText = "height:40px;padding:0 16px;display:flex;align-items:center;font:14px sans-serif"
    document.querySelector("form")!.append(toolbar)
  })
  return page
}

async function manualHintFixture() {
  const page = await previewFixture()
  await page.addScriptTag({ content: guiSource })
  await page.evaluate(() => {
    const w = window as any
    w.hintState = { enabled: true, automatic: false, reason: undefined, connected: true, hasSession: true, busy: false, pending: false, noCompletion: false, keys: ["Option", "Shift", "P"] }
    w.hintRequests = []
    w.hintMessages = [
      { type: "user", text: "Fix the assertion." },
      { type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: "Fixed the assertion." }] },
    ]
    const listeners = new Map<string, () => void>(), commands = new Map<string, any>()
    const data = {
      on: (name: string, run: () => void) => { listeners.set(name, run); return () => listeners.delete(name) },
      session: {
        get: () => ({ time: { updated: w.hintState.noCompletion ? 0 : 2 } }),
        status: () => w.hintState.busy ? "running" : "idle",
        message: { list: () => w.hintMessages },
        pending: { list: () => [] }, permission: { list: () => [] }, form: { list: () => [] },
      },
    }
    const server = {
      id: "fixture", get connected() { return w.hintState.connected }, data,
      client: { rpc: () => ({
        status: async () => ({ enabled: w.hintState.enabled, automatic: w.hintState.automatic, reason: w.hintState.reason, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }),
        predict: async (input: unknown) => { w.hintRequests.push(input); return new Promise(resolve => { w.finishHintRequest = resolve }) },
        events: { on: () => () => {} },
      }) },
    }
    const session = { id: "ses_test", key: "fixture/ses_test", directory: "/project", location: { directory: "/project" }, server, get pending() { return w.hintState.pending } }
    w.applyHintState = (patch: object) => { Object.assign(w.hintState, patch); listeners.get("config.updated")?.() }
    w.hintCommands = commands
    w.stopGUI = w.PredictionGUI.mount({
      sessions: { current: () => w.hintState.hasSession ? session : undefined },
      servers: { get: () => undefined },
      screen: { current: () => ({ composer: { text: () => w.editor.textContent, focused: () => document.activeElement === w.editor, quotable: () => w.normal, setText: (text: string) => { w.editor.textContent = text }, focus: () => w.editor.focus() } }) },
      keybinds: { keybind: () => w.hintState.keys },
      add: (_registry: unknown, command: any) => commands.set(command.id, command),
      app: { version: "test" }, toast: { show: () => ({ dismiss() {} }) },
    })
  })
  return page
}

test("Desktop manual prediction hint stays outside the draft and wraps above composer controls", async () => {
  const page = await manualHintFixture()
  try {
    const hint = page.locator("[data-opencode-prediction-hint]")
    await hint.waitFor({ state: "visible", timeout: 2000 })
    assert.equal(await hint.textContent(), "Press Option + Shift + P to request a prediction.")
    assert.equal(await page.locator('[contenteditable="true"]').innerText(), "")
    assert.equal(await page.evaluate(() => (window as any).hintRequests.length), 0)
    assert.equal(await page.evaluate(() => (window as any).hintCommands.get("accept").run()), false)
    assert.equal(await page.locator("[data-opencode-announcement]").textContent(), "Press Option + Shift + P to request a prediction.")
    for (const width of [900, 360]) {
      await page.setViewportSize({ width, height: 700 })
      await page.waitForFunction(() => {
        const hint = document.querySelector("[data-opencode-prediction-hint]")!.getBoundingClientRect()
        const editor = document.querySelector('[contenteditable="true"]')!.getBoundingClientRect()
        const toolbar = document.querySelector("[data-preview-toolbar]")!.getBoundingClientRect()
        return Math.abs(hint.left - editor.left) < 1 && Math.abs(hint.width - editor.width) < 1 && hint.bottom <= toolbar.top + 1
      })
      await page.screenshot({ path: `.test-artifacts/manual-hint-${width}.png` })
    }
    await page.evaluate(() => (window as any).stopGUI())
    assert.equal(await hint.count(), 0)
    assert.equal(await page.locator('[contenteditable="true"] + div').isVisible(), true)
    assert.equal(await page.locator('[contenteditable="true"]').evaluate(element => (element as HTMLElement).style.minHeight), "48px")
    assert.equal(await page.evaluate(() => (window as any).submissions), 0)
  } finally { await page.close() }
})

test("Desktop manual prediction hint follows the effective shortcut and hides when unbound", async () => {
  const page = await manualHintFixture()
  try {
    const hint = page.locator("[data-opencode-prediction-hint]")
    await hint.waitFor({ state: "visible", timeout: 2000 })
    await page.evaluate(() => (window as any).applyHintState({ keys: ["⌃", "P"] }))
    await page.waitForFunction(() => document.querySelector("[data-opencode-prediction-hint]")?.textContent === "Press Control + P to request a prediction.")
    await page.evaluate(() => (window as any).applyHintState({ keys: [] }))
    await hint.waitFor({ state: "hidden", timeout: 2000 })
    assert.equal(await page.evaluate(() => (window as any).hintRequests.length), 0)
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop manual prediction hint shrinks after widening and shorter remapping", async () => {
  const page = await manualHintFixture()
  try {
    const hint = page.locator("[data-opencode-prediction-hint]")
    const editor = page.locator('[contenteditable="true"]')
    await hint.waitFor({ state: "visible", timeout: 2000 })
    const height = await editor.evaluate(element => element.getBoundingClientRect().height)
    await page.setViewportSize({ width: 360, height: 700 })
    await page.waitForFunction(height => document.querySelector('[contenteditable="true"]')!.getBoundingClientRect().height > height, height)
    await page.setViewportSize({ width: 900, height: 700 })
    await page.waitForFunction(height => document.querySelector('[contenteditable="true"]')!.getBoundingClientRect().height === height, height, { timeout: 2000 })
    await page.setViewportSize({ width: 360, height: 700 })
    await page.waitForFunction(height => document.querySelector('[contenteditable="true"]')!.getBoundingClientRect().height > height, height)
    await page.evaluate(() => (window as any).applyHintState({ keys: ["P"] }))
    await page.waitForFunction(height => document.querySelector('[contenteditable="true"]')!.getBoundingClientRect().height === height, height, { timeout: 2000 })
    assert.equal(await hint.textContent(), "Press P to request a prediction.")
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop manual prediction hint requires a completed reply, not a session creation timestamp", async () => {
  const page = await manualHintFixture()
  try {
    const hint = page.locator("[data-opencode-prediction-hint]")
    await hint.waitFor({ state: "visible", timeout: 2000 })
    for (const messages of [
      [],
      [{ type: "user", text: "New prompt" }],
      [{ type: "assistant", time: {}, content: [{ type: "text", text: "Still streaming" }] }],
      [{ type: "assistant", time: { completed: 2 }, content: [{ type: "reasoning", text: "Not a reply" }] }],
    ]) {
      await page.evaluate(messages => { const w = window as any; w.hintMessages = messages; w.applyHintState({}) }, messages)
      await hint.waitFor({ state: "hidden", timeout: 2000 })
    }
    await page.evaluate(() => {
      const w = window as any
      w.hintMessages = [{ type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: "Historical completed reply without an idle marker." }] }]
      w.applyHintState({})
    })
    await hint.waitFor({ state: "visible", timeout: 2000 })
    assert.equal(await page.evaluate(() => (window as any).hintRequests.length), 0)
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop manual prediction hint withdraws when context or composer cannot request", async () => {
  const page = await manualHintFixture()
  try {
    const hint = page.locator("[data-opencode-prediction-hint]")
    const cases = [
      { automatic: true }, { enabled: false }, { reason: "models_required" }, { connected: false },
      { hasSession: false }, { busy: true }, { pending: true }, { noCompletion: true },
    ]
    for (const patch of cases) {
      await hint.waitFor({ state: "visible", timeout: 2000 })
      await page.evaluate(patch => (window as any).applyHintState(patch), patch)
      await hint.waitFor({ state: "hidden", timeout: 2000 })
      await page.evaluate(() => (window as any).applyHintState({ enabled: true, automatic: false, reason: undefined, connected: true, hasSession: true, busy: false, pending: false, noCompletion: false }))
    }
    for (const action of ["typing", "composition", "blur", "menu", "shell"]) {
      await hint.waitFor({ state: "visible", timeout: 2000 })
      await page.evaluate(action => {
        const w = window as any
        if (action === "typing") { w.editor.textContent = "My draft"; w.editor.dispatchEvent(new InputEvent("input", { bubbles: true })) }
        if (action === "composition") w.editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
        if (action === "blur") w.editor.blur()
        if (action === "menu") { const menu = document.createElement("div"); menu.setAttribute("role", "menu"); menu.textContent = "Host menu"; document.body.append(menu) }
        if (action === "shell") w.normal = false
      }, action)
      await hint.waitFor({ state: "hidden", timeout: 2000 })
      if (action === "typing") assert.equal(await page.locator('[contenteditable="true"]').innerText(), "My draft")
      await page.evaluate(() => {
        const w = window as any
        w.editor.textContent = ""; w.normal = true; document.querySelector('[role="menu"]')?.remove()
        w.editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); w.editor.focus()
      })
    }
    assert.equal(await page.evaluate(() => (window as any).hintRequests.length), 0)
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop manual prediction hint yields to pending requests and real suggestions", async () => {
  const page = await manualHintFixture()
  try {
    const hint = page.locator("[data-opencode-prediction-hint]")
    await hint.waitFor({ state: "visible", timeout: 2000 })
    await page.evaluate(() => (window as any).hintCommands.get("request-shortcut").run())
    await page.locator("[data-opencode-communication]").waitFor({ state: "visible", timeout: 2000 })
    assert.equal(await hint.count(), 0)
    await page.evaluate(() => (window as any).finishHintRequest({ text: "Run the tests." }))
    await page.locator("[data-opencode-prediction]").waitFor({ state: "visible", timeout: 2000 })
    assert.equal(await hint.count(), 0)
    assert.equal(await page.locator('[contenteditable="true"]').innerText(), "")
    assert.equal(await page.evaluate(() => (window as any).hintRequests.length), 1)
    await page.evaluate(() => (window as any).hintCommands.get("accept").run())
    assert.equal(await page.locator('[contenteditable="true"]').innerText(), "Run the tests.")
    assert.equal(await page.evaluate(() => (window as any).submissions), 0)
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop multiline prediction grows the bottom-anchored composer above its controls", async () => {
  const page = await previewFixture()
  try {
    const result = await page.evaluate(() => {
      const w = window as any
      const form = document.querySelector("form")!
      const before = form.getBoundingClientRect()
      w.adapter.paint("First line.\nSecond line.\nThird line.")
      const ghost = document.querySelector<HTMLElement>("[data-opencode-prediction]")!
      const bounds = ghost.getBoundingClientRect()
      const editor = w.editor.getBoundingClientRect()
      const controls = document.querySelector("[data-preview-toolbar]")!.getBoundingClientRect()
      const after = form.getBoundingClientRect()
      return { beforeHeight: before.height, afterHeight: after.height, sameBottom: before.bottom === after.bottom, aligned: Math.abs(bounds.top - editor.top) < 1, contained: bounds.bottom <= controls.top + 1, editorHeight: editor.height, text: ghost.textContent, draft: w.editor.textContent }
    })
    assert.ok(result.afterHeight > result.beforeHeight)
    assert.ok(result.editorHeight >= 96)
    assert.equal(result.sameBottom, true)
    assert.equal(result.aligned, true)
    assert.equal(result.contained, true)
    assert.equal(result.draft, "")
    assert.equal(result.text, "First line.\nSecond line.\nThird line.")
    await page.screenshot({ path: ".test-artifacts/preview-three-lines.png" })
  } finally { await page.close() }
})

test("Desktop preview ellipsizes after six lines but accepts the exact full prediction", async () => {
  const page = await previewFixture()
  try {
    const result = await page.evaluate(() => {
      const w = window as any
      const text = Array.from({ length: 9 }, (_, i) => `Line ${i + 1}: preserve this text. 😀`).join("\n")
      w.adapter.paint(text)
      const ghost = document.querySelector<HTMLElement>("[data-opencode-prediction]")!
      const style = getComputedStyle(ghost)
      const height = ghost.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      const visual = ghost.firstElementChild ?? ghost
      const clipped = visual.scrollHeight > visual.clientHeight
      const clamp = getComputedStyle(ghost.firstElementChild ?? ghost).webkitLineClamp
      const accepted = w.adapter.insert(text)
      return { height, clamp, clipped, accepted, fullText: w.editor.textContent === text, minHeight: w.editor.style.minHeight, submissions: w.submissions }
    })
    assert.equal(result.height, 6 * 24)
    assert.equal(result.clamp, "6")
    assert.equal(result.clipped, true)
    assert.equal(result.accepted, true)
    assert.equal(result.fullText, true)
    assert.equal(result.minHeight, "48px")
    assert.equal(result.submissions, 0)
    await page.evaluate(() => (window as any).adapter.paint(undefined))
  } finally { await page.close() }
})

test("Desktop preview reflows on resize and never accumulates reserved height", async () => {
  const page = await previewFixture()
  try {
    await page.evaluate(() => {
      const w = window as any
      w.previewText = "Keep the full prediction readable. 長い名前 😀 ".repeat(7)
      w.adapter.paint(w.previewText)
    })
    const wide = await page.locator('[contenteditable="true"]').boundingBox()
    await page.setViewportSize({ width: 360, height: 700 })
    await page.waitForFunction(() => {
      const editor = document.querySelector('[contenteditable="true"]')!.getBoundingClientRect()
      const ghost = document.querySelector("[data-opencode-prediction]")!.getBoundingClientRect()
      return Math.abs(editor.width - ghost.width) < 1 && editor.height >= ghost.height - 1
    })
    const narrow = await page.locator('[contenteditable="true"]').boundingBox()
    assert.ok(narrow!.height > wide!.height)
    assert.ok(narrow!.height <= 6 * 24 + 24)
    await page.screenshot({ path: ".test-artifacts/preview-six-lines-narrow.png" })
    await page.setViewportSize({ width: 900, height: 700 })
    await page.waitForFunction(height => document.querySelector('[contenteditable="true"]')!.getBoundingClientRect().height === height, wide!.height)
    const result = await page.evaluate(() => {
      const w = window as any
      const before = w.editor.getBoundingClientRect().height
      for (let i = 0; i < 10; i++) w.adapter.paint(w.previewText)
      const after = w.editor.getBoundingClientRect().height
      w.adapter.paint("Short.")
      return { before, after, shortHeight: w.editor.getBoundingClientRect().height }
    })
    assert.equal(result.before, result.after)
    assert.equal(result.shortHeight, 48)
  } finally { await page.close() }
})

test("Desktop preview restores original layout on every withdrawal path without growing status", async () => {
  for (const action of ["dismiss", "typing", "composition", "status", "dispose", "navigation"]) {
    const page = await previewFixture()
    try {
      const result = await page.evaluate(action => {
        const w = window as any
        w.editor.style.setProperty("min-height", "48px", "important")
        w.editor.style.color = "red"
        const original = w.editor
        const before = document.querySelector("form")!.getBoundingClientRect().height
        w.adapter.paint("One.\nTwo.\nThree.\nFour.")
        const grown = document.querySelector("form")!.getBoundingClientRect().height
        if (action === "dismiss") w.adapter.paint(undefined)
        if (action === "typing") { w.editor.textContent = "Typed"; w.editor.dispatchEvent(new InputEvent("input", { bubbles: true })) }
        if (action === "composition") w.editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
        if (action === "status") w.adapter.communicate({ message: "", activity: { kind: "initial" } })
        if (action === "dispose") w.adapter.dispose()
        if (action === "navigation") {
          const next = w.editor.cloneNode(false) as HTMLElement
          next.style.setProperty("min-height", "48px", "important")
          w.editor.replaceWith(next); w.editor = next; next.focus()
          w.adapter.paint("Short.")
        }
        return { before, grown, after: document.querySelector("form")!.getBoundingClientRect().height, value: original.style.minHeight, priority: original.style.getPropertyPriority("min-height"), color: original.style.color }
      }, action)
      assert.ok(result.grown > result.before, action)
      assert.equal(result.after, result.before, action)
      assert.equal(result.value, "48px", action)
      assert.equal(result.priority, "important", action)
      assert.equal(result.color, "red", action)
    } finally { await page.close() }
  }
})

test("Desktop preview cleanup preserves min-height changes made by the host", async () => {
  const page = await previewFixture()
  try {
    const result = await page.evaluate(() => {
      const w = window as any
      w.adapter.paint("One.\nTwo.\nThree.\nFour.")
      w.editor.style.setProperty("min-height", "80px", "important")
      w.adapter.paint("One.\nTwo.\nThree.\nFour.")
      w.adapter.paint(undefined)
      return { value: w.editor.style.minHeight, priority: w.editor.style.getPropertyPriority("min-height") }
    })
    assert.deepEqual(result, { value: "80px", priority: "important" })
  } finally { await page.close() }
})

test("Desktop preview respects content-box sizing and removes its override when min-height is inherited", async () => {
  const page = await previewFixture()
  try {
    const result = await page.evaluate(() => {
      const w = window as any
      const style = document.createElement("style")
      style.textContent = '[data-component="composer-editor"] { min-height: 24px }'
      document.head.append(style)
      w.editor.style.removeProperty("min-height")
      w.editor.style.boxSizing = "content-box"
      w.editor.style.width = "calc(100% - 32px)"
      const before = w.editor.getBoundingClientRect().height
      w.adapter.paint("One.\nTwo.\nThree.")
      const ghost = document.querySelector("[data-opencode-prediction]")!.getBoundingClientRect()
      const editor = w.editor.getBoundingClientRect()
      w.adapter.paint(undefined)
      return { contained: editor.height >= ghost.height, grown: editor.height > before, restored: w.editor.getBoundingClientRect().height === before, inline: w.editor.style.minHeight }
    })
    assert.deepEqual(result, { contained: true, grown: true, restored: true, inline: "" })
  } finally { await page.close() }
})

test("desktop ghost stays outside editable content and accepts exact multiline text without submit", async () => {
  const page = await fixture()
  try {
    const result = await page.evaluate(() => {
      const w = window as any
      const painted = w.adapter.paint("Run tests.\nExplain failures. 😀")
      const draftBefore = w.editor.textContent
      const ghost = document.querySelector("[data-opencode-prediction]")?.textContent
      const ariaHidden = document.querySelector("[data-opencode-prediction]")?.getAttribute("aria-hidden")
      const accepted = w.adapter.insert("Run tests.\nExplain failures. 😀")
      w.adapter.dispose()
      return { painted, draftBefore, ghost, ariaHidden, accepted, draftAfter: w.editor.textContent, submissions: w.submissions, leftovers: document.querySelectorAll("[data-opencode-prediction]").length }
    })
    assert.deepEqual(result, { painted: true, draftBefore: "", ghost: "Run tests.\nExplain failures. 😀", ariaHidden: "true", accepted: true, draftAfter: "Run tests.\nExplain failures. 😀", submissions: 0, leftovers: 0 })
  } finally { await page.close() }
})

test("desktop input, shell mode, composition, open menus, and missing anchors reject ghost insertion", async () => {
  const page = await fixture()
  try {
    const result = await page.evaluate(() => {
      const w = window as any
      w.editor.textContent = "my input"
      const typed = w.adapter.insert("wrong")
      const unchanged = w.editor.textContent
      w.editor.textContent = ""
      w.normal = false
      const shell = w.adapter.eligible()
      w.normal = true
      w.editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
      const composing = w.adapter.eligible()
      w.editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
      const menu = document.createElement("div"); menu.setAttribute("role", "menu"); menu.textContent = "Host menu"; document.body.append(menu)
      const menuOpen = w.adapter.eligible(); menu.remove()
      w.editor.remove()
      const missing = w.adapter.paint("wrong")
      w.adapter.dispose()
      return { typed, unchanged, shell, composing, menuOpen, missing }
    })
    assert.deepEqual(result, { typed: false, unchanged: "my input", shell: false, composing: false, menuOpen: false, missing: false })
  } finally { await page.close() }
})

test("Desktop compact status wraps a long Unicode model name within a narrow prediction slot", async () => {
  const page = await fixture()
  try {
    await page.setViewportSize({ width: 360, height: 640 })
    const state = await page.evaluate(() => {
      const w = window as any
      w.editor.style.width = "280px"
      w.adapter.communicate({ message: "", activity: { kind: "alternative", name: "長い Model Display Name With More Words" } })
      const status = document.querySelector<HTMLElement>("[data-opencode-communication]")!
      const element = w.editor.getBoundingClientRect()
      const bounds = status.getBoundingClientRect()
      return { text: status.textContent, draft: w.editor.textContent, sameLeft: bounds.left === element.left, sameWidth: bounds.width === element.width, right: bounds.right, label: document.querySelector("[data-opencode-announcement]")?.textContent }
    })
    assert.match(state.text!, /^\uFFFB[▰▱]{3} 長い Model Display Name With More Words$/)
    assert.equal(state.draft, "")
    assert.equal(state.sameLeft, true)
    assert.equal(state.sameWidth, true)
    assert.ok(state.right <= 360)
    assert.match(state.label!, /Requesting prediction from 長い Model Display Name/)
    await page.screenshot({ path: ".test-artifacts/compact-desktop-narrow.png" })
    await page.evaluate(() => (window as any).adapter.dispose())
    assert.equal(await page.locator("[data-opencode-communication], [data-opencode-announcement]").count(), 0)
  } finally { await page.close() }
})

test("Desktop abstention is a faint macOS placeholder, never an extra composer section or button", async () => {
  const page = await fixture()
  try {
    const state = await page.evaluate(() => {
      const w = window as any
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true })
      const composer = document.querySelector("form")!
      const height = composer.getBoundingClientRect().height
      w.adapter.communicate({ message: "[First Model] provided no prediction.", offer: { token: "next", group: 1, model: { providerID: "local", id: "b" }, name: "Second Model" } })
      const status = document.querySelector<HTMLElement>("[data-opencode-communication]")!
      const style = getComputedStyle(status)
      return { text: status.textContent, opacity: Number(style.opacity), sameHeight: composer.getBoundingClientRect().height === height, draft: w.editor.textContent, buttons: composer.querySelectorAll("button").length }
    })
    assert.equal(state.text, "[First Model] provided no prediction.\nOption+Shift+P: try [Second Model].")
    assert.ok(state.opacity < 1)
    assert.equal(state.sameHeight, true)
    assert.equal(state.draft, "")
    assert.equal(state.buttons, 0)
    await page.locator('[contenteditable="true"]').fill("my own prompt")
    assert.equal(await page.locator("[data-opencode-communication]").count(), 0)
  } finally { await page.close() }
})

test("Desktop owning-server config and plugin events invalidate suggestions before Tab can accept", async () => {
  for (const event of ["config.updated", "plugin.updated"]) {
    const page = await fixture()
    try {
      await page.addScriptTag({ content: guiSource })
      await page.evaluate(() => {
        const w = window as any
        const handlers = new Map<string, Set<() => void>>()
        const commands = new Map<string, { run(): unknown }>()
        const status = { enabled: true, automatic: true, models: "fixture/model", timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }
        const data = {
          on: (name: string, handler: () => void) => { const listeners = handlers.get(name) ?? new Set(); handlers.set(name, listeners); listeners.add(handler); return () => listeners.delete(handler) },
          session: { get: () => ({ time: { idle: 2 } }), status: () => "idle", pending: { list: () => [] }, permission: { list: () => [] }, form: { list: () => [] } },
        }
        const session = { id: "ses_test", key: "server/ses_test", directory: "/project", location: { directory: "/project" }, server: { connected: true, data, client: { rpc: () => ({ status: async () => ({ ...status }), predict: async () => ({ text: "Old suggestion" }), events: { on: () => () => {} } }) } } }
        w.stopGUI = w.PredictionGUI.mount({ sessions: { current: () => session }, screen: { current: () => ({ composer: { text: () => w.editor.textContent, focused: () => true, quotable: () => true, setText: (text: string) => { w.editor.textContent = text }, focus: () => w.editor.focus() } }) }, add: (_command: unknown, command: { id: string; run(): unknown }) => commands.set(command.id, command), toast: { show() {} }, app: { version: "test" } })
        w.disable = (name: string) => { status.enabled = false; for (const handler of handlers.get(name) ?? []) handler(); return commands.get("accept")!.run() }
        w.listenerCount = () => [...handlers.values()].reduce((sum, listeners) => sum + listeners.size, 0)
      })
      await page.locator("[data-opencode-prediction]").waitFor({ state: "visible" })
      const result = await page.evaluate(name => {
        const w = window as any
        const claimedTab = w.disable(name)
        const draft = w.editor.textContent
        w.stopGUI()
        return { claimedTab, draft, listeners: w.listenerCount() }
      }, event)
      assert.deepEqual(result, { claimedTab: false, draft: "", listeners: 0 })
    } finally { await page.close() }
  }
})

test("Desktop config events and plugin remount suppress the completed chat and preserve typed input", async () => {
  const page = await fixture()
  try {
    await page.addScriptTag({ content: guiSource })
    await page.evaluate(() => {
      const w = window as any
      w.predictionCalls = 0
      const listeners = new Map<string, () => void>()
      const memory = { mounted: false, suppressed: [] as string[] }
      let version = "one"
      const data = { on: (name: string, run: () => void) => { listeners.set(name, run); return () => listeners.delete(name) }, session: { get: () => ({ time: { idle: 2 } }), status: () => "idle", pending: { list: () => [] }, permission: { list: () => [] }, form: { list: () => [] } } }
      const server = { id: "fixture", connected: true, data, client: { rpc: () => ({ status: async () => ({ enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version, warnings: [] }), predict: async () => { w.predictionCalls++; return { text: "Old prediction" } }, events: { on: () => () => {} } }) } }
      const session = { id: "ses_test", key: "fixture/ses_test", directory: "/project", location: { directory: "/project" }, server }
      const ctx = {
        storage: { memory: () => [memory, (mutation: (draft: typeof memory) => void) => mutation(memory)] },
        sessions: { current: () => session },
        screen: { current: () => ({ composer: { text: () => w.editor.textContent, focused: () => true, quotable: () => true, setText: (text: string) => { w.editor.textContent = text }, focus: () => w.editor.focus() } }) },
        add() {}, app: { version: "test" }, toast: { show() {} },
      }
      w.reloadPredictionGUI = () => { w.stopGUI(); w.stopGUI = w.PredictionGUI.mount(ctx) }
      w.configChanged = () => { version = "two"; listeners.get("config.updated")!() }
      w.pluginChanged = () => listeners.get("plugin.updated")!()
      w.stopGUI = w.PredictionGUI.mount(ctx)
    })
    await page.locator("[data-opencode-prediction]").filter({ hasText: "Old prediction" }).waitFor({ state: "visible" })
    await page.evaluate(() => (window as any).configChanged())
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(() => (window as any).predictionCalls), 1)
    await page.evaluate(() => (window as any).reloadPredictionGUI())
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(() => (window as any).predictionCalls), 1)
    const editor = page.locator('[contenteditable="true"]')
    await editor.fill("my existing draft")
    await page.evaluate(() => (window as any).pluginChanged())
    assert.equal(await editor.innerText(), "my existing draft")
    assert.equal(await page.evaluate(() => (window as any).submissions), 0)
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop navigation and clearing accepted edits restore the original ghost without generating again", async () => {
  const page = await fixture()
  try {
    await page.addScriptTag({ content: guiSource })
    await page.evaluate(() => {
      const w = window as any
      const [current, setCurrent] = w.PredictionGUI.createSignal("first")
      const commands = new Map<string, any>()
      w.predictionCalls = 0
      const data = { on: () => () => {}, session: { get: () => ({ time: { idle: 2 } }), status: () => "idle", pending: { list: () => [] }, permission: { list: () => [] }, form: { list: () => [] } } }
      const server = { id: "fixture", connected: true, data, client: { rpc: () => ({ status: async () => ({ enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }), predict: async ({ sessionID }: { sessionID: string }) => { w.predictionCalls++; return { text: sessionID === "first" ? "First chat suggestion" : "Second chat suggestion" } }, events: { on: () => () => {} } }) } }
      const sessions = Object.fromEntries(["first", "second"].map(id => [id, { id, key: "fixture/" + id, directory: "/project", location: { directory: "/project" }, server }]))
      w.switchChat = setCurrent
      w.predictionCommands = commands
      w.acceptPrediction = () => commands.get("accept").run()
      w.stopGUI = w.PredictionGUI.mount({ sessions: { current: () => sessions[current()] }, screen: { current: () => ({ composer: { text: () => w.editor.textContent, focused: () => document.activeElement === w.editor, quotable: () => true, setText: (text: string) => { w.editor.textContent = text }, focus: () => w.editor.focus() } }) }, add: (_registry: unknown, command: any) => commands.set(command.id, command), app: { version: "test" }, toast: { show() {} } })
    })
    const ghost = page.locator("[data-opencode-prediction]")
    await ghost.filter({ hasText: "First chat suggestion" }).waitFor({ state: "visible" })
    assert.equal(await page.evaluate(() => [...(window as any).predictionCommands.values()].some((command: any) => command.bind === "escape")), false, "predictions must not intercept Escape")
    await page.evaluate(() => (window as any).switchChat("second"))
    await ghost.filter({ hasText: "Second chat suggestion" }).waitFor({ state: "visible" })
    await page.evaluate(() => (window as any).switchChat("first"))
    await ghost.filter({ hasText: "First chat suggestion" }).waitFor({ state: "visible" })
    assert.equal(await page.evaluate(() => (window as any).predictionCalls), 2)
    assert.equal(await page.evaluate(() => (window as any).acceptPrediction()), undefined)
    const editor = page.locator('[contenteditable="true"]')
    assert.equal(await editor.innerText(), "First chat suggestion")
    await editor.fill("Edited accepted text")
    assert.equal(await page.evaluate(() => (window as any).acceptPrediction()), false)
    await ghost.waitFor({ state: "hidden" })
    await editor.fill("")
    await ghost.filter({ hasText: "First chat suggestion" }).waitFor({ state: "visible", timeout: 2000 })
    assert.equal(await editor.textContent(), "")
    assert.equal(await page.evaluate(() => (window as any).acceptPrediction()), undefined)
    assert.equal(await editor.innerText(), "First chat suggestion")
    assert.equal(await page.evaluate(() => (window as any).predictionCalls), 2)
    assert.equal(await page.evaluate(() => (window as any).submissions), 0)
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop shortcut requests historical state without enabling automatic generation", async () => {
  const page = await fixture()
  try {
    await page.addScriptTag({ content: guiSource })
    await page.evaluate(() => {
      const w = window as any
      w.revision = Date.now() - 86400000
      w.requests = []; w.statusCalls = 0
      const commands = new Map<string, any>()
      const data = { on: () => () => {}, session: { get: () => ({ time: { updated: w.revision } }), status: () => "idle", pending: { list: () => [] }, permission: { list: () => [] }, form: { list: () => [] } } }
      const server = { id: "fixture", connected: true, data, client: { rpc: () => ({ status: async () => { w.statusCalls++; return { enabled: true, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] } }, predict: async (input: unknown) => { w.requests.push(input); return { text: "Continue the old conversation." } }, events: { on: () => () => {} } }) } }
      const session = { id: "ses_old", key: "fixture/ses_old", directory: "/project", location: { directory: "/project" }, server }
      w.runRequest = () => commands.get("request-shortcut").run()
      w.runAccept = () => commands.get("accept").run()
      w.stopGUI = w.PredictionGUI.mount({ sessions: { current: () => session }, screen: { current: () => ({ composer: { text: () => w.editor.textContent, focused: () => document.activeElement === w.editor, quotable: () => true, setText: (text: string) => { w.editor.textContent = text }, focus: () => w.editor.focus() } }) }, add: (_registry: unknown, command: any) => commands.set(command.id, command), app: { version: "test" }, toast: { show() {} } })
    })
    await page.waitForFunction(() => (window as any).statusCalls > 0)
    assert.equal(await page.evaluate(() => (window as any).requests.length), 0)
    assert.notEqual(await page.evaluate(() => (window as any).runRequest()), false)
    await page.locator("[data-opencode-prediction]").waitFor({ state: "visible", timeout: 2000 })
    const result = await page.evaluate(() => { const w = window as any; const request = w.requests[0]; return { count: w.requests.length, manual: request.manual, matchesRevision: request.completion === w.revision, sessionID: request.sessionID, requestID: typeof request.requestID, draft: w.editor.textContent } })
    assert.deepEqual(result, { count: 1, manual: true, matchesRevision: true, sessionID: "ses_old", requestID: "string", draft: "" })
    assert.equal(await page.evaluate(() => (window as any).runAccept()), undefined)
    assert.equal(await page.locator('[contenteditable="true"]').innerText(), "Continue the old conversation.")
    assert.equal(await page.evaluate(() => (window as any).submissions), 0)
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop error toasts offer persistent status actions and reopen readable status before completion", async () => {
  const page = await fixture()
  try {
    await page.addScriptTag({ content: guiSource })
    await page.evaluate(() => {
      const w = window as any
      w.notices = []; w.dialogs = []; w.commands = new Map(); w.dismissed = 0; w.settings = []
      let failing = true
      const data = { on: () => () => {}, session: { get: () => undefined } }
      const session = { id: "ses_test", key: "server/ses_test", directory: "/project", location: { directory: "/project" }, server: { id: "fixture", connected: true, data, client: { rpc: () => ({ status: async () => {
        if (!failing) throw new Error("PRIVATE")
        return { enabled: false, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [], reason: "models_required" }
      } }) } } }
      w.stopGUI = w.PredictionGUI.mount({ sessions: { current: () => session }, screen: { current: () => undefined }, add: (_registry: unknown, command: any) => w.commands.set(command.id, command), layout: { settings: (page: string) => w.settings.push(page) }, app: { version: "test" }, toast: { show: (notice: unknown) => { w.notices.push(notice); return { dismiss: () => { w.dismissed++ } } } }, dialogs: { open: (render: any) => render({ close() {} }), confirm: async (options: any) => { w.dialogs.push({ description: options.description, whiteSpace: "normal" }); return false }, alert: async () => {} }, ui: { Dialog: (props: any) => { w.dialogs.push({ description: props.children.textContent, whiteSpace: props.children.style.whiteSpace }); return props.children }, Button: () => document.createElement("button") } })
      w.disconnect = () => { failing = false }
    })
    await page.waitForFunction(() => (window as any).notices.length === 1)
    const first = await page.evaluate(async () => {
      const w = window as any
      const notice = w.notices[0]
      await notice.actions[0].run()
      const opened = [...w.settings]
      await w.commands.get("status").run()
      return { opened, variant: notice.variant, persistent: notice.persistent, action: notice.actions[0].label, descriptions: w.dialogs.map((dialog: any) => dialog.description), whitespaces: w.dialogs.map((dialog: any) => dialog.whiteSpace), notices: w.notices.length }
    })
    assert.equal(first.variant, "error")
    assert.equal(first.persistent, true)
    assert.equal(first.action, "Open Predictions Setup", "configuration blockers point at setup")
    assert.deepEqual(first.opened, ["predictions"])
    assert.equal(first.descriptions.length, 1)
    assert.deepEqual(first.whitespaces, ["pre-wrap"])
    assert.ok(first.descriptions.every((text: string) => /snapshot.*Predictions need a model/s.test(text)))
    assert.equal(first.notices, 1)
    const after = await page.evaluate(async () => { const w = window as any; w.disconnect(); await w.commands.get("status").run(); return { notices: w.notices.map((notice: any) => ({ variant: notice.variant, persistent: notice.persistent, description: notice.description, actions: notice.actions })), dismissed: w.dismissed } })
    assert.equal(after.notices.at(-1)!.variant, "error")
    assert.equal(after.notices.at(-1)!.persistent, false)
    assert.equal(after.notices.at(-1)!.actions[0].label, "Open prediction status", "runtime failures keep the status action")
    assert.doesNotMatch(after.notices.at(-1)!.description, /PRIVATE/)
    assert.ok(after.dismissed >= 1)
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop status view offers Predictions Setup and stays read-only", async () => {
  const page = await fixture()
  try {
    await page.addScriptTag({ content: guiSource })
    await page.evaluate(() => {
      const w = window as any
      w.buttons = []; w.settings = []; w.commands = new Map(); w.statusClosed = 0
      const data = { on: () => () => {}, session: { get: () => undefined } }
      const session = { id: "ses_test", key: "server/ses_test", directory: "/project", location: { directory: "/project" }, server: { id: "fixture", connected: true, data, client: { rpc: () => ({ status: async () => ({ enabled: true, models: "local/a", automatic: false, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [], candidates: [] }) }) } } }
      w.stopGUI = w.PredictionGUI.mount({ sessions: { current: () => session }, screen: { current: () => undefined }, add: (_registry: unknown, command: any) => w.commands.set(command.id, command), layout: { settings: (page: string) => w.settings.push(page) }, app: { version: "test" }, toast: { show() { return { dismiss() {} } } }, dialogs: { open: (render: any) => render({ close() { w.statusClosed++ } }) }, ui: { Dialog: (props: any) => { w.footer = props.footer; return props.children }, Button: (props: any) => { w.buttons.push(props); return document.createElement("button") } } })
    })
    await page.evaluate(async () => { await (window as any).commands.get("status").run() })
    const result = await page.evaluate(() => {
      const w = window as any
      const setup = w.buttons.find((button: any) => button.children === "Predictions Setup")
      setup.onClick()
      return { labels: w.buttons.map((button: any) => String(button.children)), settings: w.settings, closed: w.statusClosed, hasInput: false }
    })
    assert.ok(result.labels.includes("Predictions Setup"))
    assert.deepEqual(result.settings, ["predictions"])
    assert.equal(result.closed, 1, "opening setup closes the status dialog")
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop inspects default server location health on a draft with no mounted session", async () => {
  const page = await fixture()
  try {
    await page.addScriptTag({ content: guiSource })
    await page.evaluate(() => {
      const w = window as any
      w.notices = []
      const data = { location: { default: () => ({ directory: "/draft" }) }, on: () => () => {} }
      const server = { id: "sidecar", connected: true, data, client: { rpc: () => ({ status: async () => ({ enabled: false, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [], reason: "models_required" }) }) } }
      w.stopGUI = w.PredictionGUI.mount({ sessions: { current: () => undefined }, servers: { get: () => server }, screen: { current: () => undefined }, add() {}, app: { version: "test" }, toast: { show: (notice: unknown) => { w.notices.push(notice); return { dismiss() {} } } } })
    })
    await page.waitForFunction(() => (window as any).notices.length === 1, undefined, { timeout: 2000 })
    assert.equal(await page.evaluate(() => (window as any).notices[0].title), "Predictions need a model")
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

test("Desktop compact status withdraws real text, passes Tab through and restores on abstention", async () => {
  const page = await fixture()
  try {
    await page.addScriptTag({ content: guiSource })
    await page.evaluate(() => {
      const w = window as any
      w.commands = new Map(); w.requests = []; w.notices = []
      const data = { on: () => () => {}, session: { get: () => ({ time: { idle: 2 } }), status: () => "idle", pending: { list: () => [] }, permission: { list: () => [] }, form: { list: () => [] } } }
      const session = { id: "ses_test", key: "server/ses_test", directory: "/project", location: { directory: "/project" }, server: { id: "fixture", connected: true, data, client: { rpc: () => ({
        status: async () => ({ enabled: true, automatic: true, escalation: "manual", debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [] }),
        predict: async (input: any) => { w.requests.push(input); return input.escalation ? new Promise(resolve => { w.finish = resolve }) : { text: "Run the tests.", escalation: { token: "next", group: 2, model: { providerID: "paid", id: "next" }, name: "Next model" } } }, events: { on: () => () => {} },
      }) } } }
      w.pillInput = { session }
      const composer = { text: () => w.editor.textContent, focused: () => document.activeElement === w.editor, quotable: () => true, setText: (text: string) => { w.editor.textContent = text }, focus: () => w.editor.focus() }
      w.stopGUI = w.PredictionGUI.mount({ sessions: { current: () => session }, screen: { current: () => ({ composer }) }, add: (_registry: unknown, contribution: any) => w.commands.set(contribution.id, contribution), app: { version: "test" }, toast: { show: (notice: any) => { w.notices.push(notice); return { dismiss() {} } } } })
    })
    await page.locator("[data-opencode-prediction]").waitFor({ state: "visible" })
    const before = await page.evaluate(() => {
      const w = window as any
      return { draft: w.editor.textContent, calls: w.requests.length, pill: w.commands.has("escalate"), notices: w.notices.length }
    })
    assert.equal(before.draft, "")
    assert.equal(before.calls, 1)
    assert.equal(before.notices, 0)
    assert.equal(before.pill, false)
    await page.evaluate(() => (window as any).commands.get("request-shortcut").run())
    const status = page.locator("[data-opencode-communication]")
    await status.waitFor({ state: "visible" })
    assert.match((await status.textContent())!, /^\uFFFB[▰▱]{3} Next model$/)
    assert.equal(await page.locator("[data-opencode-prediction]").count(), 0)
    assert.equal(await page.evaluate(() => (window as any).commands.get("accept").run()), false)
    assert.equal(await page.locator('[contenteditable="true"]').innerText(), "")
    const announcement = await status.getAttribute("aria-label")
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.waitForFunction(() => document.querySelector("[data-opencode-communication]")?.textContent === "\uFFFB… Next model")
    assert.equal(await status.getAttribute("aria-label"), announcement)
    await page.evaluate(() => (window as any).finish({ reason: "no_suggestion" }))
    await page.waitForFunction(() => !!document.querySelector("[data-opencode-prediction]"))
    const after = await page.evaluate(() => {
      const w = window as any
      const accepted = w.commands.get("accept").run()
      return { accepted, draft: w.editor.textContent, token: w.requests[1].escalation, manual: w.requests[1].manual, messages: document.querySelectorAll("[data-opencode-communication]").length, submitted: w.submissions }
    })
    assert.deepEqual(after, { accepted: undefined, draft: "Run the tests.", token: "next", manual: true, messages: 0, submitted: 0 })
    await page.evaluate(() => (window as any).stopGUI())
  } finally { await page.close() }
})

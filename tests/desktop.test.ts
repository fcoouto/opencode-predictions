import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { chromium, type Browser } from "playwright"
import { build } from "esbuild"

let browser: Browser
let source: string
let guiSource: string
before(async () => {
  source = (await build({ entryPoints: ["src/adapters/desktop.ts"], bundle: true, write: false, format: "iife", globalName: "PredictionAdapter", platform: "browser" })).outputFiles[0].text
  guiSource = (await build({ stdin: { contents: 'import gui from "./src/gui.ts"; import { createRoot } from "solid-js"; export const mount = ctx => createRoot(dispose => { const stop = gui.setup(ctx); return () => { stop(); dispose() } })', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "PredictionGUI", platform: "browser" })).outputFiles[0].text
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

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { chromium, type Browser } from "playwright"
import { build } from "esbuild"

let browser: Browser
let source: string
let guiSource: string
before(async () => {
  source = (await build({ entryPoints: ["src/adapters/desktop.ts"], bundle: true, write: false, format: "iife", globalName: "PredictionAdapter", platform: "browser" })).outputFiles[0].text
  guiSource = (await build({ stdin: { contents: 'import gui from "./src/gui.ts"; import { createRoot } from "solid-js"; export { createSignal } from "solid-js"; export const mount = ctx => createRoot(dispose => { const stop = gui.setup(ctx); return () => { stop(); dispose() } })', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "PredictionGUI", platform: "browser" })).outputFiles[0].text
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
      w.acceptPrediction = () => commands.get("accept").run()
      w.stopGUI = w.PredictionGUI.mount({ sessions: { current: () => sessions[current()] }, screen: { current: () => ({ composer: { text: () => w.editor.textContent, focused: () => document.activeElement === w.editor, quotable: () => true, setText: (text: string) => { w.editor.textContent = text }, focus: () => w.editor.focus() } }) }, add: (_registry: unknown, command: any) => commands.set(command.id, command), app: { version: "test" }, toast: { show() {} } })
    })
    const ghost = page.locator("[data-opencode-prediction]")
    await ghost.filter({ hasText: "First chat suggestion" }).waitFor({ state: "visible" })
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
      w.notices = []; w.dialogs = []; w.commands = new Map(); w.dismissed = 0
      let failing = true
      const data = { on: () => () => {}, session: { get: () => undefined } }
      const session = { id: "ses_test", key: "server/ses_test", directory: "/project", location: { directory: "/project" }, server: { id: "fixture", connected: true, data, client: { rpc: () => ({ status: async () => {
        if (!failing) throw new Error("PRIVATE")
        return { enabled: false, automatic: true, debug: false, timeoutMs: 8000, contextTurns: 3, version: "one", warnings: [], reason: "models_required" }
      } }) } } }
      w.stopGUI = w.PredictionGUI.mount({ sessions: { current: () => session }, screen: { current: () => undefined }, add: (_registry: unknown, command: any) => w.commands.set(command.id, command), app: { version: "test" }, toast: { show: (notice: unknown) => { w.notices.push(notice); return { dismiss: () => { w.dismissed++ } } } }, dialogs: { open: (render: any) => render({ close() {} }), confirm: async (options: any) => { w.dialogs.push({ description: options.description, whiteSpace: "normal" }); return false }, alert: async () => {} }, ui: { Dialog: (props: any) => { w.dialogs.push({ description: props.children.textContent, whiteSpace: props.children.style.whiteSpace }); return props.children }, Button: () => document.createElement("button") } })
      w.disconnect = () => { failing = false }
    })
    await page.waitForFunction(() => (window as any).notices.length === 1)
    const first = await page.evaluate(async () => {
      const w = window as any
      const notice = w.notices[0]
      await notice.actions[0].run()
      await w.commands.get("status").run()
      return { variant: notice.variant, persistent: notice.persistent, action: notice.actions[0].label, descriptions: w.dialogs.map((dialog: any) => dialog.description), whitespaces: w.dialogs.map((dialog: any) => dialog.whiteSpace), notices: w.notices.length }
    })
    assert.equal(first.variant, "error")
    assert.equal(first.persistent, true)
    assert.equal(first.action, "Open prediction status")
    assert.equal(first.descriptions.length, 2)
    assert.deepEqual(first.whitespaces, ["pre-wrap", "pre-wrap"])
    assert.ok(first.descriptions.every((text: string) => /snapshot.*Predictions need a model/s.test(text)))
    assert.equal(first.notices, 1)
    const after = await page.evaluate(async () => { const w = window as any; w.disconnect(); await w.commands.get("status").run(); return { notices: w.notices.map((notice: any) => ({ variant: notice.variant, persistent: notice.persistent, description: notice.description })), dismissed: w.dismissed } })
    assert.equal(after.notices.at(-1)!.variant, "error")
    assert.equal(after.notices.at(-1)!.persistent, false)
    assert.doesNotMatch(after.notices.at(-1)!.description, /PRIVATE/)
    assert.ok(after.dismissed >= 1)
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

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { chromium, type Browser, type Page } from "playwright"
import { build } from "esbuild"

let browser: Browser
let source: string
before(async () => {
  source = (await build({
    stdin: { contents: 'export { registerSetupGUI } from "./src/setup-gui.ts"; export { setupEntries } from "./src/setup-gui.ts"; export { createRoot, createRenderEffect, createSignal } from "solid-js"; export { insert } from "solid-js/web"', resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", globalName: "Setup", platform: "browser", external: ["node:*"],
  })).outputFiles[0].text
  browser = await chromium.launch()
})
after(async () => { await browser?.close() })

// Mounts the real setup page against a fake host: only host UI components, servers and the main bridge are doubles.
type Options = { emptyDirectory?: boolean; fields?: object; readOnly?: boolean; mainFails?: boolean; mainFailures?: number; noTarget?: boolean; saveKind?: string; catalog?: object[] }
async function mount(options: Options = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } })
  page.on("pageerror", error => console.log("PAGEERROR", (error.stack ?? "").split("\n").slice(0, 6).join(" | ")))
  await page.route("https://fixture.test/", route => route.fulfill({ body: "<!doctype html><html><body></body></html>", contentType: "text/html" }))
  await page.goto("https://fixture.test/")
  await page.addScriptTag({ content: source })
  await page.evaluate(opts => {
    const w = window as any, S = w.Setup
    const log: any = { mainCalls: 0, saves: [], reads: 0, previews: 0, confirms: [], settings: [], fetches: 0, dialogs: 0, status: 0, predictions: 0 }
    w.log = log
    w.fetch = () => { log.fetches++; return Promise.reject(new Error("PRIVATE network")) }
    const catalog = opts.catalog ?? [
      { providerID: "local", id: "family/a", name: "Family A", enabled: true, variants: [{ id: "low" }, { id: "high" }] },
      { providerID: "local", id: "b", name: "Model B", enabled: true, variants: [] },
      { providerID: "paid", id: "long", name: "非常に長いモデル名 ".repeat(8) + "Ünïcødé", enabled: true, variants: [] },
    ]
    const defaults = { enabled: true, automatic: true, debug: false, includeGithubPRContext: false, escalation: "manual", timeoutMs: 8000, contextTurns: 3 }
    const snapshot: any = { revision: "r1", source: "/server/opencode.jsonc", scope: "global", writable: !opts.readOnly, fields: opts.fields ?? { automatic: false, models: [["local/family/a#low"], ["local/b"]] }, catalog, issues: [], serviceVersion: "v1", localAuthority: { id: "0123456789abcdef" } }
    const effective = () => ({ ...defaults, ...snapshot.fields, ...(snapshot.fields.models ? { models: snapshot.fields.models.map((group: string[]) => group.join(", ")) } : {}) })
    const view = () => ({ ...snapshot, effective: effective(), ...(opts.readOnly ? { reason: "This configuration source is not verified for setup writes." } : {}) })
    const clients: any = {}
    const client = (id: string) => clients[id] ??= { rpc: () => ({
      settings: async () => ({ ...view(), writable: false }),
      previewSettings: async ({ fields }: any) => { log.previews++; return { groups: (fields.models ?? []).map((group: string[]) => ({ selectors: group, candidates: group.filter(entry => !entry.includes("missing")).map((_, index) => ({ providerID: "local", id: "m" + index, name: "m" })) })), issues: group0Issues(fields) } },
      predict: async () => { log.predictions++; return {} },
    }) }
    const group0Issues = (fields: any) => (fields.models ?? []).flatMap((group: string[], g: number) => group.flatMap((entry, e) => entry.includes("missing") ? [{ field: "models", group: g, entry: e, severity: "warning", code: "no_match", message: "No current models match this selector." }] : []))
    const [serverID, setServerID] = S.createSignal("sidecar")
    const [directory, setDirectory] = S.createSignal(opts.emptyDirectory ? "" : "/project")
    w.switchDirectory = (value: string) => setDirectory(value)
    const servers = { get: (id: string) => ({ id, builtin: id === "sidecar", connected: true, client: client(id), data: { location: { default: () => ({ directory: directory() }) } } }) }
    w.switchServer = (id: string) => setServerID(id)
    w.snapshot = snapshot
    const [target, setTarget] = S.createSignal(!opts.noTarget)
    w.disconnect = () => setTarget(false)
    const ctx: any = {
      id: "opencode-predictions",
      sessions: { current: () => target() ? { id: "ses_1", location: { directory: directory() }, server: servers.get(serverID()) } : undefined },
      servers: { get: (id: string) => target() ? servers.get(id) : undefined },
      main: () => {
        if (opts.mainFails || log.mainCalls++ < (opts.mainFailures ?? 0)) throw new Error("PRIVATE no main")
        return {
          read: async () => { log.reads++; return view() },
          save: async (value: any) => {
            log.saves.push({ serverID: value.serverID, input: JSON.parse(JSON.stringify(value.input)) })
            if (opts.saveKind === "conflict") return { kind: "conflict", message: "Configuration changed. Reload settings before trying again." }
            if (opts.saveKind === "failed") return { kind: "failed", message: "Settings were not saved. Reopen settings and try again." }
            snapshot.fields = { ...snapshot.fields, ...value.input.fields }
            if (value.input.removeModels) delete snapshot.fields.models
            snapshot.revision = "r" + (log.saves.length + 1); snapshot.serviceVersion = "v" + (log.saves.length + 1)
            return { kind: "saved_not_active", revision: snapshot.revision, message: "Saved on disk." }
          },
        }
      },
      layout: { settings: (page: string) => log.settings.push(page) },
      toast: { show() {} },
      dialogs: {
        open: (render: any) => { log.dialogs++; const holder = document.createElement("div"); holder.setAttribute("data-dialog-host", ""); document.body.append(holder); const handle = { close: () => holder.remove() }; S.createRoot(() => holder.append(render(handle))); return handle },
        confirm: async (options: any) => { log.confirms.push(options); return !!w.confirmAnswer },
      },
      add: (_token: unknown, value: any) => { if (value.render) w.page = value; else w.commands = { ...(w.commands ?? {}), [value.id]: value } },
      ui: {},
    }
    const el = (tag: string, attrs: Record<string, string> = {}) => { const node = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node }
    const slot = (parent: HTMLElement, read: () => any) => { S.insert(parent, read) }
    ctx.ui = {
      SettingsLayout: (p: any) => { const root = el("main", { "data-layout": "" }); const h = el("h1"); h.textContent = p.title; const d = el("p", { "data-description": "" }); S.createRenderEffect(() => { d.textContent = p.description ?? "" }); const a = el("div"); slot(a, () => p.actions); root.append(h, d, a); slot(root, () => p.children); return root },
      SettingsSection: (p: any) => { const s = el("section", p.title ? { "data-section": p.title } : { "data-section": "" }); if (p.title) { const h = el("h2"); h.textContent = p.title; s.append(h) } slot(s, () => p.children); const f = el("div", { "data-footer": "" }); slot(f, () => p.footer); s.append(f); return s },
      SettingsRow: (p: any) => { const r = el("div", p.id ? { "data-action": p.id } : {}); const t = el("div", { "data-title": "" }); slot(t, () => p.title); const d = el("div", { "data-row-description": "" }); slot(d, () => p.description); const c = el("div", { "data-control": "" }); slot(c, () => p.children); r.append(t, d, c); return r },
      Switch: (p: any) => { const i = el("input", { type: "checkbox", role: "switch", "aria-label": p.label }) as HTMLInputElement; S.createRenderEffect(() => { i.checked = p.checked; i.disabled = !!p.disabled }); i.onchange = () => p.onChange(i.checked); return i },
      Select: (p: any) => { const s = el("select", { "aria-label": p.label }) as HTMLSelectElement; for (const o of p.options) { const n = el("option", { value: o.value }); n.textContent = o.label; s.append(n) } S.createRenderEffect(() => { s.value = p.value ?? ""; s.disabled = !!p.disabled }); s.onchange = () => p.onChange(s.value); return s },
      TextInput: (p: any) => { const i = el("input", { type: p.type ?? "text", "aria-label": p.label }) as HTMLInputElement; S.createRenderEffect(() => { i.value = p.value; i.disabled = !!p.disabled; i.setAttribute("aria-invalid", String(!!p.invalid)) }); i.oninput = () => p.onInput(i.value); i.onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter") p.onSubmit?.(i.value) }; return i },
      Button: (p: any) => { const b = el("button", { type: "button" }) as HTMLButtonElement; slot(b, () => p.children); S.createRenderEffect(() => { b.disabled = !!p.disabled; b.dataset.variant = p.variant ?? "neutral" }); b.onclick = () => { if (!b.disabled) p.onClick?.() }; return b },
      Loader: () => el("span", { role: "progressbar" }),
      Icon: (p: any) => el("span", { "data-icon": p.name, "aria-hidden": "true" }),
      Tooltip: (p: any) => { const w = el("span", { "data-tooltip": "" }); slot(w, () => p.children); return w },
      IconButton: (p: any) => { const b = el("button", { type: "button", "aria-label": p.label, "data-icon-button": p.icon }) as HTMLButtonElement; S.createRenderEffect(() => { b.disabled = !!p.disabled }); b.onclick = () => { if (!b.disabled) p.onClick?.() }; return b },
      // A menu opens a list of items read at open time; choosing an item closes it and returns focus to the trigger, like the host.
      Menu: (p: any) => {
        const wrap = el("span", {}); const trigger = el("button", { type: "button", "aria-haspopup": "menu" }) as HTMLButtonElement
        // Worst case for a host: the label is read once when the menu is created, so a page that relies on reactive labels fails.
        const label = p.label; wrap.setAttribute("data-menu", label); trigger.setAttribute("aria-label", label); if (p.trigger !== "icon") trigger.textContent = label
        trigger.dataset.menuIcon = p.icon ?? ""; trigger.disabled = !!p.disabled
        let list: HTMLElement | undefined
        const close = () => { list?.remove(); list = undefined }
        trigger.onclick = () => {
          if (list) return close()
          list = el("div", { role: "menu", "aria-label": label })
          for (const item of p.items) { if (item.type === "separator") { list.append(el("hr")); continue } const b = el("button", { role: "menuitem", type: "button" }) as HTMLButtonElement; b.textContent = item.label; b.disabled = !!item.disabled; b.onclick = () => { close(); item.onSelect(); setTimeout(() => trigger.focus(), 0) }; list.append(b) }
          wrap.append(list)
        }
        wrap.append(trigger); return wrap
      },
      Dialog: (p: any) => { const d = el("div", { role: "dialog", "aria-label": p.title }); const h = el("h2"); h.textContent = p.title; const dd = el("p"); dd.textContent = p.description ?? ""; d.append(h, dd); slot(d, () => p.children); slot(d, () => p.footer); return d },
    }
    w.status = async () => { log.status++ }
    w.dispose = S.createRoot((dispose: any) => { const stop = S.registerSetupGUI(ctx, async () => { log.status++ }); w.stop = stop; return dispose })
    w.renderPage = (target?: string) => {
      document.body.innerHTML = ""
      return S.createRoot((dispose: any) => { document.body.append(w.page.render({ target })); w.unmountPage = () => { dispose(); document.body.innerHTML = "" } })
    }
    w.renderPage()
  }, options as any)
  return page
}
const titles = (page: Page) => page.evaluate(() => [...document.querySelectorAll("[data-section]")].map(s => s.getAttribute("data-section")).filter(Boolean))
const row = (page: Page, id: string) => page.locator(`[data-action="${id}"]`)
const save = (page: Page) => page.getByRole("button", { name: "Save changes" })
const idle = (page: Page) => page.waitForFunction(() => !document.querySelector('[role="progressbar"]') && document.querySelector('[data-action="predictions-save"]'))

test("page orders Behavior, Models, Advanced with exact labels and Advanced collapsed; setup works without a session response", async () => {
  const page = await mount()
  try {
    await idle(page)
    assert.deepEqual(await titles(page), ["Behavior", "Models", "Group 1 — Tried first", "Group 2 — If Group 1 fails", "Advanced"], "each fallback group is its own section under Models, in the order it is tried")
    const labels = await page.evaluate(() => [...document.querySelectorAll('[data-section="Behavior"] [data-title]')].map(node => node.textContent))
    assert.deepEqual(labels, ["Enable Predictions", "Predict After Replies", "Escalation Mode"])
    assert.equal(await row(page, "predictions-advanced-github").count(), 0, "GitHub PR context lives only in the collapsed Advanced section")
    assert.equal(await page.getByRole("switch", { name: "Include GitHub PR context" }).count(), 0)
    await page.getByRole("button", { name: "Show advanced settings" }).click()
    assert.equal(await page.getByRole("switch", { name: "Include GitHub PR context" }).isChecked(), false, "omitted means off")
    const advanced = await page.evaluate(() => [...document.querySelectorAll('[data-action^="predictions-advanced-"] [data-title]')].map(node => node.textContent))
    assert.deepEqual(advanced, ["Timeout per model", "Recent interactions", "Include GitHub PR context", "Debug notices"])
    const warning = (await row(page, "predictions-advanced-github").textContent())!
    assert.match(warning, /private/i)
    assert.match(warning, /fallback and paid/i)
    assert.equal(await page.evaluate(() => (window as any).log.predictions + (window as any).log.fetches), 0, "opening setup generates nothing and fetches nothing")
  } finally { await page.close() }
})

test("the Predictions Setup command and settings search entries open the same page", async () => {
  const page = await mount()
  try {
    const result = await page.evaluate(async () => {
      const w = window as any
      w.commands.setup.run()
      return { title: w.commands.setup.title, group: w.commands.setup.group, bind: w.commands.setup.bind, opened: w.log.settings, entries: w.Setup.setupEntries.map((entry: any) => entry.title) }
    })
    assert.equal(result.title, "Predictions Setup")
    assert.equal(result.group, "Predictions")
    assert.equal(result.bind, undefined, "no default shortcut")
    assert.deepEqual(result.opened, ["predictions"])
    for (const title of ["Enable Predictions", "Predict After Replies", "Escalation Mode", "Models", "Timeout per model", "Recent interactions", "Include GitHub PR context", "Debug notices"]) assert.ok(result.entries.includes(title), title)
    await idle(page)
    await page.evaluate(() => (window as any).renderPage("predictions-advanced-github"))
    assert.equal(await page.getByRole("switch", { name: "Include GitHub PR context" }).count(), 1, "searching for an Advanced row reveals it")
  } finally { await page.close() }
})

test("Save sends only edited fields, never prompts or fetches, and reads back an active result", async () => {
  const page = await mount()
  try {
    await idle(page)
    assert.equal(await save(page).isDisabled(), true, "unchanged drafts cannot save")
    await page.getByRole("switch", { name: "Predict After Replies" }).check()
    await page.getByRole("button", { name: "Show advanced settings" }).click()
    await page.getByRole("switch", { name: "Include GitHub PR context" }).check()
    await save(page).click()
    await page.waitForFunction(() => /Saved\. The new settings are active/.test(document.querySelector('[data-footer] [role="status"]')?.textContent ?? ""))
    const log = await page.evaluate(() => (window as any).log)
    assert.equal(log.saves.length, 1)
    assert.deepEqual(log.saves[0].input.fields, { automatic: true, includeGithubPRContext: true })
    assert.equal(log.saves[0].serverID, "sidecar")
    assert.equal(log.predictions + log.fetches, 0)
    assert.equal(log.confirms.length, 0, "no repeated consent dialog")
  } finally { await page.close() }
})

test("GitHub PR context round-trips on and off, and an explicit false is saved rather than omitted", async () => {
  const page = await mount({ fields: { models: [["local/b"]], includeGithubPRContext: true } })
  try {
    await idle(page)
    await page.getByRole("button", { name: "Show advanced settings" }).click()
    const toggle = page.getByRole("switch", { name: "Include GitHub PR context" })
    assert.equal(await toggle.isChecked(), true)
    await toggle.uncheck()
    await save(page).click()
    await page.waitForFunction(() => (window as any).log.saves.length === 1)
    const saved = await page.evaluate(() => ({ fields: (window as any).log.saves[0].input.fields, stored: (window as any).snapshot.fields }))
    assert.deepEqual(saved.fields, { includeGithubPRContext: false })
    assert.equal(saved.stored.includeGithubPRContext, false)
    await page.waitForFunction(() => /Saved\./.test(document.querySelector('[data-footer] [role="status"]')?.textContent ?? ""))
    await toggle.check()
    await save(page).click()
    await page.waitForFunction(() => (window as any).log.saves.length === 2)
    assert.equal(await page.evaluate(() => (window as any).snapshot.fields.includeGithubPRContext), true)
    assert.equal(await page.evaluate(() => (window as any).log.fetches), 0)
  } finally { await page.close() }
})

test("an unrelated edit preserves an omitted GitHub PR context and other stored models", async () => {
  const page = await mount({ fields: { models: [["local/b"]] } })
  try {
    await idle(page)
    await page.getByRole("switch", { name: "Enable Predictions" }).uncheck()
    await save(page).click()
    await page.waitForFunction(() => (window as any).log.saves.length === 1)
    const fields = await page.evaluate(() => (window as any).log.saves[0].input.fields)
    assert.deepEqual(fields, { enabled: false })
    assert.equal(await page.evaluate(() => Object.hasOwn((window as any).snapshot.fields, "includeGithubPRContext")), false)
  } finally { await page.close() }
})

test("timeout accepts only whole numbers and the draft blocks Save until valid", async () => {
  const page = await mount()
  try {
    await idle(page)
    await page.getByRole("button", { name: "Show advanced settings" }).click()
    const input = page.getByLabel("Timeout per model")
    await input.fill("8000oops")
    assert.equal(await input.getAttribute("aria-invalid"), "true")
    assert.equal(await save(page).isDisabled(), true)
    await input.fill("9000")
    assert.equal(await save(page).isDisabled(), false)
    await save(page).click()
    await page.waitForFunction(() => (window as any).log.saves.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).log.saves[0].input.fields), { timeoutMs: 9000 })
  } finally { await page.close() }
})

const entryTitles = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-action^="predictions-entry-"] [data-title]')].map(node => node.textContent))
const menu = (page: Page, name: string) => page.locator(`[data-menu="${name}"]`)
const choose = async (page: Page, name: string, item: string) => { await menu(page, name).getByRole("button").first().click(); await page.getByRole("menuitem", { name: item, exact: true }).click() }
const focused = (page: Page) => page.evaluate(() => ({ row: document.activeElement?.closest("[data-action]")?.getAttribute("data-action"), name: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() }))

test("Models opens with a Fallback order row that explains the order and the cost, and offers Add group; the old footer row is gone", async () => {
  const page = await mount()
  try {
    await idle(page)
    const intro = (await row(page, "predictions-models").textContent())!
    assert.match(intro, /Fallback order/)
    assert.match(intro, /top to bottom/)
    assert.match(intro, /later group is tried when every model above it fails/i)
    assert.match(intro, /may incur charges/)
    assert.match(intro, /does not mean it is free/)
    assert.match(intro, /send(s)? no conversation/)
    assert.equal(await page.getByText("Add fallback pattern").count(), 0)
    assert.equal(await page.getByText("Fallback groups", { exact: true }).count(), 0)
    await menu(page, "Add group").getByRole("button").click()
    assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Model…", "Pattern… (for example provider/family-*)"])
    assert.equal(await page.getByRole("button", { name: "Refresh matches" }).count(), 1)
  } finally { await page.close() }
})

test("each group is a section with a match summary, an Add menu and a group-actions menu; every entry has one labelled actions menu", async () => {
  const page = await mount()
  try {
    await idle(page)
    assert.deepEqual(await entryTitles(page), ["1. Family A", "1. Model B"])
    for (const name of ["Move up", "Move down", "Remove", "Move group up", "Remove group"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, `no repeated text button "${name}"`)
    // Accessible names say which entry they act on, so a screen reader never hears "Actions, Actions, Actions".
    for (const name of ["Actions for Family A, group 1, entry 1", "Actions for Model B, group 2, entry 1", "Add to Group 1", "Add to Group 2", "Group 1 actions", "Group 2 actions"]) assert.equal(await menu(page, name).count(), 1, name)
    await page.waitForFunction(() => /1 model matches now/.test(document.querySelector('[data-action="predictions-group-0"]')?.textContent ?? ""))
    const controls = await page.locator('[data-section^="Group "] button').count()
    assert.equal(controls, 6, "2 groups with 1 entry each expose 6 controls (was 19)")
    await menu(page, "Actions for Family A, group 1, entry 1").getByRole("button").click()
    assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Move up", "Move down", "Remove"])
    assert.equal(await page.getByRole("menuitem", { name: "Move up" }).isDisabled(), true)
  } finally { await page.close() }
})

test("group actions menu moves and removes groups; focus follows the moved group's menu and removing asks before dropping several models", async () => {
  const page = await mount({ fields: { models: [["local/family/a#low", "local/b"], ["local/b"]] } })
  try {
    await idle(page)
    await menu(page, "Group 1 actions").getByRole("button").click()
    assert.equal(await page.getByRole("menuitem", { name: "Move group up" }).isDisabled(), true, "the first group cannot move up; the item stays so positions are stable")
    await page.getByRole("menuitem", { name: "Move group down" }).click()
    assert.deepEqual(await entryTitles(page), ["1. Model B", "1. Family A", "2. Model B"])
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Group 2 actions")
    assert.deepEqual(await focused(page), { row: "predictions-group-1", name: "Group 2 actions" })
    // Removing a group that holds more than one model asks first; declining keeps it.
    await page.evaluate(() => { (window as any).confirmAnswer = false })
    await choose(page, "Group 2 actions", "Remove group")
    assert.equal(await page.evaluate(() => (window as any).log.confirms.length), 1)
    assert.match(await page.evaluate(() => (window as any).log.confirms[0].description), /2 models/)
    assert.deepEqual(await entryTitles(page), ["1. Model B", "1. Family A", "2. Model B"])
    await page.evaluate(() => { (window as any).confirmAnswer = true })
    await choose(page, "Group 2 actions", "Remove group")
    await page.waitForFunction(() => document.querySelectorAll('[data-action^="predictions-entry-"]').length === 1)
    assert.deepEqual(await entryTitles(page), ["1. Model B"])
    assert.deepEqual(await focused(page), { row: "predictions-group-0", name: "Group 1 actions" }, "focus lands on a control that still exists")
    // A single-model group is removed without a prompt.
    const before = await page.evaluate(() => (window as any).log.confirms.length)
    await choose(page, "Group 1 actions", "Remove group")
    assert.equal(await page.evaluate(() => (window as any).log.confirms.length), before)
    await page.getByText("No models configured").waitFor()
    assert.deepEqual(await focused(page), { row: "predictions-models", name: "Add a model" })
  } finally { await page.close() }
})

test("an entry's actions menu reorders within a group and keeps focus on the moved entry; removing the last model removes the setting explicitly", async () => {
  const page = await mount({ fields: { models: [["local/family/a#low", "local/b"]] } })
  try {
    await idle(page)
    await choose(page, "Actions for Model B, group 1, entry 2", "Move up")
    assert.deepEqual(await entryTitles(page), ["1. Model B", "2. Family A"])
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Actions for Model B, group 1, entry 1")
    assert.deepEqual(await focused(page), { row: "predictions-entry-0-0", name: "Actions for Model B, group 1, entry 1" })
    await choose(page, "Actions for Model B, group 1, entry 1", "Remove")
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Actions for Family A, group 1, entry 1")
    assert.deepEqual(await focused(page), { row: "predictions-entry-0-0", name: "Actions for Family A, group 1, entry 1" }, "focus moves to the entry that took the removed one's place")
    await choose(page, "Actions for Family A, group 1, entry 1", "Remove")
    await page.getByText("No models configured").waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Add a model")
    assert.deepEqual(await focused(page), { row: "predictions-models", name: "Add a model" })
    await save(page).click()
    await page.waitForFunction(() => (window as any).log.saves.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).log.saves[0].input), { revision: "r1", fields: {}, removeModels: true })
  } finally { await page.close() }
})

test("Add group and the per-group Add menu open the model and pattern dialogs and add to the right place", async () => {
  const page = await mount({ fields: { models: [["local/b"]] } })
  try {
    await idle(page)
    await choose(page, "Add to Group 1", "Pattern… (for example provider/family-*)")
    const dialog = page.getByRole("dialog", { name: "Add a model pattern" })
    await dialog.getByLabel("Model pattern").fill("local/family-*")
    await dialog.getByRole("button", { name: "Add pattern" }).click()
    assert.deepEqual(await entryTitles(page), ["1. Model B", "2. local/family-*"])
    await choose(page, "Add group", "Model…")
    const add = page.getByRole("dialog", { name: "Add a model" })
    assert.match(await add.textContent() ?? "", /may incur charges/, "the cost note is repeated where a model is added")
    await add.getByLabel("Search models").fill("family a")
    await add.getByRole("button", { name: /Family A/ }).click()
    await add.getByRole("button", { name: "Add model" }).click()
    assert.deepEqual(await entryTitles(page), ["1. Model B", "2. local/family-*", "1. Family A"])
    assert.deepEqual(await titles(page), ["Behavior", "Models", "Group 1 — Tried first", "Group 2 — If Group 1 fails", "Advanced"])
  } finally { await page.close() }
})

test("zero-match and overlap warnings carry an icon and text beside the entry, not colour alone", async () => {
  const page = await mount({ fields: { models: [["local/b"], ["local/missing-*"]] } })
  try {
    await idle(page)
    await page.waitForFunction(() => /No current models match/.test(document.querySelector('[data-action="predictions-entry-1-0"]')?.textContent ?? ""))
    assert.equal(await row(page, "predictions-entry-1-0").locator('[data-icon="outline-hexagonal-warning"]').count(), 1)
    assert.match((await row(page, "predictions-group-1").textContent())!, /0 models match now/)
  } finally { await page.close() }
})

test("searchable model selection offers variants and keeps provider IDs as secondary identifiers", async () => {
  const page = await mount({ fields: {} })
  try {
    await idle(page)
    await page.getByRole("button", { name: "Add a model" }).click()
    const dialog = page.getByRole("dialog", { name: "Add a model" })
    await dialog.getByLabel("Search models").fill("family a")
    const choices = await dialog.getByRole("button").allTextContents()
    assert.ok(choices.some(text => text.includes("Family A") && text.includes("local/family/a")), JSON.stringify(choices))
    assert.equal(choices.some(text => text.includes("Model B")), false)
    await dialog.getByRole("button", { name: /Family A/ }).click()
    await dialog.getByLabel("Reasoning variant").selectOption("high")
    await dialog.getByRole("button", { name: "Add model" }).click()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await row(page, "predictions-entry-0-0").locator("[data-row-description]").textContent().then(text => text!.includes("local/family/a#high")), true)
    await save(page).click()
    await page.waitForFunction(() => (window as any).log.saves.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).log.saves[0].input.fields), { models: [["local/family/a#high"]] })
  } finally { await page.close() }
})

test("patterns stay patterns, invalid ones are blocked and zero-match warnings stay visible without being dropped", async () => {
  const page = await mount({ fields: {} })
  try {
    await idle(page)
    await page.getByRole("button", { name: "Add model pattern" }).click()
    const dialog = page.getByRole("dialog", { name: "Add a model pattern" })
    await dialog.getByLabel("Model pattern").fill("no-slash")
    assert.equal(await dialog.getByRole("button", { name: "Add pattern" }).isDisabled(), true)
    await dialog.getByLabel("Model pattern").fill("local/missing-*")
    await dialog.getByRole("button", { name: "Add pattern" }).click()
    await page.waitForFunction(() => /No current models match/.test(document.querySelector('[data-action="predictions-entry-0-0"]')?.textContent ?? ""))
    assert.equal(await page.getByText("local/missing-*").count() > 0, true)
    await save(page).click()
    await page.waitForFunction(() => (window as any).log.saves.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).log.saves[0].input.fields), { models: [["local/missing-*"]] })
  } finally { await page.close() }
})

test("long Unicode model names stay complete and the cost disclosure opens the models section", async () => {
  const page = await mount({ fields: { models: [["paid/long"]] } })
  try {
    await idle(page)
    const title = (await row(page, "predictions-entry-0-0").locator("[data-title]").textContent())!
    assert.match(title, /^1\. 非常に長いモデル名/)
    assert.match(title, /Ünïcødé$/)
    const intro = await row(page, "predictions-models").textContent()
    assert.match(intro!, /may incur charges/)
    assert.match(intro!, /does not mean it is free/)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    assert.equal(overflow, true, "long names must not widen the page")
  } finally { await page.close() }
})

test("the external-editor warning sits beside Save without any consent dialog", async () => {
  const page = await mount()
  try {
    await idle(page)
    const text = (await row(page, "predictions-save").textContent())!
    assert.match(text, /another editor during a save can be overwritten, including unrelated settings/)
    assert.match(text, /Recovery copies may not contain those changes/)
    assert.doesNotMatch(text, /conflict-proof|guarantee/i)
    assert.equal(await page.evaluate(() => (window as any).log.confirms.length), 0)
  } finally { await page.close() }
})

test("conflict and failure keep the draft, and saved-not-active is explained", async () => {
  for (const [saveKind, pattern] of [["conflict", /Configuration changed/], ["failed", /not saved/]] as const) {
    const page = await mount({ saveKind })
    try {
      await idle(page)
      await page.getByRole("switch", { name: "Enable Predictions" }).uncheck()
      await save(page).click()
      await page.waitForFunction(() => /\S/.test(document.querySelector('[data-footer] [role="status"]')?.textContent ?? ""))
      assert.match((await page.locator('[data-footer] [role="status"]').textContent())!, pattern)
      assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isChecked(), false, "the draft survives a failed save")
    } finally { await page.close() }
  }
})

test("read-only configurations explain why, disable every control and never offer Save", async () => {
  const page = await mount({ readOnly: true })
  try {
    await idle(page)
    assert.match((await row(page, "predictions-readonly").textContent())!, /not verified for setup writes/)
    assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isDisabled(), true)
    assert.equal(await page.getByLabel("Escalation Mode").isDisabled(), true)
    assert.equal(await save(page).isDisabled(), true)
  } finally { await page.close() }
})

test("a missing main bridge keeps inspection read-only and writes nothing, even if metadata claims a local authority", async () => {
  const page = await mount({ mainFails: true })
  try {
    await idle(page)
    assert.match((await row(page, "predictions-readonly").textContent())!, /Read-only/)
    assert.equal(await save(page).isDisabled(), true)
    assert.equal(await page.evaluate(() => (window as any).log.saves.length), 0)
    assert.doesNotMatch(await page.locator("body").textContent() ?? "", /PRIVATE/)
  } finally { await page.close() }
})

test("with no connected server the page explains instead of editing", async () => {
  const page = await mount({ noTarget: true })
  try {
    await page.waitForFunction(() => document.querySelector('[data-action="predictions-unavailable"]'))
    assert.equal(await page.getByRole("button", { name: "Save changes" }).count(), 0)
    assert.match((await row(page, "predictions-unavailable").textContent())!, /Open a project or connect/)
  } finally { await page.close() }
})

test("a changed server target requires discard confirmation and never retargets an unsaved draft's Save", async () => {
  const page = await mount()
  try {
    await idle(page)
    await page.getByRole("switch", { name: "Predict After Replies" }).check()
    await page.evaluate(() => (window as any).switchServer("remote-host"))
    await row(page, "predictions-switch").waitFor()
    assert.match((await row(page, "predictions-switch").textContent())!, /Switch to remote-host/)
    // The pinned editor still owns the draft; saving writes to the original server only.
    await save(page).click()
    await page.waitForFunction(() => (window as any).log.saves.length === 1)
    assert.equal(await page.evaluate(() => (window as any).log.saves[0].serverID), "sidecar")
    // Nothing is left to discard once saved, so the page follows the active server on its own.
    await page.waitForFunction(() => /remote-host/.test(document.querySelector("[data-description]")?.textContent ?? "") && !document.querySelector('[data-action="predictions-switch"]'))
    await idle(page)
    // A dirty draft is never discarded silently: switching back needs an explicit, confirmed action.
    await page.evaluate(() => { (window as any).confirmAnswer = false })
    await page.getByRole("switch", { name: "Predict After Replies" }).uncheck()
    await page.evaluate(() => (window as any).switchServer("sidecar"))
    await row(page, "predictions-switch").waitFor()
    await row(page, "predictions-switch").getByRole("button", { name: "Switch server" }).click()
    assert.equal(await page.evaluate(() => (window as any).log.confirms.length), 1, "a dirty draft asks before it is discarded")
    assert.equal(await page.getByRole("switch", { name: "Predict After Replies" }).isChecked(), false, "declining keeps the draft")
    await page.evaluate(() => { (window as any).confirmAnswer = true })
    await row(page, "predictions-switch").getByRole("button", { name: "Switch server" }).click()
    await page.waitForFunction(() => !document.querySelector('[data-action="predictions-switch"]') && /this computer/.test(document.querySelector("[data-description]")?.textContent ?? ""))
  } finally { await page.close() }
})

test("leaving and returning to the page keeps an unsaved draft", async () => {
  const page = await mount()
  try {
    await idle(page)
    await page.getByRole("switch", { name: "Enable Predictions" }).uncheck()
    await page.evaluate(() => { (window as any).unmountPage(); (window as any).renderPage() })
    await idle(page)
    assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isChecked(), false)
    assert.equal(await save(page).isDisabled(), false)
  } finally { await page.close() }
})

test("the status action opens the existing status view without turning it into an editor", async () => {
  const page = await mount()
  try {
    await idle(page)
    await page.getByRole("button", { name: "Prediction status and preview" }).click()
    assert.equal(await page.evaluate(() => (window as any).log.status), 1)
  } finally { await page.close() }
})

test("a location-only change on the same server never prompts and re-pins a clean draft", async () => {
  const page = await mount()
  try {
    await idle(page)
    await page.evaluate(() => (window as any).switchDirectory("/other-project"))
    await page.waitForTimeout(100)
    assert.equal(await row(page, "predictions-switch").count(), 0, "settings are global per server")
    await page.getByRole("switch", { name: "Enable Predictions" }).uncheck()
    await page.evaluate(() => (window as any).switchDirectory("/third-project"))
    await page.waitForTimeout(100)
    assert.equal(await row(page, "predictions-switch").count(), 0, "a dirty draft stays pinned without a server prompt")
    assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isChecked(), false)
  } finally { await page.close() }
})

test("a read-only first load recovers with Check again when the bridge was still starting", async () => {
  const page = await mount({ mainFailures: 1 })
  try {
    await idle(page)
    assert.equal(await row(page, "predictions-readonly").count(), 1)
    await row(page, "predictions-readonly").getByRole("button", { name: "Check again" }).click()
    await page.waitForFunction(() => !document.querySelector('[data-action="predictions-readonly"]'))
    assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isDisabled(), false)
  } finally { await page.close() }
})

test("a read-only first load retries once on its own", async () => {
  const page = await mount({ mainFailures: 1 })
  try {
    await idle(page)
    assert.equal(await row(page, "predictions-readonly").count(), 1)
    await page.waitForFunction(() => !document.querySelector('[data-action="predictions-readonly"]'), undefined, { timeout: 8000 })
  } finally { await page.close() }
})

test("an empty host location is not a target; the page becomes editable when the location arrives", async () => {
  const page = await mount({ emptyDirectory: true })
  try {
    await page.waitForFunction(() => document.querySelector('[data-action="predictions-unavailable"]'))
    assert.equal(await page.evaluate(() => (window as any).log.reads), 0, "no read is attempted for an empty location")
    await page.evaluate(() => (window as any).switchDirectory("/project"))
    await idle(page)
    assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isDisabled(), false)
  } finally { await page.close() }
})

test("the not-connected notice disappears once the editor exists, even when it was pinned after first render", async () => {
  const page = await mount({ emptyDirectory: true })
  try {
    await page.waitForFunction(() => document.querySelector('[data-action="predictions-unavailable"]'))
    await page.evaluate(() => (window as any).switchDirectory("/project"))
    await idle(page)
    assert.equal(await page.locator('[data-action="predictions-unavailable"]').count(), 0, "no stale not-connected notice above a live editor")
  } finally { await page.close() }
})

test("match counts appear after load through metadata-only preview, without generating", async () => {
  const page = await mount()
  try {
    await idle(page)
    await page.waitForFunction(() => /1 model matches now/.test(document.querySelector('[data-action="predictions-group-0"]')?.textContent ?? ""))
    assert.equal(await page.evaluate(() => (window as any).log.predictions + (window as any).log.fetches), 0)
  } finally { await page.close() }
})

test("an invalid timeout explains itself in text, not only with a red field", async () => {
  const page = await mount()
  try {
    await idle(page)
    await page.getByRole("button", { name: "Show advanced settings" }).click()
    await page.getByLabel("Timeout per model").fill("8000oops")
    const alert = row(page, "predictions-advanced-timeout").getByRole("alert")
    assert.match((await alert.textContent())!, /whole number/i)
    await page.getByLabel("Timeout per model").fill("9000")
    assert.equal(await row(page, "predictions-advanced-timeout").getByRole("alert").count(), 0, "the message goes away with the problem")
  } finally { await page.close() }
})

test("after a conflict Save explains itself and Reload settings recovers", async () => {
  const page = await mount({ saveKind: "conflict" })
  try {
    await idle(page)
    await page.evaluate(() => { (window as any).confirmAnswer = true })
    await page.getByRole("switch", { name: "Enable Predictions" }).uncheck()
    await save(page).click()
    await page.waitForFunction(() => /Configuration changed/.test(document.querySelector('[data-footer] [role="status"]')?.textContent ?? ""))
    assert.equal(await page.getByRole("button", { name: "Reload settings" }).count(), 1, "a blocked Save offers the way out")
    await page.getByRole("switch", { name: "Enable Predictions" }).check()
    await page.getByRole("switch", { name: "Enable Predictions" }).uncheck()
    await save(page).click()
    await page.waitForFunction(() => /Reload settings before trying again/.test(document.querySelector('[data-footer] [role="status"]')?.textContent ?? ""))
    await page.getByRole("button", { name: "Reload settings" }).click()
    await page.waitForFunction(() => !document.querySelector('[role="status"]')?.textContent?.includes("Reload settings"))
    assert.equal(await page.getByRole("button", { name: "Reload settings" }).count(), 0)
    assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isChecked(), true, "reloading shows the stored value")
  } finally { await page.close() }
})

test("a menu that reads its label and disabled state only once still names the entry it acts on after a move and a removal", async () => {
  const page = await mount({ fields: { models: [["local/family/a#low", "local/b", "local/family/a#high"]] } })
  try {
    await idle(page)
    await choose(page, "Actions for Family A, group 1, entry 1", "Move down")
    assert.deepEqual(await entryTitles(page), ["1. Model B", "2. Family A", "3. Family A"])
    for (const name of ["Actions for Model B, group 1, entry 1", "Actions for Family A, group 1, entry 2", "Actions for Family A, group 1, entry 3"]) assert.equal(await menu(page, name).count(), 1, name)
    // The last entry cannot move down, and that follows the entry's position, not the one the slot was created for.
    await menu(page, "Actions for Family A, group 1, entry 3").getByRole("button").click()
    assert.equal(await page.getByRole("menuitem", { name: "Move down" }).isDisabled(), true)
    await page.getByRole("menuitem", { name: "Move up" }).click()
    await choose(page, "Actions for Model B, group 1, entry 1", "Remove")
    assert.deepEqual(await entryTitles(page), ["1. Family A", "2. Family A"])
    assert.equal(await menu(page, "Actions for Family A, group 1, entry 3").count(), 0, "labels follow positions after a removal")
    // The same model twice stays distinguishable by position.
    for (const name of ["Actions for Family A, group 1, entry 1", "Actions for Family A, group 1, entry 2"]) assert.equal(await menu(page, name).count(), 1, name)
  } finally { await page.close() }
})

test("match counts come back after any edit that clears the preview, not only after group edits", async () => {
  const page = await mount()
  try {
    await idle(page)
    await page.waitForFunction(() => /1 model matches now/.test(document.querySelector('[data-action="predictions-group-0"]')?.textContent ?? ""))
    await page.getByRole("switch", { name: "Enable Predictions" }).uncheck()
    await page.waitForFunction(() => /1 model matches now/.test(document.querySelector('[data-action="predictions-group-0"]')?.textContent ?? ""), undefined, { timeout: 5000 })
    await page.getByRole("button", { name: "Discard changes" }).click()
    await page.waitForFunction(() => /1 model matches now/.test(document.querySelector('[data-action="predictions-group-0"]')?.textContent ?? ""), undefined, { timeout: 5000 })
    assert.equal(await page.evaluate(() => (window as any).log.predictions + (window as any).log.fetches), 0)
  } finally { await page.close() }
})

test("Reload settings asks before it discards an unsaved draft, and keeps the draft when declined", async () => {
  const page = await mount({ saveKind: "conflict" })
  try {
    await idle(page)
    await page.getByRole("switch", { name: "Enable Predictions" }).uncheck()
    await save(page).click()
    await page.getByRole("button", { name: "Reload settings" }).waitFor()
    await page.evaluate(() => { (window as any).confirmAnswer = false })
    await page.getByRole("button", { name: "Reload settings" }).click()
    assert.equal(await page.evaluate(() => (window as any).log.confirms.length), 1)
    assert.match(await page.evaluate(() => (window as any).log.confirms[0].title), /Discard/)
    assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isChecked(), false, "declining keeps the draft")
    await page.evaluate(() => { (window as any).confirmAnswer = true })
    await page.getByRole("button", { name: "Reload settings" }).click()
    await page.waitForFunction(() => !document.body.textContent?.includes("Reload settings"))
    assert.equal(await page.getByRole("switch", { name: "Enable Predictions" }).isChecked(), true)
  } finally { await page.close() }
})

test("the reason Save is disabled stays visible next to Save even when Advanced is collapsed", async () => {
  const page = await mount()
  try {
    await idle(page)
    await page.getByRole("button", { name: "Show advanced settings" }).click()
    await page.getByLabel("Timeout per model").fill("8000oops")
    await page.getByRole("button", { name: "Hide advanced settings" }).click()
    assert.equal(await save(page).isDisabled(), true)
    assert.match((await page.locator('[data-footer] [role="status"]').textContent())!, /whole number/i)
  } finally { await page.close() }
})
